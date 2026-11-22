import { WebSocket, type RawData } from "ws";
import type { ClientCallRecord, ToolActivityRecord, TurnRecord } from "./assertions";
import type { ClientToolSpec } from "./scenario";

/**
 * A text-mode client for the relay's `/agent` WebSocket (docs/protocol.md): it
 * starts a session without audio, sends typed turns and collects what the agent
 * does in response. It speaks the real protocol, so a scenario exercises the
 * same relay path a browser or phone does, minus speech.
 */

export type ClientOptions = {
  /** `ws://` or `wss://` base of the relay, without `/agent`. */
  relayUrl: string;
  token?: string;
  /** An HTTP endpoint that returns `{ "token": "..." }` to a POST; asked before each connection. */
  tokenUrl?: string;
  clientTools?: readonly ClientToolSpec[];
  context?: string;
  language?: string;
  /** Quiet time after a finished-looking reply before the turn closes, to catch a follow-up. Default 400. */
  settleMs?: number;
  /** A turn that produces nothing complete within this fails. Default 30000. */
  turnTimeoutMs?: number;
  /** How long to wait for `session.started`. Default 10000. */
  connectTimeoutMs?: number;
  /** Called with a one-line description of each relay event, for `--verbose`. */
  log?: (line: string) => void;
};

type RelayEvent = { type: string } & Record<string, unknown>;

const quietStates = new Set(["ready", "listening"]);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Decides when a typed turn is over. The relay has no "turn finished" event, so
 * a turn is complete when an agent reply is final, no tool is still running
 * and the status is back to `ready` or `listening`. A reply can be followed by
 * more (a line before a tool call, another after), so the caller still waits a
 * settle time and re-checks after every event.
 */
export class TurnTracker {
  status: string;
  private readonly finals = new Map<string, string>();
  readonly activity: ToolActivityRecord[] = [];
  readonly calls: ClientCallRecord[] = [];
  readonly telemetry: Record<string, unknown>[] = [];
  readonly errors: string[] = [];
  private readonly running = new Set<string>();
  lastFinalAt: number | undefined;
  /** Why the relay ended the conversation, once it has said so. */
  ended: string | undefined;

  constructor(
    status = "",
    private readonly clock: () => number = Date.now
  ) {
    this.status = status;
  }

  ingest(event: RelayEvent): void {
    switch (event.type) {
      case "status":
        this.status = str(event.state);
        break;
      case "transcript":
        // Partials are cumulative and keyed by turnId; only a final is a reply.
        if (event.speaker === "agent" && event.final === true && str(event.text).trim()) {
          const id = str(event.turnId) || `final-${this.finals.size}`;
          this.finals.set(id, str(event.text));
          this.lastFinalAt = this.clock();
        }
        break;
      case "tool.activity": {
        const record: ToolActivityRecord = {
          callId: str(event.callId),
          name: str(event.name),
          where: event.where === "client" ? "client" : "server",
          state: event.state === "succeeded" || event.state === "failed" ? event.state : "started"
        };
        if (typeof event.durationMs === "number") record.durationMs = event.durationMs;
        if (typeof event.error === "string") record.error = event.error;
        this.activity.push(record);
        if (record.state === "started") this.running.add(record.callId);
        else this.running.delete(record.callId);
        break;
      }
      case "telemetry": {
        const rest = { ...event } as Record<string, unknown>;
        delete rest.type;
        this.telemetry.push(rest);
        break;
      }
      case "error":
        this.errors.push(str(event.message) || "unknown error");
        break;
      case "session.ended":
        this.ended = str(event.reason) || "ended";
        break;
    }
  }

  get replies(): string[] {
    return [...this.finals.values()];
  }

  get toolRunning(): boolean {
    return this.running.size > 0;
  }

  /**
   * `complete`: a reply is in, nothing is running, the relay is idle again.
   * `failed`: the relay reported an error and nothing else is happening, so waiting
   * for the timeout would only hide the message.
   */
  get state(): "waiting" | "complete" | "failed" {
    if (this.running.size > 0) return "waiting";
    // An ended conversation has nothing more to say, whatever the status was.
    if (this.ended !== undefined) return "complete";
    if (this.finals.size > 0 && quietStates.has(this.status)) return "complete";
    if (this.finals.size === 0 && this.errors.length > 0) return "failed";
    return "waiting";
  }

  /** What has been seen so far, for a timeout message. */
  describe(): string {
    const parts = [`status "${this.status || "none"}"`];
    parts.push(this.finals.size ? `replies: ${this.replies.map((r) => JSON.stringify(r)).join(" / ")}` : "no reply");
    if (this.running.size) parts.push(`${this.running.size} tool call(s) still running`);
    if (this.activity.length) parts.push(`tools: ${this.activity.map((a) => `${a.name} ${a.state}`).join(", ")}`);
    if (this.errors.length) parts.push(`errors: ${this.errors.join("; ")}`);
    return parts.join("; ");
  }

  record(user: string, sentAt: number, failure?: string): TurnRecord {
    const replies = this.replies;
    return {
      user,
      reply: replies.join(" "),
      replies,
      activity: this.activity,
      calls: this.calls,
      telemetry: this.telemetry,
      errors: this.errors,
      ...(this.lastFinalAt !== undefined ? { latencyMs: Math.max(0, this.lastFinalAt - sentAt) } : {}),
      ...(this.ended !== undefined ? { sessionEnded: this.ended } : {}),
      ...(failure ? { failure } : {})
    };
  }
}

/** Explains the HTTP statuses the relay refuses an upgrade with (docs/protocol.md "Refusals"). */
function refusalMessage(status: number): string {
  const hint: Record<number, string> = {
    401: "a token is required and the one sent is missing, wrong or expired (pass --token, or --token-url)",
    403: "the Origin header is not allowed (RELAY_ALLOWED_ORIGINS)",
    429: "too many connection attempts from this address (RELAY_CONN_PER_MINUTE); retry in a minute or lower --concurrency",
    503: "the relay is shutting down; retry in a few seconds"
  };
  return `the relay refused the connection with HTTP ${status}${hint[status] ? `: ${hint[status]}` : ""}`;
}

async function fetchToken(tokenUrl: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(tokenUrl, { method: "POST", signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(`could not reach the token endpoint: ${error instanceof Error ? error.message : error}`, {
      cause: error
    });
  }
  if (!response.ok) throw new Error(`the token endpoint answered HTTP ${response.status}`);
  const body = (await response.json().catch(() => undefined)) as { token?: unknown } | undefined;
  if (typeof body?.token !== "string" || !body.token)
    throw new Error('the token endpoint did not return { "token": "…" }');
  return body.token;
}

export type SessionInfo = { provider: string; mode: string; capabilities: Record<string, unknown> };

/** How long a turn that expects the relay to end the conversation waits for it after the reply. */
const END_WAIT_MS = 10_000;

export class AgentTestClient {
  /** What the agent said before the first turn, if anything. */
  greeting: string | undefined;
  session: SessionInfo = { provider: "", mode: "", capabilities: {} };
  private tracker = new TurnTracker();
  private closeInfo: { code: number; reason: string } | undefined;
  private onChange: (() => void) | undefined;
  private onClosed: (() => void) | undefined;
  private onStarted: ((outcome: { error?: string }) => void) | undefined;
  private started = false;
  private readonly tools: ReadonlyMap<string, ClientToolSpec>;

  private constructor(
    private readonly ws: WebSocket,
    private readonly options: ClientOptions
  ) {
    this.tools = new Map((options.clientTools ?? []).map((tool) => [tool.name, tool]));
  }

  /** Connects, starts the session and waits for it to be ready. Throws a plain-language Error on any failure. */
  static async connect(options: ClientOptions): Promise<AgentTestClient> {
    const token = options.tokenUrl ? await fetchToken(options.tokenUrl) : options.token;
    const url = `${options.relayUrl.replace(/\/+$/, "")}/agent`;
    const ws = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const client = new AgentTestClient(ws, options);
    await client.start();
    return client;
  }

  private start(): Promise<void> {
    const { ws, options } = this;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners("unexpected-response");
        ws.terminate();
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail(`no session.started within ${options.connectTimeoutMs ?? 10_000} ms`),
        options.connectTimeoutMs ?? 10_000
      );
      this.onStarted = ({ error }) => {
        if (error) return fail(error);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.on("unexpected-response", (_request, response) => {
        response.resume();
        fail(refusalMessage(response.statusCode ?? 0));
      });
      ws.on("error", (error: Error & { code?: string }) => {
        const refused = error.code === "ECONNREFUSED" ? "connection refused: is the relay running?" : error.message;
        fail(`cannot connect to the relay: ${refused}`);
      });
      ws.on("open", () => {
        const tools = (options.clientTools ?? []).map(({ name, description, parameters }) => ({
          name,
          description,
          ...(parameters ? { parameters } : {})
        }));
        this.send({
          type: "session.start",
          sampleRate: 16000,
          channels: 1,
          appVersion: "agent-test",
          protocol: 1,
          ...(tools.length ? { tools } : {}),
          ...(options.context ? { context: options.context } : {}),
          ...(options.language ? { language: options.language } : {})
        });
      });
      ws.on("message", (data, isBinary) => this.receive(data, isBinary));
      ws.on("close", (code, reason) => {
        this.closeInfo = { code, reason: reason.toString() };
        if (!this.started) fail(`the relay closed the connection before the session started (${this.describeClose()})`);
        this.onClosed?.();
      });
    });
  }

  private describeClose(): string {
    const info = this.closeInfo;
    return info ? `close code ${info.code}${info.reason ? `, reason "${info.reason}"` : ""}` : "not closed";
  }

  private send(payload: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private receive(data: RawData, isBinary: boolean): void {
    if (isBinary) return; // synthesized speech: a text-mode client has no use for it
    let event: RelayEvent;
    try {
      event = JSON.parse(data.toString()) as RelayEvent;
    } catch {
      return;
    }
    if (typeof event.type !== "string") return;
    this.options.log?.(summarize(event));
    if (event.type === "session.started") {
      const capabilities = (event.capabilities ?? {}) as Record<string, unknown>;
      this.session = { provider: str(event.provider), mode: str(event.mode), capabilities };
      if (capabilities.textInput === false) {
        this.onStarted?.({
          error: `the "${this.session.provider}" backend does not accept typed turns (capabilities.textInput is false). agent-test needs one that does: every backend except Doubao and the original helmet demo. Use the keyless demo (VOICE_PROVIDER=mock with an app assistant) or a live backend such as openai.`
        });
        return;
      }
      this.started = true;
      this.onStarted?.({});
      return;
    }
    if (!this.started) {
      if (event.type === "error") this.onStarted?.({ error: `the relay refused the session: ${str(event.message)}` });
      return;
    }
    if (event.type === "tool.call") this.answerToolCall(event);
    this.tracker.ingest(event);
    this.onChange?.();
  }

  /** Answers a client tool from the scenario, or with an error when the scenario never declared it. */
  private answerToolCall(event: RelayEvent): void {
    const callId = str(event.callId);
    const name = str(event.name);
    const spec = this.tools.get(name);
    let answer: ClientCallRecord["answer"];
    if (!spec) answer = { error: `Tool "${name}" is not declared by the test client` };
    else if (spec.error !== undefined) answer = { error: spec.error };
    else answer = { output: spec.result ?? {} };
    this.tracker.calls.push({ callId, name, arguments: event.arguments, answer });
    this.send({ type: "tool.result", callId, ...answer });
  }

  /**
   * After `session.started`, gives a greeting one settle period to arrive so it
   * is not mistaken for the answer to turn 1. Only the first call has an effect.
   */
  async collectGreeting(): Promise<void> {
    const settleMs = this.options.settleMs ?? 400;
    await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
    const waitUntil = Date.now() + (this.options.turnTimeoutMs ?? 30_000);
    // A greeting that has started but not ended (a tool still running) is waited out.
    while (this.tracker.toolRunning && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 50));
    const replies = this.tracker.replies;
    if (replies.length) this.greeting = replies.join(" ");
    this.tracker = new TurnTracker(this.tracker.status);
  }

  /**
   * Sends one typed turn and resolves with what happened. Never rejects: failures are on the record.
   * With `awaitEnd`, a finished reply is not the end of the turn: the relay ends a conversation only
   * once its goodbye has played out, so the turn waits for that (up to {@link END_WAIT_MS}).
   */
  sendTurn(text: string, turn: { awaitEnd?: boolean } = {}): Promise<TurnRecord> {
    const settleMs = this.options.settleMs ?? 400;
    const timeoutMs = this.options.turnTimeoutMs ?? 30_000;
    const tracker = new TurnTracker(this.tracker.status);
    this.tracker = tracker;
    const sentAt = Date.now();
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve(tracker.record(text, sentAt, `connection closed (${this.describeClose()})`));
    }
    return new Promise<TurnRecord>((resolve) => {
      let settle: NodeJS.Timeout | undefined;
      const done = (failure?: string) => {
        clearTimeout(settle);
        clearTimeout(timeout);
        this.onChange = undefined;
        this.onClosed = undefined;
        resolve(tracker.record(text, sentAt, failure));
      };
      const timeout = setTimeout(
        () => done(`no complete reply within ${timeoutMs} ms (${tracker.describe()})`),
        timeoutMs
      );
      this.onChange = () => {
        clearTimeout(settle);
        settle = undefined;
        const state = tracker.state;
        if (state === "complete") {
          const wait = turn.awaitEnd && tracker.ended === undefined ? Math.max(settleMs, END_WAIT_MS) : settleMs;
          settle = setTimeout(() => done(), wait);
        } else if (state === "failed") {
          settle = setTimeout(
            () => done(`the relay reported an error and no reply: ${tracker.errors.join("; ")}`),
            settleMs
          );
        }
      };
      this.onClosed = () =>
        // The relay closing a conversation it ended is how that turn finishes, not a failure.
        tracker.ended !== undefined
          ? done()
          : done(`connection closed during the turn (${this.describeClose()}; ${tracker.describe()})`);
      this.send({ type: "text.input", text });
    });
  }

  /** Closes the socket normally and waits for the close to finish. */
  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const guard = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 2000);
      this.ws.once("close", () => {
        clearTimeout(guard);
        resolve();
      });
      this.ws.close(1000);
    });
  }
}

function summarize(event: RelayEvent): string {
  const { type, ...rest } = event;
  const detail = JSON.stringify(rest);
  return `<- ${type} ${detail.length > 200 ? `${detail.slice(0, 200)}…` : detail}`;
}

/** Connects and waits out any greeting, ready for the first turn. */
export async function openSession(options: ClientOptions): Promise<AgentTestClient> {
  const client = await AgentTestClient.connect(options);
  await client.collectGreeting();
  return client;
}
