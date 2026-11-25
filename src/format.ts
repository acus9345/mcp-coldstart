import { METRICS } from "./stats.js";
import type { Metric, Result, Verdict } from "./types.js";

export type Report = Verdict & { notes: string[] };

export interface FormatOptions {
  color?: boolean;
}

// Strip control characters so server-provided strings cannot inject terminal escapes.
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

const ANSI = { red: 31, yellow: 33, green: 32, cyan: 36, gray: 90, bold: 1 } as const;
type Style = keyof typeof ANSI;
function painter(on: boolean) {
  return (style: Style, s: string) => (on ? `\u001b[${ANSI[style]}m${s}\u001b[0m` : s);
}

function num(n: number | undefined, unit: string): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const v = unit === "ms" || unit === "MB" ? n.toFixed(1) : Math.round(n).toString();
  return `${v} ${unit}`;
}

function pct(p: number | null): string {
  if (p === null) return "new";
  const s = p.toFixed(1);
  return p > 0 ? `+${s}%` : `${s}%`;
}

function serverLine(r: Result): string {
  const s = r.server ?? {};
  const sName = typeof s.name === "string" && s.name ? s.name : "";
  const sVer = typeof s.version === "string" && s.version ? s.version : "";
  const sProto = typeof s.protocolVersion === "string" && s.protocolVersion ? s.protocolVersion : "";
  const name = sName ? `${sName}${sVer ? ` ${sVer}` : ""}` : "MCP server";
  return clean(`${name}${sProto ? ` (protocol ${sProto})` : ""}`);
}

function pad(s: string, n: number, right = false): string {
  // pad by visible length (no ANSI in inputs here)
  return right ? s.padStart(n) : s.padEnd(n);
}

/** Human-readable report for terminals. */
export function formatText(result: Result, report: Report | null, opts: FormatOptions = {}): string {
  const p = painter(opts.color ?? false);
  const L: string[] = [];
  const toolCount = result.samples[0]?.toolCount ?? 0;
  L.push(p("bold", `mcp-coldstart — ${serverLine(result)}`));
  L.push(p("gray", `command: ${clean(result.command.join(" "))}${result.argsRedacted ? " (arguments hidden; use --show-args to record them)" : ""}`));
  L.push(p("gray", `runs: ${result.runs} (+${result.warmup} warmup) · tools: ${toolCount} · ${result.environment.platform}/${result.environment.arch} · Node ${result.environment.node}`));
  L.push("");
  const w = 30;
  L.push(p("bold", `${pad("metric", w)}${pad("p50", 11, true)}${pad("p95", 11, true)}${pad("min", 11, true)}${pad("max", 11, true)}`));
  for (const m of METRICS) {
    const s = result.stats[m.metric];
    if (!s) continue;
    L.push(`${pad(m.label, w)}${pad(num(s.p50, m.unit), 11, true)}${pad(num(s.p95, m.unit), 11, true)}${pad(num(s.min, m.unit), 11, true)}${pad(num(s.max, m.unit), 11, true)}`);
  }
  if (result.warnings.length) {
    L.push("", p("yellow", p("bold", "Warnings")));
    for (const w of result.warnings) L.push(`  ${p("yellow", "!")} ${clean(w)}`);
  }
  if (report) {
    if (report.comparisons.length) {
      L.push("", p("bold", `Baseline comparison (${report.stat})`));
      for (const c of report.comparisons) {
        const label = METRICS.find((m) => m.metric === c.metric)!.label;
        const mark = c.regressed ? (c.gated ? p("red", "✖ regressed") : p("yellow", "▲ regressed (not gated)")) : c.delta < 0 ? p("green", "▼ improved") : p("gray", "ok");
        L.push(`  ${pad(label, w - 2)}${pad(num(c.base, c.unit), 11, true)} → ${pad(num(c.head, c.unit), 11)} ${pad(pct(c.deltaPct), 8, true)}  ${mark}`);
      }
    }
    if (report.budgets.length) {
      L.push("", p("bold", `Budgets (${report.stat})`));
      for (const b of report.budgets) {
        const label = METRICS.find((m) => m.metric === b.metric)!.label;
        L.push(`  ${pad(label, w - 2)}${pad(num(b.actual, b.unit), 11, true)} ≤ ${pad(num(b.limit, b.unit), 11)} ${b.exceeded ? p("red", "✖ over budget") : p("green", "✔")}`);
      }
    }
    for (const n of report.notes) L.push(`  ${p("gray", `note: ${clean(n)}`)}`);
    if (report.comparisons.length || report.budgets.length) {
      L.push("");
      if (report.failed) {
        L.push(p("red", p("bold", "FAIL")));
        for (const r of report.reasons) L.push(`  ${p("red", "✖")} ${r}`);
      } else {
        L.push(p("green", p("bold", "PASS")));
      }
    }
  }
  return L.join("\n") + "\n";
}

/** JSON report. The output is itself a valid baseline file. */
export function formatJson(result: Result, report: Report | null): string {
  return JSON.stringify(report ? { ...result, verdict: report } : result, null, 2) + "\n";
}

function md(s: string): string {
  return clean(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\`*_[\]|~#!])/g, "\\$1");
}

/** Markdown report for PR comments / GitHub job summaries. */
export function formatMarkdown(result: Result, report: Report | null): string {
  const L: string[] = ["## MCP server cold start", ""];
  const toolCount = result.samples[0]?.toolCount ?? 0;
  if (report && (report.comparisons.length || report.budgets.length)) {
    L.push(report.failed ? "🔴 **Performance gate failed.**" : "🟢 **Performance gate passed.**", "");
    for (const r of report.reasons) L.push(`- ${md(r)}`);
    if (report.reasons.length) L.push("");
  }
  L.push(`**${md(serverLine(result))}** · ${toolCount} tools · ${result.runs} runs (+${result.warmup} warmup) · ${md(`${result.environment.platform}/${result.environment.arch}, Node ${result.environment.node}`)}`, "");
  const byMetric = new Map<Metric, Report["comparisons"][number]>((report?.comparisons ?? []).map((c) => [c.metric, c]));
  const hasBase = byMetric.size > 0;
  L.push(hasBase ? `| Metric | p50 | p95 | Baseline (${report!.stat}) | Δ |` : "| Metric | p50 | p95 | min | max |");
  L.push(hasBase ? "| --- | ---: | ---: | ---: | ---: |" : "| --- | ---: | ---: | ---: | ---: |");
  for (const m of METRICS) {
    const s = result.stats[m.metric];
    if (!s) continue;
    if (hasBase) {
      const c = byMetric.get(m.metric);
      const delta = c ? `${pct(c.deltaPct)}${c.regressed ? (c.gated ? " 🔴" : " 🟡") : ""}` : "—";
      L.push(`| ${md(m.label)} | ${num(s.p50, m.unit)} | ${num(s.p95, m.unit)} | ${c ? num(c.base, m.unit) : "—"} | ${delta} |`);
    } else {
      L.push(`| ${md(m.label)} | ${num(s.p50, m.unit)} | ${num(s.p95, m.unit)} | ${num(s.min, m.unit)} | ${num(s.max, m.unit)} |`);
    }
  }
  L.push("");
  if (report?.budgets.length) {
    L.push("| Budget | Actual | Limit | |", "| --- | ---: | ---: | --- |");
    for (const b of report.budgets) L.push(`| ${b.metric} | ${num(b.actual, b.unit)} | ${num(b.limit, b.unit)} | ${b.exceeded ? "🔴 over" : "🟢 ok"} |`);
    L.push("");
  }
  const notes = [...result.warnings, ...(report?.notes ?? [])];
  if (notes.length) {
    L.push("**Notes**", "");
    for (const n of notes) L.push(`- ⚠️ ${md(n)}`);
    L.push("");
  }
  L.push("<sub>Generated by mcp-coldstart</sub>", "");
  return L.join("\n");
}
