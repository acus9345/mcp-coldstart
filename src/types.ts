/** One cold start of the server. Times are milliseconds. */
export interface Sample {
  /** spawn -> `initialize` response received. */
  initMs: number;
  /** `initialize` response -> last `tools/list` page received (includes `notifications/initialized`). */
  toolsListMs: number;
  /** spawn -> tools known: what a client waits for before the server is usable. */
  readyMs: number;
  /** stdin closed -> process exited. */
  shutdownMs: number;
  /** True if the server ignored stdin EOF and needed SIGTERM/SIGKILL. */
  forcedKill: boolean;
  /** POSIX: processes the server started were still running after it exited and had to be terminated. */
  leftoverProcesses?: boolean;
  /** Process-tree memory in MB (see `memoryMethod`), or null if not measurable. */
  memoryMb: number | null;
  toolCount: number;
  /** Total bytes of all `tools/list` response lines. */
  toolsListBytes: number;
  /** Rough token estimate of the tool definitions (bytes / 4). */
  approxTokens: number;
  /** Non-JSON lines the server wrote to stdout (stdio transport violation). */
  stdoutNoiseLines: number;
}

export interface Stat {
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export type Metric = "ready" | "init" | "toolsList" | "shutdown" | "memory" | "tokens" | "bytes";

export interface ServerMeta {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

/** A complete measurement; also the baseline file format. */
export interface Result {
  schemaVersion: 1;
  tool: "mcp-coldstart";
  toolVersion: string;
  createdAt: string;
  /** Server command line. Arguments are replaced with "***" unless recorded with --show-args. */
  command: string[];
  /** True when arguments were redacted from `command`. */
  argsRedacted?: boolean;
  runs: number;
  warmup: number;
  environment: { platform: string; arch: string; node: string; cpus: number; cpuModel?: string };
  memoryMethod: string;
  server: ServerMeta;
  stats: Partial<Record<Metric, Stat>>;
  samples: Sample[];
  warnings: string[];
}

export type StatName = "p50" | "p95" | "mean" | "min" | "max";

export interface MetricComparison {
  metric: Metric;
  unit: string;
  base: number;
  head: number;
  delta: number;
  deltaPct: number | null;
  gated: boolean;
  regressed: boolean;
}

export interface BudgetCheck {
  metric: Metric;
  unit: string;
  limit: number;
  actual: number;
  exceeded: boolean;
}

export interface Verdict {
  stat: StatName;
  comparisons: MetricComparison[];
  budgets: BudgetCheck[];
  failed: boolean;
  reasons: string[];
}
