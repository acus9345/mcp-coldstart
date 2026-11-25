import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/** All descendant pids of `root` (inclusive), from a pid->ppid table. */
function descendants(root: number, table: Map<number, number>): number[] {
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const [pid, ppid] of table) if (ppid === out[i] && !out.includes(pid)) out.push(pid);
  }
  return out;
}

function linuxTable(): Map<number, number> {
  const table = new Map<number, number>();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      // field 4 is ppid; comm (field 2) may contain spaces, so split after the last ')'
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      table.set(Number(d), Number(rest[1]));
    } catch {
      /* process went away */
    }
  }
  return table;
}

function linuxKb(pid: number, field: "VmHWM" | "VmRSS"): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m").exec(status);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Peak resident memory (MB) of a process tree.
 *  - Linux: sum of VmHWM (peak RSS) across the process and its descendants.
 *  - macOS / BSD: current RSS of the tree via `ps` (a lower bound of the peak).
 *  - Windows: not measured (returns null).
 */
export function treeMemoryMb(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    if (process.platform === "linux") {
      const pids = descendants(pid, linuxTable());
      const kb = pids.reduce((sum, p) => sum + (linuxKb(p, "VmHWM") || linuxKb(p, "VmRSS")), 0);
      return kb > 0 ? kb / 1024 : null;
    }
    if (process.platform === "win32") return null;
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" });
    const table = new Map<number, number>();
    const rss = new Map<number, number>();
    for (const line of out.split("\n")) {
      const [p, pp, r] = line.trim().split(/\s+/).map(Number);
      if (p === undefined || pp === undefined || !Number.isFinite(p) || !Number.isFinite(pp)) continue;
      table.set(p, pp);
      rss.set(p, r !== undefined && Number.isFinite(r) ? r : 0);
    }
    const kb = descendants(pid, table).reduce((sum, p) => sum + (rss.get(p) ?? 0), 0);
    return kb > 0 ? kb / 1024 : null;
  } catch {
    return null;
  }
}

export const MEMORY_METHOD: string =
  process.platform === "linux" ? "peak RSS (VmHWM) of process tree" : process.platform === "win32" ? "not measured on Windows" : "RSS of process tree after tools/list (ps)";
