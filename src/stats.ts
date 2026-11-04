import type { Metric, Sample, Stat } from "./types.js";

/** Linear-interpolated percentile (p in [0, 100]) of an unsorted list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const rank = (p / 100) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return s[lo]! + (s[hi]! - s[lo]!) * (rank - lo);
}

export function summarize(values: number[]): Stat {
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    min: round(Math.min(...values)),
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    max: round(Math.max(...values)),
    mean: round(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

export const METRICS: { metric: Metric; unit: string; label: string; pick: (s: Sample) => number | null }[] = [
  { metric: "ready", unit: "ms", label: "ready (spawn → tools listed)", pick: (s) => s.readyMs },
  { metric: "init", unit: "ms", label: "initialize", pick: (s) => s.initMs },
  { metric: "toolsList", unit: "ms", label: "tools/list", pick: (s) => s.toolsListMs },
  { metric: "shutdown", unit: "ms", label: "shutdown", pick: (s) => s.shutdownMs },
  { metric: "memory", unit: "MB", label: "memory", pick: (s) => s.memoryMb },
  { metric: "tokens", unit: "tok", label: "tool tokens (≈)", pick: (s) => s.approxTokens },
  { metric: "bytes", unit: "B", label: "tools/list bytes", pick: (s) => s.toolsListBytes },
];

export function computeStats(samples: Sample[]): Partial<Record<Metric, Stat>> {
  const out: Partial<Record<Metric, Stat>> = {};
  for (const m of METRICS) {
    const vals = samples.map(m.pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (vals.length) out[m.metric] = summarize(vals);
  }
  return out;
}
