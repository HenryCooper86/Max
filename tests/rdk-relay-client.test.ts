import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionStart,
  defaultRouteNetworkType,
  classifyClose,
  createRelayClient,
  defaultSocketOptions,
  HANDSHAKE_TIMEOUT_MS,
  type RelayClose,
  type RelayCloseKind,
  type SocketLike
} from "../rdk/agent/src/relay";
import { USAGE_LIMIT_CLOSE_CODE } from "../shared/agent";
import type { RdkConfig } from "../rdk/agent/src/config";

const CONFIG = {
  relayUrl: "wss://relay.example/agent",
  relayToken: "tok",
  insecureTls: false,
  releaseRoot: "/nonexistent-release-root",
  testing: {}
} as unknown as RdkConfig;

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
const DEVICE_ID = "rdk-123e4567-e89b-42d3-a456-426614174000";

describe("buildSessionStart", () => {
  it("includes the already-loaded RDK identity", () => {
    expect(buildSessionStart(CONFIG, DEVICE_ID).deviceId).toBe(DEVICE_ID);
  });

  it("reports the network the default route uses, not always wifi", () => {
    const table = (iface: string, flags = "0003") =>
      `Iface\tDestination\tGateway\tFlags\n${iface}\t0010A8C0\t00000000\t0001\n${iface}\t00000000\t0101A8C0\t${flags}\n`;
    expect(defaultRouteNetworkType(table("wlan0"))).toBe("wifi");
    expect(defaultRouteNetworkType(table("eth0"))).toBe("ethernet");
    expect(defaultRouteNetworkType(table("usb0"))).toBe("cellular");
    expect(defaultRouteNetworkType(table("wlan0", "0002"))).toBe("unknown"); // route not up
    expect(defaultRouteNetworkType("")).toBe("unknown");
    // Wi-Fi and a USB tether both up: the lower metric wins, whichever line comes first.
    const header = "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\n";
    const wifi = "wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\n";
    const tether = "usb0\t00000000\t012AA8C0\t0003\t0\t0\t100\n";
    expect(defaultRouteNetworkType(header + wifi + tether)).toBe("cellular");
    expect(defaultRouteNetworkType(header + tether + wifi)).toBe("cellular");
  });

  it("sends the release's build identity, the link and the test run it is under", () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), "rdk-release-"));
    try {
      mkdirSync(releaseRoot, { recursive: true });
      writeFileSync(join(releaseRoot, ".rdk-release-sha"), `${"ab12".repeat(10)}\n`);
      writeFileSync(join(releaseRoot, "package.json"), JSON.stringify({ version: "0.2.0" }));
      const config = {
        ...CONFIG,
        releaseRoot,
        testing: { testerId: "bench-2", testingRunId: "run-7" }
      } as RdkConfig;
      const socket = fakeSocket();
      const client = createRelayClient(config, DEVICE_ID, HANDLERS, {
        wsFactory: () => socket,
        log: () => {},
        readRouteTable: () => "Iface\tDestination\tGateway\tFlags\nusb0\t00000000\t0101A8C0\t0003\n",
        setInterval: (() => 0) as unknown as typeof setInterval,
        clearInterval: () => {}
      });
      client.connect();
      socket.readyState = 1;
      socket.emit("open");
      const start = JSON.parse(String(socket.sent[0])) as Record<string, unknown>;
      expect(start).toMatchObject({
        gitCommit: "ab12ab12ab12",
        appVersion: "max-rdk@0.2.0",
        networkType: "cellular",
        testerId: "bench-2",
        testingRunId: "run-7"
      });
      client.disconnect();
    } finally {
      rmSync(releaseRoot, { recursive: true, force: true });
    }
  });
});

describe("createRelayClient lifecycle", () => {
  it("keeps asynchronous command replies bound to their original socket", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const client = createRelayClient(CONFIG, DEVICE_ID, HANDLERS, {
      wsFactory: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      },
      log: () => {}
    });
    client.connect();
    sockets[0]!.readyState = 1;
    const reply = client.captureEventSender();
    reply({ type: "device.result", commandId: "current" });
    expect(sockets[0]!.sent).toHaveLength(1);
    sockets[0]!.readyState = 2;
    client.connect();
    sockets[1]!.readyState = 1;
    reply({ type: "device.result", commandId: "stale" });
    expect(sockets[0]!.sent).toHaveLength(1);
    expect(sockets[1]!.sent).toHaveLength(0);
  });

  it("ignores all messages and a late open from a superseded socket", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const onEvent = vi.fn();
    const onVoice = vi.fn();
    const onReady = vi.fn();
    const setInterval = vi.fn();
    const client = createRelayClient(
      CONFIG,
      DEVICE_ID,
      { ...HANDLERS, onEvent, onVoice, onReady },
      {
        wsFactory: () => {
          const socket = fakeSocket();
          sockets.push(socket);
          return socket;
        },
        setInterval: setInterval as unknown as typeof globalThis.setInterval,
        log: () => {}
      }
    );
    client.connect();
    sockets[0]!.readyState = 2;
    client.connect();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", Buffer.alloc(2), true);
    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "session.started" })), false);
    sockets[0]!.emit("message", Buffer.from(JSON.stringify({ type: "device.command", commandId: "old" })), false);
    expect(sockets[0]!.sent).toEqual([]);
    expect(setInterval).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onVoice).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("reuses the loaded identity in every reconnect handshake", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const client = createRelayClient(CONFIG, DEVICE_ID, HANDLERS, {
      wsFactory: () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      }
    });

    client.connect();
    sockets[0]!.readyState = 1;
    sockets[0]!.emit("open");
    sockets[0]!.emit("close", 1006, Buffer.alloc(0));
    client.connect();
    sockets[1]!.readyState = 1;
    sockets[1]!.emit("open");

    expect(sockets.map((socket) => JSON.parse(socket.sent[0] as string).deviceId)).toEqual([DEVICE_ID, DEVICE_ID]);
  });

  it("connect() while a socket is open or connecting is a no-op", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const lines: string[] = [];
    const client = createRelayClient(CONFIG, DEVICE_ID, HANDLERS, {
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
    const client = createRelayClient(CONFIG, DEVICE_ID, HANDLERS, {
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
    const client = createRelayClient(CONFIG, DEVICE_ID, HANDLERS, {
      wsFactory: () => socket,
      log: (line) => lines.push(line)
    });
    client.connect();
    socket.emit("error", new Error("Unexpected server response: 401"));
    expect(lines.some((line) => line.includes("401"))).toBe(true);
  });

  it("reconnect after a close creates a fresh socket", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const client = createRelayClient(CONFIG, DEVICE_ID, HANDLERS, {
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
    const closedCalls: RelayCloseKind[] = [];
    const client = createRelayClient(
      CONFIG,
      DEVICE_ID,
      { ...HANDLERS, onClosed: (close) => closedCalls.push(close.kind) },
      {
        wsFactory: () => {
          const socket = fakeSocket();
          sockets.push(socket);
          return socket;
        },
        log: () => {}
      }
    );
    client.connect();
    sockets[0]!.readyState = 2; // CLOSING — guard lets a new connect through
    client.connect();
    expect(sockets.length).toBe(2);
    sockets[1]!.readyState = 1;
    sockets[1]!.emit("open");
    sockets[1]!.emit("message", Buffer.from(JSON.stringify({ type: "session.started" })), false);
    sockets[0]!.emit("close", 1006, Buffer.alloc(0)); // stale close lands late
    // the stale close must not touch live state: no onClosed, no flush upstream.
    expect(closedCalls.length).toBe(0);
    client.sendFrame(new Int16Array(320));
    // ready must still be true on the live socket: the frame goes out.
    expect(sockets[1]!.sent.some((item) => Buffer.isBuffer(item))).toBe(true);
    // the live socket's own close must still drive reconnection normally.
    sockets[1]!.emit("close", 1000, Buffer.alloc(0));
    expect(closedCalls).toEqual(["dropped"]);
  });

  it("an intentional disconnect still delivers an intentional close when it lands", () => {
    // disconnect() used to null the socket synchronously, so its own close —
    // which ws delivers asynchronously — failed the stale-socket guard and
    // the intentional close never reached onClosed. Unobservable while
    // shutdown() exits the process immediately, and a trap for any later
    // graceful-shutdown work.
    const socket = fakeSocket();
    const closedCalls: RelayCloseKind[] = [];
    const client = createRelayClient(
      CONFIG,
      DEVICE_ID,
      { ...HANDLERS, onClosed: (close) => closedCalls.push(close.kind) },
      { wsFactory: () => socket, log: () => {} }
    );
    client.connect();
    socket.readyState = 1;
    socket.emit("open");
    client.disconnect();
    expect(socket.close).toHaveBeenCalled();
    // The close event arrives after disconnect() has already returned.
    socket.readyState = 3;
    socket.emit("close", 1000, Buffer.alloc(0));
    expect(closedCalls).toEqual(["intentional"]);
  });

  it("a reconnect between disconnect and its late close keeps the old close stale", () => {
    // The guard disconnect() was wrongly tripping still has a job: once a
    // fresh socket replaces the closing one, the old close must not fire
    // onClosed or clobber the live socket's ready state.
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const closedCalls: RelayCloseKind[] = [];
    const client = createRelayClient(
      CONFIG,
      DEVICE_ID,
      { ...HANDLERS, onClosed: (close) => closedCalls.push(close.kind) },
      {
        wsFactory: () => {
          const socket = fakeSocket();
          sockets.push(socket);
          return socket;
        },
        log: () => {}
      }
    );
    client.connect();
    sockets[0]!.readyState = 1;
    sockets[0]!.emit("open");
    client.disconnect();
    sockets[0]!.readyState = 2; // CLOSING — the already-open guard lets connect through
    client.connect();
    expect(sockets.length).toBe(2);
    sockets[1]!.readyState = 1;
    sockets[1]!.emit("open");
    sockets[1]!.emit("message", Buffer.from(JSON.stringify({ type: "session.started" })), false);
    sockets[0]!.emit("close", 1000, Buffer.alloc(0)); // the old close lands late
    expect(closedCalls).toEqual([]);
    client.sendFrame(new Int16Array(320));
    expect(sockets[1]!.sent.some((item) => Buffer.isBuffer(item))).toBe(true);
  });

  it("a handshake that dies before open still reaches the close path and can reconnect", () => {
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const lines: string[] = [];
    const closedCalls: RelayCloseKind[] = [];
    const client = createRelayClient(
      CONFIG,
      DEVICE_ID,
      { ...HANDLERS, onClosed: (close) => closedCalls.push(close.kind) },
      {
        wsFactory: () => {
          const socket = fakeSocket();
          sockets.push(socket);
          return socket;
        },
        log: (line) => lines.push(line)
      }
    );
    client.connect();
    // This is what ws does on a handshake timeout: `error` then `close(1006)`,
    // `open` never fires.
    sockets[0]!.emit("error", new Error("Opening handshake has timed out"));
    sockets[0]!.emit("close", 1006, Buffer.alloc(0));
    expect(lines.some((line) => line.includes("Opening handshake has timed out"))).toBe(true);
    expect(lines.some((line) => line.includes("closed code=1006"))).toBe(true);
    expect(closedCalls).toEqual(["dropped"]);
    // The already-open guard must not still be blocking: the wedged socket's
    // close nulled it out, so a fresh connect() creates a new socket.
    client.connect();
    expect(sockets.length).toBe(2);
  });
});

describe("relay close contract", () => {
  it.each([
    [USAGE_LIMIT_CLOSE_CODE, "usage-limit", "usage limit reached"],
    [1008, "credentials", "signed out"]
  ] as const)("hands a close %s to onClosed as %s, with the relay's reason", (code, kind, reason) => {
    const closed: RelayClose[] = [];
    const socket = fakeSocket();
    const client = createRelayClient(
      CONFIG,
      DEVICE_ID,
      { ...HANDLERS, onClosed: (close) => closed.push(close) },
      { wsFactory: () => socket, log: () => {} }
    );
    client.connect();
    socket.emit("close", code, Buffer.from(reason));
    expect(closed).toEqual([{ kind, reason }]);
  });

  it("hands an idle close to onClosed as idle", () => {
    const closed: RelayClose[] = [];
    const socket = fakeSocket();
    const client = createRelayClient(
      CONFIG,
      DEVICE_ID,
      { ...HANDLERS, onClosed: (close) => closed.push(close) },
      { wsFactory: () => socket, log: () => {} }
    );
    client.connect();
    socket.emit("close", 4001, Buffer.from("idle timeout"));
    expect(closed).toEqual([{ kind: "idle", reason: "idle timeout" }]);
  });
});

describe("classifyClose", () => {
  it("maps the codes the relay closes with to what they mean for reconnecting", () => {
    expect(classifyClose(4001, false, "idle timeout")).toEqual({ kind: "idle", reason: "idle timeout" });
    expect(classifyClose(USAGE_LIMIT_CLOSE_CODE, false, "usage limit reached")).toEqual({
      kind: "usage-limit",
      reason: "usage limit reached"
    });
    expect(classifyClose(1008, false, "signed out")).toEqual({ kind: "credentials", reason: "signed out" });
    expect(classifyClose(1008, false)).toEqual({ kind: "credentials", reason: "" });
  });

  it("treats every other code as a drop", () => {
    for (const code of [1000, 1001, 1005, 1006, 1011, 1013]) {
      expect(classifyClose(code, false, "").kind).toBe("dropped");
    }
  });

  it("lets a disconnect we asked for outrank the code", () => {
    expect(classifyClose(USAGE_LIMIT_CLOSE_CODE, true, "usage limit reached")).toEqual({
      kind: "intentional",
      reason: "usage limit reached"
    });
  });
});

describe("relay credentials", () => {
  it("passes the token as an Authorization header and keeps it out of the URL", () => {
    const socket = fakeSocket();
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const client = createRelayClient(CONFIG, DEVICE_ID, HANDLERS, {
      wsFactory: (url, options) => {
        seen.push({ url, headers: options.headers });
        return socket;
      },
      log: () => {}
    });
    client.connect();
    expect(seen).toEqual([{ url: "wss://relay.example/agent", headers: { Authorization: "Bearer tok" } }]);
  });
});

describe("defaultSocketOptions", () => {
  it("gives the real WebSocket constructor a bounded handshake alongside TLS policy", () => {
    const opts = defaultSocketOptions(CONFIG);
    expect(opts.handshakeTimeout).toBe(HANDSHAKE_TIMEOUT_MS);
    expect(opts.handshakeTimeout).toBe(15_000);
    expect(opts.rejectUnauthorized).toBe(true);
  });

  it("hands connect() the same options the real constructor gets, not a subset", () => {
    const socket = fakeSocket();
    const seen: Array<{ rejectUnauthorized: boolean; handshakeTimeout?: number }> = [];
    const client = createRelayClient(CONFIG, DEVICE_ID, HANDLERS, {
      wsFactory: (_url, options) => {
        seen.push(options);
        return socket;
      },
      log: () => {}
    });
    client.connect();
    // The call site used to build its own {rejectUnauthorized} object while the
    // default factory quietly ignored the argument and called
    // defaultSocketOptions itself. Production was fine; every injected factory
    // saw a socket with no handshake bound, so nothing could pin the timeout
    // through the path that actually constructs the socket.
    expect(seen).toEqual([defaultSocketOptions(CONFIG)]);
  });

  it("carries the insecure-TLS escape hatch through to the constructor options", () => {
    const socket = fakeSocket();
    const seen: Array<{ rejectUnauthorized: boolean }> = [];
    const client = createRelayClient({ ...CONFIG, insecureTls: true } as RdkConfig, DEVICE_ID, HANDLERS, {
      wsFactory: (_url, options) => {
        seen.push(options);
        return socket;
      },
      log: () => {}
    });
    client.connect();
    expect(seen[0]?.rejectUnauthorized).toBe(false);
  });
});

describe("relay liveness", () => {
  function liveClient() {
    const socket = fakeSocket();
    const ticks: Array<() => void> = [];
    const cleared: unknown[] = [];
    const client = createRelayClient(CONFIG, DEVICE_ID, HANDLERS, {
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
