import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type ClientOptions } from "ws";
import { createHudServer } from "../rdk/agent/src/hud/server";
import type { HudState } from "../rdk/agent/src/hud/state";

type HudServer = ReturnType<typeof createHudServer>;

const livePairingState: HudState = {
  connection: "ready",
  turnState: "speaking",
  transcript: [{ speaker: "agent", text: "继续直行", final: true, turnId: "turn-7" }],
  latencyMs: 42,
  lastError: null,
  companion: {
    pairingCode: "314159",
    pairingExpiresAt: 2_000_000_000_000,
    paired: false,
    locationState: "connected",
    horizontalAccuracyMeters: 8,
    lastFixAgeMs: 600
  },
  navigation: {
    phase: "guiding",
    destinationName: "市图书馆",
    instruction: "前方右转",
    distanceToManeuverMeters: 120,
    remainingMeters: 2_400,
    remainingSeconds: 480,
    offRoute: false,
    location: { connection: "sharing", usable: true, horizontalAccuracyMeters: 8, ageMs: 600 }
  }
};

const openSockets = new Set<WebSocket>();
const openServers = new Set<HudServer>();

function cloneState(state: HudState): HudState {
  return structuredClone(state);
}

async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("probe did not receive a TCP port");
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function nonLoopbackIPv4(): string {
  for (const records of Object.values(networkInterfaces())) {
    for (const record of records ?? []) {
      if (record.family === "IPv4" && !record.internal) return record.address;
    }
  }
  throw new Error("security regression requires a non-loopback IPv4 interface");
}

function nextState(socket: WebSocket): Promise<HudState> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for HUD state")), 5_000);
    socket.once("message", (data, isBinary) => {
      clearTimeout(timeout);
      if (isBinary) {
        reject(new Error("HUD state unexpectedly arrived as binary"));
        return;
      }
      try {
        resolve(JSON.parse(data.toString()) as HudState);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function connect(url: string, options?: ClientOptions): Promise<WebSocket> {
  const socket = new WebSocket(url, options);
  openSockets.add(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
  } catch (error) {
    openSockets.delete(socket);
    throw error;
  }
  return socket;
}

async function connectWithInitial(
  url: string,
  options?: ClientOptions
): Promise<{ socket: WebSocket; initial: HudState }> {
  const socket = new WebSocket(url, options);
  openSockets.add(socket);
  const initial = nextState(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return { socket, initial: await initial };
  } catch (error) {
    openSockets.delete(socket);
    void initial.catch(() => undefined);
    throw error;
  }
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  if (socket.readyState === WebSocket.CONNECTING) {
    await new Promise<void>((resolve) => {
      socket.once("error", () => undefined);
      socket.once("close", resolve);
      socket.terminate();
    });
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 1_000);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close();
  });
}

afterEach(async () => {
  await Promise.all([...openSockets].map((socket) => closeSocket(socket)));
  openSockets.clear();
  for (const server of openServers) server.close();
  openServers.clear();
});

describe("RDK HUD pairing-secret transport boundary", () => {
  it("redacts pairing secrets from a non-loopback peer's initial replay and later broadcasts despite HTTP spoofing", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081);
    openServers.add(server);
    const source = cloneState(livePairingState);
    const sourceBeforePublish = cloneState(source);
    server.publish(source);

    const remoteConnection = await connectWithInitial(`ws://${nonLoopbackIPv4()}:${port}/?host=127.0.0.1&local=true`, {
      origin: "http://127.0.0.1:8080",
      headers: {
        host: "127.0.0.1:8080",
        forwarded: "for=127.0.0.1;host=localhost",
        "x-forwarded-for": "127.0.0.1, ::1",
        "x-real-ip": "::ffff:127.0.0.1"
      }
    });
    const { socket: remote, initial } = remoteConnection;

    expect(initial.companion).toEqual({
      paired: false,
      locationState: "connected",
      horizontalAccuracyMeters: 8,
      lastFixAgeMs: 600
    });
    expect(initial.transcript).toEqual(livePairingState.transcript);
    expect(initial.navigation).toEqual(livePairingState.navigation);
    expect(initial.connection).toBe("ready");

    remote.send(
      JSON.stringify({
        remoteAddress: "127.0.0.1",
        origin: "http://localhost",
        host: "localhost",
        "x-forwarded-for": "127.0.0.1",
        local: true
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const update = cloneState(source);
    update.turnState = "hearing";
    update.companion.pairingCode = "271828";
    update.companion.pairingExpiresAt = 2_000_000_100_000;
    const remoteUpdate = nextState(remote);
    server.publish(update);

    expect(await remoteUpdate).toEqual({
      ...update,
      companion: {
        paired: false,
        locationState: "connected",
        horizontalAccuracyMeters: 8,
        lastFixAgeMs: 600
      }
    });
    expect(source).toEqual(sourceBeforePublish);
    expect(update.companion).toMatchObject({ pairingCode: "271828", pairingExpiresAt: 2_000_000_100_000 });

    const local = await connectWithInitial(`ws://127.0.0.1:${port}/`);
    expect(local.initial).toEqual(update);

    const expiredButStillSecret: HudState = {
      ...cloneState(update),
      companion: {
        ...update.companion,
        paired: true,
        pairingCode: "161803",
        pairingExpiresAt: 1
      }
    };
    const remoteExpired = nextState(remote);
    const localExpired = nextState(local.socket);
    server.publish(expiredButStillSecret);
    expect((await remoteExpired).companion).toEqual({
      paired: true,
      locationState: "connected",
      horizontalAccuracyMeters: 8,
      lastFixAgeMs: 600
    });
    expect(await localExpired).toEqual(expiredButStillSecret);

    const noSecret: HudState = {
      ...cloneState(expiredButStillSecret),
      companion: { paired: true, locationState: "sharing", horizontalAccuracyMeters: 5, lastFixAgeMs: 100 }
    };
    const remoteCleared = nextState(remote);
    const localCleared = nextState(local.socket);
    server.publish(noSecret);
    await expect(Promise.all([remoteCleared, localCleared])).resolves.toEqual([noSecret, noSecret]);
  });

  it("keeps full initial and broadcast frames for IPv4, IPv6, and IPv4-mapped loopback peers", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081);
    openServers.add(server);
    server.publish(livePairingState);

    const loopbackUrls = [`ws://127.0.0.1:${port}/`, `ws://[::1]:${port}/`, `ws://[::ffff:127.0.0.1]:${port}/`];
    const locals: WebSocket[] = [];
    for (const url of loopbackUrls) {
      const { socket, initial } = await connectWithInitial(url);
      locals.push(socket);
      expect(initial).toEqual(livePairingState);
    }

    const expiredButStillSecret: HudState = {
      ...cloneState(livePairingState),
      companion: {
        ...livePairingState.companion,
        paired: true,
        pairingCode: "161803",
        pairingExpiresAt: 1
      }
    };
    const updates = locals.map((socket) => nextState(socket));
    server.publish(expiredButStillSecret);
    await expect(Promise.all(updates)).resolves.toEqual(locals.map(() => expiredButStillSecret));

    const noSecret: HudState = {
      ...cloneState(expiredButStillSecret),
      companion: { paired: true, locationState: "sharing", horizontalAccuracyMeters: 5, lastFixAgeMs: 100 }
    };
    const cleared = locals.map((socket) => nextState(socket));
    server.publish(noSecret);
    await expect(Promise.all(cleared)).resolves.toEqual(locals.map(() => noSecret));
  });

  it("closes the listener after connected clients leave", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081);
    openServers.add(server);
    const socket = await connect(`ws://127.0.0.1:${port}/`);
    await closeSocket(socket);
    openSockets.delete(socket);
    server.close();
    openServers.delete(server);

    await expect(connect(`ws://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});
