import { readFile } from "node:fs/promises";
import { METRICS } from "./stats.js";
import type { BudgetCheck, Metric, MetricComparison, Result, StatName, Verdict } from "./types.js";

export class InputError extends Error {
  override name = "InputError";
}

export const ALL_METRICS: Metric[] = METRICS.map((m) => m.metric);
/** Metrics that fail the gate by default when they regress. */
export const DEFAULT_GATE: Metric[] = ["ready", "memory", "tokens"];

/** Accepted spellings for metric names on the command line. */
const ALIASES: Record<string, Metric> = {
  ready: "ready",
  init: "init",
  initialize: "init",
  "tools-list": "toolsList",
  toolslist: "toolsList",
  list: "toolsList",
  shutdown: "shutdown",
  memory: "memory",
  mem: "memory",
  rss: "memory",
  tokens: "tokens",
  bytes: "bytes",
};

export function parseMetric(name: string): Metric {
  const m = ALIASES[name.trim().toLowerCase()];
  if (!m) throw new InputError(`unknown metric "${name}" (use: ready, init, tools-list, shutdown, memory, tokens, bytes)`);
  return m;
}

export interface GateOptions {
  /** Statistic to compare (default p50). */
  stat?: StatName;
  /** Max allowed regression in percent before failing (default 20). */
  maxRegressionPct?: number;
  /** Metrics whose regression fails the gate (default ready, memory, tokens). */
  gate?: Metric[];
  /** Ignore time regressions smaller than this many ms (default 25). */
  minDeltaMs?: number;
  /** Ignore memory regressions smaller than this many MB (default 5). */
  minDeltaMb?: number;
  /** Absolute limits per metric, in the metric's unit (ms, MB, tokens, bytes). */
  budgets?: Partial<Record<Metric, number>>;
}

function unitOf(metric: Metric): string {
  return METRICS.find((m) => m.metric === metric)!.unit;
}

function fmt(n: number, unit: string): string {
  const v = unit === "ms" || unit === "MB" ? (Math.round(n * 10) / 10).toString() : Math.round(n).toString();
  return `${v} ${unit}`;
}

/**
 * Check a result against absolute budgets and, if given, a baseline result.
 * A metric regresses when head > base by more than `maxRegressionPct` percent
 * AND by more than the noise floor for its unit.
 */
export function evaluate(head: Result, base: Result | null, opts: GateOptions = {}): Verdict & { notes: string[] } {
  const stat = opts.stat ?? "p50";
  const maxPct = opts.maxRegressionPct ?? 20;
  const gate = new Set(opts.gate ?? DEFAULT_GATE);
  const floors: Record<string, number> = { ms: opts.minDeltaMs ?? 25, MB: opts.minDeltaMb ?? 5, tok: 0, B: 0 };
  const comparisons: MetricComparison[] = [];
  const budgets: BudgetCheck[] = [];
  const reasons: string[] = [];
  const notes: string[] = [];

  if (base) {
    for (const metric of ALL_METRICS) {
      const b = base.stats[metric]?.[stat];
      const h = head.stats[metric]?.[stat];
      if (typeof b !== "number" || typeof h !== "number") continue;
      const unit = unitOf(metric);
      const delta = h - b;
      const deltaPct = b === 0 ? (h === 0 ? 0 : null) : (delta / b) * 100;
      const overPct = deltaPct === null ? delta > 0 : deltaPct > maxPct;
      const regressed = overPct && delta > (floors[unit] ?? 0);
      const gated = gate.has(metric);
      comparisons.push({ metric, unit, base: b, head: h, delta, deltaPct, gated, regressed });
      if (regressed && gated) {
        reasons.push(`${metric} ${stat} regressed ${fmt(b, unit)} → ${fmt(h, unit)} (${deltaPct === null ? "new" : `+${deltaPct.toFixed(1)}%`}, limit ${maxPct}%)`);
      }
    }
    const be = base.environment;
    const he = head.environment;
    if (be && he && (be.platform !== he.platform || be.arch !== he.arch || be.cpus !== he.cpus || String(be.node ?? "").split(".")[0] !== String(he.node ?? "").split(".")[0])) {
      notes.push(`baseline was measured on ${be.platform}/${be.arch}, ${be.cpus} CPUs, Node ${be.node}; this run is ${he.platform}/${he.arch}, ${he.cpus} CPUs, Node ${he.node}. Timing comparisons across machines are unreliable.`);
    }
    if (base.runs < 3 || head.runs < 3) notes.push("fewer than 3 runs on one side; regression checks are noisy");
  }

  for (const [metric, limit] of Object.entries(opts.budgets ?? {}) as [Metric, number][]) {
    const actual = head.stats[metric]?.[stat];
    const unit = unitOf(metric);
    if (typeof actual !== "number") {
      notes.push(`budget for ${metric} not checked: no data (e.g. memory is not measured on this platform)`);
      continue;
    }
    const exceeded = actual > limit;
    budgets.push({ metric, unit, limit, actual, exceeded });
    if (exceeded) reasons.push(`${metric} ${stat} ${fmt(actual, unit)} exceeds budget ${fmt(limit, unit)}`);
  }
  return { stat, comparisons, budgets, failed: reasons.length > 0, reasons, notes };
}

/** Load and validate a result/baseline JSON file written by `mcp-coldstart -o`. */
export async function loadResult(path: string): Promise<Result> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new InputError(`cannot read ${path}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new InputError(`${path}: invalid JSON: ${(err as Error).message}`);
  }
  const r = data as Partial<Result>;
  if (!r || typeof r !== "object" || Array.isArray(r) || r.tool !== "mcp-coldstart" || r.schemaVersion !== 1) {
    throw new InputError(`${path}: not an mcp-coldstart result (expected a file written with "mcp-coldstart -o <file>")`);
  }
  const problems = validateResult(r as Record<string, unknown>);
  if (problems.length) throw new InputError(`${path}: malformed mcp-coldstart result: ${problems.slice(0, 5).join("; ")}`);
  return r as Result;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Structural checks for every field the comparison and the formatters read. */
function validateResult(r: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (!Array.isArray(r.command) || !r.command.every((c) => typeof c === "string")) out.push("command must be an array of strings");
  if (!isNum(r.runs) || r.runs < 1) out.push("runs must be a positive number");
  if (!isNum(r.warmup) || r.warmup < 0) out.push("warmup must be a non-negative number");
  const env = r.environment;
  if (!isObj(env)) out.push("environment must be an object");
  else {
    for (const k of ["platform", "arch", "node"]) if (typeof env[k] !== "string") out.push(`environment.${k} must be a string`);
    if (!isNum(env.cpus)) out.push("environment.cpus must be a number");
  }
  if (r.server !== undefined && !isObj(r.server)) out.push("server must be an object");
  if (!Array.isArray(r.samples) || !r.samples.every(isObj)) out.push("samples must be an array of objects");
  if (!Array.isArray(r.warnings) || !r.warnings.every((w) => typeof w === "string")) out.push("warnings must be an array of strings");
  if (!isObj(r.stats)) out.push("stats must be an object");
  else {
    for (const [metric, st] of Object.entries(r.stats)) {
      if (st === null || st === undefined) continue;
      if (!isObj(st)) {
        out.push(`stats.${metric} must be an object`);
        continue;
      }
      for (const k of ["min", "p50", "p95", "max", "mean"]) if (!isNum(st[k])) out.push(`stats.${metric}.${k} must be a number`);
    }
  }
  return out;
}
