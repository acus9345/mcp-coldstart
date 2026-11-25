/**
 * Shell-free process launching that also works on Windows.
 *
 * `child_process.spawn(cmd, args, { shell: true })` joins the arguments into one
 * unquoted string for cmd.exe. Arguments containing spaces get split, cmd
 * metacharacters (& | < > ^ %) run as shell syntax (command injection), and
 * Node >= 22 warns with DEP0190. Instead we:
 *
 *  - POSIX: spawn the command directly (shell: false). Node already resolves
 *    PATH.
 *  - Windows: resolve the command ourselves via PATH + PATHEXT.
 *     - .exe / .com files are spawned directly with shell: false.
 *     - .cmd / .bat files (e.g. npx.cmd) can only be run by cmd.exe. They are
 *       run as `cmd.exe /d /s /v:off /c "<escaped command line>"` with
 *       (/d: skip AutoRun, /v:off: no delayed !VAR! expansion even if the
 *       registry enables it)
 *       windowsVerbatimArguments, every argument quoted for the MSVCRT
 *       command-line rules, and cmd metacharacters escaped with ^.
 *
 * The escaping follows cross-spawn (MIT, (c) 2018 Made With MOXY Lda,
 * https://github.com/moxystudio/node-cross-spawn, lib/util/escape.js and
 * lib/parse.js). It is vendored to keep the package dependency-free.
 * Differences from cross-spawn:
 *  - ":" is also escaped. cmd expands %VAR:a=b% and %VAR:~n% even after the
 *    % signs are ^-escaped (the variable name ends at ":"); "^:" turns the
 *    name into "VAR^", which is undefined, so the text stays literal.
 *  - cmd.exe gets /v:off so delayed !VAR! expansion stays off even when the
 *    registry enables it.
 *  - Arguments are double-escaped for batch files that forward "%*" (npm/npx/
 *    pnpm/yarn shims, anything under node_modules\.bin, or a .cmd/.bat whose
 *    text contains "%*"). Those lines are parsed by cmd a second time. Other
 *    batch files (e.g. ones that read "%~1") get single escaping.
 *  - PATHEXT is limited to .COM/.EXE/.BAT/.CMD; .JS/.VBS/... (Windows Script
 *    Host) are never launched.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

/** Characters cmd.exe treats specially; each is prefixed with ^. */
const META_CHARS = /([()\][%!^"`<>&|;, *?:])/g;

/** Escape a command (program path) for a cmd.exe command line. */
export function escapeCommand(command: string): string {
  return command.replace(META_CHARS, "^$1");
}

/**
 * Quote one argument for the MSVCRT/CommandLineToArgvW rules, then escape cmd
 * metacharacters. Pass `doubleEscape` when the target is a batch file whose
 * arguments are parsed by cmd a second time.
 */
export function escapeArgument(arg: string, doubleEscape = false): string {
  let s = String(arg);
  // Backslashes before a double quote: double them and escape the quote.
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  // Backslashes at the end (they will precede our closing quote): double them.
  s = s.replace(/(\\*)$/, "$1$1");
  s = `"${s}"`;
  s = s.replace(META_CHARS, "^$1");
  if (doubleEscape) s = s.replace(META_CHARS, "^$1");
  return s;
}

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Windows environment variable names are case-insensitive ("Path", "PATH").
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** For tests: override the file-existence check. */
  isFile?: (p: string) => boolean;
  /** PATH list delimiter (default ";"). */
  delimiter?: string;
  /** For tests: read the start of a batch file (to look for "%*"). */
  readText?: (p: string) => string;
}

/** Extensions we launch; PATHEXT entries outside this set are ignored. */
const RUNNABLE = new Set([".com", ".exe", ".bat", ".cmd"]);

/** The on-disk spelling of an existing file's name (NTFS is case-insensitive). */
function onDiskSpelling(p: string): string {
  try {
    const dir = path.dirname(p);
    const want = path.basename(p).toLowerCase();
    const hit = readdirSync(dir).find((e) => e.toLowerCase() === want);
    return hit ? path.join(dir, hit) : p;
  } catch {
    return p;
  }
}

function readHead(p: string): string {
  try {
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("latin1");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * Resolve a command the way Windows does for PATH lookups: if it contains a
 * path separator, resolve it against cwd; otherwise search each PATH entry.
 * Tries the name as given (if it already has a runnable extension) and then
 * each PATHEXT extension (only .com/.exe/.bat/.cmd) in order. Returns the
 * on-disk spelling of the file name. Returns null if nothing matches. The
 * current directory is deliberately not searched implicitly.
 */
export function resolveWindowsCommand(command: string, opts: ResolveOptions = {}): string | null {
  if (!command.trim()) return null;
  const env = opts.env ?? process.env;
  const exists = opts.isFile ?? isFile;
  const delimiter = opts.delimiter ?? ";";
  const cwd = opts.cwd ?? process.cwd();
  const exts = (envGet(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => RUNNABLE.has(e));
  if (exts.length === 0) exts.push(".com", ".exe", ".bat", ".cmd");
  const given = path.extname(command).toLowerCase();
  const candidates = (base: string) => {
    // The name as given first (if it already has a runnable extension), then
    // each extension in PATHEXT order, lowercase.
    const out: string[] = [];
    if (RUNNABLE.has(given)) out.push(base);
    for (const e of exts) out.push(base + e);
    return out;
  };
  const dirs = /[\\/]/.test(command) || path.isAbsolute(command)
    ? [""]
    : (envGet(env, "PATH") ?? "").split(delimiter).map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  for (const dir of dirs) {
    const base = dir ? path.join(dir, command) : path.resolve(cwd, command);
    for (const c of candidates(base)) if (exists(c)) return opts.isFile ? c : onDiskSpelling(c);
  }
  return null;
}

/** Batch files known to forward their arguments with %* (so cmd parses them twice). */
const FORWARDING_SHIMS = /^(npx|npm|pnpm|pnpx|yarn|yarnpkg|corepack|bunx|tsx|ts-node)\.(cmd|bat)$/i;

/** Does this batch file forward "%*" (and therefore need double escaping)? */
export function forwardsAllArgs(file: string, readText: (p: string) => string = readHead): boolean {
  if (FORWARDING_SHIMS.test(path.win32.basename(file))) return true;
  if (/[\\/]node_modules[\\/]\.bin[\\/][^\\/]+$/i.test(file)) return true;
  return readText(file).includes("%*");
}

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Must be passed to spawn() when set (the cmd.exe line is pre-escaped). */
  windowsVerbatimArguments: boolean;
  /** Windows: the command was not found via PATH/PATHEXT; do not spawn. */
  notFound?: boolean;
}

/** An argument that cannot be passed to a batch file without risking command injection. */
export class UnsafeArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArgumentError";
  }
}

/** cmd.exe to run batch files with: %ComSpec%, else an absolute System32 path (never a PATH/cwd lookup). */
export function comspecPath(env: NodeJS.ProcessEnv): string {
  const fromEnv = envGet(env, "COMSPEC")?.trim();
  if (fromEnv && path.win32.isAbsolute(fromEnv)) return fromEnv;
  const root = envGet(env, "SystemRoot")?.trim() || envGet(env, "windir")?.trim();
  return path.win32.join(root && path.win32.isAbsolute(root) ? root : "C:\\Windows", "System32", "cmd.exe");
}

export interface PlanOptions extends ResolveOptions {
  platform?: NodeJS.Platform;
}

/**
 * Work out how to launch `command args` without a shell.
 * @throws UnsafeArgumentError on Windows when an argument cannot be passed
 *   safely to a .cmd/.bat target (a `"` for batch files that read %1, or a
 *   line break / NUL for any batch file).
 */
export function planSpawn(command: string, args: string[], opts: PlanOptions = {}): SpawnPlan {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { file: command, args: [...args], windowsVerbatimArguments: false };
  const resolved = resolveWindowsCommand(command, opts);
  // Unresolvable: report "command not found" instead of handing a missing
  // .cmd/.bat to cmd.exe (confusing error) or to spawn (EINVAL).
  if (!resolved) return { file: command, args: [...args], windowsVerbatimArguments: false, notFound: true };
  if (/\.(?:exe|com)$/i.test(resolved)) return { file: resolved, args: [...args], windowsVerbatimArguments: false };
  // .cmd / .bat have to go through cmd.exe.
  const name = path.win32.basename(resolved);
  // cmd.exe ends the command line at a line break, and NUL cannot be passed at all.
  const broken = args.findIndex((a) => /[\r\n\0]/.test(a));
  if (broken >= 0) throw new UnsafeArgumentError(`argument ${broken + 1} contains a line break or NUL, which cannot be passed safely to the batch file ${name}`);
  const doubleEscape = forwardsAllArgs(resolved, opts.readText);
  if (!doubleEscape) {
    // The batch file reads %1 / "%~1": cmd re-parses the value with its own quote
    // rules, where \" does not escape a quote, so a " in the value would end the
    // quoting and expose & | < > (BatBadBut). Nothing can escape it there.
    const quoted = args.findIndex((a) => a.includes('"'));
    if (quoted >= 0) {
      throw new UnsafeArgumentError(
        `argument ${quoted + 1} contains a double quote, which cannot be passed safely to the batch file ${name} (it reads %1-style arguments, not %*). Run the server's program directly (e.g. node server.js) instead of through the batch file`,
      );
    }
  }
  const line = [escapeCommand(path.win32.normalize(resolved)), ...args.map((a) => escapeArgument(a, doubleEscape))].join(" ");
  const comspec = comspecPath(opts.env ?? process.env);
  return { file: comspec, args: ["/d", "/s", "/v:off", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
