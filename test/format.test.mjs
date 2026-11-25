import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, formatJson, formatMarkdown, formatText } from "../dist/index.js";
import { fakeResult } from "./helpers.mjs";

test("text report lists metrics, warnings, comparison and verdict", () => {
  const head = fakeResult({ ready: 300, tokens: 25 }, { warnings: ["server wrote 1 non-JSON line(s) to stdout"] });
  const report = evaluate(head, fakeResult({ ready: 100, tokens: 25 }), { budgets: { ready: 1000 } });
  const out = formatText(head, report);
  assert.match(out, /mcp-coldstart — fake 1\.0\.0/);
  assert.match(out, /ready \(spawn → tools listed\)\s+300\.0 ms/);
  assert.match(out, /Warnings/);
  assert.match(out, /✖ regressed/);
  assert.match(out, /Budgets \(p50\)/);
  assert.match(out, /^FAIL$/m);
  assert.doesNotMatch(out, /\u001b\[/, "no ANSI codes unless color is requested");
  assert.match(formatText(head, report, { color: true }), /\u001b\[31m/);
});

test("text report says PASS when gates pass and omits verdict when there are no gates", () => {
  const head = fakeResult({ ready: 100 });
  assert.match(formatText(head, evaluate(head, fakeResult({ ready: 100 }))), /^PASS$/m);
  assert.doesNotMatch(formatText(head, null), /PASS|FAIL/);
});

test("server-controlled strings cannot inject terminal escapes", () => {
  const head = fakeResult({ ready: 100 }, { server: { name: "evil\u001b[2Jname", version: "1" } });
  assert.doesNotMatch(formatText(head, null), /\u001b\[2J/);
});

test("markdown report escapes server-controlled text and shows deltas", () => {
  const head = fakeResult({ ready: 300 }, { server: { name: "<img src=x onerror=alert(1)>|`x`", version: "1" } });
  const md = formatMarkdown(head, evaluate(head, fakeResult({ ready: 100 })));
  assert.match(md, /^## MCP server cold start/);
  assert.match(md, /🔴 \*\*Performance gate failed\.\*\*/);
  assert.match(md, /\+200\.0% 🔴/);
  assert.doesNotMatch(md, /<img/);
  assert.match(md, /&lt;img/);
  assert.match(formatMarkdown(head, null), /\| Metric \| p50 \| p95 \| min \| max \|/);
});

test("JSON output round-trips and embeds the verdict", () => {
  const head = fakeResult({ ready: 100 });
  const parsed = JSON.parse(formatJson(head, evaluate(head, null, { budgets: { ready: 50 } })));
  assert.equal(parsed.tool, "mcp-coldstart");
  assert.equal(parsed.verdict.failed, true);
  assert.equal(JSON.parse(formatJson(head, null)).verdict, undefined);
});

test("formatText and formatMarkdown handle missing or malformed server metadata defensively", () => {
  const missing = fakeResult({ ready: 100 }, { server: undefined });
  assert.match(formatText(missing, null), /MCP server/);
  assert.match(formatMarkdown(missing, null), /\*\*MCP server\*\*/);
});
