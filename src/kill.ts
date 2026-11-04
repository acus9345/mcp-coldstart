import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** taskkill.exe from System32, so a PATH entry cannot shadow it. */
function taskkillPath(): string {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir;
  return root ? path.win32.join(root, "System32", "taskkill.exe") : "taskkill.exe";
}

/**
 * Signal a server and everything it started.
 *  - Windows: `taskkill /pid <pid> /T /F`, spawned without a shell. Killing
 *    only the direct child would leave e.g. node.exe running under a
 *    cmd.exe-launched npx.cmd.
 *  - POSIX: the server runs in its own process group (spawned detached), so
 *    signal the group (-pid). This reaches grandchildren that `npx` or a
 *    shell wrapper started. Falls back to signalling the child alone.
 * Never throws.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals, opts: { group: boolean }): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      try {
        const tk = spawn(taskkillPath(), ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false });
        const timer = setTimeout(() => {
          try {
            child.kill(signal);
          } catch {
            /* ignore */
          }
          resolve();
        }, 5000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        tk.once("exit", done);
        tk.once("error", () => {
          try {
            child.kill(signal);
          } catch {
            /* ignore */
          }
          done();
        });
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* ignore */
        }
        resolve();
      }
    });
  }
  killTreeSync(child, signal, opts);
  return Promise.resolve();
}

/** Synchronous variant for process-exit cleanup. Never throws. */
export function killTreeSync(child: ChildProcess, signal: NodeJS.Signals, opts: { group: boolean }): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawnSync(taskkillPath(), ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false, timeout: 5000 });
    } catch {
      /* ignore */
    }
    return;
  }
  if (opts.group) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      /* group gone or not ours: fall through */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
}

/**
 * Members of POSIX process group `pgid`: `live` (running or stopped) and
 * `zombies` (dead, not yet reaped by their new parent, usually init).
 * Linux reads /proc. Elsewhere only "some member exists" is known (kill -0),
 * which is reported as one live member.
 */
export function groupMembers(pgid: number): { live: number; zombies: number } {
  if (process.platform === "linux") {
    let live = 0;
    let zombies = 0;
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      entries = [];
    }
    if (entries.length) {
      for (const e of entries) {
        if (e.charCodeAt(0) < 48 || e.charCodeAt(0) > 57) continue;
        let stat: string;
        try {
          stat = readFileSync(`/proc/${e}/stat`, "latin1");
        } catch {
          continue; // exited while we looked
        }
        // fields after "(comm) ": state ppid pgrp ...
        const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(f[2]) !== pgid) continue;
        if (f[0] === "Z" || f[0] === "X") zombies++;
        else live++;
      }
      return { live, zombies };
    }
  }
  try {
    process.kill(-pgid, 0);
    return { live: 1, zombies: 0 };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? { live: 1, zombies: 0 } : { live: 0, zombies: 0 };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until the group has no live members (and, if `zombies`, no unreaped ones either) or `ms` passes. */
export async function waitGroupGone(pgid: number, ms: number, opts: { zombies?: boolean; intervalMs?: number } = {}): Promise<boolean> {
  const until = performance.now() + ms;
  for (;;) {
    const m = groupMembers(pgid);
    if (m.live === 0 && (!opts.zombies || m.zombies === 0)) return true;
    if (performance.now() >= until) return false;
    await sleep(opts.intervalMs ?? 20);
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* gone */
  }
}

/**
 * POSIX: after the server itself has exited, make sure nothing it left in its
 * process group survives. SIGTERM the leftovers, wait up to `graceMs` for them
 * to exit, then SIGKILL the group and wait (up to 1 s) until every member is
 * gone, unreaped zombies included. Returns what was needed.
 */
export async function reapGroup(pgid: number, graceMs: number, opts: { termSent?: boolean } = {}): Promise<{ leftovers: boolean; killed: boolean; gone: boolean }> {
  if (groupMembers(pgid).live === 0) {
    return { leftovers: false, killed: false, gone: await waitGroupGone(pgid, 200, { zombies: true, intervalMs: 5 }) };
  }
  if (!opts.termSent) signalGroup(pgid, "SIGTERM");
  let killed = false;
  if (!(await waitGroupGone(pgid, graceMs))) {
    killed = true;
    signalGroup(pgid, "SIGKILL");
    await waitGroupGone(pgid, 1000, { intervalMs: 5 });
  }
  const gone = await waitGroupGone(pgid, 200, { zombies: true, intervalMs: 5 });
  return { leftovers: true, killed, gone };
}
