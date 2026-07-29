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

  it("a stale socket's late close does not stomp the live socket's ready flag", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const client = createRelayClient(CONFIG, HANDLERS, {
      wsFactory: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      },
      log: () => {}
    });
    client.connect();
    sockets[0]!.readyState = 2; // CLOSING — guard lets a new connect through
    client.connect();
    expect(sockets.length).toBe(2);
    sockets[1]!.readyState = 1;
    sockets[1]!.emit("open");
    sockets[1]!.emit("message", Buffer.from(JSON.stringify({ type: "session.started" })), false);
    sockets[0]!.emit("close", 1006, Buffer.alloc(0)); // stale close lands late
    client.sendFrame(new Int16Array(320));
    // ready must still be true on the live socket: the frame goes out.
    expect(sockets[1]!.sent.some((item) => Buffer.isBuffer(item))).toBe(true);
  });
});

describe("relay liveness", () => {
  function liveClient() {
    const socket = fakeSocket();
    const ticks: Array<() => void> = [];
    const cleared: unknown[] = [];
    const client = createRelayClient(CONFIG, HANDLERS, {
      wsFactory: () => socket,
      pingIntervalMs: 15_000,
      setInterval: ((fn: () => void) => {
        ticks.push(fn);
        return ticks.length as unknown as NodeJS.Timeout;
      }) as typeof globalThis.setInterval,
      clearInterval: ((id: unknown) => {
        cleared.push(id);
      }) as typeof globalThis.clearInterval,
      log: () => {}
    });
    client.connect();
    socket.readyState = 1;
    socket.emit("open");
    return { socket, ticks, cleared };
  }

  it("pings on each interval while the pong keeps coming", () => {
    const { socket, ticks } = liveClient();
    ticks[0]!(); // ping 1
    socket.emit("pong");
    ticks[0]!(); // ping 2
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("terminates a socket whose ping goes unanswered", () => {
    const { socket, ticks } = liveClient();
    ticks[0]!(); // ping, no pong
    ticks[0]!(); // deadline passed
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it("stops the liveness timer when the socket closes", () => {
    const { socket, ticks, cleared } = liveClient();
    ticks[0]!();
    socket.emit("close", 1006, Buffer.alloc(0));
    expect(cleared.length).toBe(1);
  });
});
