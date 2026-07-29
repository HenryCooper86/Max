import { describe, expect, it, vi } from "vitest";
import { createRelayClient, type SocketLike } from "../rdk/agent/src/relay";
import type { RdkConfig } from "../rdk/agent/src/config";

const CONFIG = {
  relayUrl: "wss://relay.example/agent",
  relayToken: "tok",
  insecureTls: false
} as RdkConfig;

function fakeSocket() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket: SocketLike & { emit(event: string, ...args: unknown[]): void; sent: unknown[] } = {
    binaryType: "",
    readyState: 0, // CONNECTING
    sent: [],
    send(data: unknown) {
      this.sent.push(data);
    },
    close: vi.fn() as unknown as () => void,
    terminate: vi.fn() as unknown as () => void,
    ping: vi.fn() as unknown as () => void,
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    }
  };
  return socket;
}

const HANDLERS = { onEvent: () => {}, onVoice: () => {}, onReady: () => {}, onClosed: () => {} };

describe("createRelayClient lifecycle", () => {
  it("connect() while a socket is open or connecting is a no-op", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const lines: string[] = [];
    const client = createRelayClient(CONFIG, HANDLERS, {
      wsFactory: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      },
      log: (line) => lines.push(line)
    });
    client.connect();
    client.connect(); // still CONNECTING
    expect(sockets.length).toBe(1);
    expect(lines).toContain("[relay] connect ignored; socket already open");
  });

  it("logs the close code and reason", () => {
    const lines: string[] = [];
    const socket = fakeSocket();
    const client = createRelayClient(CONFIG, HANDLERS, {
      wsFactory: () => socket,
      log: (line) => lines.push(line)
    });
    client.connect();
    socket.emit("close", 4001, Buffer.from("idle"));
    expect(lines.some((line) => line.includes("closed code=4001") && line.includes("idle"))).toBe(true);
  });

  it("logs socket errors with their message", () => {
    const lines: string[] = [];
    const socket = fakeSocket();
    const client = createRelayClient(CONFIG, HANDLERS, {
      wsFactory: () => socket,
      log: (line) => lines.push(line)
    });
    client.connect();
    socket.emit("error", new Error("Unexpected server response: 401"));
    expect(lines.some((line) => line.includes("401"))).toBe(true);
  });

  it("reconnect after a close creates a fresh socket", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const client = createRelayClient(CONFIG, HANDLERS, {
      wsFactory: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    client.connect();
    sockets[0]!.emit("close", 1006, Buffer.alloc(0));
    client.connect();
    expect(sockets.length).toBe(2);
  });
});
