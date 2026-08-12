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
    position: { lat: 31.2304, lon: 121.4737 },
    location: { connection: "sharing", usable: true, horizontalAccuracyMeters: 8, ageMs: 600 }
  },
  route: {
    destinationName: "人民广场",
    polyline: [
      { lat: 31.23, lon: 121.47 },
      { lat: 31.24, lon: 121.47 }
    ],
    steps: [{ lat: 31.235, lon: 121.47 }]
  }
};

const TOKEN = "s3cret-bench-token";

const openSockets = new Set<WebSocket>();
const openServers = new Set<HudServer>();

function cloneState(state: HudState): HudState {
  return structuredClone(state);
}

/**
 * What this test expects a non-loopback peer's view of `state` to look like:
 * everything except the rider's route and position, which the dedicated
 * "RDK HUD rider-location transport boundary" describe block below verifies
 * directly against literal values. Used here only to keep this test's
 * *other* assertions (about pairing-secret redaction) valid now that the
 * shared fixture carries route/position too.
 */
function withoutRiderLocation(state: HudState): HudState {
  const navigation = state.navigation === null ? null : { ...state.navigation };
  if (navigation !== null) delete navigation.position;
  return { ...state, navigation, route: null };
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

describe("RDK HUD bench-token boundary", () => {
  async function fetchPage(url: string): Promise<{ status: number; body: string }> {
    const response = await fetch(url);
    return { status: response.status, body: await response.text() };
  }

  it("serves the page to the board itself with no token in the URL", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    const page = await fetchPage(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    // The sidecar refuses non-loopback peers, so the page has to carry the
    // token for the browser's fetches to 8081 to work at all.
    expect(page.body).toContain(TOKEN);
  });

  it("refuses a non-loopback peer that brings no token, so the page cannot leak it", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    const page = await fetchPage(`http://${nonLoopbackIPv4()}:${port}/`);
    expect(page.status).toBe(401);
    expect(page.body).not.toContain(TOKEN);
  });

  it("tells a refused peer how to get in, since a browser hits this with no other clue", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    const page = await fetchPage(`http://${nonLoopbackIPv4()}:${port}/`);
    expect(page.status).toBe(401);
    // Both routes, because they suit different jobs: the query parameter for
    // an ordinary bench look, the forward for reading a pairing code (which
    // redaction withholds from any non-loopback peer, token or not).
    expect(page.body).toContain("?t=");
    expect(page.body).toContain("MAX_VISION_TOKEN");
    expect(page.body).toContain("ssh -N -L 8080:127.0.0.1:8080");
    // ...and never the answer itself.
    expect(page.body).not.toContain(TOKEN);
  });

  it("serves a non-loopback peer that presents the token", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    const page = await fetchPage(`http://${nonLoopbackIPv4()}:${port}/?t=${TOKEN}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain(TOKEN);
  });

  it("refuses a non-loopback peer presenting the wrong token", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    expect((await fetchPage(`http://${nonLoopbackIPv4()}:${port}/?t=nope`)).status).toBe(401);
  });

  it("refuses every non-loopback peer when no token is configured", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, "");
    openServers.add(server);
    // Fail closed, matching the sidecar: a forgotten env var must not publish
    // the rider's transcript and destination to the network.
    expect((await fetchPage(`http://${nonLoopbackIPv4()}:${port}/?t=anything`)).status).toBe(401);
    expect((await fetchPage(`http://127.0.0.1:${port}/`)).status).toBe(200);
  });

  it("refuses a non-loopback websocket upgrade that brings no token", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    await expect(connect(`ws://${nonLoopbackIPv4()}:${port}`)).rejects.toThrow();
    const socket = await connect(`ws://${nonLoopbackIPv4()}:${port}/?t=${TOKEN}`);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe("RDK HUD pairing-secret transport boundary", () => {
  it("redacts pairing secrets from a non-loopback peer's initial replay and later broadcasts despite HTTP spoofing", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    const source = cloneState(livePairingState);
    const sourceBeforePublish = cloneState(source);
    server.publish(source);

    // Holding the bench token gets this peer in; it does not make it local.
    // Redaction keys off the peer address, so a token-bearing stranger still
    // never receives the pairing code.
    const remoteConnection = await connectWithInitial(
      `ws://${nonLoopbackIPv4()}:${port}/?host=127.0.0.1&local=true&t=${TOKEN}`,
      {
        origin: "http://127.0.0.1:8080",
        headers: {
          host: "127.0.0.1:8080",
          forwarded: "for=127.0.0.1;host=localhost",
          "x-forwarded-for": "127.0.0.1, ::1",
          "x-real-ip": "::ffff:127.0.0.1"
        }
      }
    );
    const { socket: remote, initial } = remoteConnection;

    expect(initial.companion).toEqual({
      paired: false,
      locationState: "connected",
      horizontalAccuracyMeters: 8,
      lastFixAgeMs: 600
    });
    expect(initial.transcript).toEqual(livePairingState.transcript);
    expect(initial.navigation).toEqual(withoutRiderLocation(livePairingState).navigation);
    expect(initial.route).toBeNull();
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
      ...withoutRiderLocation(update),
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
    await expect(Promise.all([remoteCleared, localCleared])).resolves.toEqual([
      withoutRiderLocation(noSecret),
      noSecret
    ]);
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

describe("RDK HUD rider-location transport boundary", () => {
  it("sends no route geometry and no rider position to a token-bearing non-loopback peer", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    server.publish(cloneState(livePairingState));

    const { initial } = await connectWithInitial(`ws://${nonLoopbackIPv4()}:${port}/?t=${TOKEN}`);

    expect(initial.route).toBeNull();
    expect(initial.navigation).not.toHaveProperty("position");
    // The whole frame, not just the fields we remembered to name: a rider's
    // coordinates must not survive anywhere in it.
    expect(JSON.stringify(initial)).not.toContain("31.2304");
    expect(JSON.stringify(initial)).not.toContain("121.4737");
    expect(JSON.stringify(initial)).not.toContain("121.47");
  });

  it("gives a loopback peer the full route and rider position", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    server.publish(cloneState(livePairingState));

    const { initial } = await connectWithInitial(`ws://127.0.0.1:${port}/`);

    expect(initial.route?.polyline).toHaveLength(2);
    expect(initial.navigation?.position).toEqual({ lat: 31.2304, lon: 121.4737 });
  });

  it("keeps redacting the rider position on later broadcasts, not just the initial replay", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    // No prior publish, so `connectWithInitial` would block forever waiting on
    // a connect-time reply that never comes (the server only sends one if
    // state already exists). This test cares about the broadcast, not the
    // initial replay, so `connect` — which doesn't wait on a first message —
    // is the right tool here.
    const socket = await connect(`ws://${nonLoopbackIPv4()}:${port}/?t=${TOKEN}`);

    const update = nextState(socket);
    server.publish(cloneState(livePairingState));

    const received = await update;
    expect(received.route).toBeNull();
    expect(received.navigation).not.toHaveProperty("position");
  });

  it("does not mutate the caller's state while redacting", async () => {
    const port = await unusedPort();
    const server = createHudServer(port, 8081, TOKEN);
    openServers.add(server);
    const source = cloneState(livePairingState);
    // Same reasoning as above: connect before any publish exists, so use
    // `connect` rather than `connectWithInitial`.
    await connect(`ws://${nonLoopbackIPv4()}:${port}/?t=${TOKEN}`);

    server.publish(source);

    expect(source.route?.polyline).toHaveLength(2);
    expect(source.navigation?.position).toEqual({ lat: 31.2304, lon: 121.4737 });
  });
});
