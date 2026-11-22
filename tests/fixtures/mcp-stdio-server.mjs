// A small MCP server that speaks over stdin and stdout, for tests/tools-mcp-stdio.test.ts.
// What it does out of the ordinary is chosen by its arguments and by the tool that is called.
import fs from "node:fs";
import readline from "node:readline";

const flags = new Set(process.argv.slice(2));
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const cancelled = [];
const asked = new Map();
let initialised = false;

if (flags.has("--exit-at-once")) process.exit(3);
// A line a careless server prints before it speaks the protocol.
if (flags.has("--chatty")) process.stdout.write("starting up, please wait\n");
process.stderr.write("fixture ready\n");
if (process.env.MCP_FIXTURE_STARTS) fs.appendFileSync(process.env.MCP_FIXTURE_STARTS, `${process.pid}\n`);

const TOOLS = [
  {
    name: "echo",
    description: "Says it back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } }
  },
  { name: "env", description: "Lists the environment it runs in.", inputSchema: { type: "object", properties: {} } },
  {
    name: "slow",
    description: "Answers late.",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } }
  },
  { name: "crash", description: "Stops the server.", inputSchema: { type: "object", properties: {} } },
  { name: "big", description: "Answers with far too much.", inputSchema: { type: "object", properties: {} } },
  { name: "ask", description: "Asks the client something first.", inputSchema: { type: "object", properties: {} } },
  { name: "cancelled", description: "Which requests were cancelled.", inputSchema: { type: "object", properties: {} } },
  { name: "where", description: "The directory it runs in.", inputSchema: { type: "object", properties: {} } }
];

const text = (id, value) => send({ id, result: { content: [{ type: "text", text: value }] } });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // An answer to something this server asked.
  if (message.method === undefined && asked.has(message.id)) {
    const reply = asked.get(message.id);
    asked.delete(message.id);
    reply(message);
    return;
  }
  if (message.method === "initialize") {
    if (flags.has("--refuse")) return send({ id: message.id, error: { code: -32000, message: "not today" } });
    return send({
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0", clientVersion: message.params?.clientInfo?.version }
      }
    });
  }
  if (message.method === "notifications/initialized") {
    initialised = true;
    return;
  }
  if (message.method === "notifications/cancelled") {
    cancelled.push(message.params?.requestId);
    return;
  }
  if (message.method === "tools/list") {
    if (!initialised) return send({ id: message.id, error: { code: -32002, message: "not initialised" } });
    return send({ id: message.id, result: { tools: TOOLS } });
  }
  if (message.method !== "tools/call") {
    if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
    return;
  }
  if (!initialised) return send({ id: message.id, error: { code: -32002, message: "not initialised" } });
  const { name, arguments: args = {} } = message.params ?? {};
  if (name === "echo") return text(message.id, `echo: ${args.text}`);
  if (name === "env") return send({ id: message.id, result: { content: [], structuredContent: { ...process.env } } });
  if (name === "where") return text(message.id, process.cwd());
  if (name === "slow") return void setTimeout(() => text(message.id, "late"), Number(args.ms ?? 1000));
  if (name === "crash") return process.exit(7);
  if (name === "big") return void process.stdout.write("x".repeat(1024 * 1024 + 4096));
  if (name === "cancelled") return text(message.id, JSON.stringify(cancelled));
  if (name === "ask") {
    // Two requests to the client: one it answers, one it has no method for.
    asked.set("s1", (pong) => {
      asked.set("s2", (refused) =>
        text(message.id, JSON.stringify({ ping: pong.result, sampling: refused.error?.code }))
      );
      send({ id: "s2", method: "sampling/createMessage", params: {} });
    });
    return send({ id: "s1", method: "ping" });
  }
  send({ id: message.id, result: { isError: true, content: [{ type: "text", text: `no tool ${name}` }] } });
});
