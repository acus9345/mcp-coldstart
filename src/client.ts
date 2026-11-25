import { spawn, type ChildProcess } from "node:child_process";
import { killTree, killTreeSync, reapGroup } from "./kill.js";
import { executableName, makeScrubber } from "./redact.js";
import { planSpawn } from "./spawn.js";

export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export interface LaunchOptions {
  /** Executable to launch. */
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Forward the server's stderr to this process's stderr (otherwise it is buffered and shown on failure). */
  inheritStderr?: boolean;
  /**
   * Keep server arguments verbatim (default false). By default results record
   * only the executable/package name with other arguments as "***", and
   * argument values echoed in server output (error messages) are scrubbed.
   */
  showArgs?: boolean;
  /**
   * POSIX only: run the server in its own process group so shutdown can signal
   * everything it started (default true). Ignored on Windows, where the
   * process tree is killed with taskkill /T.
   */
  processGroup?: boolean;
}

/** Servers that are still running, for cleanup on exit or Ctrl-C. */
const live = new Set<StdioClient>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => killAllServers());
}

/**
 * Kill every server this process started that is still running, including
 * their child processes. Synchronous; safe to call from signal handlers.
 */
export function killAllServers(): void {
  for (const c of live) c.killNow();
}

export class ServerError extends Error {
  override name = "ServerError";
  constructor(message: string, readonly stderr = "") {
    super(stderr.trim() ? `${message}\n--- server output (last lines) ---\n${tail(stderr)}` : message);
  }
}

/** How the server command is named in errors: never more than redactCommand would show. */
function commandLabel(command: string, showArgs?: boolean): string {
  return showArgs ? command : executableName(command);
}

function notFoundMessage(command: string, showArgs?: boolean): string {
  const where = process.platform === "win32" ? "PATH with PATHEXT extensions" : "PATH";
  const hint = /\s/.test(command.trim()) && !/[\\/]/.test(command)
    ? '; it contains spaces: pass the program and each argument separately after "--"'
    : "";
  return `command not found: "${commandLabel(command, showArgs)}" (not an existing file and not on ${where}${hint})`;
}

function tail(s: string, lines = 20): string {
  return s.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

interface Pending {
  resolve: (v: { result: unknown; bytes: number }) => void;
  reject: (e: Error) => void;
  method: string;
}

export interface CloseResult {
  /** Milliseconds from closing stdin until the process exited. */
  ms: number;
  /** True if the server ignored stdin EOF and had to be signalled. */
  forced: boolean;
  /** POSIX: processes were still running in the server's process group after it exited (they were terminated). */
  leftovers?: boolean;
}

/**
 * Minimal MCP client over stdio: newline-delimited JSON-RPC 2.0 as defined by
 * the MCP stdio transport. No SDK dependency.
 */
export class StdioClient {
  readonly child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private buffer = "";
  private stderrBuf = "";
  private exited: Error | null = null;
  private readonly group: boolean;
  private readonly scrub: (text: string) => string;
  /** Lines on stdout that were not JSON-RPC (a stdio-transport violation). */
  stdoutNoise = 0;

  constructor(opts: LaunchOptions) {
    this.scrub = makeScrubber(opts.command, opts.args ?? [], opts.showArgs);
    const env = opts.env ?? process.env;
    // Never use a shell: see spawn.ts for how Windows .cmd shims are handled.
    const plan = planSpawn(opts.command, opts.args ?? [], { env, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    if (plan.notFound) throw new ServerError(notFoundMessage(opts.command, opts.showArgs));
    this.group = process.platform !== "win32" && (opts.processGroup ?? true);
    const child = spawn(plan.file, plan.args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", opts.inheritStderr ? "inherit" : "pipe"],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      detached: this.group,
    });
    this.child = child;
    live.add(this);
    installExitHook();
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderrBuf = (this.stderrBuf + chunk).slice(-64 * 1024);
      });
    }
    child.stdin!.on("error", () => {
      /* surfaced via the exit handler */
    });
    child.on("error", (err) => {
      live.delete(this);
      this.fail(this.error((err as NodeJS.ErrnoException).code === "ENOENT" ? notFoundMessage(opts.command, opts.showArgs) : `failed to start "${commandLabel(opts.command, opts.showArgs)}": ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      live.delete(this);
      this.fail(this.error(`server exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Recent server stderr (and non-JSON stdout), with argument values scrubbed unless showArgs. */
  get stderr(): string {
    return this.scrub(this.stderrBuf);
  }

  /** A ServerError carrying the (scrubbed) recent server output. */
  error(message: string): ServerError {
    return new ServerError(this.scrub(message), this.stderr);
  }

  private fail(err: Error): void {
    if (!this.exited) this.exited = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const line = raw.replace(/\r$/, "").trim();
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        this.stdoutNoise++;
        this.stderrBuf = (this.stderrBuf + `[non-JSON on stdout] ${line.slice(0, 200)}\n`).slice(-64 * 1024);
        continue;
      }
      if (Array.isArray(msg)) {
        // JSON-RPC batch: attribute to each response its own (re-serialized) size,
        // not the size of the whole line.
        for (const m of msg) this.onMessage(m, Buffer.byteLength(JSON.stringify(m) ?? "", "utf8") + 1);
      } else {
        this.onMessage(msg, Buffer.byteLength(raw, "utf8") + 1);
      }
    }
  }

  private onMessage(msg: unknown, bytes: number): void {
    if (typeof msg !== "object" || msg === null) {
      this.stdoutNoise++;
      return;
    }
    const m = msg as { id?: number | string | null; method?: string; result?: unknown; error?: { code?: number; message?: string } };
    if (m.method !== undefined) {
      // Server -> client request or notification.
      if (m.id !== undefined && m.id !== null) {
        if (m.method === "ping") this.send({ jsonrpc: "2.0", id: m.id, result: {} });
        else if (m.method === "roots/list") this.send({ jsonrpc: "2.0", id: m.id, result: { roots: [] } });
        else this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
      }
      return;
    }
    if (m.id === undefined || m.id === null) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(this.error(`${p.method} failed: ${m.error.message ?? "unknown error"} (code ${m.error.code ?? "?"})`));
    else p.resolve({ result: m.result, bytes });
  }

  private send(obj: unknown): void {
    const stdin = this.child.stdin;
    if (this.exited || !stdin || stdin.writableEnded || stdin.destroyed) return;
    stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Send a request; resolves with the result and the size of the response line in bytes. */
  requestSized<T = unknown>(method: string, params?: unknown): Promise<{ result: T; bytes: number }> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as Pending["resolve"], reject, method });
      this.send(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
    });
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return (await this.requestSized<T>(method, params)).result;
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  /** Kill the server and its descendants immediately (synchronous). */
  killNow(): void {
    killTreeSync(this.child, "SIGKILL", { group: this.group });
    live.delete(this);
  }

  /** Drop our handles so a lingering grandchild holding the pipes cannot keep this process alive. */
  private release(): void {
    for (const s of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      try {
        s?.destroy();
      } catch {
        /* ignore */
      }
    }
    this.child.unref();
  }

  /**
   * Shut down the way the MCP stdio transport recommends: close stdin, wait
   * `graceMs`, then terminate the process tree, then kill it. The returned
   * `ms` is the time until the server process itself exited.
   *
   * On POSIX, close() then waits until the server's whole process group is
   * gone: leftovers (e.g. a grandchild under an `npx` wrapper) get SIGTERM, up
   * to `graceMs` to exit, then SIGKILL, and close() waits for them to die and
   * be reaped. It always returns, by about `2 * graceMs + max(1s, graceMs)`
   * for the server plus `graceMs + 1.4s` for leftovers, even if something
   * cannot be reaped. Our pipe handles are released either way.
   */
  async close(graceMs = 2000): Promise<CloseResult> {
    const child = this.child;
    const start = performance.now();
    let forced = false;
    let termSent = false;
    if (child.exitCode === null && child.signalCode === null && !this.startFailed()) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const timers: NodeJS.Timeout[] = [];
        const finish = () => {
          if (settled) return;
          settled = true;
          for (const t of timers) clearTimeout(t);
          resolve();
        };
        child.once("exit", finish);
        try {
          child.stdin!.end();
        } catch {
          /* ignore */
        }
        timers.push(
          setTimeout(() => {
            forced = true;
            termSent = true;
            void killTree(child, "SIGTERM", { group: this.group });
          }, graceMs),
          setTimeout(() => {
            forced = true;
            void killTree(child, "SIGKILL", { group: this.group });
          }, graceMs * 2),
          // Hard deadline: never hang, even if the exit event never arrives.
          setTimeout(finish, graceMs * 2 + Math.max(1000, graceMs)),
        );
      });
    }
    const ms = performance.now() - start;
    let leftovers = false;
    // Wait until nothing the server left behind in its process group survives.
    if (this.group && child.pid !== undefined) {
      try {
        leftovers = (await reapGroup(child.pid, graceMs, { termSent })).leftovers;
      } catch {
        killTreeSync(child, "SIGKILL", { group: true });
      }
    }
    live.delete(this);
    this.release();
    return { ms, forced, leftovers };
  }

  private startFailed(): boolean {
    return this.child.pid === undefined;
  }
}
