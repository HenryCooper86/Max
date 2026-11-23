import type { ToolContext, ToolDefinition, ToolParameters } from "./index";
import { MAX_TOOL_DESCRIPTION, toolSpecFrom } from "./schema";
import { stdioConnection, StdioError, type RpcMessage } from "./mcp-stdio";
import { expandEnv, urlAllowed } from "./webhook";

/**
 * MCP servers as tool sources. The owner lists a server under
 * `mcpServers` in `assistant.config.json`; at startup the relay connects,
 * asks it which tools it has (`tools/list`) and registers each one as an
 * ordinary relay tool whose handler forwards the call (`tools/call`). That
 * gives the assistant the whole MCP ecosystem (calendars, CRMs, search) with
 * no glue code.
 *
 * Transport — MCP "Streamable HTTP", protocol revision 2025-06-18. Every
 * message is a `POST <url>` carrying one JSON-RPC 2.0 message. The server
 * answers with either one `application/json` body or a `text/event-stream`
 * whose events may include notifications before the response we are waiting
 * for. Only that response is used.
 *
 * Session — `initialize`, then the `notifications/initialized` notification.
 * A server may hand out an `mcp-session-id`, and every later request echoes
 * it together with `mcp-protocol-version`. If the server forgets the session
 * (it restarted or the session expired: HTTP 404, or 400) the relay performs
 * the handshake again once and retries the request once, so a long-lived relay
 * outlives its servers' restarts.
 *
 * `${NAME}` in the URL or a header value is replaced with the relay's
 * environment variable on every request, as for webhooks, so a rotated key
 * applies without a restart.
 *
 * Errors reach the model, so they name the server and, at most, an HTTP
 * status: never a header value, nor the URL (its query string may carry a key).
 *
 * A server can instead be a program on the relay's own machine: an entry with
 * a `command` in place of a `url` is started by the relay and spoken to over
 * its stdin and stdout (see mcp-stdio.ts). Only the config file can name a
 * command; nothing that arrives over the network can.
 */

type McpHttpServer = {
  /** May contain `${ENV}` placeholders. */
  url: string;
  /** Values may contain `${ENV}` placeholders. */
  headers: Record<string, string>;
};

type McpStdioServer = {
  /** The program to start, as a path or a name looked up on PATH. Never run through a shell. */
  command: string;
  args: string[];
  /** Added to the small environment the process gets. Values may contain `${ENV}` placeholders. */
  env: Record<string, string>;
  /** The directory to start it in. Absent: the relay's own. */
  cwd?: string;
};

export type McpServerConfig = (McpHttpServer | McpStdioServer) & {
  /** Letters, digits, `_` and `-`; used in logs and problems. */
  name: string;
  /** MCP tool names (as the server lists them) to expose; absent = all. */
  allowedTools?: string[];
  /** When set, exposed tool names are `${prefix}_${mcpName}`. */
  prefix?: string;
  /** Per request. */
  timeoutMs: number;
  /** MCP tool names the conversation does not wait for (see `background` on a tool). */
  backgroundTools?: string[];
  /** Per call of a background tool. Two minutes when absent. */
  backgroundTimeoutMs?: number;
};

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 15_000;
/** A background tool is not holding the conversation up, so it may take longer. */
const DEFAULT_BACKGROUND_TIMEOUT_MS = 120_000;
const MAX_BACKGROUND_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_LIST_PAGES = 10;
const MAX_TOOLS_PER_SERVER = 64;
const SERVER_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const PREFIX = /^[a-zA-Z_][a-zA-Z0-9_]{0,23}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_COMMAND_CHARS = 500;
const MAX_ARGS = 64;
const MAX_ARG_CHARS = 2000;
const MAX_ENV_ENTRIES = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Parses one `mcpServers[]` entry of the config file. */
/** Where the server is: a `url`, or a `command` the relay starts itself. */
function mcpTransportFrom(
  raw: Record<string, unknown>,
  name: string
): McpHttpServer | McpStdioServer | { problem: string } {
  const has = (key: string) => raw[key] !== undefined && raw[key] !== null;
  if (has("command")) {
    if (has("url")) return { problem: `mcp server ${name}: takes a url or a command, not both` };
    if (has("headers")) return { problem: `mcp server ${name}: headers go with a url, not with a command` };
    if (typeof raw.command !== "string" || !raw.command.trim() || raw.command.length > MAX_COMMAND_CHARS)
      return { problem: `mcp server ${name}: command must be the program to run` };
    let args: string[] = [];
    if (has("args")) {
      if (
        !Array.isArray(raw.args) ||
        raw.args.length > MAX_ARGS ||
        !raw.args.every((item) => typeof item === "string" && item.length <= MAX_ARG_CHARS)
      )
        return { problem: `mcp server ${name}: args must be a list of at most ${MAX_ARGS} texts` };
      args = raw.args as string[];
    }
    const env: Record<string, string> = {};
    if (has("env")) {
      if (!isRecord(raw.env) || Object.keys(raw.env).length > MAX_ENV_ENTRIES)
        return { problem: `mcp server ${name}: env must be an object of at most ${MAX_ENV_ENTRIES} variables` };
      for (const [variable, value] of Object.entries(raw.env)) {
        if (!ENV_NAME.test(variable) || typeof value !== "string")
          return { problem: `mcp server ${name}: invalid env variable ${variable.slice(0, 40)}` };
        env[variable] = value;
      }
    }
    if (has("cwd") && (typeof raw.cwd !== "string" || !raw.cwd.trim()))
      return { problem: `mcp server ${name}: cwd must be a directory` };
    return {
      command: raw.command.trim(),
      args,
      env,
      ...(typeof raw.cwd === "string" ? { cwd: raw.cwd.trim() } : {})
    };
  }
  for (const key of ["args", "env", "cwd"]) {
    if (has(key)) return { problem: `mcp server ${name}: ${key} goes with a command, not with a url` };
  }
  if (typeof raw.url !== "string" || !raw.url.trim())
    return { problem: `mcp server ${name}: needs a url, or a command to run` };
  const url = raw.url.trim();
  // Shape is checked now with variables blanked; they are expanded per request.
  let parsed: URL;
  try {
    parsed = new URL(url.replace(PLACEHOLDER, "x"));
  } catch {
    return { problem: `mcp server ${name}: url is not a URL` };
  }
  if (!urlAllowed(parsed))
    return { problem: `mcp server ${name}: url must be https (plain http only to local or private hosts)` };
  const headers: Record<string, string> = {};
  if (has("headers")) {
    if (!isRecord(raw.headers)) return { problem: `mcp server ${name}: headers must be an object` };
    for (const [header, value] of Object.entries(raw.headers)) {
      if (!HEADER_NAME.test(header) || typeof value !== "string")
        return { problem: `mcp server ${name}: invalid header ${header}` };
      headers[header] = value;
    }
  }
  return { url, headers };
}

export function mcpServerFrom(raw: unknown): { server?: McpServerConfig; problem?: string } {
  if (!isRecord(raw)) return { problem: "mcpServers: each entry must be an object" };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!SERVER_NAME.test(name))
    return {
      problem: `mcpServers: invalid name ${JSON.stringify(raw.name ?? "")} (letters, digits, _ and -; starts with a letter; at most 32)`
    };
  const transport = mcpTransportFrom(raw, name);
  if ("problem" in transport) return { problem: transport.problem };
  let allowedTools: string[] | undefined;
  if (raw.allowedTools !== undefined) {
    if (
      !Array.isArray(raw.allowedTools) ||
      !raw.allowedTools.every((item) => typeof item === "string" && item.trim() !== "")
    )
      return { problem: `mcp server ${name}: allowedTools must be a list of tool names` };
    allowedTools = (raw.allowedTools as string[]).map((item) => item.trim());
  }
  let prefix: string | undefined;
  if (raw.prefix !== undefined) {
    if (typeof raw.prefix !== "string" || !PREFIX.test(raw.prefix))
      return {
        problem: `mcp server ${name}: invalid prefix ${JSON.stringify(raw.prefix)} (letters, digits and _; at most 24)`
      };
    prefix = raw.prefix;
  }
  let backgroundTools: string[] | undefined;
  if (raw.backgroundTools !== undefined) {
    if (
      !Array.isArray(raw.backgroundTools) ||
      !raw.backgroundTools.every((item) => typeof item === "string" && item.trim() !== "")
    )
      return { problem: `mcp server ${name}: backgroundTools must be a list of tool names` };
    backgroundTools = (raw.backgroundTools as string[]).map((item) => item.trim());
    const hidden = backgroundTools.filter((item) => allowedTools && !allowedTools.includes(item));
    if (hidden.length > 0)
      return {
        problem: `mcp server ${name}: backgroundTools names ${hidden.join(", ")}, which allowedTools leaves out`
      };
  }
  const timeout = Number(raw.timeoutMs);
  const backgroundTimeout = Number(raw.backgroundTimeoutMs);
  return {
    server: {
      name,
      ...transport,
      ...(allowedTools ? { allowedTools } : {}),
      ...(prefix ? { prefix } : {}),
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
      ...(backgroundTools
        ? {
            backgroundTools,
            backgroundTimeoutMs:
              Number.isFinite(backgroundTimeout) && backgroundTimeout > 0
                ? Math.min(backgroundTimeout, MAX_BACKGROUND_TIMEOUT_MS)
                : DEFAULT_BACKGROUND_TIMEOUT_MS
          }
        : {})
    }
  };
}

/** An error whose text is already safe to show the model. */
class McpError extends Error {}

type Posted = { status: number; headers: Headers; message?: RpcMessage };

/** Pulls the JSON-RPC response for `id` out of a (possibly partial) SSE buffer. */
function findInEvents(buffer: string, id: number): { message?: RpcMessage; rest: string } {
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf("\n\n");
    if (end < 0) return { rest };
    const event = rest.slice(0, end);
    rest = rest.slice(end + 2);
    const message = messageOfEvent(event, id);
    if (message) return { message, rest };
  }
}

function messageOfEvent(event: string, id: number): RpcMessage | undefined {
  const data: string[] = [];
  for (const line of event.split("\n")) {
    if (!line.startsWith("data:")) continue;
    data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    return undefined;
  }
  return responseFor(parsed, id);
}

/** Notifications and server-to-client requests carry a `method`; only a
 *  result or error with our id counts. */
function responseFor(parsed: unknown, id: number): RpcMessage | undefined {
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of candidates) {
    if (isRecord(item) && item.id === id && !("method" in item) && ("result" in item || "error" in item))
      return item as RpcMessage;
  }
  return undefined;
}

/** Reads the response body, never more than the cap, and stops at our answer. */
async function readResponse(response: Response, id: number, sse: boolean): Promise<RpcMessage | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let total = 0;
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new McpError(`response is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB`);
    }
    buffer += decoder.decode(value, { stream: true });
    if (!sse) continue;
    // A CR at the very end may be half of a CRLF that continues in the next chunk.
    if (buffer.endsWith("\r")) continue;
    buffer = buffer.replace(/\r\n?/g, "\n");
    const found = findInEvents(buffer, id);
    if (found.message) {
      await reader.cancel().catch(() => undefined);
      return found.message;
    }
    buffer = found.rest;
  }
  buffer += decoder.decode();
  if (sse) return findInEvents(`${buffer.replace(/\r\n?/g, "\n")}\n\n`, id).message;
  if (!buffer.trim()) return undefined;
  try {
    return responseFor(JSON.parse(buffer), id);
  } catch {
    throw new McpError("answered with something that is not JSON");
  }
}

function textOf(content: unknown): { texts: string[]; parts: string[] } {
  const texts: string[] = [];
  const parts: string[] = [];
  if (!Array.isArray(content)) return { texts, parts };
  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
      parts.push(item.text);
    } else {
      parts.push(`[${isRecord(item) && typeof item.type === "string" ? item.type : "content"}]`);
    }
  }
  return { texts, parts };
}

/** One server, whichever way it is reached. */
type McpClient = {
  /** Connects and introduces the relay. Rejects when the server is not there. */
  start(): Promise<void>;
  rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
  close(): void;
};

const clientInfo = (version: string | undefined) => ({
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "max-voice-agent-relay", version: version ?? "0.0.0" }
});

function httpClient(
  server: McpHttpServer & { timeoutMs: number },
  label: string,
  options: { request?: typeof fetch; env?: NodeJS.ProcessEnv; clientVersion?: string }
): McpClient {
  const request = options.request ?? fetch;
  const env = options.env ?? process.env;
  const session: { id?: string; protocol?: string } = {};
  let nextId = 1;
  let handshaking: Promise<void> | undefined;

  /** One POST. Returns the status and, when `expect` is given, its JSON-RPC response. */
  async function post(
    body: Record<string, unknown>,
    expect: number | undefined,
    signal?: AbortSignal,
    timeoutMs = server.timeoutMs
  ): Promise<Posted> {
    const url = expandEnv(server.url, env);
    const missing = new Set(url.missing);
    const headers: Record<string, string> = {};
    for (const [header, value] of Object.entries(server.headers)) {
      const expanded = expandEnv(value, env);
      expanded.missing.forEach((item) => missing.add(item));
      headers[header] = expanded.value;
    }
    // Fail closed: a blank credential would send the request unauthenticated.
    if (missing.size) throw new McpError(`relay is missing environment variable ${[...missing].join(", ")}`);
    let target: URL;
    try {
      target = new URL(url.value);
    } catch {
      throw new McpError(`${label} URL is not a URL once its variables are filled in`);
    }
    if (!urlAllowed(target))
      throw new McpError(`${label} URL must be https (plain http only to local or private hosts)`);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      const response = await request(target.href, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(session.protocol ? { "mcp-protocol-version": session.protocol } : {}),
          ...(session.id ? { "mcp-session-id": session.id } : {})
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        signal: combined,
        redirect: "error"
      });
      if (!response.ok || expect === undefined) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status, headers: response.headers };
      }
      const sse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
      const message = await readResponse(response, expect, sse);
      return { status: response.status, headers: response.headers, message };
    } catch (error) {
      if (error instanceof McpError) throw new McpError(`${label}: ${error.message}`);
      if (timeout.aborted) throw new McpError(`${label} did not answer within ${timeoutMs / 1000} s`);
      if (signal?.aborted) throw new McpError(`call to the ${label} was cancelled`);
      throw new McpError(`could not reach the ${label}`);
    }
  }

  function failure(posted: Posted, method: string): McpError {
    if (!posted.message) {
      return new McpError(
        posted.status >= 200 && posted.status < 300
          ? `${label} sent no answer to ${method}`
          : `${label} answered HTTP ${posted.status} to ${method}`
      );
    }
    const error = posted.message.error;
    const text = isRecord(error) && typeof error.message === "string" ? error.message : `${method} failed`;
    return new McpError(text);
  }

  async function handshake(): Promise<void> {
    session.id = undefined;
    session.protocol = undefined;
    const id = nextId++;
    const init = await post(
      {
        id,
        method: "initialize",
        params: clientInfo(options.clientVersion)
      },
      id
    );
    if (init.status < 200 || init.status >= 300 || !init.message || init.message.error !== undefined)
      throw failure(init, "initialize");
    const result = init.message.result;
    session.protocol =
      isRecord(result) && typeof result.protocolVersion === "string" && result.protocolVersion
        ? result.protocolVersion
        : PROTOCOL_VERSION;
    session.id = init.headers.get("mcp-session-id") ?? undefined;
    const ack = await post({ method: "notifications/initialized" }, undefined);
    if (ack.status < 200 || ack.status >= 300)
      throw new McpError(`${label} answered HTTP ${ack.status} to notifications/initialized`);
  }

  const reconnect = (): Promise<void> => {
    handshaking ??= handshake().finally(() => {
      handshaking = undefined;
    });
    return handshaking;
  };

  async function rpc(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const usedSession = session.id;
      const id = nextId++;
      const posted = await post({ id, method, params }, id, signal, timeoutMs);
      // The session is gone: handshake once more and retry once.
      if (usedSession && (posted.status === 404 || posted.status === 400) && attempt === 0) {
        if (session.id === usedSession) await reconnect();
        continue;
      }
      if (posted.status < 200 || posted.status >= 300 || !posted.message || posted.message.error !== undefined)
        throw failure(posted, method);
      return posted.message.result;
    }
  }

  return { start: handshake, rpc, close: () => undefined };
}

function stdioClient(
  server: McpStdioServer & { timeoutMs: number },
  label: string,
  options: { env?: NodeJS.ProcessEnv; clientVersion?: string; onLog?: (line: string) => void; now?: () => number }
): McpClient {
  const env = options.env ?? process.env;
  let nextId = 1;
  /** The start of the process that the relay has introduced itself to. */
  let introduced = 0;
  let handshaking: Promise<void> | undefined;
  const connection = stdioConnection(
    label,
    () => {
      const missing = new Set<string>();
      const extra: Record<string, string> = {};
      for (const [variable, value] of Object.entries(server.env)) {
        const expanded = expandEnv(value, env);
        expanded.missing.forEach((item) => missing.add(item));
        extra[variable] = expanded.value;
      }
      // Fail closed: a server started with a blank credential would run unauthenticated.
      if (missing.size) throw new McpError(`relay is missing environment variable ${[...missing].join(", ")}`);
      return { command: server.command, args: server.args, env: extra, ...(server.cwd ? { cwd: server.cwd } : {}) };
    },
    { env, onLog: options.onLog, now: options.now }
  );

  const failure = (message: RpcMessage, method: string): McpError => {
    const error = message.error;
    return new McpError(isRecord(error) && typeof error.message === "string" ? error.message : `${method} failed`);
  };

  async function handshake(): Promise<void> {
    await connection.start();
    const generation = connection.generation();
    const id = nextId++;
    const init = await connection.request(
      { id, method: "initialize", params: clientInfo(options.clientVersion) },
      server.timeoutMs
    );
    if (init.error !== undefined) throw failure(init, "initialize");
    connection.notify({ method: "notifications/initialized" });
    introduced = generation;
  }

  /** The process is running and knows the relay: a process started again is a stranger. */
  async function ready(): Promise<void> {
    await connection.start();
    if (connection.generation() === introduced) return;
    handshaking ??= handshake().finally(() => {
      handshaking = undefined;
    });
    await handshaking;
  }

  const told = (error: unknown): unknown => (error instanceof StdioError ? new McpError(error.message) : error);

  return {
    start: () => ready().catch((error: unknown) => Promise.reject(told(error))),
    async rpc(method, params, signal, timeoutMs = server.timeoutMs) {
      try {
        await ready();
        const answer = await connection.request({ id: nextId++, method, params }, timeoutMs, signal);
        if (answer.error !== undefined) throw failure(answer, method);
        return answer.result;
      } catch (error) {
        throw told(error);
      }
    },
    close: () => connection.close()
  };
}

/**
 * Connects to one MCP server and turns its tools into relay tools. Never
 * throws: a server that is down gives no tools and one problem, so one
 * broken integration cannot keep the relay from starting. `close` ends what
 * the relay started for the server (a process, for a `command`).
 */
export async function loadMcpTools(
  server: McpServerConfig,
  options: {
    request?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    clientVersion?: string;
    /** What a server run as a process writes to its log. */
    onLog?: (line: string) => void;
    /** The clock that spaces out the starts of a process. */
    now?: () => number;
  } = {}
): Promise<{ tools: ToolDefinition[]; problems: string[]; close(): void; unavailable?: true }> {
  const label = `${server.name} MCP server`;
  const problems: string[] = [];
  const client = "command" in server ? stdioClient(server, label, options) : httpClient(server, label, options);
  const rpc = client.rpc;

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
    timeoutMs: number
  ): Promise<unknown> {
    const result = await rpc("tools/call", { name, arguments: args }, context.signal, timeoutMs);
    if (!isRecord(result)) throw new McpError(`${label} sent an unreadable result for ${name}`);
    const { texts, parts } = textOf(result.content);
    if (result.isError === true) throw new Error(texts.join("\n") || `${name} failed on the ${label}`);
    if (!texts.length && isRecord(result.structuredContent)) return result.structuredContent;
    return parts.join("\n");
  }

  const tools: ToolDefinition[] = [];
  try {
    await client.start();
    const listed: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await rpc("tools/list", cursor ? { cursor } : {});
      pages++;
      if (isRecord(page) && Array.isArray(page.tools)) listed.push(...page.tools);
      cursor = isRecord(page) && typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor && pages < MAX_LIST_PAGES);
    if (cursor) problems.push(`${label}: more than ${MAX_LIST_PAGES} pages of tools; the rest are ignored`);

    const seen = new Set<string>();
    for (const item of listed) {
      if (!isRecord(item) || typeof item.name !== "string") {
        problems.push(`${label}: skipped a tool without a name`);
        continue;
      }
      const mcpName = item.name;
      if (server.allowedTools && !server.allowedTools.includes(mcpName)) continue;
      if (tools.length >= MAX_TOOLS_PER_SERVER) {
        problems.push(`${label}: more than ${MAX_TOOLS_PER_SERVER} tools; the rest are ignored`);
        break;
      }
      const exposed = server.prefix ? `${server.prefix}_${mcpName}` : mcpName;
      const described = [item.description, item.title].find((text) => typeof text === "string" && text.trim());
      const description = (
        typeof described === "string" ? described.trim() : `${mcpName} (from the ${server.name} MCP server)`
      ).slice(0, MAX_TOOL_DESCRIPTION);
      const { spec, problem } = toolSpecFrom({ name: exposed, description, parameters: item.inputSchema });
      if (!spec) {
        problems.push(`${label}: skipped tool ${mcpName}: ${problem}`);
        continue;
      }
      if (seen.has(spec.name)) {
        problems.push(`${label}: skipped tool ${mcpName}: name ${spec.name} is already used`);
        continue;
      }
      seen.add(spec.name);
      const background = server.backgroundTools?.includes(mcpName) === true;
      const timeoutMs = background ? (server.backgroundTimeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS) : server.timeoutMs;
      tools.push({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters as ToolParameters,
        timeoutMs,
        ...(background ? { background: true } : {}),
        handler: (args, context) => callTool(mcpName, args, context, timeoutMs)
      });
    }
    for (const name of server.backgroundTools ?? []) {
      if (!listed.some((item) => isRecord(item) && item.name === name))
        problems.push(`${label}: backgroundTools names ${name}, which the server does not have`);
    }
  } catch (error) {
    // Nothing of the server is in use: what was started for it is not left running.
    client.close();
    return {
      tools: [],
      problems: [`${label} is not available: ${error instanceof Error ? error.message : String(error)}`],
      close: () => undefined,
      // Worth another try later. A server that answered with tools none of which can be used is not.
      unavailable: true
    };
  }
  // A server with no tool the assistant can use serves nothing: its process is not kept.
  if (tools.length === 0) {
    client.close();
    return { tools, problems, close: () => undefined };
  }
  return { tools, problems, close: client.close };
}
