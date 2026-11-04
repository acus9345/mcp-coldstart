import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evaluate, InputError, loadResult, parseMetric } from "../dist/index.js";
import { fakeResult, tmp } from "./helpers.mjs";

test("no baseline and no budgets: nothing fails", () => {
  const r = evaluate(fakeResult({ ready: 100 }), null);
  assert.equal(r.failed, false);
  assert.deepEqual(r.comparisons, []);
});

test("regression above threshold and noise floor fails the gate", () => {
  const r = evaluate(fakeResult({ ready: 200, init: 150 }), fakeResult({ ready: 100, init: 100 }));
  const ready = r.comparisons.find((c) => c.metric === "ready");
  assert.equal(ready.regressed, true);
  assert.equal(ready.gated, true);
  assert.equal(ready.deltaPct, 100);
  assert.equal(r.failed, true);
  assert.match(r.reasons[0], /ready p50 regressed 100 ms → 200 ms \(\+100\.0%, limit 20%\)/);
  // init regressed too but is not gated by default
  const init = r.comparisons.find((c) => c.metric === "init");
  assert.equal(init.regressed, true);
  assert.equal(init.gated, false);
  assert.equal(r.reasons.length, 1);
});

test("small absolute time deltas are ignored as noise even if the percentage is large", () => {
  const r = evaluate(fakeResult({ ready: 30 }), fakeResult({ ready: 10 }));
  assert.equal(r.comparisons[0].regressed, false);
  assert.equal(r.failed, false);
  const strict = evaluate(fakeResult({ ready: 30 }), fakeResult({ ready: 10 }), { minDeltaMs: 0 });
  assert.equal(strict.failed, true);
});

test("memory uses an MB noise floor; tokens have none", () => {
  assert.equal(evaluate(fakeResult({ memory: 13 }), fakeResult({ memory: 10 })).failed, false);
  assert.equal(evaluate(fakeResult({ memory: 40 }), fakeResult({ memory: 20 })).failed, true);
  assert.equal(evaluate(fakeResult({ tokens: 1300 }), fakeResult({ tokens: 1000 })).failed, true);
  assert.equal(evaluate(fakeResult({ tokens: 1100 }), fakeResult({ tokens: 1000 })).failed, false);
});

test("--max-regression, --gate and --stat are honoured", () => {
  const head = fakeResult({ ready: 140, shutdown: 400 });
  const base = fakeResult({ ready: 100, shutdown: 100 });
  assert.equal(evaluate(head, base).failed, true);
  assert.equal(evaluate(head, base, { maxRegressionPct: 50 }).failed, false);
  assert.equal(evaluate(head, base, { maxRegressionPct: 50, gate: ["shutdown"] }).failed, true);
  const h2 = fakeResult({ ready: 100 });
  h2.stats.ready.p95 = 500;
  assert.equal(evaluate(h2, fakeResult({ ready: 100 })).failed, false);
  assert.equal(evaluate(h2, fakeResult({ ready: 100 }), { stat: "p95" }).failed, true);
});

test("improvements never fail", () => {
  const r = evaluate(fakeResult({ ready: 50, memory: 10 }), fakeResult({ ready: 500, memory: 100 }));
  assert.equal(r.failed, false);
  assert.ok(r.comparisons.every((c) => c.delta < 0 && !c.regressed));
});

test("zero baseline yields deltaPct null and counts any growth", () => {
  const r = evaluate(fakeResult({ tokens: 10 }), fakeResult({ tokens: 0 }));
  assert.equal(r.comparisons[0].deltaPct, null);
  assert.equal(r.failed, true);
  assert.match(r.reasons[0], /\(new, limit 20%\)/);
});

test("budgets fail when exceeded and note missing data", () => {
  const head = fakeResult({ ready: 900, tokens: 5000 });
  const r = evaluate(head, null, { budgets: { ready: 1000, tokens: 4000, memory: 100 } });
  assert.equal(r.failed, true);
  assert.deepEqual(
    r.budgets.map((b) => [b.metric, b.exceeded]),
    [
      ["ready", false],
      ["tokens", true],
    ],
  );
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /tokens p50 5000 tok exceeds budget 4000 tok/);
  assert.ok(r.notes.some((n) => /budget for memory not checked/.test(n)));
});

test("baseline from a different machine produces a note, not a failure", () => {
  const base = fakeResult({ ready: 100 }, { environment: { platform: "darwin", arch: "arm64", node: "v22.1.0", cpus: 10 } });
  const r = evaluate(fakeResult({ ready: 100 }), base);
  assert.equal(r.failed, false);
  assert.ok(r.notes.some((n) => /unreliable/.test(n)));
});

test("parseMetric accepts aliases and rejects unknown names", () => {
  assert.equal(parseMetric("tools-list"), "toolsList");
  assert.equal(parseMetric("RSS"), "memory");
  assert.equal(parseMetric("initialize"), "init");
  assert.throws(() => parseMetric("latency"), InputError);
});

test("loadResult validates the file", async () => {
  const dir = tmp();
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify(fakeResult({ ready: 1 })));
  assert.equal((await loadResult(good)).tool, "mcp-coldstart");
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ tools: [] }));
  await assert.rejects(loadResult(bad), /not an mcp-coldstart result/);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{nope");
  await assert.rejects(loadResult(broken), /invalid JSON/);
  await assert.rejects(loadResult(join(dir, "missing.json")), /cannot read/);
});
