import type { ToolActivityEvent, ToolCallEvent, ToolResultEvent } from "../../shared/agent";
import type { Logger } from "../logger";
import type { ToolDefinition, ToolSpec } from "./index";
import { parseToolArguments, toolErrorText, toolOutputText } from "./schema";

/**
 * One session's tools: the relay's own plus the ones the client declared, and
 * the bookkeeping that runs a call wherever its tool lives.
 *
 * Every call ends in exactly one result for the model, whatever happens —
 * a handler that throws, a webhook that hangs, a client that never answers,
 * a session that closes mid-call. A model left waiting on a tool result
 * stalls the whole conversation.
 */

const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

type ToolCall = {
  /** The upstream's id for the call; echoed in the result. */
  callId: string;
  name: string;
  /** JSON text (realtime APIs) or an already parsed object (Gemini). */
  arguments: unknown;
};

type ToolOutcome = { ok: boolean; output: string };

export type ToolBrokerOptions = {
  sessionId: string;
  serverTools: () => readonly ToolDefinition[];
  clientTools: readonly ToolSpec[];
  send(event: ToolCallEvent | ToolActivityEvent): void;
  language?: () => string | undefined;
  userId?: string;
  log: Logger;
  clientTimeoutMs?: number;
  now?: () => number;
  /** Whether the agent the conversation is with may use a tool right now.
   *  Absent: every tool. Read on every call, because the agent can change. */
  allowed?: (name: string) => boolean;
};

type PendingClientCall = { name: string; resolve(outcome: ToolOutcome): void; timer: NodeJS.Timeout };

export type ToolBroker = {
  /** Everything the model may call right now. */
  specs(): ToolSpec[];
  /** Everything any agent of this session may call, for upstreams whose tools
   *  cannot change once the session has started. */
  allSpecs(): ToolSpec[];
  /** Runs one call to completion. Never rejects. */
  run(call: ToolCall): Promise<ToolOutcome>;
  /** Whether a tool is one the conversation does not wait for (`background: true`). */
  runsInBackground(name: string): boolean;
  /** A client's answer to a `tool.call`. Unknown or late answers are ignored. */
  clientResult(event: ToolResultEvent): void;
  /** Ends every call in flight with an error result. */
  close(): void;
};

export function createToolBroker(options: ToolBrokerOptions): ToolBroker {
  const now = options.now ?? Date.now;
  const clientTimeoutMs = options.clientTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const pendingClient = new Map<string, PendingClientCall>();
  const running = new Set<AbortController>();
  let closed = false;

  function serverTool(name: string): ToolDefinition | undefined {
    return options.serverTools().find((tool) => tool.name === name);
  }

  function clientTool(name: string): ToolSpec | undefined {
    if (serverTool(name)) return undefined;
    return options.clientTools.find((tool) => tool.name === name);
  }

  function activity(
    call: ToolCall,
    where: ToolActivityEvent["where"],
    state: ToolActivityEvent["state"],
    extra: { durationMs?: number; error?: string } = {}
  ): void {
    options.send({ type: "tool.activity", callId: call.callId, name: call.name, where, state, ...extra });
  }

  async function runServer(tool: ToolDefinition, call: ToolCall, args: Record<string, unknown>): Promise<ToolOutcome> {
    const controller = new AbortController();
    running.add(controller);
    const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      const output = await Promise.race([
        Promise.resolve().then(() =>
          tool.handler(args, {
            callId: call.callId,
            sessionId: options.sessionId,
            language: options.language?.(),
            userId: options.userId,
            signal: controller.signal,
            log: {
              info: (message, fields) => options.log.info(`[tool ${tool.name}] ${message}`, fields),
              warn: (message, fields) => options.log.warn(`[tool ${tool.name}] ${message}`, fields)
            }
          })
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Reject first: the abort below would otherwise report "session ended".
            reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`));
            controller.abort();
          }, timeoutMs);
          // close() settles the call at once, even if the handler ignores its signal.
          controller.signal.addEventListener("abort", () => reject(new Error("the session ended")), { once: true });
        })
      ]);
      return { ok: true, output: toolOutputText(output) };
    } finally {
      if (timer) clearTimeout(timer);
      running.delete(controller);
    }
  }

  function runClient(call: ToolCall, args: Record<string, unknown>): Promise<ToolOutcome> {
    return new Promise<ToolOutcome>((resolve) => {
      const timer = setTimeout(() => {
        pendingClient.delete(call.callId);
        resolve({ ok: false, output: toolErrorText(`the app did not answer within ${clientTimeoutMs / 1000} s`) });
      }, clientTimeoutMs);
      pendingClient.set(call.callId, { name: call.name, resolve, timer });
      options.send({ type: "tool.call", callId: call.callId, name: call.name, arguments: args });
    });
  }

  function everySpec(): ToolSpec[] {
    const specs: ToolSpec[] = options.serverTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} }
    }));
    const taken = new Set(specs.map((spec) => spec.name));
    for (const tool of options.clientTools) if (!taken.has(tool.name)) specs.push(tool);
    return specs;
  }

  return {
    specs() {
      const allowed = options.allowed;
      return allowed ? everySpec().filter((spec) => allowed(spec.name)) : everySpec();
    },

    allSpecs: everySpec,

    runsInBackground: (name) => serverTool(name)?.background === true,

    async run(call) {
      if (closed) return { ok: false, output: toolErrorText("the session ended") };
      const startedAt = now();
      const server = serverTool(call.name);
      const client = server ? undefined : clientTool(call.name);
      const where: ToolActivityEvent["where"] = server ? "server" : "client";
      if (!server && !client) {
        options.log.warn("model called an unknown tool", { tool: call.name });
        return { ok: false, output: toolErrorText(`there is no tool called ${call.name}`) };
      }
      if (options.allowed && !options.allowed(call.name)) {
        // Only reachable on upstreams that were offered every agent's tools up front.
        return {
          ok: false,
          output: toolErrorText(`${call.name} is not available to the agent handling this conversation`)
        };
      }
      activity(call, where, "started");
      let outcome: ToolOutcome;
      try {
        const args = parseToolArguments(call.arguments);
        outcome = server ? await runServer(server, call, args) : await runClient(call, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.log.warn("tool failed", { tool: call.name, where, message });
        outcome = { ok: false, output: toolErrorText(message) };
      }
      const durationMs = Math.max(0, now() - startedAt);
      if (outcome.ok) activity(call, where, "succeeded", { durationMs });
      else {
        let reason = "failed";
        try {
          reason = String((JSON.parse(outcome.output) as { error?: unknown }).error ?? reason);
        } catch {
          /* keep the generic reason */
        }
        // A client tool's reason came from the client. A server tool's can hold
        // internal detail (a webhook's error body, a missing variable's name,
        // an internal address): the model and the log get it, the browser not.
        activity(call, where, "failed", { durationMs, error: where === "client" ? reason.slice(0, 200) : "failed" });
      }
      return outcome;
    },

    clientResult(event) {
      const pending = pendingClient.get(event.callId);
      if (!pending) return;
      pendingClient.delete(event.callId);
      clearTimeout(pending.timer);
      if (typeof event.error === "string" && event.error.trim()) {
        pending.resolve({ ok: false, output: toolErrorText(event.error) });
      } else {
        pending.resolve({ ok: true, output: toolOutputText(event.output) });
      }
    },

    close() {
      closed = true;
      for (const controller of running) controller.abort();
      running.clear();
      for (const [callId, pending] of pendingClient) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, output: toolErrorText("the session ended") });
        pendingClient.delete(callId);
      }
    }
  };
}
