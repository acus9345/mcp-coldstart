import { cpus } from "node:os";
import { DEFAULT_PROTOCOL_VERSION, ServerError, StdioClient, type LaunchOptions } from "./client.js";
import { MEMORY_METHOD, treeMemoryMb } from "./memory.js";
import { redactCommand } from "./redact.js";
import { computeStats } from "./stats.js";
import type { Result, Sample, ServerMeta } from "./types.js";
import { VERSION } from "./version.js";

export interface MeasureOptions extends LaunchOptions {
  /** Measured cold starts (default 5). */
  runs?: number;
  /** Discarded cold starts before measuring, to warm OS/disk caches (default 1). */
  warmup?: number;
  /** Per-run timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Grace period before signalling a server that ignores stdin EOF (default 2000). */
  shutdownGraceMs?: number;
  protocolVersion?: string;
  /** Called after each run (warmups have `warmup: true`). */
  onRun?: (info: { index: number; warmup: boolean; sample: Sample }) => void;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string, stderr: () => string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ServerError(`timed out after ${ms}ms waiting for ${what}`, stderr())), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Perform one cold start: spawn, initialize, list all tools, measure, shut down. */
export async function measureOnce(opts: MeasureOptions): Promise<{ sample: Sample; server: ServerMeta }> {
  const t0 = performance.now();
  const client = new StdioClient(opts);
  const timeout = opts.timeoutMs ?? 30000;
  let closed = false;
  try {
    const { initAt, listAt, bytes, toolCount, server } = await withTimeout(
      (async () => {
        const init = await client.request<{ protocolVersion?: string; serverInfo?: { name?: string; version?: string } }>("initialize", {
          protocolVersion: opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "mcp-coldstart", version: VERSION },
        });
        const initAt = performance.now();
        client.notify("notifications/initialized");
        let bytes = 0;
        let toolCount = 0;
        let cursor: string | undefined;
        for (let page = 0; page < 1000; page++) {
          const { result, bytes: b } = await client.requestSized<{ tools?: unknown[]; nextCursor?: string }>("tools/list", cursor ? { cursor } : {});
          if (!result || !Array.isArray(result.tools)) throw new ServerError("tools/list returned no tools array", client.stderr);
          bytes += b;
          toolCount += result.tools.length;
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
        const listAt = performance.now();
        const server: ServerMeta = {};
        if (init?.serverInfo?.name) server.name = init.serverInfo.name;
        if (init?.serverInfo?.version) server.version = init.serverInfo.version;
        if (init?.protocolVersion) server.protocolVersion = init.protocolVersion;
        return { initAt, listAt, bytes, toolCount, server };
      })(),
      timeout,
      "initialize + tools/list",
      () => client.stderr,
    );
    const memoryMb = treeMemoryMb(client.pid);
    const close = await client.close(opts.shutdownGraceMs ?? 2000);
    closed = true;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const sample: Sample = {
      initMs: r2(initAt - t0),
      toolsListMs: r2(listAt - initAt),
      readyMs: r2(listAt - t0),
      shutdownMs: r2(close.ms),
      forcedKill: close.forced,
      ...(close.leftovers ? { leftoverProcesses: true } : {}),
      memoryMb: memoryMb === null ? null : r2(memoryMb),
      toolCount,
      toolsListBytes: bytes,
      approxTokens: Math.ceil(bytes / 4),
      stdoutNoiseLines: client.stdoutNoise,
    };
    return { sample, server };
  } finally {
    if (!closed) await client.close(200);
  }
}

/** Run warmups + measured cold starts and aggregate them into a {@link Result}. */
export async function measure(opts: MeasureOptions): Promise<Result> {
  const runs = opts.runs ?? 5;
  const warmup = opts.warmup ?? 1;
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError("runs must be a positive integer");
  if (!Number.isInteger(warmup) || warmup < 0) throw new RangeError("warmup must be a non-negative integer");
  const samples: Sample[] = [];
  let server: ServerMeta = {};
  for (let i = 0; i < warmup + runs; i++) {
    const isWarmup = i < warmup;
    const r = await measureOnce(opts);
    server = r.server;
    if (!isWarmup) samples.push(r.sample);
    opts.onRun?.({ index: isWarmup ? i : i - warmup, warmup: isWarmup, sample: r.sample });
  }
  const warnings: string[] = [];
  const noisy = Math.max(...samples.map((s) => s.stdoutNoiseLines));
  if (noisy > 0) warnings.push(`server wrote ${noisy} non-JSON line(s) to stdout; the stdio transport reserves stdout for JSON-RPC (log to stderr instead)`);
  const forced = samples.filter((s) => s.forcedKill).length;
  const leftover = samples.filter((s) => s.leftoverProcesses).length;
  if (leftover > 0) warnings.push(`server left child processes running after it exited in ${leftover}/${samples.length} run(s); they were terminated (SIGTERM, then SIGKILL after the shutdown grace)`);
  if (forced > 0) warnings.push(`server ignored stdin EOF in ${forced}/${samples.length} run(s) and had to be signalled; exit when stdin closes`);
  const counts = new Set(samples.map((s) => s.toolCount));
  if (counts.size > 1) warnings.push(`tool count varied between runs (${[...counts].join(", ")}); tools/list is not deterministic`);
  if (runs < 3) warnings.push(`only ${runs} run(s); percentiles are not meaningful below 3 (5+ recommended)`);
  const cpu = cpus();
  const environment: Result["environment"] = { platform: process.platform, arch: process.arch, node: process.version, cpus: cpu.length };
  if (cpu[0]?.model) environment.cpuModel = cpu[0].model.trim();
  return {
    schemaVersion: 1,
    tool: "mcp-coldstart",
    toolVersion: VERSION,
    createdAt: new Date().toISOString(),
    ...(() => {
      const r = redactCommand(opts.command, opts.args ?? [], opts.showArgs);
      return { command: r.command, argsRedacted: r.redacted };
    })(),
    runs,
    warmup,
    environment,
    memoryMethod: MEMORY_METHOD,
    server,
    stats: computeStats(samples),
    samples,
    warnings,
  };
}
