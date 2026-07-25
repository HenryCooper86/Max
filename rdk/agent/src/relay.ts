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

export function createRelayClient(config: RdkConfig, handlers: RelayHandlers): RelayClient {
  let socket: WebSocket | null = null;
  let ready = false;
  let memory: SessionMemorySnapshot | undefined;
  let intentional = false;

  function open(): void {
    ready = false;
    intentional = false;
    socket = new WebSocket(config.relayUrl, { rejectUnauthorized: !config.insecureTls });
    socket.binaryType = "nodebuffer";

    socket.on("open", () => {
      socket?.send(JSON.stringify(buildSessionStart(config, memory)));
    });

    socket.on("message", (data: Buffer, isBinary: boolean) => {
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
        socket?.send(JSON.stringify({ type: "audio.start" }));
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

    socket.on("close", (code: number) => {
      ready = false;
      socket = null;
      handlers.onClosed(code === IDLE_CLOSE_CODE || intentional);
    });

    socket.on("error", () => {
      // `close` always follows; recovery is handled there.
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
      if (!ready || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), { binary: true });
    },
    sendEvent(event: unknown): void {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(event));
    },
    isReady(): boolean {
      return ready;
    }
  };
}
