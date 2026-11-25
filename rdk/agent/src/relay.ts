import WebSocket from "ws";
import {
  IDLE_CLOSE_CODE,
  PROTOCOL_VERSION,
  USAGE_LIMIT_CLOSE_CODE,
  type AgentEvent,
  type SessionMemorySnapshot,
  type SessionStartEvent
} from "../../../shared/agent";
import { UPLINK_RATE } from "./audio/dsp";
import { loadConfig, type RdkConfig } from "./config";

export { loadConfig };
export type { RdkConfig };

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
/** The relay's policy close (docs/protocol.md, "Close codes"): it refused the
 *  connection's credentials. Only the relay sends it, so it has no shared
 *  constant beside IDLE_CLOSE_CODE. */
const POLICY_CLOSE_CODE = 1008;
/** If the TCP connect succeeds but the WS upgrade never completes (coverage
 *  drop mid-handshake, half-open NAT), `ws` waits forever with no `close` and
 *  no backoff scheduled — the agent goes silently mute. Bounding the
 *  handshake turns that hang into the ordinary error+close(1006) recovery
 *  path below. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

export function nextBackoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

/** Why the connection ended, as far as its close code says (docs/protocol.md,
 *  "Close codes"). */
export type RelayCloseKind =
  /** We called `disconnect()`. */
  | "intentional"
  /** 4001: the relay freed an idle session on purpose. */
  | "idle"
  /** Anything else, 1006 included: the link dropped. */
  | "dropped"
  /** 4003: the account's voice minutes are used up — a spent monthly
   *  allowance, a Max Cloud balance, a project's minutes limit — and stay
   *  used up until that changes elsewhere. */
  | "usage-limit"
  /** 1008: the relay refused the connection's credentials. */
  | "credentials";

export type RelayClose = {
  kind: RelayCloseKind;
  /** The relay's close reason; empty when it sent none. */
  reason: string;
};

/**
 * What a close code means for getting the session back. An intentional
 * disconnect outranks the code: ws reports whatever the peer happened to
 * answer with, and none of it is a verdict on this agent.
 */
export function classifyClose(code: number, intentional: boolean, reason = ""): RelayClose {
  if (intentional) return { kind: "intentional", reason };
  if (code === IDLE_CLOSE_CODE) return { kind: "idle", reason };
  if (code === USAGE_LIMIT_CLOSE_CODE) return { kind: "usage-limit", reason };
  if (code === POLICY_CLOSE_CODE) return { kind: "credentials", reason };
  return { kind: "dropped", reason };
}

/**
 * Splits the relay URL from its credential. The token goes in an
 * `Authorization: Bearer` header, which `server/auth.ts` accepts alongside the
 * query form, because a query string lands in relay and proxy access logs and
 * in shell history. A `token` already pasted into MAX_RELAY_URL is lifted out
 * for the same reason (MAX_RELAY_TOKEN wins if both are set).
 *
 * A malformed URL is returned untouched: a bad MAX_RELAY_URL should surface as a
 * connection failure, not a parse crash before the first attempt.
 */
export function relayEndpoint(config: Pick<RdkConfig, "relayUrl" | "relayToken">): {
  url: string;
  headers: Record<string, string>;
} {
  let url = config.relayUrl;
  let token = config.relayToken;
  try {
    const parsed = new URL(config.relayUrl);
    const inUrl = parsed.searchParams.get("token");
    if (inUrl !== null) {
      parsed.searchParams.delete("token");
      url = parsed.toString();
      if (!token) token = inUrl;
    }
  } catch {
    // fall through with the URL as given
  }
  return { url, headers: token ? { Authorization: `Bearer ${token}` } : {} };
}

export function buildSessionStart(
  config: RdkConfig,
  deviceId: string,
  memory?: SessionMemorySnapshot
): SessionStartEvent {
  const event: SessionStartEvent = {
    type: "session.start",
    sampleRate: UPLINK_RATE,
    channels: 1,
    platform: "embedded",
    protocol: PROTOCOL_VERSION,
    deviceId,
    deviceLabel: "RDK X5",
    networkType: "wifi"
  };
  if (memory) event.memory = memory;
  void config;
  return event;
}

export type RelayHandlers = {
  onEvent(event: AgentEvent): void;
  onVoice(pcm: Int16Array): void;
  onReady(): void;
  /** How the connection ended. `idle` must NOT trigger an automatic
   *  reconnect — the local voice gate re-arms instead. `usage-limit` and
   *  `credentials` are final: the relay would answer a retry exactly as it
   *  answered the connection that just closed. */
  onClosed(close: RelayClose): void;
};

export type RelayClient = {
  connect(): void;
  disconnect(): void;
  sendFrame(frame: Int16Array): void;
  sendEvent(event: unknown): void;
  /** An async operation may reply only on the transport that requested it. */
  captureEventSender(): (event: unknown) => void;
  isReady(): boolean;
};

/** The slice of `ws` the client uses — injectable so the lifecycle is testable. */
export type SocketLike = {
  binaryType: string;
  readyState: number;
  send(data: unknown, options?: { binary?: boolean }): void;
  close(): void;
  terminate(): void;
  ping(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

export type RelayClientOptions = {
  wsFactory?: (
    url: string,
    options: {
      rejectUnauthorized: boolean;
      handshakeTimeout?: number;
      headers?: Record<string, string>;
    }
  ) => SocketLike;
  pingIntervalMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  log?: (line: string) => void;
};

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

/** Options the default (non-injected) `wsFactory` gives the real `ws`
 *  constructor. Exported so a unit test can pin the handshake timeout without
 *  standing up a live socket. */
export function defaultSocketOptions(config: RdkConfig): {
  rejectUnauthorized: boolean;
  handshakeTimeout: number;
  headers: Record<string, string>;
} {
  return {
    rejectUnauthorized: !config.insecureTls,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    headers: relayEndpoint(config).headers
  };
}

export function createRelayClient(
  config: RdkConfig,
  deviceId: string,
  handlers: RelayHandlers,
  options: RelayClientOptions = {}
): RelayClient {
  let socket: SocketLike | null = null;
  let ready = false;
  let memory: SessionMemorySnapshot | undefined;
  let intentional = false;

  const log = options.log ?? ((line: string) => console.log(line));
  // The factory uses the options it is handed rather than rebuilding them, so
  // an injected socket sees exactly what the real WebSocket constructor does.
  const wsFactory =
    options.wsFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions) as unknown as SocketLike);

  function open(): void {
    if (socket && (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN)) {
      log("[relay] connect ignored; socket already open");
      return;
    }
    ready = false;
    intentional = false;
    const current = wsFactory(relayEndpoint(config).url, defaultSocketOptions(config));
    socket = current;
    current.binaryType = "nodebuffer";

    const timers = {
      set: options.setInterval ?? globalThis.setInterval,
      clear: options.clearInterval ?? globalThis.clearInterval
    };
    const pingEvery = options.pingIntervalMs ?? 15_000;
    let liveness: NodeJS.Timeout | null = null;
    let awaitingPong = false;

    current.on("open", () => {
      if (socket !== current) return;
      current.send(JSON.stringify(buildSessionStart(config, deviceId, memory)));
      awaitingPong = false;
      liveness = timers.set(() => {
        if (socket !== current) return;
        if (awaitingPong) {
          // The relay pings from its side too, but neither close crosses a
          // black-holed path. Terminating locally is the only exit.
          log("[relay] no pong within the liveness window; terminating the socket");
          current.terminate();
          return;
        }
        awaitingPong = true;
        current.ping();
      }, pingEvery);
    });

    current.on("pong", () => {
      awaitingPong = false;
    });

    current.on("message", (rawData: unknown, rawIsBinary: unknown) => {
      if (socket !== current) return;
      const data = rawData as Buffer;
      const isBinary = rawIsBinary as boolean;
      if (isBinary) {
        // Downlink voice is 24 kHz PCM16. A Buffer may not be 2-byte aligned
        // inside its parent ArrayBuffer, so copy rather than view.
        const copy = Buffer.from(data);
        handlers.onVoice(new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2));
        return;
      }
      let event: AgentEvent;
      try {
        event = JSON.parse(data.toString("utf8")) as AgentEvent;
      } catch {
        return;
      }
      if (event.type === "session.started") {
        if (socket === current) ready = true;
        current.send(JSON.stringify({ type: "audio.start" }));
        handlers.onReady();
      }
      if (event.type === "session.memory") {
        memory = {
          language: event.language,
          destination: event.destination,
          lastIntent: event.lastIntent,
          responseMode: event.responseMode
        };
      }
      handlers.onEvent(event);
    });

    current.on("close", (...args: unknown[]) => {
      if (liveness !== null) {
        timers.clear(liveness);
        liveness = null;
      }
      const code = args[0] as number;
      const reason = args[1] as Buffer;
      const text = reason && reason.length > 0 ? reason.toString("utf8") : "";
      const detail = text ? ` reason=${text}` : "";
      log(`[relay] closed code=${code}${detail}`);
      if (socket === current) {
        ready = false;
        socket = null;
        handlers.onClosed(classifyClose(code, intentional, text));
      }
    });

    current.on("error", (...args: unknown[]) => {
      const error = args[0] as Error;
      // `close` always follows; recovery is handled there. This line is the
      // difference between a diagnosable 401 and "reconnects with no explanation".
      log(`[relay] socket error: ${error.message}`);
    });
  }

  return {
    connect: open,
    disconnect(): void {
      intentional = true;
      ready = false;
      socket?.close();
      // The socket stays set: ws delivers `close` asynchronously, and nulling
      // here made that event fail the `socket === current` guard — so an
      // intentional close never reached onClosed. The close handler
      // nulls it; sendFrame/sendEvent are already gated on readyState, which
      // close() moves off OPEN synchronously.
    },
    sendFrame(frame: Int16Array): void {
      // Gate on session.started: transmitting earlier produces the startup
      // burst the other clients were changed to avoid.
      if (!ready || socket?.readyState !== SOCKET_OPEN) return;
      socket.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), { binary: true });
    },
    sendEvent(event: unknown): void {
      if (socket?.readyState !== SOCKET_OPEN) return;
      socket.send(JSON.stringify(event));
    },
    captureEventSender(): (event: unknown) => void {
      const owner = socket;
      return (event) => {
        if (!owner || socket !== owner || owner.readyState !== SOCKET_OPEN) return;
        owner.send(JSON.stringify(event));
      };
    },
    isReady(): boolean {
      return ready;
    }
  };
}
