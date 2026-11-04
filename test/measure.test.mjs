import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { measure, measureOnce, ServerError, StdioClient } from "../dist/index.js";
import { DEMO, SDK_SERVER } from "./helpers.mjs";

const node = process.execPath;

test("measureOnce times a cold start and pages through tools/list", async () => {
  const { sample, server } = await measureOnce({ command: node, args: [DEMO, "--tools", "20", "--page-size", "6", "--name", "paged", "--version", "9.9.9"] });
  assert.equal(sample.toolCount, 20);
  assert.ok(sample.initMs > 0);
  assert.ok(sample.readyMs >= sample.initMs);
  assert.ok(Math.abs(sample.readyMs - (sample.initMs + sample.toolsListMs)) < 0.05);
  assert.ok(sample.toolsListBytes > 1000);
  assert.equal(sample.approxTokens, Math.ceil(sample.toolsListBytes / 4));
  assert.equal(sample.forcedKill, false);
  assert.equal(sample.stdoutNoiseLines, 0);
  assert.deepEqual(server, { name: "paged", version: "9.9.9", protocolVersion: "2025-06-18" });
  if (process.platform === "linux") assert.ok(sample.memoryMb > 5, `memory ${sample.memoryMb}`);
});

test("JSON-RPC batch lines: each response is counted with its own size, not the whole line", async () => {
  const args = [DEMO, "--tools", "12", "--page-size", "4"];
  const plain = await measureOnce({ command: node, args });
  const batched = await measureOnce({ command: node, args: [...args, "--batch"] });
  assert.equal(batched.sample.toolCount, 12);
  // 3 pages, each line carries a 4 KB notification; it must not be counted.
  assert.ok(Math.abs(batched.sample.toolsListBytes - plain.sample.toolsListBytes) <= 3 * 4, `plain ${plain.sample.toolsListBytes} batched ${batched.sample.toolsListBytes}`);
});

test("startup delay shows up in init and ready times", async () => {
  const fast = await measureOnce({ command: node, args: [DEMO] });
  const slow = await measureOnce({ command: node, args: [DEMO, "--startup-delay", "300"] });
  assert.ok(slow.sample.initMs >= fast.sample.initMs + 250, `fast ${fast.sample.initMs} slow ${slow.sample.initMs}`);
});

test("list delay shows up in tools/list time", async () => {
  const { sample } = await measureOnce({ command: node, args: [DEMO, "--list-delay", "200"] });
  assert.ok(sample.toolsListMs >= 190, `toolsList ${sample.toolsListMs}`);
});

test("memory ballast is reflected in the memory metric (Linux)", { skip: process.platform !== "linux" ? "peak memory of the tree (VmHWM) is only measured on Linux" : false }, async () => {
  const base = await measureOnce({ command: node, args: [DEMO] });
  const big = await measureOnce({ command: node, args: [DEMO, "--alloc-mb", "80"] });
  assert.ok(big.sample.memoryMb >= base.sample.memoryMb + 60, `base ${base.sample.memoryMb} big ${big.sample.memoryMb}`);
});

test("stdout noise is counted and warned about", async () => {
  const r = await measure({ command: node, args: [DEMO, "--noise"], runs: 2, warmup: 0 });
  assert.equal(r.samples[0].stdoutNoiseLines, 1);
  assert.ok(r.warnings.some((w) => /non-JSON line/.test(w)));
  assert.ok(r.warnings.some((w) => /percentiles are not meaningful/.test(w)));
});

test("a server that ignores stdin EOF is force-killed and flagged", async () => {
  const r = await measure({ command: node, args: [DEMO, "--ignore-eof"], runs: 1, warmup: 0, shutdownGraceMs: 150 });
  assert.equal(r.samples[0].forcedKill, true);
  assert.ok(r.samples[0].shutdownMs >= 140);
  assert.ok(r.warnings.some((w) => /ignored stdin EOF/.test(w)));
});

test("measure aggregates runs, discards warmups and records metadata", async () => {
  const seen = [];
  const r = await measure({ command: node, args: [DEMO], runs: 3, warmup: 2, onRun: (i) => seen.push(i.warmup) });
  assert.deepEqual(seen, [true, true, false, false, false]);
  assert.equal(r.samples.length, 3);
  assert.equal(r.runs, 3);
  assert.equal(r.warmup, 2);
  assert.equal(r.schemaVersion, 1);
  assert.deepEqual(r.command, [path.basename(node), "***"], "args are redacted by default");
  assert.equal(r.argsRedacted, true);
  assert.ok(r.stats.ready.p50 > 0);
  assert.ok(r.stats.ready.min <= r.stats.ready.p50 && r.stats.ready.p50 <= r.stats.ready.max);
  assert.deepEqual(r.warnings, []);
});

test("rejects invalid run counts", async () => {
  await assert.rejects(measure({ command: node, args: [DEMO], runs: 0 }), RangeError);
  await assert.rejects(measure({ command: node, args: [DEMO], warmup: -1 }), RangeError);
});

test("a crashing server raises ServerError with its stderr", async () => {
  await assert.rejects(measureOnce({ command: node, args: [DEMO, "--crash"] }), (err) => {
    assert.ok(err instanceof ServerError);
    assert.match(err.message, /server exited \(code 3/);
    assert.match(err.message, /simulated crash/);
    return true;
  });
});

test("a missing executable raises ServerError", async () => {
  await assert.rejects(measureOnce({ command: "definitely-not-a-real-command-xyz" }), ServerError);
});

test("a hung server times out", async () => {
  const t = Date.now();
  await assert.rejects(measureOnce({ command: node, args: [DEMO, "--list-delay", "5000"], timeoutMs: 300 }), /timed out after 300ms/);
  assert.ok(Date.now() - t < 4000);
});

test("works against a server built with the official MCP SDK", async () => {
  const { sample, server } = await measureOnce({ command: node, args: [SDK_SERVER] });
  assert.equal(sample.toolCount, 2);
  assert.equal(server.name, "sdk-fixture");
  assert.equal(server.version, "2.3.4");
  assert.equal(sample.forcedKill, false);
});

test("StdioClient answers server-initiated ping and surfaces JSON-RPC errors", async () => {
  const c = new StdioClient({ command: node, args: [DEMO] });
  try {
    await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    await assert.rejects(c.request("resources/list"), /resources\/list failed: Method not found/);
    assert.deepEqual(await c.request("ping"), {});
  } finally {
    await c.close();
  }
});
