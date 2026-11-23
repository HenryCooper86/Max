import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServerTools } from "../server/tools/registry";
import type { ToolContext, ToolDefinition } from "../server/tools";

type Seen = { method: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };
type Rpc = { id?: number; method: string; params?: Record<string, unknown> };

type FakeOptions = {
  sse?: boolean;
  sessionId?: string;
  protocolVersion?: string;
  tools?: unknown[];
  pages?: unknown[][];
  call?: (params: Record<string, unknown>) => unknown;
  /** Return true when the handler already answered. */
  intercept?: (message: Rpc, res: ServerResponse, seen: Seen[]) => boolean;
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
  });
}

function send(res: ServerResponse, sse: boolean | undefined, id: number | undefined, result: unknown, extra = {}) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id, ...("code" in extra ? { error: extra } : { result }) });
  if (!sse) {
    res.writeHead(200, { "content-type": "application/json" }).end(payload);
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  // A notification first, then the response split over two data lines (JSON
  // allows a newline between tokens), as a server streaming progress would.
  res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n');
  const cut = payload.indexOf(",");
  res.write(`event: message\r\ndata: ${payload.slice(0, cut)}\r\ndata: ${payload.slice(cut)}\r\n\r\n`);
  res.end();
}

async function fake(options: FakeOptions = {}) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as Rpc;
    seen.push({ method: body.method, headers: req.headers, body: body as Record<string, unknown> });
    if (options.intercept?.(body, res, seen)) return;
    if (body.method === "initialize") {
      if (options.sessionId) res.setHeader("mcp-session-id", options.sessionId);
      return send(res, options.sse, body.id, {
        protocolVersion: options.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1" }
      });
    }
    if (body.method === "notifications/initialized") return void res.writeHead(202).end();
    if (body.method === "tools/list") {
      if (options.pages) {
        const index = body.params?.cursor ? Number(body.params.cursor) : 0;
        const next = index + 1 < options.pages.length ? { nextCursor: String(index + 1) } : {};
        return send(res, options.sse, body.id, { tools: options.pages[index], ...next });
      }
      return send(res, options.sse, body.id, { tools: options.tools ?? [] });
    }
    if (body.method === "tools/call") return send(res, options.sse, body.id, options.call?.(body.params ?? {}) ?? {});
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, seen };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-registry-"));
  dirs.push(dir);
  return dir;
}

function context(): ToolContext {
  return { callId: "c1", sessionId: "s1", signal: new AbortController().signal, log: { info() {}, warn() {} } };
}

type Found = { results: { text: string }[] };
const names = (tools: ToolDefinition[]) => tools.map((tool) => tool.name).sort();
const echo = { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: {} } };
const other = { name: "other", description: "Other", inputSchema: { type: "object", properties: {} } };

/** A localhost port nothing listens on. */
async function deadUrl() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  await new Promise((done) => server.close(done));
  return `http://127.0.0.1:${port}/mcp`;
}

const webhookTool = (name: string) => ({
  name,
  description: "A webhook tool",
  parameters: { type: "object", properties: {} },
  webhook: { url: "https://hooks.example.com/tool" }
});

describe("buildServerTools: knowledge", () => {
  it("adds search_knowledge for inline text", async () => {
    const built = await buildServerTools({ knowledge: { text: "We close on Mondays. The shop opens at nine." } });
    expect(built.problems).toEqual([]);
    expect(names(built.tools)).toEqual(["search_knowledge"]);
    const result = (await built.tools[0]!.handler({ query: "when do you close" }, context())) as Found;
    expect(result.results.map((item) => item.text).join(" ")).toMatch(/close on Mondays/);
  });

  it("loads a file relative to baseDir", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "faq.md"), "# Delivery\n\nDelivery to Berlin takes three days.\n");
    const built = await buildServerTools({ knowledge: "faq.md", baseDir: dir });
    expect(built.problems).toEqual([]);
    const result = (await built.tools[0]!.handler({ query: "delivery Berlin" }, context())) as Found;
    expect(result.results[0]!.text).toMatch(/three days/);
  });

  it("adds no tool and reports a problem when nothing can be found", async () => {
    const dir = tempDir();
    const built = await buildServerTools({ knowledge: "missing.md", baseDir: dir });
    expect(built.tools).toEqual([]);
    expect(built.problems.join("\n")).toMatch(/knowledge: nothing to search was found/);
    expect(built.problems.length).toBeGreaterThan(1);
  });

  it("reports an invalid knowledge key", async () => {
    const built = await buildServerTools({ knowledge: 42 });
    expect(built.tools).toEqual([]);
    expect(built.problems).toEqual(["knowledge must be a path, a list of paths or an object"]);
  });

  it("adds nothing without a knowledge key", async () => {
    expect(await buildServerTools({})).toMatchObject({ tools: [], problems: [], unreachable: [] });
  });
});

describe("buildServerTools: knowledge embeddings", () => {
  const env = {
    KNOWLEDGE_EMBEDDINGS_MODEL: "small",
    KNOWLEDGE_EMBEDDINGS_API_KEY: "k",
    KNOWLEDGE_EMBEDDINGS_CACHE: "off"
  };
  const fast = { backoffMs: 1, attempts: 2 };
  const text =
    "# Reimbursement\n\nCustomers are reimbursed within 14 days.\n\n# Delivery\n\nOur courier delivers in 3 days.";
  const concept = (value: string) => [
    /reimburs|money|back/i.test(value) ? 1 : 0,
    /courier|deliver/i.test(value) ? 1 : 0
  ];
  const fakeRequest = (calls: unknown[] = []) =>
    (async (url: string, init: RequestInit) => {
      calls.push(url);
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(
        JSON.stringify({ data: input.map((value, index) => ({ index, embedding: concept(value) })) })
      );
    }) as unknown as typeof fetch;
  const ask = async (tool: ToolDefinition, query: string) =>
    ((await tool.handler({ query }, context())) as Found).results.map((item) => item.heading);

  it("answers with BM25 until the vectors are ready, then with hybrid search", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: unknown[] = [];
    const inner = fakeRequest(calls);
    const request = (async (...args: Parameters<typeof fetch>) => {
      await gate;
      return inner(...args);
    }) as typeof fetch;
    const built = await buildServerTools({ knowledge: { text } }, { env, request });
    expect(built.problems).toEqual([]);
    const tool = built.tools[0]!;
    expect(await ask(tool, "money back")).toEqual([]);
    release();
    await vi.waitFor(async () => expect(await ask(tool, "money back")).toEqual(["Reimbursement"]));
    expect(await ask(tool, "courier")).toEqual(["Delivery"]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not wait for the embeddings before returning", async () => {
    const request = (() => new Promise(() => {})) as unknown as typeof fetch;
    const built = await buildServerTools({ knowledge: { text } }, { env, request });
    expect(names(built.tools)).toEqual(["search_knowledge"]);
  });

  it("keeps BM25 when the endpoint fails, and adds no problem", async () => {
    const request = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const built = await buildServerTools({ knowledge: { text } }, { env, request, embedJob: fast });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await new Promise((done) => setTimeout(done, 20));
    expect(built.problems).toEqual([]);
    expect(await ask(built.tools[0]!, "courier")).toEqual(["Delivery"]);
    expect(await ask(built.tools[0]!, "money back")).toEqual([]);
  });

  it("stays on BM25 above the passage limit, without calling the endpoint", async () => {
    const request = vi.fn(fakeRequest()) as unknown as typeof fetch;
    const built = await buildServerTools({ knowledge: { text } }, { env, request, maxEmbeddedPassages: 1 });
    await new Promise((done) => setTimeout(done, 20));
    expect(request).not.toHaveBeenCalled();
    expect(await ask(built.tools[0]!, "money back")).toEqual([]);
  });

  it("reports a bad embeddings setting as a knowledge problem and stays on BM25", async () => {
    const built = await buildServerTools(
      { knowledge: { text } },
      { env: { KNOWLEDGE_EMBEDDINGS_MODEL: "small" }, request: fakeRequest() }
    );
    expect(built.problems).toHaveLength(1);
    expect(built.problems[0]).toMatch(/^knowledge: KNOWLEDGE_EMBEDDINGS_MODEL needs/);
    expect(await ask(built.tools[0]!, "courier")).toEqual(["Delivery"]);
  });

  it("does nothing without a model in the environment", async () => {
    const request = vi.fn(fakeRequest()) as unknown as typeof fetch;
    await buildServerTools({ knowledge: { text } }, { env: {}, request });
    await new Promise((done) => setTimeout(done, 20));
    expect(request).not.toHaveBeenCalled();
  });

  it("lets a replaced build's job finish without touching the new tool", async () => {
    const first = await buildServerTools({ knowledge: { text } }, { env, request: fakeRequest() });
    const second = await buildServerTools({ knowledge: { text } }, { env: {} });
    await vi.waitFor(async () => expect(await ask(first.tools[0]!, "money back")).toEqual(["Reimbursement"]));
    expect(await ask(second.tools[0]!, "money back")).toEqual([]);
  });
});

describe("buildServerTools: mcpServers", () => {
  const server = (name: string, url: string) => ({ name, url, timeoutMs: 2000 });

  it("adds the tools of a reachable server", async () => {
    const a = await fake({ tools: [echo] });
    const built = await buildServerTools({ mcpServers: [server("demo", a.url)] });
    expect(built.problems).toEqual([]);
    expect(built.unreachable).toEqual([]);
    expect(names(built.tools)).toEqual(["echo"]);
  });

  it("combines servers, and reports and tracks an unreachable one", async () => {
    const a = await fake({ tools: [echo] });
    const dead = await deadUrl();
    const built = await buildServerTools({ mcpServers: [server("up", a.url), server("down", dead)] });
    expect(names(built.tools)).toEqual(["echo"]);
    expect(built.problems.length).toBeGreaterThan(0);
    expect(built.problems.join("\n")).toMatch(/down/);
    expect(built.unreachable.map((item) => item.name)).toEqual(["down"]);
  });

  it("gives a problem, no tools and an unreachable entry for a lone dead server", async () => {
    const built = await buildServerTools({ mcpServers: [server("down", await deadUrl())] });
    expect(built.tools).toEqual([]);
    expect(built.problems.length).toBeGreaterThan(0);
    expect(built.unreachable).toHaveLength(1);
  });

  it("reports a server defined twice and uses the first", async () => {
    const a = await fake({ tools: [echo] });
    const b = await fake({ tools: [other] });
    const built = await buildServerTools({ mcpServers: [server("demo", a.url), server("demo", b.url)] });
    expect(built.problems).toEqual(["mcp server demo is defined twice; the first definition is used"]);
    expect(names(built.tools)).toEqual(["echo"]);
  });

  it("uses only the first 8 servers", async () => {
    const a = await fake({ tools: [echo] });
    const list = Array.from({ length: 10 }, (_, index) => server(`s${index}`, a.url));
    list[9] = server("last", await deadUrl());
    const built = await buildServerTools({ mcpServers: list });
    expect(built.problems).toContain("only the first 8 MCP servers are used");
    // Every server shares one tool name, so only the first is added; the ninth and tenth are never contacted.
    expect(built.unreachable).toEqual([]);
    expect(built.problems.filter((problem) => problem.includes("last"))).toEqual([]);
  });

  it("reports mcpServers that is not an array", async () => {
    const built = await buildServerTools({ mcpServers: { name: "x" } });
    expect(built.problems).toEqual(["mcpServers must be an array"]);
    expect(built.tools).toEqual([]);
  });

  it("reports an invalid entry and still loads the rest", async () => {
    const a = await fake({ tools: [echo] });
    const built = await buildServerTools({ mcpServers: ["nope", server("demo", a.url)] });
    expect(built.problems).toEqual(["mcpServers: each entry must be an object"]);
    expect(names(built.tools)).toEqual(["echo"]);
  });

  it("keeps the first of a webhook tool and an MCP tool with the same name", async () => {
    const a = await fake({ tools: [echo] });
    const built = await buildServerTools({ tools: [webhookTool("echo")], mcpServers: [server("demo", a.url)] });
    expect(built.problems).toEqual(["tool echo is defined twice; the first definition is used"]);
    expect(built.tools).toHaveLength(1);
    expect(built.tools[0]!.description).toBe("A webhook tool");
  });

  it("combines webhook, knowledge and MCP tools", async () => {
    const a = await fake({ tools: [echo] });
    const built = await buildServerTools({
      tools: [webhookTool("lookup")],
      knowledge: { text: "Opening hours are nine to five." },
      mcpServers: [server("demo", a.url)]
    });
    expect(built.problems).toEqual([]);
    expect(names(built.tools)).toEqual(["echo", "lookup", "search_knowledge"]);
  });
});
