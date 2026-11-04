import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CLI = join(ROOT, "dist", "cli.js");
export const DEMO = join(ROOT, "examples", "demo-server.mjs");
export const SDK_SERVER = join(ROOT, "test", "fixtures", "sdk-server.mjs");

export function tmp() {
  return mkdtempSync(join(tmpdir(), "mcp-coldstart-test-"));
}

/** Run the built CLI; resolves with { code, stdout, stderr }. */
export function cli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? ROOT, env: { ...process.env, NO_COLOR: "1", ...opts.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A minimal fake Result for unit tests. */
export function fakeResult(stats, extra = {}) {
  const full = {};
  for (const [k, v] of Object.entries(stats)) full[k] = { min: v, p50: v, p95: v, max: v, mean: v };
  return {
    schemaVersion: 1,
    tool: "mcp-coldstart",
    toolVersion: "0.0.0",
    createdAt: new Date(0).toISOString(),
    command: ["node", "server.js"],
    runs: 5,
    warmup: 1,
    environment: { platform: "linux", arch: "x64", node: "v20.0.0", cpus: 4 },
    memoryMethod: "test",
    server: { name: "fake", version: "1.0.0" },
    stats: full,
    samples: [{ initMs: 1, toolsListMs: 1, readyMs: 2, shutdownMs: 1, forcedKill: false, memoryMb: 10, toolCount: 3, toolsListBytes: 100, approxTokens: 25, stdoutNoiseLines: 0 }],
    warnings: [],
    ...extra,
  };
}
