import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolDefinition } from "../server/tools";
import { loadMcpTools, mcpServerFrom, type McpServerConfig } from "../server/tools/mcp";
import { MAX_TOOL_DESCRIPTION } from "../server/tools/schema";

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

function config(url: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name: "demo", url, headers: {}, timeoutMs: 2000, ...extra };
}

function context(signal: AbortSignal = new AbortController().signal): ToolContext {
  return { callId: "c1", sessionId: "s1", signal, log: { info() {}, warn() {} } };
}

const echo = {
  name: "echo",
  description: "Echo text",
  inputSchema: { type: "object", properties: { t: { type: "string" } } }
};
const find = (tools: ToolDefinition[], name: string) => tools.find((tool) => tool.name === name)!;

describe("mcpServerFrom", () => {
  const ok = { name: "crm", url: "https://mcp.example.com/mcp" };

  it("applies defaults and clamps the timeout", () => {
    expect(mcpServerFrom(ok).server).toEqual({ ...ok, headers: {}, timeoutMs: 15_000 });
    expect(mcpServerFrom({ ...ok, timeoutMs: 999_999 }).server?.timeoutMs).toBe(60_000);
    expect(mcpServerFrom({ ...ok, timeoutMs: 5000 }).server?.timeoutMs).toBe(5000);
  });

  it("reads the tools the conversation does not wait for, and how long they may take", () => {
    expect(mcpServerFrom({ ...ok, backgroundTools: [" make_report "] }).server).toMatchObject({
      backgroundTools: ["make_report"],
      backgroundTimeoutMs: 120_000
    });
    const timed = (backgroundTimeoutMs: number) =>
      mcpServerFrom({ ...ok, backgroundTools: ["make_report"], backgroundTimeoutMs }).server?.backgroundTimeoutMs;
    expect(timed(30_000)).toBe(30_000);
    expect(timed(9_999_999)).toBe(600_000);
    expect(mcpServerFrom({ ...ok, backgroundTools: "make_report" }).problem).toContain("backgroundTools");
    expect(mcpServerFrom({ ...ok, backgroundTools: ["a", ""] }).problem).toContain("backgroundTools");
    // A tool that allowedTools hides cannot be a background tool: say so, rather than ignore it.
    expect(mcpServerFrom({ ...ok, allowedTools: ["search"], backgroundTools: ["make_report"] }).problem).toContain(
      "allowedTools leaves out"
    );
  });

  it("keeps placeholders, headers, allowedTools and prefix", () => {
    const { server } = mcpServerFrom({
      name: "crm",
      url: "https://${HOST}/mcp?key=${KEY}",
      headers: { Authorization: "Bearer ${TOKEN}" },
      allowedTools: [" search "],
      prefix: "crm"
    });
    expect(server).toMatchObject({
      url: "https://${HOST}/mcp?key=${KEY}",
      headers: { Authorization: "Bearer ${TOKEN}" },
      allowedTools: ["search"],
      prefix: "crm"
    });
  });

  it("rejects bad entries", () => {
    expect(mcpServerFrom("x").problem).toBeTruthy();
    expect(mcpServerFrom({ ...ok, name: "1bad" }).problem).toContain("invalid name");
    expect(mcpServerFrom({ ...ok, name: "a".repeat(33) }).problem).toContain("invalid name");
    expect(mcpServerFrom({ name: "crm" }).problem).toContain("needs a url");
    expect(mcpServerFrom({ ...ok, url: "not a url" }).problem).toContain("not a URL");
    expect(mcpServerFrom({ ...ok, url: "http://example.com/mcp" }).problem).toContain("must be https");
    expect(mcpServerFrom({ ...ok, url: "http://localhost:8080/mcp" }).server).toBeTruthy();
    expect(mcpServerFrom({ ...ok, headers: { "bad name": "v" } }).problem).toContain("invalid header");
    expect(mcpServerFrom({ ...ok, headers: { A: 1 } }).problem).toContain("invalid header");
    expect(mcpServerFrom({ ...ok, allowedTools: "search" }).problem).toContain("allowedTools");
    expect(mcpServerFrom({ ...ok, allowedTools: ["a", ""] }).problem).toContain("allowedTools");
    expect(mcpServerFrom({ ...ok, prefix: "9x" }).problem).toContain("invalid prefix");
    expect(mcpServerFrom({ ...ok, prefix: "a".repeat(25) }).problem).toContain("invalid prefix");
  });
});

describe.each([false, true])("loadMcpTools (sse: %s)", (sse) => {
  it("handshakes in order and echoes session and protocol headers", async () => {
    const { url, seen } = await fake({ sse, sessionId: "sess-1", protocolVersion: "2025-03-26", tools: [echo] });
    const { tools, problems } = await loadMcpTools(config(url, { headers: { "x-key": "${KEY}" } }), {
      env: { KEY: "secret" },
      clientVersion: "9.9.9"
    });
    expect(problems).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(seen.map((item) => item.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    const [init, ack, list] = seen;
    expect(init.body).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "max-voice-agent-relay", version: "9.9.9" }
      }
    });
    expect(init.headers["accept"]).toBe("application/json, text/event-stream");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["x-key"]).toBe("secret");
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    expect(ack.body.id).toBeUndefined();
    for (const later of [ack, list]) {
      expect(later.headers["mcp-session-id"]).toBe("sess-1");
      expect(later.headers["mcp-protocol-version"]).toBe("2025-03-26");
    }
  });

  it("follows pagination", async () => {
    const mk = (name: string) => ({ name, description: name });
    const { url } = await fake({ sse, pages: [[mk("a"), mk("b")], [mk("c")]] });
    const { tools } = await loadMcpTools(config(url));
    expect(tools.map((tool) => tool.name)).toEqual(["a", "b", "c"]);
  });

  it("applies allowedTools to server names, then prefix", async () => {
    const mk = (name: string) => ({ name, description: name });
    const { url } = await fake({ sse, tools: [mk("search"), mk("delete")] });
    const { tools } = await loadMcpTools(config(url, { allowedTools: ["search"], prefix: "crm" }));
    expect(tools.map((tool) => tool.name)).toEqual(["crm_search"]);
  });

  it("calls the server's own tool name and joins text, with markers for other items", async () => {
    const seenCalls: unknown[] = [];
    const { url } = await fake({
      sse,
      tools: [echo],
      call: (params) => {
        seenCalls.push(params);
        return {
          content: [
            { type: "text", text: "one" },
            { type: "image", data: "x" },
            { type: "text", text: "two" }
          ]
        };
      }
    });
    const { tools } = await loadMcpTools(config(url, { prefix: "p" }));
    expect(tools[0].timeoutMs).toBe(2000);
    await expect(find(tools, "p_echo").handler({ t: "hi" }, context())).resolves.toBe("one\n[image]\ntwo");
    expect(seenCalls).toEqual([{ name: "echo", arguments: { t: "hi" } }]);
  });

  it("falls back to structuredContent when there is no text", async () => {
    const { url } = await fake({ sse, tools: [echo], call: () => ({ content: [], structuredContent: { n: 3 } }) });
    const { tools } = await loadMcpTools(config(url));
    await expect(tools[0].handler({}, context())).resolves.toEqual({ n: 3 });
  });

  it("throws the text when isError is set, and the message of a JSON-RPC error", async () => {
    const { url } = await fake({
      sse,
      tools: [echo],
      call: () => ({ isError: true, content: [{ type: "text", text: "no such order" }] })
    });
    const { tools } = await loadMcpTools(config(url));
    await expect(tools[0].handler({}, context())).rejects.toThrow("no such order");

    const rpcError = await fake({
      sse,
      tools: [echo],
      intercept: (message, res) => {
        if (message.method !== "tools/call") return false;
        send(res, sse, message.id, undefined, { code: -32602, message: "bad arguments" });
        return true;
      }
    });
    const loaded = await loadMcpTools(config(rpcError.url));
    await expect(loaded.tools[0].handler({}, context())).rejects.toThrow("bad arguments");
  });

  it("re-initialises once when the session has expired", async () => {
    let issued = 0;
    let expired = false;
    const { url, seen } = await fake({
      sse,
      tools: [echo],
      call: () => ({ content: [{ type: "text", text: "fine" }] }),
      intercept: (message, res) => {
        if (message.method === "initialize") {
          res.setHeader("mcp-session-id", `s${++issued}`);
          return false;
        }
        if (message.method === "tools/call" && !expired) {
          expired = true;
          res.writeHead(404).end();
          return true;
        }
        return false;
      }
    });
    const { tools } = await loadMcpTools(config(url));
    await expect(tools[0].handler({}, context())).resolves.toBe("fine");
    expect(seen.map((item) => item.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call"
    ]);
    expect(seen[3].headers["mcp-session-id"]).toBe("s1");
    expect(seen[6].headers["mcp-session-id"]).toBe("s2");
  });

  it("does not retry twice", async () => {
    let calls = 0;
    const { url } = await fake({
      sse,
      sessionId: "s",
      tools: [echo],
      intercept: (message, res) => {
        if (message.method !== "tools/call") return false;
        calls++;
        res.writeHead(404).end();
        return true;
      }
    });
    const { tools } = await loadMcpTools(config(url));
    await expect(tools[0].handler({}, context())).rejects.toThrow("HTTP 404");
    expect(calls).toBe(2);
  });
});

describe("loadMcpTools background tools", () => {
  const report = { name: "make_report", description: "Makes a long report" };

  it("marks the listed tools, by the server's own names, and gives them the longer limit", async () => {
    const { url } = await fake({ tools: [echo, report] });
    const { tools, problems } = await loadMcpTools(
      config(url, { prefix: "crm", backgroundTools: ["make_report"], backgroundTimeoutMs: 90_000 })
    );
    expect(problems).toEqual([]);
    expect(find(tools, "crm_make_report")).toMatchObject({ background: true, timeoutMs: 90_000 });
    expect(find(tools, "crm_echo").background).toBeUndefined();
    expect(find(tools, "crm_echo").timeoutMs).toBe(2000);
  });

  it("says when a listed tool is not on the server", async () => {
    const { url } = await fake({ tools: [echo] });
    const { tools, problems } = await loadMcpTools(config(url, { backgroundTools: ["make_report"] }));
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(problems).toEqual([expect.stringContaining("backgroundTools names make_report")]);
  });

  it("waits for a background tool beyond the server's ordinary limit", async () => {
    const { url } = await fake({
      tools: [echo, report],
      intercept: (message, res) => {
        if (message.method !== "tools/call") return false;
        setTimeout(() => send(res, false, message.id, { content: [{ type: "text", text: "done" }] }), 400);
        return true;
      }
    });
    const { tools } = await loadMcpTools(
      config(url, { timeoutMs: 150, backgroundTools: ["make_report"], backgroundTimeoutMs: 5000 })
    );
    await expect(find(tools, "make_report").handler({}, context())).resolves.toBe("done");
    await expect(find(tools, "echo").handler({}, context())).rejects.toThrow("did not answer within 0.15 s");
  });
});

describe("loadMcpTools tool conversion", () => {
  it("falls back to title, then a generated description, and cuts long ones", async () => {
    const { url } = await fake({
      tools: [
        { name: "titled", title: "A title" },
        { name: "bare" },
        { name: "long", description: "x".repeat(MAX_TOOL_DESCRIPTION + 500) }
      ]
    });
    const { tools, problems } = await loadMcpTools(config(url));
    expect(problems).toEqual([]);
    expect(find(tools, "titled").description).toBe("A title");
    expect(find(tools, "bare").description).toBe("bare (from the demo MCP server)");
    expect(find(tools, "long").description).toHaveLength(MAX_TOOL_DESCRIPTION);
  });

  it("skips an invalid tool with a problem that names the server and tool", async () => {
    const { url } = await fake({
      tools: [
        { name: "has space", description: "bad name" },
        { name: "ok", description: "fine" }
      ]
    });
    const { tools, problems } = await loadMcpTools(config(url));
    expect(tools.map((tool) => tool.name)).toEqual(["ok"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("demo MCP server");
    expect(problems[0]).toContain("has space");
  });

  it("keeps at most 64 tools and says so", async () => {
    const many = Array.from({ length: 70 }, (_, index) => ({ name: `t${index}`, description: "d" }));
    const { url } = await fake({ tools: many });
    const { tools, problems } = await loadMcpTools(config(url));
    expect(tools).toHaveLength(64);
    expect(problems.join()).toContain("64");
  });
});

describe("loadMcpTools failures", () => {
  it("returns a problem instead of throwing when the server is down", async () => {
    const { url } = await fake();
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
    const result = await loadMcpTools(config(url));
    expect(result.tools).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("demo MCP server");
    expect(result.problems[0]).not.toContain("127.0.0.1");
  });

  it("reports an HTTP failure without leaking the URL", async () => {
    const { url } = await fake({
      intercept: (_message, res) => res.writeHead(500).end("boom") && true
    });
    const result = await loadMcpTools(config(`${url}?key=hunter2`));
    expect(result.tools).toEqual([]);
    expect(result.problems[0]).toContain("HTTP 500");
    expect(result.problems[0]).not.toContain("hunter2");
  });

  it("times out a server that never answers", async () => {
    const { url } = await fake({ intercept: () => true });
    const result = await loadMcpTools(config(url, { timeoutMs: 100 }));
    expect(result.tools).toEqual([]);
    expect(result.problems[0]).toContain("did not answer");
  });

  it("aborts a call when the context signal aborts", async () => {
    const { url } = await fake({
      tools: [echo],
      intercept: (message) => message.method === "tools/call"
    });
    const { tools } = await loadMcpTools(config(url));
    const controller = new AbortController();
    const pending = tools[0].handler({}, context(controller.signal));
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("fails on a missing environment variable without sending anything", async () => {
    const { url, seen } = await fake();
    const result = await loadMcpTools(config(url, { headers: { authorization: "Bearer ${NOPE}" } }), { env: {} });
    expect(result.tools).toEqual([]);
    expect(result.problems[0]).toContain("relay is missing environment variable NOPE");
    expect(seen).toEqual([]);
  });

  it("re-checks the expanded URL", async () => {
    const result = await loadMcpTools(config("https://${HOST}/mcp"), { env: { HOST: "x" }, request: undefined });
    // https://x resolves to nothing, so this only proves https is accepted and the failure is a clean problem.
    expect(result.tools).toEqual([]);
    const blocked = await loadMcpTools(config("${SCHEME}://example.com/mcp"), { env: { SCHEME: "http" } });
    expect(blocked.problems[0]).toContain("must be https");
  });

  it("refuses a response over the size cap in either mode", async () => {
    for (const sse of [false, true]) {
      const { url } = await fake({
        intercept: (_message, res) => {
          res.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" });
          res.end(sse ? `data: ${"x".repeat(1024 * 1024 + 10)}` : "x".repeat(1024 * 1024 + 10));
          return true;
        }
      });
      const result = await loadMcpTools(config(url));
      expect(result.tools).toEqual([]);
      expect(result.problems[0]).toContain("larger than 1 MiB");
    }
  });
});
