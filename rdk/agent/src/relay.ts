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
  wsFactory?: (url: string, options: { rejectUnauthorized: boolean }) => SocketLike;
  pingIntervalMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  log?: (line: string) => void;
};

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

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
    options.wsFactory ??
    ((url, socketOptions) => new WebSocket(url, socketOptions) as unknown as SocketLike);

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

    current.on("open", () => {
      current.send(JSON.stringify(buildSessionStart(config, memory)));
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
        ready = true;
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
      const code = args[0] as number;
      const reason = args[1] as Buffer;
      const detail = reason && reason.length > 0 ? ` reason=${reason.toString("utf8")}` : "";
      log(`[relay] closed code=${code}${detail}`);
      if (socket === current) {
        ready = false;
        socket = null;
      }
      handlers.onClosed(code === IDLE_CLOSE_CODE || intentional);
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
