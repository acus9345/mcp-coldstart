import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStats, percentile, summarize } from "../dist/index.js";

test("percentile interpolates linearly", () => {
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 0), 1);
  assert.equal(percentile([5, 1, 3, 2, 4], 100), 5);
  assert.equal(percentile([10, 20], 50), 15);
  assert.ok(Math.abs(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) - 9.55) < 1e-9);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test("summarize returns min/p50/p95/max/mean rounded to 2 decimals", () => {
  assert.deepEqual(summarize([1, 2, 3, 4]), { min: 1, p50: 2.5, p95: 3.85, max: 4, mean: 2.5 });
  assert.deepEqual(summarize([1 / 3]), { min: 0.33, p50: 0.33, p95: 0.33, max: 0.33, mean: 0.33 });
});

test("computeStats skips metrics without data (memory null)", () => {
  const s = (ready, mem) => ({ initMs: 1, toolsListMs: 1, readyMs: ready, shutdownMs: 1, forcedKill: false, memoryMb: mem, toolCount: 1, toolsListBytes: 40, approxTokens: 10, stdoutNoiseLines: 0 });
  const stats = computeStats([s(10, null), s(20, null), s(30, null)]);
  assert.equal(stats.ready.p50, 20);
  assert.equal(stats.memory, undefined);
  assert.equal(stats.tokens.max, 10);
  const withMem = computeStats([s(10, 50), s(20, null)]);
  assert.equal(withMem.memory.p50, 50);
});
