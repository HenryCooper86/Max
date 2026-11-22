import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { ToolContext, ToolDefinition, ToolParameters } from "./index";
import { toolSpecFrom } from "./schema";

/**
 * Webhook tools: the relay POSTs the call to a URL the owner configured and
 * hands whatever comes back to the model. The tool can live in any language
 * on any server.
 *
 * Request — `POST <url>`, `content-type: application/json`:
 *
 * ```json
 * {
 *   "tool": "get_order_status",
 *   "callId": "call_8f2…",
 *   "arguments": { "orderId": "A-1042" },
 *   "session": { "id": "4b1e…", "language": "en", "userId": "user-17" }
 * }
 * ```
 *
 * With `webhook.secret` set, the request carries
 * `x-voice-agent-signature: sha256=<hex HMAC-SHA256 of the raw body>` and
 * `x-voice-agent-timestamp: <epoch ms>` (also part of the signed payload:
 * the HMAC covers `<timestamp>.<body>`), so the receiver can reject forgeries
 * and replays.
 *
 * Response — any 2xx status. A JSON body is passed to the model as JSON, any
 * other body as text. A non-2xx status fails the call; a JSON `{ "error": "…" }`
 * body becomes the reason the assistant is given.
 *
 * `${NAME}` anywhere in the URL, a header value or the secret is replaced with
 * the relay's environment variable `NAME`, so credentials stay in `.env` and
 * out of the config file.
 */

export type WebhookConfig = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  secret?: string;
  timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
/** A background tool is not holding the conversation up, so it may take longer. */
const DEFAULT_BACKGROUND_TIMEOUT_MS = 120_000;
const MAX_BACKGROUND_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Replaces `${NAME}` with the environment variable, or reports the missing names. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): { value: string; missing: string[] } {
  const missing: string[] = [];
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const found = env[name];
    if (found === undefined || found === "") {
      missing.push(name);
      return "";
    }
    return found;
  });
  return { value: expanded, missing };
}

/**
 * Plain HTTP is allowed only where the traffic never crosses the internet:
 * loopback, `.local`/`.internal` names, private address ranges and the
 * single-label service names of a Docker or Kubernetes network. Everything
 * else must be HTTPS, because the body carries what the user said.
 */
export function plainHttpAllowed(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(host);
  if (family === 4) {
    const [a = -1, b = -1] = host.split(".").map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (family === 6) return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host);
  // Names: only ones that cannot be registered on the public internet. A
  // dotted name such as 10.example.com is a public name, whatever it starts with.
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  return /^[a-z0-9-]+$/.test(host) && !/^\d+$/.test(host);
}

/** True when a URL may carry a call: https anywhere, plain http only to local
 *  or private hosts. Checked on the configured URL and again once expanded. */
export function urlAllowed(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && plainHttpAllowed(url.hostname));
}

/** The signature headers every relay webhook carries: an HMAC-SHA256 of
 *  `<timestamp>.<body>` keyed with the shared secret. */
export function signatureHeaders(body: string, secret: string, at: number): Record<string, string> {
  const timestamp = String(at);
  return {
    "x-voice-agent-timestamp": timestamp,
    "x-voice-agent-signature": `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`
  };
}

/** Parses one `tools[]` entry of the config file. */
export function webhookToolFrom(raw: unknown): { tool?: ToolDefinition; webhook?: WebhookConfig; problem?: string } {
  const { spec, problem } = toolSpecFrom(raw);
  if (!spec) return { problem };
  const record = raw as Record<string, unknown>;
  const hook = isRecord(record.webhook) ? record.webhook : typeof record.url === "string" ? { url: record.url } : null;
  if (!hook || typeof hook.url !== "string" || !hook.url.trim())
    return { problem: `tool ${spec.name}: needs webhook.url (or define it in toolsModule)` };
  const rawUrl = hook.url.trim();
  // Validate the shape now with variables blanked; they are expanded per call
  // so a key rotated in the environment takes effect without a restart.
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "x"));
  } catch {
    return { problem: `tool ${spec.name}: webhook.url is not a URL` };
  }
  if (!urlAllowed(parsed))
    return { problem: `tool ${spec.name}: webhook.url must be https (plain http only to local or private hosts)` };
  const headers: Record<string, string> = {};
  if (isRecord(hook.headers)) {
    for (const [name, value] of Object.entries(hook.headers)) {
      if (!HEADER_NAME.test(name) || typeof value !== "string")
        return { problem: `tool ${spec.name}: invalid webhook header ${name}` };
      headers[name] = value;
    }
  }
  if (record.background !== undefined && typeof record.background !== "boolean")
    return { problem: `tool ${spec.name}: background must be true or false` };
  const background = record.background === true;
  const timeout = Number(hook.timeoutMs);
  const longest = background ? MAX_BACKGROUND_TIMEOUT_MS : MAX_TIMEOUT_MS;
  const webhook: WebhookConfig = {
    url: rawUrl,
    method: "POST",
    headers,
    ...(typeof hook.secret === "string" && hook.secret.trim() ? { secret: hook.secret.trim() } : {}),
    timeoutMs:
      Number.isFinite(timeout) && timeout > 0
        ? Math.min(timeout, longest)
        : background
          ? DEFAULT_BACKGROUND_TIMEOUT_MS
          : DEFAULT_TIMEOUT_MS
  };
  return {
    webhook,
    tool: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters as ToolParameters,
      timeoutMs: webhook.timeoutMs,
      ...(background ? { background: true } : {}),
      handler: (args, context) => callWebhook(spec.name, webhook, args, context)
    }
  };
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response is larger than ${MAX_RESPONSE_BYTES / 1024} KiB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Performs one webhook call. Exported for tests. */
export async function callWebhook(
  name: string,
  webhook: WebhookConfig,
  args: Record<string, unknown>,
  context: Pick<ToolContext, "callId" | "sessionId" | "language" | "userId" | "signal">,
  request: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now
): Promise<unknown> {
  const url = expandEnv(webhook.url, env);
  const missing = new Set(url.missing);
  const headers: Record<string, string> = {};
  for (const [header, value] of Object.entries(webhook.headers)) {
    const expanded = expandEnv(value, env);
    expanded.missing.forEach((item) => missing.add(item));
    headers[header] = expanded.value;
  }
  const secret = webhook.secret ? expandEnv(webhook.secret, env) : undefined;
  secret?.missing.forEach((item) => missing.add(item));
  // Fail closed: a call with a blank credential would leak the request to an
  // endpoint expecting authentication, and its 401 would be harder to read.
  if (missing.size) throw new Error(`relay is missing environment variable ${[...missing].join(", ")}`);
  // A variable in the URL can name any host, so the rule is applied again to
  // what the URL actually became.
  let target: URL;
  try {
    target = new URL(url.value);
  } catch {
    throw new Error("webhook URL is not a URL once its variables are filled in");
  }
  if (!urlAllowed(target)) throw new Error("webhook URL must be https (plain http only to local or private hosts)");

  const body = JSON.stringify({
    tool: name,
    callId: context.callId,
    arguments: args,
    session: {
      id: context.sessionId,
      ...(context.language ? { language: context.language } : {}),
      ...(context.userId ? { userId: context.userId } : {})
    }
  });
  if (secret) Object.assign(headers, signatureHeaders(body, secret.value, now()));
  const response = await request(url.value, {
    method: webhook.method,
    headers: { "content-type": "application/json", accept: "application/json, text/plain", ...headers },
    body,
    signal: context.signal,
    redirect: "error"
  });
  const text = await readCapped(response);
  const isJson = (response.headers.get("content-type") ?? "").includes("json");
  let payload: unknown = text;
  if (isJson && text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const reason =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `HTTP ${response.status}${text.trim() ? `: ${text.trim().replace(/\s+/g, " ").slice(0, 160)}` : ""}`;
    throw new Error(reason);
  }
  return payload;
}
