// Max Cloud tools: a project's no-code webhook tools, run on the relay.
//
// The relay calls addresses a customer typed, so every call goes through
// guardedFetch: https only, the host's addresses resolved and checked against
// private, loopback and link-local ranges, and the connection made to the
// address that was checked (a name that re-resolves somewhere private between
// the check and the connect cannot slip through). No redirects, and the
// relay's environment is never expanded into a customer's URL.

import dns from "node:dns";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { privateAddress, studioToolParameters, toolUrlProblem, type ProjectStudio } from "../../shared/cloud-studio";
import type { ToolContext, ToolDefinition } from "../tools";
import { callWebhook, type WebhookConfig } from "../tools/webhook";

const TOOL_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** dns.lookup that refuses names resolving to any non-public address. */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((entry) => privateAddress(entry.address))) {
      const refused = Object.assign(new Error(`${hostname} resolves to a private address`), { code: "EPRIVATE" });
      callback(refused, "", 0);
      return;
    }
    if ((options as { all?: boolean }).all) {
      (callback as unknown as (error: null, addresses: dns.LookupAddress[]) => void)(null, list);
      return;
    }
    callback(null, list[0]!.address, list[0]!.family);
  });
};

/** A network failure in words a person setting up their first tool can act on. */
function plainNetworkError(error: NodeJS.ErrnoException, host: string): string {
  switch (error.code) {
    case "EPRIVATE":
      return "tool address must be public, not a private one";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `${host} could not be found: check the address`;
    case "ECONNREFUSED":
      return `nothing is answering at ${host}: is your server running?`;
    case "ECONNRESET":
      return `${host} closed the connection`;
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return `${host} has an https certificate that cannot be trusted`;
    default:
      return error.message;
  }
}

/**
 * A fetch for customer-supplied addresses: POSTs over https to public
 * addresses only, follows no redirects, and caps the response. Returns a
 * standard Response so callWebhook can read it like any other.
 */
export const guardedFetch: typeof fetch = (input, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const problem = toolUrlProblem(target.href);
    if (problem) {
      reject(new Error(`tool address ${problem}`));
      return;
    }
    const headers = new Headers(init.headers);
    const outgoing: Record<string, string> = {};
    headers.forEach((value, name) => {
      outgoing[name] = value;
    });
    const body = typeof init.body === "string" ? init.body : "";
    outgoing["content-length"] = String(Buffer.byteLength(body));
    const request = https.request(
      target,
      { method: init.method ?? "POST", headers: outgoing, lookup: publicOnlyLookup, timeout: TOOL_TIMEOUT_MS },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            request.destroy(new Error(`response is larger than ${MAX_RESPONSE_BYTES / 1024} KiB`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") responseHeaders.set(name, value);
          }
          const status = response.statusCode ?? 502;
          // Response cannot carry 1xx and some 3xx codes: report those as a failure the agent can read.
          const usable = status >= 200 && status <= 599 && ![204, 205, 304].includes(status);
          resolve(
            new Response(usable ? Buffer.concat(chunks) : null, {
              status: usable ? status : status < 300 ? 200 : 502,
              headers: responseHeaders
            })
          );
        });
        response.on("error", reject);
      }
    );
    // An answer of "101 Switching Protocols" is no answer to a POST. With nobody listening for it Node would drop
    // the connection and tell no one, and whoever asked would wait for ever.
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("the server tried to switch protocols instead of answering"));
    });
    // Whatever else ends a request with neither an answer nor an error. After either, this does nothing.
    request.on("close", () => reject(new Error("the connection closed without an answer")));
    request.on("timeout", () => request.destroy(new Error("the tool did not answer within 10 seconds")));
    request.on("error", (error: NodeJS.ErrnoException) => reject(new Error(plainNetworkError(error, target.hostname))));
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) request.destroy(new Error("cancelled"));
      else signal.addEventListener("abort", () => request.destroy(new Error("cancelled")), { once: true });
    }
    request.end(body);
  });

function webhookFor(url: string, secret: string | undefined): WebhookConfig {
  return { url, method: "POST", headers: {}, ...(secret ? { secret } : {}), timeoutMs: TOOL_TIMEOUT_MS };
}

/** The project's tools as relay tool definitions, signed with its secret. */
export function projectServerTools(studio: ProjectStudio, secret: string | undefined): ToolDefinition[] {
  return studio.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: studioToolParameters(tool),
    timeoutMs: TOOL_TIMEOUT_MS,
    handler: (args: Record<string, unknown>, context: ToolContext) =>
      callWebhook(tool.name, webhookFor(tool.url, secret), args, context, guardedFetch, {})
  }));
}

/** One call of a project tool from the console's "Send test" button. */
export async function testProjectTool(
  studio: ProjectStudio,
  secret: string | undefined,
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: true; result: unknown; ms: number } | { ok: false; error: string; ms: number }> {
  const tool = studio.tools.find((candidate) => candidate.name === name);
  const started = Date.now();
  if (!tool) return { ok: false, error: `No tool named ${name}. Save the tool first.`, ms: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS + 1000);
  try {
    const result = await callWebhook(
      tool.name,
      webhookFor(tool.url, secret),
      args,
      { callId: `test_${started.toString(36)}`, sessionId: "console-test", signal: controller.signal },
      guardedFetch,
      {}
    );
    return { ok: true, result, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
