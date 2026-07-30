import WebSocket from "ws";
import {
  IDLE_CLOSE_CODE,
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
/** If the TCP connect succeeds but the WS upgrade never completes (coverage
 *  drop mid-handshake, half-open NAT), `ws` waits forever with no `close` and
 *  no backoff scheduled — the agent goes silently mute. Bounding the
 *  handshake turns that hang into the ordinary error+close(1006) recovery
 *  path below. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

export function nextBackoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

/**
 * Adds the operator relay token as `?token=…`, the form `server/auth.ts` reads
 * and the web client already uses. Without it an authenticated relay rejects the
 * upgrade with 401 before a session ever starts.
 *
 * A malformed URL is returned untouched: a bad MAX_RELAY_URL should surface as a
 * connection failure, not a parse crash before the first attempt.
 */
export function authorizedRelayUrl(relayUrl: string, token: string): string {
  if (!token) return relayUrl;
  try {
    const url = new URL(relayUrl);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return relayUrl;
  }
}

export function buildSessionStart(config: RdkConfig, memory?: SessionMemorySnapshot): SessionStartEvent {
  const event: SessionStartEvent = {
    type: "session.start",
    sampleRate: UPLINK_RATE,
    channels: 1,
    platform: "embedded",
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
  /** `idle` is true when the relay closed us with IDLE_CLOSE_CODE, which must
   *  NOT trigger an automatic reconnect — the local voice gate re-arms instead. */
  onClosed(idle: boolean): void;
};

export type RelayClient = {
  connect(): void;
  disconnect(): void;
  sendFrame(frame: Int16Array): void;
  sendEvent(event: unknown): void;
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
    options: { rejectUnauthorized: boolean; handshakeTimeout?: number }
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
export function defaultSocketOptions(
  config: RdkConfig
): { rejectUnauthorized: boolean; handshakeTimeout: number } {
  return {
    rejectUnauthorized: !config.insecureTls,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS
  };
}

export function createRelayClient(
  config: RdkConfig,
  handlers: RelayHandlers,
  options: RelayClientOptions = {}
): RelayClient {
  let socket: SocketLike | null = null;
  let ready = false;
  let memory: SessionMemorySnapshot | undefined;
  let intentional = false;

  const log = options.log ?? ((line: string) => console.log(line));
  const wsFactory =
    options.wsFactory ?? ((url) => new WebSocket(url, defaultSocketOptions(config)) as unknown as SocketLike);

  function open(): void {
    if (socket && (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN)) {
      log("[relay] connect ignored; socket already open");
      return;
    }
    ready = false;
    intentional = false;
    const current = wsFactory(authorizedRelayUrl(config.relayUrl, config.relayToken), {
      rejectUnauthorized: !config.insecureTls
    });
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
      current.send(JSON.stringify(buildSessionStart(config, memory)));
      awaitingPong = false;
      liveness = timers.set(() => {
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
      const detail = reason && reason.length > 0 ? ` reason=${reason.toString("utf8")}` : "";
      log(`[relay] closed code=${code}${detail}`);
      if (socket === current) {
        ready = false;
        socket = null;
        handlers.onClosed(code === IDLE_CLOSE_CODE || intentional);
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
      socket = null;
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
    isReady(): boolean {
      return ready;
    }
  };
}
