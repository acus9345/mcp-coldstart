import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { comspecPath, escapeArgument, escapeCommand, forwardsAllArgs, planSpawn, resolveWindowsCommand, UnsafeArgumentError } from "../dist/index.js";
import { cli, DEMO, ROOT, tmp } from "./helpers.mjs";

const ECHO = path.join(ROOT, "test", "fixtures", "echo-args.mjs");
const isWin = process.platform === "win32";

// --- reference decoders: what cmd.exe and the MSVCRT do to a command line ---

/** cmd.exe removes one level of ^ escapes (we never leave cmd in quote mode: every " is ^-escaped). */
function uncaret(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "^" && i + 1 < s.length) out += s[++i];
    else out += s[i];
  }
  return out;
}

/** CommandLineToArgvW / MSVCRT argument splitting. */
function parseArgv(line) {
  const args = [];
  let cur = "";
  let inQuotes = false;
  let has = false;
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (c === "\\") {
      let n = 0;
      while (line[i] === "\\") (n++, i++);
      if (line[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) {
          cur += '"';
          i++;
        }
      } else cur += "\\".repeat(n);
      has = true;
    } else if (c === '"') {
      inQuotes = !inQuotes;
      has = true;
      i++;
    } else if ((c === " " || c === "\t") && !inQuotes) {
      if (has) args.push(cur);
      cur = "";
      has = false;
      i++;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  if (has) args.push(cur);
  return args;
}

const TRICKY = ['x"&calc&"', 'a"|b', "%PATH:\\=/%", "%X:a=b%", "%USERNAME:~0,3%", "%=C:%", "!USERNAME!", "a!b", "C:\\dir", "plain", "a b", 'say "hi"', "a&b", "x > canary.txt", "a|b", "<in", "%PATH%", "100%", "^caret", "trail\\", "C:\\Program Files\\x\\", 'back\\"slash', "", "(paren) !bang! `tick` ;semi, comma", "*?", "\\\\server\\share"];

test("escapeArgument: exact output for common cases", () => {
  assert.equal(escapeArgument("hello"), '^"hello^"');
  assert.equal(escapeArgument("a b"), '^"a^ b^"');
  assert.equal(escapeArgument('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.equal(escapeArgument("a&b>c"), '^"a^&b^>c^"');
  assert.equal(escapeArgument("%PATH%"), '^"^%PATH^%^"');
  assert.equal(escapeArgument("x^y"), '^"x^^y^"');
  assert.equal(escapeArgument("C:\\dir\\"), '^"C^:\\dir\\\\^"');
  assert.equal(escapeArgument("%PATH:\\=/%"), '^"^%PATH^:\\=/^%^"');
  assert.equal(escapeArgument("!VAR!"), '^"^!VAR^!^"');
  assert.equal(escapeArgument("a&b", true), '^^^"a^^^&b^^^"');
  assert.equal(escapeCommand("C:\\Program Files\\nodejs\\npx.cmd"), "C^:\\Program^ Files\\nodejs\\npx.cmd");
});

test("escapeArgument: round-trips through cmd.exe + MSVCRT parsing (single and double escaping)", () => {
  for (const a of TRICKY) {
    assert.deepEqual(parseArgv(uncaret(escapeArgument(a))), [a], `single: ${JSON.stringify(a)}`);
    assert.deepEqual(parseArgv(uncaret(uncaret(escapeArgument(a, true)))), [a], `double: ${JSON.stringify(a)}`);
  }
  // cmd expands %NAME% and %NAME:a=b% / %NAME:~n% in phase 1, before carets are
  // processed. Every name cmd could see must end in "^" (so it is undefined).
  for (const a of TRICKY) {
    for (const m of escapeArgument(a).matchAll(/%([^%:]*)(?=[%:])/g)) {
      assert.ok(m[1] === "" || m[1].endsWith("^"), `${JSON.stringify(a)}: cmd would expand %${m[1]}`);
    }
  }
  // Escaped output never contains an unescaped cmd operator.
  for (const a of TRICKY) {
    const e = escapeArgument(a);
    assert.doesNotMatch(e.replace(/\^./g, ""), /[&|<>%"^!:]/, `unescaped metachar in ${e}`);
  }
});

test("resolveWindowsCommand: PATH + PATHEXT lookup", () => {
  const root = tmp();
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(path.join(b, "npx.cmd"), "");
  writeFileSync(path.join(a, "node.exe"), "");
  writeFileSync(path.join(b, "node.exe"), "");
  writeFileSync(path.join(a, "README"), "");
  mkdirSync(path.join(root, "sub"));
  writeFileSync(path.join(root, "sub", "srv.bat"), "");
  const env = { Path: `${a};"${b}"`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  writeFileSync(path.join(a, "Mixed.Cmd"), "");
  writeFileSync(path.join(a, "script.js"), "");
  // NTFS is case-insensitive: compare paths case-insensitively there. The resolver
  // returns the on-disk spelling, so on case-sensitive file systems this is exact too.
  const same = (actual, expected, msg) =>
    isWin ? assert.equal(actual?.toLowerCase(), expected.toLowerCase(), msg) : assert.equal(actual, expected, msg);
  same(resolveWindowsCommand("npx", { env }), path.join(b, "npx.cmd"));
  same(resolveWindowsCommand("npx.cmd", { env }), path.join(b, "npx.cmd"));
  same(resolveWindowsCommand("node", { env }), path.join(a, "node.exe"), "first PATH entry wins");
  if (isWin) assert.equal(resolveWindowsCommand("mixed", { env }), path.join(a, "Mixed.Cmd"), "on-disk spelling is returned");
  const withJs = { ...env, PATHEXT: ".JS;.COM;.EXE;.BAT;.CMD;.VBS" };
  assert.equal(resolveWindowsCommand("script", { env: withJs }), null, ".js (Windows Script Host) is never launched");
  same(resolveWindowsCommand("npx", { env: withJs }), path.join(b, "npx.cmd"));
  assert.equal(resolveWindowsCommand("README", { env }), null, "files without a PATHEXT extension are not runnable");
  assert.equal(resolveWindowsCommand("missing", { env }), null);
  same(resolveWindowsCommand(path.join("sub", "srv"), { env, cwd: root }), path.join(root, "sub", "srv.bat"));
  assert.equal(resolveWindowsCommand("srv", { env, cwd: path.join(root, "sub") }), null, "cwd is not searched implicitly");
});

test("planSpawn: npx with an & argument on Windows goes through cmd.exe /d /s /v:off /c, fully escaped", () => {
  const dir = "C:\\Program Files\\nodejs";
  const npx = path.join(dir, "npx.cmd");
  const plan = planSpawn("npx", ["-y", "@scope/server", "--name", "a&b > pwned.txt"], {
    platform: "win32",
    env: { PATH: `C:\\Windows\\System32;${dir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    isFile: (p) => p === npx,
  });
  assert.equal(plan.file, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(plan.windowsVerbatimArguments, true);
  assert.deepEqual(plan.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"], "AutoRun off, delayed expansion off");
  assert.equal(plan.args.length, 5);
  const line = plan.args[4];
  assert.equal(
    line,
    '"C^:\\Program^ Files\\nodejs\\npx.cmd ^^^"-y^^^" ^^^"@scope/server^^^" ^^^"--name^^^" ^^^"a^^^&b^^^ ^^^>^^^ pwned.txt^^^""',
  );
  // /s strips the outer quotes; cmd parses once, the npx.cmd shim's %* is parsed again.
  const inner = line.slice(1, -1);
  const afterCmd = uncaret(inner);
  assert.ok(afterCmd.startsWith("C:\\Program Files\\nodejs\\npx.cmd "));
  const forwarded = afterCmd.slice(afterCmd.indexOf("npx.cmd ") + "npx.cmd ".length);
  assert.deepEqual(parseArgv(uncaret(forwarded)), ["-y", "@scope/server", "--name", "a&b > pwned.txt"]);
});

test("planSpawn: .exe on Windows is spawned directly; POSIX is always direct", () => {
  const exe = path.join("C:\\nodejs", "node.exe");
  const plan = planSpawn("node", ["a&b"], { platform: "win32", env: { PATH: "C:\\nodejs" }, isFile: (p) => p === exe });
  assert.deepEqual(plan, { file: exe, args: ["a&b"], windowsVerbatimArguments: false });
  assert.deepEqual(planSpawn("npx", ["a&b"], { platform: "linux" }), { file: "npx", args: ["a&b"], windowsVerbatimArguments: false });
});

test("planSpawn: a command that is not on PATH (e.g. a missing .cmd shim) is reported as notFound on Windows", () => {
  const plan = planSpawn("nope", ["x"], { platform: "win32", env: { PATH: "C:\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD" }, isFile: () => false });
  assert.equal(plan.notFound, true);
  assert.equal(plan.windowsVerbatimArguments, false);
  assert.equal(planSpawn("C:\\gone\\srv.cmd", [], { platform: "win32", env: {}, isFile: () => false }).notFound, true);
});

test("planSpawn: exact cmd.exe command-line shape for a .cmd (ComSpec fallback, /d /s /v:off /c, one quoted line)", () => {
  const shim = path.join("C:\\tools", "srv.cmd");
  const plan = planSpawn("srv", ["--port", "1"], { platform: "win32", env: { PATH: "C:\\tools" }, isFile: (p) => p === shim, readText: () => "@node srv.js %*" });
  assert.deepEqual(plan, {
    file: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/v:off", "/c", '"C^:\\tools\\srv.cmd ^^^"--port^^^" ^^^"1^^^""'],
    windowsVerbatimArguments: true,
  });
});

test("comspecPath: %ComSpec% if absolute, else %SystemRoot%\\System32\\cmd.exe, never a bare cmd.exe", () => {
  assert.equal(comspecPath({}), "C:\\Windows\\System32\\cmd.exe");
  assert.equal(comspecPath({ SystemRoot: "D:\\WINNT" }), "D:\\WINNT\\System32\\cmd.exe");
  assert.equal(comspecPath({ SYSTEMROOT: "D:\\WINNT" }), "D:\\WINNT\\System32\\cmd.exe", "env names are case-insensitive");
  assert.equal(comspecPath({ windir: "E:\\Win" }), "E:\\Win\\System32\\cmd.exe");
  assert.equal(comspecPath({ ComSpec: "C:\\Windows\\system32\\cmd.exe" }), "C:\\Windows\\system32\\cmd.exe");
  assert.equal(comspecPath({ ComSpec: "cmd.exe" }), "C:\\Windows\\System32\\cmd.exe", "a relative ComSpec would be a PATH/cwd lookup");
  assert.equal(comspecPath({ ComSpec: "", SystemRoot: "relative" }), "C:\\Windows\\System32\\cmd.exe");
  const shim = path.join("C:\\tools", "srv.cmd");
  for (const env of [{ PATH: "C:\\tools" }, { PATH: "C:\\tools", ComSpec: "cmd.exe" }]) {
    const plan = planSpawn("srv", [], { platform: "win32", env, isFile: (p) => p === shim, readText: () => "%*" });
    assert.ok(path.win32.isAbsolute(plan.file), plan.file);
  }
});

/**
 * Model of a batch file that reads "%~1": cmd splits its own arguments (quotes
 * toggle, backslash does not escape), %~1 strips the outer quotes, and the
 * substituted line is parsed again. Returns the operators cmd would run.
 */
function cmdArgs(s) {
  const out = [];
  let cur = "";
  let q = false;
  for (const c of s) {
    if (c === '"') q = !q;
    if (!q && (c === " " || c === "\t")) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
function unquotedOperators(line) {
  const ops = [];
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (!q && c === "^") i++;
    else if (!q && "&|<>".includes(c)) ops.push(i);
  }
  return ops;
}
function viaPercentTilde1(arg) {
  // what the batch file receives after cmd /c removes one level of carets
  const received = cmdArgs(uncaret(escapeArgument(arg, false)));
  const v = received[0].replace(/^"(.*)"$/s, "$1");
  return `node server.js "${v}"`;
}

test("BatBadBut model: single escaping cannot protect a \" inside a %~1 value, so such arguments are rejected", () => {
  // The hazard: x"&calc&" through a "%~1" batch file leaves & unquoted.
  assert.ok(unquotedOperators(viaPercentTilde1('x"&calc&"')).length > 0, "model should show the injection");
  // Every quote-free tricky argument stays inside quotes.
  for (const a of TRICKY.filter((t) => !t.includes('"'))) {
    assert.deepEqual(unquotedOperators(viaPercentTilde1(a)), [], a);
  }
  const bat = path.join("C:\\x", "custom.bat");
  const opts = { platform: "win32", env: { PATH: "C:\\x" }, isFile: (p) => p === bat, readText: () => 'node server.js "%~1"' };
  for (const bad of ['x"&calc&"', 'say "hi"', '"']) {
    assert.throws(() => planSpawn("custom", ["ok", bad], opts), (err) => {
      assert.ok(err instanceof UnsafeArgumentError);
      assert.match(err.message, /argument 2 contains a double quote/);
      assert.match(err.message, /custom\.bat/);
      assert.doesNotMatch(err.message, /calc|"hi"/, "the argument itself is not echoed");
      return true;
    });
  }
  // %* forwarders (double escaping) are fine with quotes: the round-trip test above covers them.
  assert.doesNotThrow(() => planSpawn("custom", ['x"&calc&"'], { ...opts, readText: () => "node server.js %*" }));
  // .exe targets are never affected.
  const exe = path.join("C:\\x", "srv.exe");
  assert.doesNotThrow(() => planSpawn("srv", ['x"&calc&"'], { ...opts, isFile: (p) => p === exe }));
});

test("planSpawn rejects line breaks and NUL for any batch file, without echoing the value", () => {
  const shim = path.join("C:\\x", "npx.cmd");
  const opts = { platform: "win32", env: { PATH: "C:\\x" }, isFile: (p) => p === shim };
  for (const bad of ["a\nsecret", "a\r\nsecret", "a\0secret"]) {
    assert.throws(() => planSpawn("npx", ["-y", bad], opts), (err) => err instanceof UnsafeArgumentError && /argument 2 contains a line break or NUL/.test(err.message) && !err.message.includes("secret"));
  }
  assert.doesNotThrow(() => planSpawn("node", ["a\nb"], { platform: "linux" }));
});

test("forwardsAllArgs: double escaping only for %* forwarders", () => {
  const none = () => "";
  assert.equal(forwardsAllArgs("C:\\Program Files\\nodejs\\npx.cmd", none), true);
  assert.equal(forwardsAllArgs("C:\\x\\PNPM.CMD", none), true);
  assert.equal(forwardsAllArgs("C:\\proj\\node_modules\\.bin\\my-server.cmd", none), true);
  assert.equal(forwardsAllArgs("C:\\x\\custom.bat", () => '@echo off\r\n"%~dp0\\srv.exe" %*\r\n'), true);
  assert.equal(forwardsAllArgs("C:\\x\\custom.bat", () => '@echo off\r\nsrv.exe "%~1" "%~2"\r\n'), false);
});

test("planSpawn: a .bat that reads %~1 gets single escaping (one cmd parse)", () => {
  const bat = path.join("C:\\x", "custom.bat");
  const opts = { platform: "win32", env: { PATH: "C:\\x" }, isFile: (p) => p === bat, readText: () => 'srv.exe "%~1"' };
  const plan = planSpawn("custom", ["a&b %PATH:\\=/%"], opts);
  assert.equal(plan.args[4], '"C^:\\x\\custom.bat ^"a^&b^ ^%PATH^:\\=/^%^""');
  assert.deepEqual(parseArgv(uncaret(plan.args[4].slice(1, -1))).slice(1), ["a&b %PATH:\\=/%"]);
});

test("CLI: a missing server command is a clean 'command not found' error with exit 2", async () => {
  const r = await cli(["-n", "1", "--warmup", "0", "--", isWin ? "no-such-server-xyz.cmd" : "no-such-server-xyz", "--token", "SECRETVALUE123"]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /command not found/i);
  assert.match(r.stderr, /no-such-server-xyz/);
  assert.doesNotMatch(r.stderr, /SECRETVALUE123/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
});

function runPlan(plan, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, { cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

const CANARY_ARGS = ["%PATH:\\=/%", "%USERNAME:~0,3%", "!USERNAME!", "a b", 'say "hi"', "x & echo pwned > canary1.txt", "| echo pwned > canary2.txt", "$(echo pwned > canary3.txt)", "; echo pwned > canary4.txt", "%PATH%", "^caret", "trail\\"];

test("metacharacter arguments reach the program verbatim and cannot create a canary file", async () => {
  const dir = tmp();
  const out = path.join(dir, "args.json");
  const plan = planSpawn(process.execPath, [ECHO, ...CANARY_ARGS]);
  const code = await runPlan(plan, dir, { ...process.env, ECHO_ARGS_OUT: out });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), CANARY_ARGS);
  for (let i = 1; i <= 4; i++) assert.equal(existsSync(path.join(dir, `canary${i}.txt`)), false);
});

test("a server name with & and > does not run shell syntax (full CLI path)", async () => {
  const dir = tmp();
  const r = await cli(["-n", "1", "--warmup", "0", "--json", "--", process.execPath, DEMO, "--name", "a&b > canary.txt"], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).server.name, "a&b > canary.txt");
  assert.equal(existsSync(path.join(dir, "canary.txt")), false);
  assert.doesNotMatch(r.stderr, /DEP0190/);
});

test("Windows: a .cmd shim that forwards %* (like npx.cmd) receives & > % ^ \" args verbatim", { skip: isWin ? false : "needs cmd.exe (Windows only); the escaping itself is verified above on every OS" }, async () => {
  const dir = tmp();
  const bin = path.join(dir, "bin dir");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "echoargs.cmd"), `@"${process.execPath}" "${ECHO}" %*\r\n`);
  const out = path.join(dir, "args.json");
  const env = { ...process.env, ECHO_ARGS_OUT: out };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${bin};${env[pathKey] ?? ""}`;
  const plan = planSpawn("echoargs", CANARY_ARGS, { env, cwd: dir });
  assert.equal(plan.windowsVerbatimArguments, true);
  const code = await runPlan(plan, dir, env);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), CANARY_ARGS);
  for (let i = 1; i <= 4; i++) assert.equal(existsSync(path.join(dir, `canary${i}.txt`)), false);
});

test("Windows: a .bat that reads %~1 receives the argument verbatim (single escaping)", { skip: isWin ? false : "needs cmd.exe (Windows only)" }, async () => {
  const dir = tmp();
  const bat = path.join(dir, "one.bat");
  writeFileSync(bat, `@"${process.execPath}" "${ECHO}" "%~1"\r\n`);
  const out = path.join(dir, "args.json");
  const env = { ...process.env, ECHO_ARGS_OUT: out };
  const arg = "a&b %PATH:\\=/% !USERNAME!";
  const code = await runPlan(planSpawn(bat, [arg], { env, cwd: dir }), dir, env);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), [arg]);
});

test("Windows: the CLI refuses a \" argument for a %~1 batch file (exit 2, no canary, value not echoed)", { skip: isWin ? false : "needs cmd.exe (Windows only); the rejection itself is tested above on every OS" }, async () => {
  const dir = tmp();
  const bat = path.join(dir, "one.bat");
  writeFileSync(bat, `@"${process.execPath}" "${DEMO}" --name "%~1"\r\n`);
  const r = await cli(["-n", "1", "--warmup", "0", "--", bat, 'x"&echo pwned>canary.txt&"'], { cwd: dir });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /contains a double quote/);
  assert.doesNotMatch(r.stderr, /pwned/);
  assert.equal(existsSync(path.join(dir, "canary.txt")), false);
});

test("Windows: the CLI runs a server through a .cmd shim in a path with spaces", { skip: isWin ? false : "needs cmd.exe (Windows only)" }, async () => {
  const dir = tmp();
  const bin = path.join(dir, "my servers");
  mkdirSync(bin);
  const shim = path.join(bin, "demo.cmd");
  writeFileSync(shim, `@"${process.execPath}" "${DEMO}" %*\r\n`);
  const r = await cli(["-n", "1", "--warmup", "0", "--json", "--", shim, "--name", "x&y > canary.txt"], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).server.name, "x&y > canary.txt");
  assert.equal(existsSync(path.join(dir, "canary.txt")), false);
  assert.doesNotMatch(r.stderr, /DEP0190/);
});

test("server script path with spaces is passed as one argument", async () => {
  const { copyFileSync } = await import("node:fs");
  const dir = path.join(tmp(), "dir with spaces");
  mkdirSync(dir);
  const script = path.join(dir, "demo server.mjs");
  copyFileSync(DEMO, script);
  const r = await cli(["-n", "1", "--warmup", "0", "--json", "--", process.execPath, script, "--name", "spaced"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).server.name, "spaced");
});
