// A server built with the official MCP TypeScript SDK, to prove interop of mcp-coldstart's own client.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "sdk-fixture", version: "2.3.4" });
server.tool("echo", "Echo a message back", { message: z.string() }, async ({ message }) => ({ content: [{ type: "text", text: message }] }));
server.tool("add", "Add two numbers", { a: z.number(), b: z.number() }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
await server.connect(new StdioServerTransport());
