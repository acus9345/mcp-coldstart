import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { cli, DEMO, tmp } from "./helpers.mjs";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function waitDead(pid, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

function readPid(file) {
  assert.ok(existsSync(file), "server did not start its child");
  return Number(readFileSync(file, "utf8"));
}

test("a server that ignores stdin EOF and has a grandchild: CLI exits, whole tree is killed", { timeout: 60000 }, async () => {
  const dir = tmp();
  const pidFile = path.join(dir, "child.pid");
  const start = Date.now();
  const r = await cli(["-n", "1", "--warmup", "0", "--shutdown-grace", "300", "--json", "--", process.execPath, DEMO, "--ignore-eof", "--spawn-child", pidFile], { cwd: dir });
  const elapsed = Date.now() - start;
  assert.equal(r.code, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.samples[0].forcedKill, true);
  assert.ok(result.warnings.some((w) => /ignored stdin EOF/.test(w)));
  assert.ok(elapsed < 20000, `CLI took ${elapsed}ms to exit`);
  const pid = readPid(pidFile);
  assert.ok(await waitDead(pid), `grandchild ${pid} is still running`);
});

test("a server that exits on EOF but leaves a grandchild holding stdout: CLI still exits", { timeout: 60000 }, async () => {
  const dir = tmp();
  const pidFile = path.join(dir, "child.pid");
  const start = Date.now();
  const r = await cli(["-n", "1", "--warmup", "0", "--shutdown-grace", "300", "--json", "--", process.execPath, DEMO, "--spawn-child", pidFile], { cwd: dir });
  const elapsed = Date.now() - start;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).samples[0].forcedKill, false);
  assert.ok(elapsed < 20000, `CLI took ${elapsed}ms to exit`);
  const pid = readPid(pidFile);
  if (process.platform === "win32") {
    // Once the server has exited, Windows has no record of its children, so taskkill /T cannot find
    // the orphan. We only promise that the CLI exits; clean up the orphan here.
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  } else {
    assert.ok(await waitDead(pid), `grandchild ${pid} survived; the process group should have been reaped`);
  }
});

// --- the whole process group is gone by the time close() / the CLI returns (POSIX) ---

const posixOnly = process.platform === "win32" ? "POSIX process groups only (Windows uses taskkill /T, see README)" : false;

/** Strict, no polling: kill(pid, 0) also succeeds for an unreaped zombie, so this is false only once it is fully gone. */
function goneNow(pid) {
  return !alive(pid);
}

test("close() waits for a grandchild that ignores SIGTERM briefly: graceful exit within the grace period", { skip: posixOnly, timeout: 30000 }, async () => {
  const { measureOnce } = await import("../dist/index.js");
  const dir = tmp();
  const pidFile = path.join(dir, "child.pid");
  const t0 = Date.now();
  // --list-delay gives the grandchild time to install its SIGTERM handler
  const { sample } = await measureOnce({ command: process.execPath, args: [DEMO, "--spawn-child", pidFile, "--child-ignore-term", "300", "--list-delay", "300"], shutdownGraceMs: 2000 });
  const elapsed = Date.now() - t0;
  const pid = readPid(pidFile);
  assert.ok(goneNow(pid), `grandchild ${pid} still exists right after measureOnce() resolved`);
  assert.ok(existsSync(`${pidFile}.graceful`), "grandchild should have been given time to exit on its own after SIGTERM");
  assert.equal(sample.forcedKill, false);
  assert.equal(sample.leftoverProcesses, true);
  assert.ok(sample.shutdownMs < 250, `shutdownMs measures the server itself, not the leftovers (${sample.shutdownMs})`);
  assert.ok(elapsed >= 300 + 300, `the 300 ms graceful exit should have been waited for (${elapsed}ms)`);
  assert.ok(elapsed < 2000 + 1400 + 3000, `took ${elapsed}ms`);
});

test("close() SIGKILLs a grandchild that outlasts the grace period, and returns only once the group is gone", { skip: posixOnly, timeout: 30000 }, async () => {
  const { measureOnce } = await import("../dist/index.js");
  for (const extra of [[], ["--ignore-eof"]]) {
    const dir = tmp();
    const pidFile = path.join(dir, "child.pid");
    const t0 = Date.now();
    const { sample } = await measureOnce({ command: process.execPath, args: [DEMO, "--spawn-child", pidFile, "--child-ignore-term", "5000", "--list-delay", "300", ...extra], shutdownGraceMs: 300 });
    const elapsed = Date.now() - t0;
    const pid = readPid(pidFile);
    assert.ok(goneNow(pid), `${extra}: grandchild ${pid} still exists right after measureOnce() resolved`);
    assert.equal(existsSync(`${pidFile}.graceful`), false, "grandchild should have been SIGKILLed, not waited for");
    assert.equal(sample.forcedKill, extra.length > 0);
    // bounded: server phase (<= 2*grace + 1s) + leftovers (<= grace + 1.4s) + startup
    assert.ok(elapsed < 4500, `${extra}: took ${elapsed}ms`);
  }
});

test("CLI: no process from the server's group is left when the CLI exits (checked immediately, no polling)", { skip: posixOnly, timeout: 60000 }, async () => {
  const dir = tmp();
  const pids = [];
  // several runs plus a warm-up, each leaving a TERM-ignoring grandchild
  const pidFile = path.join(dir, "child.pid");
  const r = await cli(["-n", "3", "--warmup", "1", "--shutdown-grace", "200", "--json", "--", process.execPath, DEMO, "--spawn-child", pidFile, "--child-ignore-term", "5000", "--list-delay", "300"], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  pids.push(readPid(pidFile)); // the last run's grandchild
  assert.ok(goneNow(pids[0]), `grandchild ${pids[0]} of the last run outlived the CLI`);
  const json = JSON.parse(r.stdout);
  assert.ok(json.samples.every((s) => s.leftoverProcesses === true));
  assert.ok(json.warnings.some((w) => /left child processes running/.test(w)), json.warnings.join("\n"));
});
