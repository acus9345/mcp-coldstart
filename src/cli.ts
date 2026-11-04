#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { killAllServers, ServerError } from "./client.js";
import { UnsafeArgumentError } from "./spawn.js";
import { evaluate, InputError, loadResult, parseMetric, type GateOptions } from "./compare.js";
import { formatJson, formatMarkdown, formatText, type Report } from "./format.js";
import { measure, type MeasureOptions } from "./measure.js";
import type { Metric, Result, StatName } from "./types.js";
import { VERSION } from "./version.js";

export const HELP = `mcp-coldstart ${VERSION} — measure an MCP server's cold start and fail CI when it regresses

Usage:
  mcp-coldstart [run] [options] -- <command> [args...]
      Launch the server over stdio N times; time initialize, tools/list and
      shutdown; measure memory and tool-definition size.
  mcp-coldstart compare <base.json> <head.json> [gate options]
      Compare two saved results without launching anything.

Run options:
  -n, --runs <n>            Measured cold starts (default: 5)
  --warmup <n>              Discarded runs before measuring (default: 1)
  --timeout <ms>            Per-run timeout for initialize + tools/list (default: 30000)
  --shutdown-grace <ms>     Wait this long after closing stdin before killing the
                            server's process tree (default: 2000)
  --protocol-version <v>    protocolVersion to request (default: 2025-06-18)
  --cwd <dir>               Working directory for the server
  --verbose                 Pass the server's stderr through
  --show-args               Record the full server command line in output and
                            saved results (default: only the executable/package
                            name; other arguments are shown as *** because
                            they often contain API keys)
  -o, --output <file>       Save the result as JSON (use it later as --baseline)

Gate options (run, compare):
  --baseline <file>         Compare against a saved result (run only)
  --max-regression <pct>    Allowed regression in percent (default: 20)
  --stat <name>             p50 | p95 | mean | min | max (default: p50)
  --gate <metrics>          Comma-separated metrics that fail on regression
                            (default: ready,memory,tokens)
  --min-delta-ms <ms>       Ignore time regressions smaller than this (default: 25)
  --min-delta-mb <mb>       Ignore memory regressions smaller than this (default: 5)
  --budget <metric>=<n>     Absolute limit, repeatable. Units: ms for times,
                            MB for memory, tokens, bytes. e.g. --budget ready=1500

Output:
  --json                    JSON (the output is itself a valid baseline file)
  --markdown, --md          Markdown (PR comments / $GITHUB_STEP_SUMMARY)
  --format <fmt>            text | json | markdown (default: text)
  --color / --no-color      Force ANSI colors on/off (default: auto; honours NO_COLOR)

Metrics: ready (spawn → tools listed), init, tools-list, shutdown, memory, tokens, bytes

Exit codes:
  0  measured successfully and every gate passed
  1  a budget was exceeded or a gated metric regressed
  2  usage error, invalid input, or the server failed to start/respond
`;

class UsageError extends Error {}

interface Parsed {
  positionals: string[];
  command: string[];
  flags: Map<string, string | true>;
  budgets: string[];
}

const VALUE_FLAGS = new Set([
  "-n",
  "--runs",
  "--warmup",
  "--timeout",
  "--shutdown-grace",
  "--protocol-version",
  "--cwd",
  "-o",
  "--output",
  "--baseline",
  "--max-regression",
  "--stat",
  "--gate",
  "--min-delta-ms",
  "--min-delta-mb",
  "--budget",
  "--format",
]);
const BOOL_FLAGS = new Set(["--json", "--markdown", "--md", "--color", "--no-color", "--verbose", "--show-args", "-h", "--help", "-v", "--version"]);
const CANON: Record<string, string> = { "-n": "--runs", "-o": "--output" };

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const budgets: string[] = [];
  let command: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      command = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (VALUE_FLAGS.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new UsageError(`${name} requires a value`);
        if (name === "--budget") budgets.push(v);
        else flags.set(CANON[name] ?? name, v);
      } else if (BOOL_FLAGS.has(name)) {
        flags.set(name, true);
      } else {
        throw new UsageError(`unknown option ${a}`);
      }
      continue;
    }
    positionals.push(a);
  }
  return { positionals, command, flags, budgets };
}

function str(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function numFlag(p: Parsed, name: string, opts: { int?: boolean; min?: number } = {}): number | undefined {
  const raw = str(p, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || (opts.int && !Number.isInteger(n)) || n < (opts.min ?? -Infinity)) {
    throw new UsageError(`${name} must be ${opts.int ? "an integer" : "a number"}${opts.min !== undefined ? ` >= ${opts.min}` : ""} (got "${raw}")`);
  }
  return n;
}

function outputFormat(p: Parsed): "text" | "json" | "markdown" {
  const f = str(p, "--format");
  if (f !== undefined) {
    if (f === "md") return "markdown";
    if (f !== "text" && f !== "json" && f !== "markdown") throw new UsageError(`--format must be text, json or markdown (got "${f}")`);
    return f;
  }
  if (p.flags.has("--json")) return "json";
  if (p.flags.has("--markdown") || p.flags.has("--md")) return "markdown";
  return "text";
}

function useColor(p: Parsed): boolean {
  if (p.flags.has("--no-color")) return false;
  if (p.flags.has("--color")) return true;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY);
}

function gateOptions(p: Parsed): GateOptions {
  const g: GateOptions = {};
  const stat = str(p, "--stat");
  if (stat !== undefined) {
    if (!["p50", "p95", "mean", "min", "max"].includes(stat)) throw new UsageError(`--stat must be p50, p95, mean, min or max (got "${stat}")`);
    g.stat = stat as StatName;
  }
  const mr = numFlag(p, "--max-regression", { min: 0 });
  if (mr !== undefined) g.maxRegressionPct = mr;
  const md = numFlag(p, "--min-delta-ms", { min: 0 });
  if (md !== undefined) g.minDeltaMs = md;
  const mb = numFlag(p, "--min-delta-mb", { min: 0 });
  if (mb !== undefined) g.minDeltaMb = mb;
  const gate = str(p, "--gate");
  if (gate !== undefined) {
    const names = gate.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) throw new UsageError(`--gate needs at least one metric, e.g. --gate ready,memory (got "${gate}")`);
    g.gate = names.map(parseMetric);
  }
  if (p.budgets.length) {
    const budgets: Partial<Record<Metric, number>> = {};
    for (const b of p.budgets) {
      const m = /^([^=]+)=(.+)$/.exec(b);
      const limit = m ? Number(m[2]) : NaN;
      if (!m || !Number.isFinite(limit) || limit < 0) throw new UsageError(`--budget expects <metric>=<number>, e.g. ready=1500 (got "${b}")`);
      budgets[parseMetric(m[1]!)] = limit;
    }
    g.budgets = budgets;
  }
  return g;
}

interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

function render(p: Parsed, result: Result, report: Report | null): string {
  const fmt = outputFormat(p);
  if (fmt === "json") return formatJson(result, report);
  if (fmt === "markdown") return formatMarkdown(result, report);
  return formatText(result, report, { color: useColor(p) });
}

/** Run the CLI. Returns the process exit code. */
export async function run(argv: string[], io: Io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }): Promise<number> {
  try {
    const p = parse(argv);
    if (p.flags.has("--version") || p.flags.has("-v")) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    const help = p.flags.has("--help") || p.flags.has("-h");
    if (help || (p.positionals.length === 0 && p.command.length === 0)) {
      io.stdout(HELP);
      return help ? 0 : 2;
    }
    const [sub, ...rest] = p.positionals;
    if (sub === "compare") {
      if (rest.length !== 2) throw new UsageError("compare expects two result files: mcp-coldstart compare <base.json> <head.json>");
      if (p.command.length) throw new UsageError("compare does not launch a server; drop the -- <command>");
      if (str(p, "--baseline")) throw new UsageError("compare takes the baseline as its first argument, not --baseline");
      const gates = gateOptions(p);
      const [base, head] = await Promise.all([loadResult(rest[0]!), loadResult(rest[1]!)]);
      const report = evaluate(head, base, gates);
      io.stdout(render(p, head, report));
      return report.failed ? 1 : 0;
    }
    if (sub !== undefined && sub !== "run") throw new UsageError(`unknown command "${sub}" (put the server command after --)`);
    if (rest.length) throw new UsageError(`unexpected argument "${rest[0]}" (put the server command after --)`);
    if (p.command.length === 0) throw new UsageError("missing server command; use: mcp-coldstart -- <command> [args...]");

    const gates = gateOptions(p);
    const baselinePath = str(p, "--baseline");
    const base = baselinePath ? await loadResult(baselinePath) : null;
    const [command, ...args] = p.command;
    const opts: MeasureOptions = { command: command!, args, inheritStderr: p.flags.has("--verbose") };
    if (p.flags.has("--show-args")) opts.showArgs = true;
    const runs = numFlag(p, "--runs", { int: true, min: 1 });
    if (runs !== undefined) opts.runs = runs;
    const warmup = numFlag(p, "--warmup", { int: true, min: 0 });
    if (warmup !== undefined) opts.warmup = warmup;
    const timeout = numFlag(p, "--timeout", { min: 1 });
    if (timeout !== undefined) opts.timeoutMs = timeout;
    const grace = numFlag(p, "--shutdown-grace", { min: 1 });
    if (grace !== undefined) opts.shutdownGraceMs = grace;
    const pv = str(p, "--protocol-version");
    if (pv) opts.protocolVersion = pv;
    const cwd = str(p, "--cwd");
    if (cwd) opts.cwd = cwd;
    const total = (opts.runs ?? 5) + (opts.warmup ?? 1);
    let done = 0;
    opts.onRun = ({ warmup: w, sample }) => {
      done++;
      if (process.stderr.isTTY && outputFormat(p) === "text") {
        io.stderr(`\r\u001b[2K  run ${done}/${total}${w ? " (warmup)" : ""}: ready in ${sample.readyMs.toFixed(0)} ms`);
        if (done === total) io.stderr("\r\u001b[2K");
      }
    };
    const result = await measure(opts);
    const out = str(p, "--output");
    if (out) await writeFile(out, JSON.stringify(result, null, 2) + "\n");
    const report = base || gates.budgets ? evaluate(result, base, gates) : null;
    io.stdout(render(p, result, report));
    if (out) io.stderr(`mcp-coldstart: saved result to ${out}\n`);
    return report?.failed ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError || err instanceof RangeError) {
      io.stderr(`mcp-coldstart: ${err.message}\nRun "mcp-coldstart --help" for usage.\n`);
      return 2;
    }
    if (err instanceof UnsafeArgumentError) {
      io.stderr(`mcp-coldstart: ${err.message}\nRun "mcp-coldstart --help" for usage.\n`);
      return 2;
    }
    if (err instanceof InputError || err instanceof ServerError) {
      io.stderr(`mcp-coldstart: ${err.message}\n`);
      return 2;
    }
    io.stderr(`mcp-coldstart: ${(err as Error)?.stack ?? String(err)}\n`);
    return 2;
  }
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  // Servers run in their own process group on POSIX, so a terminal Ctrl-C does
  // not reach them: kill them ourselves.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      killAllServers();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // Watchdog: if anything (e.g. an orphaned grandchild's handle) keeps the event
    // loop alive after the report is written, exit anyway. unref() means this
    // timer never delays a normal exit.
    setTimeout(() => process.exit(code), 3000).unref();
  });
}
