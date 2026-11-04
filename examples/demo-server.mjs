#!/usr/bin/env node
// A tiny dependency-free MCP server over stdio, for trying mcp-coldstart and for its tests.
//
//   node demo-server.mjs [--startup-delay ms] [--list-delay ms] [--tools n] [--page-size n]
//                        [--alloc-mb n] [--noise] [--ignore-eof] [--crash] [--crash-echo-args] [--name s] [--version s]
//                        [--spawn-child pidfile] [--child-ignore-term ms] [--batch]
//
// --startup-delay simulates slow imports/boot work (busy-wait before reading stdin).
// --spawn-child starts a long-lived grandchild that shares stdout (like a server
// launched through a wrapper) and writes its pid to the given file.
// --child-ignore-term makes that grandchild ignore SIGTERM for the first ms
// milliseconds after it receives one (like a server flushing state), then write
// "<pidfile>.graceful" and exit.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const startupDelay = Number(opt("startup-delay", process.env.DEMO_STARTUP_DELAY_MS ?? 0));
const listDelay = Number(opt("list-delay", 0));
const toolCount = Number(opt("tools", 3));
const pageSize = Number(opt("page-size", 0));
const allocMb = Number(opt("alloc-mb", 0));
const name = opt("name", "demo-server");
const version = opt("version", "1.0.0");

if (flag("crash-echo-args")) {
  // Like a server that logs its own argv before failing (tests output scrubbing).
  process.stderr.write(`demo-server: bad arguments: ${argv.join(" ")}\n`);
  process.exit(3);
}
if (flag("crash")) {
  process.stderr.write("demo-server: simulated crash during startup\n");
  process.exit(3);
}

// Simulate expensive startup work.
const until = Date.now() + startupDelay;
while (Date.now() < until) {
  /* busy wait */
}
// Simulate memory held by the server.
const ballast = allocMb > 0 ? Buffer.alloc(allocMb * 1024 * 1024, 1) : null;

const pidFile = opt("spawn-child");
if (pidFile) {
  const ignoreTerm = Number(opt("child-ignore-term", 0));
  const code = ignoreTerm > 0
    ? `process.on("SIGTERM", () => setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(pidFile + ".graceful")}, "1"); process.exit(0); }, ${ignoreTerm})); setInterval(() => {}, 1000);`
    : "setInterval(() => {}, 1000)";
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "inherit", "inherit"] });
  writeFileSync(pidFile, String(child.pid));
  child.unref();
}

if (flag("noise")) process.stdout.write("demo-server starting up (this line breaks the stdio transport)\n");

const tools = Array.from({ length: toolCount }, (_, i) => ({
  name: `tool_${String(i).padStart(3, "0")}`,
  description: `Demo tool number ${i}. Returns a greeting for the given name.`,
  inputSchema: { type: "object", properties: { name: { type: "string", description: "Who to greet" } }, required: ["name"] },
  annotations: { readOnlyHint: true },
}));

// --batch: every response goes out as a JSON-RPC batch line together with a
// large log notification (tests that bytes are attributed per message).
const PAD = { jsonrpc: "2.0", method: "notifications/message", params: { level: "debug", data: "x".repeat(4000) } };
const send = (msg) => process.stdout.write(JSON.stringify(flag("batch") && msg.id !== undefined ? [PAD, msg] : msg) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version } },
      });
      break;
    case "tools/list": {
      const start = Number(msg.params?.cursor ?? 0);
      const end = pageSize > 0 ? Math.min(start + pageSize, tools.length) : tools.length;
      const result = { tools: tools.slice(start, end) };
      if (end < tools.length) result.nextCursor = String(end);
      setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result }), listDelay);
      break;
    }
    case "ping":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});
rl.on("close", () => {
  if (flag("ignore-eof")) {
    setInterval(() => void ballast, 1000); // keep running until signalled
    return;
  }
  process.exit(0);
});
