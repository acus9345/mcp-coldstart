import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { executableName, makeScrubber, redactCommand } from "../dist/index.js";
import { cli, DEMO, tmp } from "./helpers.mjs";

test("executableName strips POSIX and Windows directories", () => {
  assert.equal(executableName("/home/alice/.nvm/versions/node/v20/bin/node"), "node");
  assert.equal(executableName("C:\\Program Files\\nodejs\\node.exe"), "node.exe");
  assert.equal(executableName("npx"), "npx");
});

test("redactCommand keeps only the executable and package name by default", () => {
  const r = (cmd, args, show) => redactCommand(cmd, args, show).command;
  assert.deepEqual(r("node", ["dist/server.js", "--api-key", "sk-live-123"]), ["node", "***"]);
  assert.deepEqual(r("/usr/bin/python3", ["server.py"]), ["python3", "***"]);
  assert.deepEqual(r("node", []), ["node"]);
  assert.deepEqual(r("npx", ["-y", "@modelcontextprotocol/server-everything"]), ["npx", "@modelcontextprotocol/server-everything", "***"]);
  assert.deepEqual(r("npx", ["@scope/pkg@1.2.3"]), ["npx", "@scope/pkg@1.2.3"]);
  assert.deepEqual(r("npx.cmd", ["-y", "mcp-remote", "https://x.example/mcp", "--header", "Authorization: Bearer sk-abc"]), ["npx.cmd", "mcp-remote", "***"]);
  assert.deepEqual(r("uvx", ["mcp-server-fetch==0.6.2", "--token", "t0k"]), ["uvx", "mcp-server-fetch==0.6.2", "***"]);
  assert.deepEqual(r("pnpm", ["dlx", "some-server", "KEY"]), ["pnpm", "dlx", "some-server", "***"]);
  assert.deepEqual(r("pnpm", ["start", "KEY"]), ["pnpm", "***"], "not the dlx form: nothing kept");
  // The first positional of a runner is kept only if it looks like a package name.
  assert.deepEqual(r("npx", ["-y", "https://user:pass@host/pkg.tgz"]), ["npx", "***"]);
  assert.deepEqual(r("npx", ["--api-key=sk-123"]), ["npx", "***"]);
  assert.deepEqual(r("docker", ["run", "-i", "-e", "GITHUB_TOKEN=ghp_x", "ghcr.io/github/github-mcp-server"]), ["docker", "***"]);
  assert.equal(redactCommand("node", ["a"]).redacted, true);
  assert.equal(redactCommand("npx", ["pkg"]).redacted, false);
});

test("redactCommand never keeps a runner flag's value, a URL, a path or a token as the 'package'", () => {
  const r = (cmd, args) => redactCommand(cmd, args).command;
  // round-3 L-1 cases
  assert.deepEqual(r("npx", ["--otp", "123456", "pkg"]), ["npx", "***"]);
  assert.deepEqual(r("npm", ["exec", "--_authToken", "npm_AbC123secret", "pkg"]), ["npm", "exec", "***"]);
  assert.deepEqual(r("npx", ["--//registry.npmjs.org/:_authToken=abc123", "pkg"]), ["npx", "***"]);
  assert.deepEqual(r("uvx", ["--with", "ghp_abcdefSECRET", "mcp-x"]), ["uvx", "***"]);
  assert.deepEqual(r("uvx", ["--from", "git+https://user:tok@host/repo", "mcp-x"]), ["uvx", "***"]);
  assert.deepEqual(r("pnpm", ["dlx", "--package", "tok123", "x"]), ["pnpm", "dlx", "***"]);
  assert.deepEqual(r("npx", ["-p", "secretpkg", "cmd"]), ["npx", "***"]);
  // boolean runner flags are skipped, so the usual forms still show the package
  assert.deepEqual(r("npx", ["-y", "--prefer-offline", "@scope/srv@1.2.3", "--token", "t"]), ["npx", "@scope/srv@1.2.3", "***"]);
  assert.deepEqual(r("uvx", ["--quiet", "mcp-server-fetch==0.6.2"]), ["uvx", "mcp-server-fetch==0.6.2", "***"], "skipped flags are hidden too");
  // a bare word that is not a package name
  for (const word of ["https://hooks.slack.com/services/T/B/SECRETxyz", "./server.js", "C:\\srv\\x.js", "ghp_abcdef123456", "sk_live_SECRET", "sk-proj-abc", "xoxb-1-2-SECRET", "github_pat_11AB", "npm_abcdef", "AKIAABCDEFGH", "eyJhbGciOiJIUzI1NiJ9", "abcdef1234567890", "Zm9vYmFyYmF6cXV4cXV1eA", "KEY=value", "a b"]) {
    assert.deepEqual(r("npx", ["-y", word]), ["npx", "***"], word);
  }
  // not a runner: only the executable, whatever the arguments
  assert.deepEqual(r("/usr/local/bin/slack-mcp", ["https://hooks.slack.com/services/T/B/SECRETxyz"]), ["slack-mcp", "***"]);
  assert.deepEqual(r("cmd", ["/c", "npx -y pkg --token ghp_SECRET"]), ["cmd", "***"]);
  // a whole command line given as the command (a common mistake)
  assert.deepEqual(r("npx -y pkg --token ghp_SECRET", []), ["npx", "***"]);
  assert.equal(executableName("npx -y pkg --token ghp_SECRET"), "npx");
});

test("redactCommand with showArgs returns the full command line", () => {
  assert.deepEqual(redactCommand("node", ["s.js", "--key", "k"], true), { command: ["node", "s.js", "--key", "k"], redacted: false });
});

const SECRET = "sk-SECRET-1234567890";
const ENV_SECRET = "env-SECRET-0987654321";
const args = (...extra) => [...extra, "-n", "1", "--warmup", "0", "--", process.execPath, DEMO, SECRET, "--header", `Authorization: Bearer ${SECRET}`];

test("secrets in server args or env never reach text, JSON, Markdown, saved results or errors by default", async () => {
  const dir = tmp();
  const out = path.join(dir, "base.json");
  const env = { MY_API_TOKEN: ENV_SECRET };
  const runs = [
    await cli(args("-o", out), { env }),
    await cli(args("--json"), { env }),
    await cli(args("--md", "--budget", "ready=60000"), { env }),
    await cli(args("--baseline", out, "--md"), { env }),
    await cli(["compare", out, out], { env }),
    await cli(["-n", "1", "--warmup", "0", "--", "definitely-not-a-real-command-xyz", SECRET], { env }),
    await cli(["-n", "1", "--warmup", "0", "--", process.execPath, DEMO, "--crash", SECRET], { env }),
  ];
  const saved = readFileSync(out, "utf8");
  for (const [i, r] of runs.entries()) {
    const all = r.stdout + r.stderr;
    assert.doesNotMatch(all, /SECRET/, `run ${i} leaked a secret:\n${all}`);
  }
  assert.doesNotMatch(saved, /SECRET/);
  assert.equal(runs[5].code, 2);
  assert.equal(runs[6].code, 2);
  const json = JSON.parse(runs[1].stdout);
  assert.deepEqual(json.command, [path.basename(process.execPath), "***"]);
  assert.equal(json.argsRedacted, true);
  assert.match(runs[0].stdout, /command: \S+ \*\*\* \(arguments hidden; use --show-args/);
});

test("--show-args records the full command line (still never env values)", async () => {
  const r = await cli(args("--json", "--show-args"), { env: { MY_API_TOKEN: ENV_SECRET } });
  assert.equal(r.code, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.command, [process.execPath, DEMO, SECRET, "--header", `Authorization: Bearer ${SECRET}`]);
  assert.equal(json.argsRedacted, false);
  assert.doesNotMatch(r.stdout + r.stderr, /env-SECRET/);
});

test("makeScrubber removes argument values (and long pieces of them) from server output", () => {
  const url = makeScrubber("slack-mcp", ["https://hooks.slack.com/services/T000/B000/SECRETxyz"]);
  assert.equal(url("posting to SECRETxyz failed"), "posting to *** failed", "the last URL segment alone is scrubbed");
  assert.doesNotMatch(url("bad url https://hooks.slack.com/services/T000/B000/SECRETxyz"), /SECRET/);
  assert.doesNotMatch(makeScrubber("npx -y pkg --token ghp_SECRETabc", [])("token ghp_SECRETabc"), /SECRET/);
  const scrub = makeScrubber("node", ["server.js", "--token=abcd1234efgh", "Authorization: Bearer sk-live-XYZ987"]);
  assert.equal(scrub("bad token abcd1234efgh"), "bad token ***");
  assert.equal(scrub("got --token=abcd1234efgh"), "got ***");
  assert.equal(scrub("header Bearer sk-live-XYZ987 rejected"), "header Bearer *** rejected");
  assert.equal(scrub("plain text"), "plain text");
  assert.equal(makeScrubber("node", ["sk-live-XYZ987"], true)("sk-live-XYZ987"), "sk-live-XYZ987", "--show-args disables scrubbing");
  // Package names kept in the redacted command line are not scrubbed.
  assert.equal(makeScrubber("npx", ["-y", "@modelcontextprotocol/server-everything"])("loading @modelcontextprotocol/server-everything"), "loading @modelcontextprotocol/server-everything");
});

test("a server that echoes its arguments to stderr on failure: the error output is scrubbed", async () => {
  const r = await cli(["-n", "1", "--warmup", "0", "--", process.execPath, DEMO, "--crash-echo-args", "--api-key", SECRET]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /bad arguments/);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
  assert.match(r.stderr, /\*\*\*/);
});

test("leak regressions: nonexistent absolute path + secret URL, `cmd /c \"…\"` as one string, sk_live_ args", async () => {
  const dir = tmp();
  const hook = "https://hooks.slack.com/services/T0SECRET1/B0SECRET2/SECRETxyz";
  const leaks = /SECRET|ghp_|sk_live|hooks\.slack\.com|T0SECRET1|B0SECRET2/;
  const base = path.join(dir, "base.json");
  const ok = (extra) => ["-n", "1", "--warmup", "0", ...extra, "--", process.execPath, DEMO, hook, "sk_live_SECRET123", "--header", "Authorization: Bearer ghp_SECRETtoken"];
  const runs = {
    text: await cli(ok(["-o", base])),
    json: await cli(ok(["--json"])),
    md: await cli(ok(["--md"])),
    baselineMd: await cli(ok(["--baseline", base, "--md"])),
    compare: await cli(["compare", base, base]),
    missingAbs: await cli(["-n", "1", "--warmup", "0", "--", "/usr/local/bin/slack-mcp-nonexistent-xyz", hook]),
    missingAbsJson: await cli(["-n", "1", "--warmup", "0", "--json", "--", "/usr/local/bin/slack-mcp-nonexistent-xyz", hook]),
    cmdC: await cli(["-n", "1", "--warmup", "0", "--", "cmd-nonexistent-xyz", "/c", "npx -y pkg --token ghp_SECRET"]),
    oneString: await cli(["-n", "1", "--warmup", "0", "--md", "--", "npx -y pkg --token ghp_SECRET sk_live_SECRET"]),
    skLive: await cli(["-n", "1", "--warmup", "0", "--", "npx", "-y", "sk_live_SECRET"], { env: { npm_config_offline: "true" } }),
    crashEcho: await cli(["-n", "1", "--warmup", "0", "--", process.execPath, DEMO, "--crash-echo-args", hook, "sk_live_SECRET123"]),
  };
  for (const [name, r] of Object.entries(runs)) {
    assert.doesNotMatch(r.stdout + r.stderr, leaks, `${name} leaked:\n${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /\n\s+at /, `${name}: stack trace`);
  }
  assert.doesNotMatch(readFileSync(base, "utf8"), leaks);
  for (const name of ["text", "json", "md", "baselineMd", "compare"]) assert.equal(runs[name].code, 0, `${name}: ${runs[name].stderr}`);
  for (const name of ["missingAbs", "missingAbsJson", "cmdC", "oneString", "skLive", "crashEcho"]) assert.equal(runs[name].code, 2, `${name}: ${runs[name].stderr}`);
  assert.deepEqual(JSON.parse(runs.json.stdout).command, [path.basename(process.execPath), "***"]);
  assert.match(runs.missingAbs.stderr, /command not found: "slack-mcp-nonexistent-xyz"/);
  assert.match(runs.oneString.stderr, /command not found: "npx".*contains spaces/);
  assert.match(runs.crashEcho.stderr, /bad arguments: \*\*\*/);
});
