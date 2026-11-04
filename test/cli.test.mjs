import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cli, DEMO, fakeResult, tmp } from "./helpers.mjs";

const node = process.execPath;
const fast = ["--", node, DEMO];
const slow = ["--", node, DEMO, "--startup-delay", "400"];

test("--help exits 0, --version prints the version, no args exits 2", async () => {
  const h = await cli(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Usage:/);
  const v = await cli(["--version"]);
  assert.equal(v.code, 0);
  assert.equal(v.stdout.trim(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  const none = await cli([]);
  assert.equal(none.code, 2);
});

test("usage errors exit 2", async () => {
  for (const args of [
    ["--bogus", ...fast],
    ["run"],
    ["frobnicate", ...fast],
    ["-n", "0", ...fast],
    ["-n", "abc", ...fast],
    ["--budget", "ready", ...fast],
    ["--budget", "latency=5", ...fast],
    ["--stat", "p99", ...fast],
    ["--format", "xml", ...fast],
    ["compare", "only-one.json"],
    ["--gate", "", ...fast],
    ["--gate", " , ", ...fast],
  ]) {
    const r = await cli(args);
    assert.equal(r.code, 2, `${args.join(" ")} -> ${r.code}\n${r.stderr}`);
    assert.match(r.stderr, /mcp-coldstart:/);
  }
});

test("run prints a text report and exits 0", async () => {
  const r = await cli(["-n", "2", "--warmup", "0", ...fast]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mcp-coldstart — demo-server 1\.0\.0/);
  assert.match(r.stdout, /ready \(spawn → tools listed\)/);
  assert.doesNotMatch(r.stdout, /PASS|FAIL/);
});

test("'run' keyword is optional and --json output is a valid baseline", async () => {
  const dir = tmp();
  const r = await cli(["run", "-n", "2", "--warmup", "0", "--json", ...fast]);
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.tool, "mcp-coldstart");
  assert.equal(parsed.samples.length, 2);
  writeFileSync(join(dir, "b.json"), r.stdout);
  const again = await cli(["-n", "2", "--warmup", "0", "--baseline", join(dir, "b.json"), "--max-regression", "1000", ...fast]);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /Baseline comparison/);
});

test("server failure exits 2 and shows server stderr", async () => {
  const r = await cli(["-n", "1", "--warmup", "0", "--", node, DEMO, "--crash"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /simulated crash/);
});

test("exceeded budget exits 1; generous budget exits 0", async () => {
  const over = await cli(["-n", "1", "--warmup", "0", "--budget", "ready=1", ...fast]);
  assert.equal(over.code, 1, over.stdout);
  assert.match(over.stdout, /over budget/);
  assert.match(over.stdout, /^FAIL$/m);
  const ok = await cli(["-n", "1", "--warmup", "0", "--budget", "ready=20000", "--budget", "tokens=100000", ...fast]);
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /^PASS$/m);
});

test("end to end: baseline from fast server, slow server regresses (exit 1), compare works both ways", async () => {
  const dir = tmp();
  const base = join(dir, "base.json");
  const head = join(dir, "head.json");
  const b = await cli(["-n", "3", "--warmup", "1", "-o", base, ...fast]);
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stderr, /saved result to/);
  const regressed = await cli(["-n", "3", "--warmup", "0", "--baseline", base, "-o", head, ...slow]);
  assert.equal(regressed.code, 1, regressed.stdout + regressed.stderr);
  assert.match(regressed.stdout, /ready p50 regressed/);
  assert.ok(JSON.parse(readFileSync(head, "utf8")).stats.ready.p50 > 300);

  const cmpFail = await cli(["compare", base, head]);
  assert.equal(cmpFail.code, 1);
  const cmpMd = await cli(["compare", base, head, "--markdown"]);
  assert.equal(cmpMd.code, 1);
  assert.match(cmpMd.stdout, /Performance gate failed/);
  const cmpOk = await cli(["compare", head, base]);
  assert.equal(cmpOk.code, 0, cmpOk.stdout);
  assert.match(cmpOk.stdout, /improved/);
  const notGated = await cli(["compare", base, head, "--gate", "tokens"]);
  assert.equal(notGated.code, 0, notGated.stdout);
  const relaxed = await cli(["compare", base, head, "--max-regression", "100000"]);
  assert.equal(relaxed.code, 0);
});

test("compare rejects non-result files with exit 2", async () => {
  const dir = tmp();
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify(fakeResult({ ready: 10 })));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "[]");
  const r = await cli(["compare", good, bad]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not an mcp-coldstart result/);
  const missing = await cli(["--baseline", join(dir, "nope.json"), ...fast]);
  assert.equal(missing.code, 2);
});

test("malformed baselines are a clean error with exit 2, never a stack trace", async () => {
  const dir = tmp();
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify(fakeResult({ ready: 10 })));
  const cases = {
    "no-env-node": (() => { const r = fakeResult({ ready: 10 }); delete r.environment.node; return r; })(),
    "no-environment": (() => { const r = fakeResult({ ready: 10 }); delete r.environment; return r; })(),
    "stats-wrong-type": fakeResult({ ready: 10 }, { stats: { ready: { p50: "fast" } } }),
    "stats-null": fakeResult({ ready: 10 }, { stats: null }),
    "samples-missing": fakeResult({ ready: 10 }, { samples: undefined }),
    "command-string": fakeResult({ ready: 10 }, { command: "node server.js" }),
    "runs-string": fakeResult({ ready: 10 }, { runs: "5" }),
  };
  for (const [name, data] of Object.entries(cases)) {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(data));
    for (const args of [["compare", file, good], ["compare", good, file], ["--baseline", file, ...fast]]) {
      const r = await cli(args);
      assert.equal(r.code, 2, `${name}: ${args.join(" ")} -> ${r.code}\n${r.stderr}`);
      assert.match(r.stderr, /malformed mcp-coldstart result|not an mcp-coldstart result/, name);
      assert.doesNotMatch(r.stderr, /TypeError|\n\s+at /, `${name}: stack trace\n${r.stderr}`);
    }
  }
  const notJson = join(dir, "not.json");
  writeFileSync(notJson, "{ nope");
  const r = await cli(["compare", notJson, good]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /invalid JSON/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("markdown output for a run", async () => {
  const r = await cli(["-n", "1", "--warmup", "0", "--md", ...fast]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^## MCP server cold start/);
  assert.match(r.stdout, /\| ready \(spawn → tools listed\) \|/);
});
