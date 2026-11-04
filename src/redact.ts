/**
 * Server command lines often carry secrets: API keys as positional arguments,
 * `--header "Authorization: Bearer ..."`, connection strings. Results are
 * printed, written to baselines, committed and posted to PRs, so by default
 * only the executable name and, for package runners such as npx/uvx, the
 * package name are kept. Every other argument becomes a single "***".
 * Environment variables are never recorded.
 */

export const REDACTED = "***";

/** Runners whose first non-flag argument is a package spec: exe -> required subcommand ("" = none). */
const RUNNERS: Record<string, string> = {
  npx: "",
  pnpx: "",
  bunx: "",
  uvx: "",
  npm: "exec",
  pnpm: "dlx",
  yarn: "dlx",
  bun: "x",
  pipx: "run",
};

/** npm / PyPI style package spec, optionally with @version or ==version. No URLs, paths or "=" values. */
const PACKAGE_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*((@|==)[\w.^~<>=*+-]+)?$/i;

/**
 * Runner flags that take no value. Any other flag (e.g. `--otp 123456`,
 * `--_authToken x`, `--with ghp_...`, `-p pkg`) may take the next word as its
 * value, so after one of those nothing more is kept.
 */
const BOOLEAN_RUNNER_FLAGS = new Set([
  "-y", "--yes", "--no", "--no-yes", "-q", "--quiet", "--silent", "-s", "--offline", "--prefer-offline", "--prefer-online",
  "--no-install", "--ignore-existing", "--isolated", "--refresh", "--no-cache", "--verbose", "-v", "--shell-auto-fallback",
]);

/** Common credential shapes (GitHub, Slack, Stripe/OpenAI, npm, GitLab, AWS, JWT-ish). */
const TOKEN_LIKE = /^(gh[pousr]_|github_pat_|xox[abposr]-|sk[-_]|rk_|pk_|npm_|glpat-|AKIA|ASIA|eyJ)/i;

/** A word we are willing to print as the package name. */
function isPackageName(word: string): boolean {
  if (word.length > 214 || !PACKAGE_SPEC.test(word) || TOKEN_LIKE.test(word)) return false;
  // Strip a version and the scope; the remaining name must not look random (token-ish).
  const name = word.replace(/^@[^/]+\//, "").replace(/(@|==).*$/, "");
  if (TOKEN_LIKE.test(name)) return false;
  const digits = (name.match(/\d/g) ?? []).length;
  if (digits >= 6) return false;
  if (name.length >= 20 && !/[-_.]/.test(name)) return false; // long unbroken blob
  return true;
}

/** Executable name without its directory (POSIX or Windows separators). */
export function executableName(command: string): string {
  const parts = command.split(/[\\/]/).filter(Boolean);
  const base = parts[parts.length - 1] ?? command;
  // A whole command line passed as one string ("npx -y pkg --token x"): keep the first word only.
  return /\s/.test(base.trim()) ? base.trim().split(/\s+/)[0]! : base;
}

/**
 * The command line as it should be recorded. With `showArgs` it is returned
 * unchanged. Otherwise it becomes `[exe, subcommand?, package?, "***"?]`:
 * the package is kept only for a known runner, only if no value-taking runner
 * flag precedes it, and only if it looks like a package name (never a URL,
 * path, "key=value" or token).
 */
export function redactCommand(command: string, args: readonly string[], showArgs = false): { command: string[]; redacted: boolean } {
  if (showArgs) return { command: [command, ...args], redacted: false };
  const exe = executableName(command);
  const out = [exe];
  const commandHidden = exe !== command.split(/[\\/]/).filter(Boolean).pop();
  const key = exe.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
  const sub = RUNNERS[key];
  let kept = 0;
  if (sub !== undefined && !commandHidden) {
    let i = 0;
    if (sub) {
      if (args[0] === sub) {
        out.push(sub);
        kept++;
        i = 1;
      } else i = args.length; // not the runner form: keep nothing else
    }
    for (; i < args.length; i++) {
      const a = args[i]!;
      if (a.startsWith("-")) {
        if (BOOLEAN_RUNNER_FLAGS.has(a)) continue; // inline "--flag=value" and value-taking flags fall through
        break;
      }
      if (isPackageName(a)) {
        out.push(a);
        kept++;
      }
      break;
    }
  }
  const redacted = commandHidden || args.length > kept;
  if (redacted) out.push(REDACTED);
  return { command: out, redacted };
}

/**
 * Best-effort scrubbing of server output (shown when a server fails): replace
 * every redacted argument, and every long piece of one (split on whitespace,
 * "=", ":", ",", "/", "?", "&", "#" and "@"), with "***". A command given as one
 * string with spaces is treated the same way. This catches a server echoing
 * "Unknown option sk-..." or a token taken from "Authorization: Bearer ...".
 * Short values are left alone so ordinary words are not mangled.
 */
export function makeScrubber(command: string, args: readonly string[], showArgs = false): (text: string) => string {
  if (showArgs) return (t) => t;
  const kept = new Set(redactCommand(command, args).command);
  const values = new Set<string>();
  const secretish = [...args];
  if (/\s/.test(command.trim())) secretish.push(...command.trim().split(/\s+/).slice(1));
  for (const a of secretish) {
    if (kept.has(a)) continue;
    if (a.length >= 6) values.add(a);
    for (const piece of a.split(/[\s=:,/?&#@]+/)) if (piece.length >= 8 && !kept.has(piece)) values.add(piece);
  }
  const list = [...values].sort((x, y) => y.length - x.length);
  if (list.length === 0) return (t) => t;
  return (text) => {
    let out = text;
    for (const v of list) out = out.split(v).join(REDACTED);
    return out;
  };
}
