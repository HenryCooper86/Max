/**
 * Tools: functions the assistant can call in the middle of a conversation —
 * look up an order, book a table, check stock, turn on a light.
 *
 * There are three ways to give the assistant a tool, and a session can mix
 * them freely:
 *
 * 1. **Code tools** — a TypeScript/JavaScript module named by `toolsModule` in
 *    `assistant.config.json`, whose default export is a list made with
 *    `defineTools`. The handler runs inside the relay.
 *
 *    ```ts
 *    // agent-tools.ts
 *    import { defineTool, defineTools } from "./server/tools";
 *
 *    export default defineTools([
 *      defineTool({
 *        name: "get_order_status",
 *        description: "Look up the status of an order by its number.",
 *        parameters: {
 *          type: "object",
 *          properties: { orderId: { type: "string", description: "e.g. A-1042" } },
 *          required: ["orderId"]
 *        },
 *        async handler({ orderId }, context) {
 *          const response = await fetch(`https://api.example.com/orders/${orderId}`, { signal: context.signal });
 *          return response.json();
 *        }
 *      })
 *    ]);
 *    ```
 *
 * 2. **Webhook tools** — declared in `assistant.config.json` under `tools`,
 *    each with a `webhook.url` the relay POSTs the arguments to. Any language,
 *    any server. See server/tools/webhook.ts for the request and response.
 *
 * 3. **Client tools** — declared by the app itself in `session.start.tools`
 *    and executed in the browser or on the device (`tool.call` → `tool.result`).
 *    Use these for things only the client can do: navigate a page, fill a
 *    form, read a sensor.
 *
 * Whatever a tool returns is shown to the model as the tool's result. Throw
 * (or return `{ error }` from a webhook) to report a failure; the assistant is
 * told the tool failed and says so instead of inventing an answer.
 */

/** JSON Schema for a tool's arguments. Must describe an object. */
export type ToolParameters = Record<string, unknown>;

/** What the model is told about a tool. */
export type ToolSpec = {
  /** Letters, digits, `_` and `-`; starts with a letter or `_`; ≤ 64 chars. */
  name: string;
  /** What the tool does and when to use it. The model reads this. */
  description: string;
  /** JSON Schema for the arguments. Defaults to "no arguments". */
  parameters: ToolParameters;
};

/** A tool the client runs, as its `session.start` declared it. */
export type ClientToolDeclaration = ToolSpec & {
  /** The conversation does not wait for it: see `background` on {@link ToolDefinition}. */
  background?: boolean;
};

/** What a code tool's handler gets besides its arguments. */
export type ToolContext = {
  /** Unique id of this call. */
  callId: string;
  /** The relay session the call belongs to. */
  sessionId: string;
  /** Language the session is speaking ("en", "zh", …), when known. */
  language?: string;
  /** The signed-in user, or the `userId` stamped on the session token. */
  userId?: string;
  /** Aborted when the call times out or the session ends. Pass it to fetch(). */
  signal: AbortSignal;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
};

/** A tool implemented in code, inside the relay. */
export type ToolDefinition<Args extends Record<string, unknown> = Record<string, unknown>> = {
  name: string;
  description: string;
  parameters?: ToolParameters;
  /** Overrides the default 15 s time limit. */
  timeoutMs?: number;
  /**
   * For work that takes longer than anyone should wait in silence: a report,
   * a booking, a search of a slow system. The assistant is told at once that
   * the work has started and carries on talking; when the handler finishes,
   * the assistant is given the result and tells the user at the next quiet
   * moment. Give such a tool a generous `timeoutMs`.
   */
  background?: boolean;
  /** Returns anything JSON-serialisable (or a string). Throw to fail. */
  handler(args: Args, context: ToolContext): unknown;
};

/** Identity helper that gives a tool definition full type checking. */
export function defineTool<Args extends Record<string, unknown> = Record<string, unknown>>(
  tool: ToolDefinition<Args>
): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

/** Identity helper for a module's default export. */
export function defineTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools;
}
