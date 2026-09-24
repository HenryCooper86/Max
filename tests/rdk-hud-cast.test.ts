import { createServer, get } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createCastReceiver, CAST_STALE_MS } from "../rdk/agent/src/hud-cast/server";
import { createHudBond } from "../rdk/agent/src/hud-cast/bond";
import { parseCastFrame, type CastFrame } from "../rdk/agent/src/hud-cast/protocol";

const frame: CastFrame = {
  type: "hud.frame",
  sequence: 1,
  destination: "人民广场",
  instruction: "右转",
  distance: 120,
  remaining: 2000,
  seconds: 300,
  offRoute: false,
  polyline: [
    { lat: 31.23, lon: 121.47 },
    { lat: 31.24, lon: 121.48 }
  ],
  position: { lat: 31.23, lon: 121.47 }
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
async function harness(musicFactory?: Parameters<typeof createCastReceiver>[3]) {
  let time = 1_000_000;
  const receiver = createCastReceiver("<title>HUD</title>", () => time, "", musicFactory, createHudBond(""));
  const server = createServer((req, res) => {
    if (!receiver.handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    receiver.upgrade(req, socket, head);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const url = `http://127.0.0.1:${address.port}`;
  cleanups.push(() => {
    receiver.close();
    server.close();
  });
  const state = async () => (await fetch(`${url}/cast/state`)).json();
  async function connect() {
    const socket = new WebSocket(url.replace("http:", "ws:") + "/cast/socket");
    await once(socket, "open");
    cleanups.push(() => socket.terminate());
    return socket;
  }
  async function send(socket: WebSocket, value: unknown) {
    const reply = once(socket, "message");
    socket.send(JSON.stringify(value));
    return JSON.parse(String((await reply)[0]));
  }
  return {
    url,
    state,
    connect,
    send,
    advance: (ms: number) => {
      time += ms;
    }
  };
}

describe("local phone HUD sharing", () => {
  it("remembers a code pairing and resumes after disconnect without reusing the code", async () => {
    const h = await harness();
    const first = await h.connect();
    const ready = await h.send(first, { type: "hud.join", code: (await h.state()).code, remember: true });
    expect(ready.resumeToken).toMatch(/^[\w-]{43}$/);
    // Reconnect before the old socket has timed out (e.g. a half-open Wi-Fi connection).
    const closed = once(first, "close");
    const second = await h.connect();
    expect(await h.send(second, { type: "hud.join", resumeToken: ready.resumeToken })).toEqual({ type: "hud.ready" });
    await closed;
    expect((await h.state()).connected).toBe(true);
    expect(JSON.stringify(await h.state())).not.toContain(ready.resumeToken);
  });
  it("renders the phone route, detects stale guidance and accepts fresh reroutes", async () => {
    const h = await harness();
    const { code } = await h.state();
    const socket = await h.connect();
    expect(await h.send(socket, { type: "hud.join", code })).toEqual({ type: "hud.ready" });
    expect(await h.send(socket, frame)).toEqual({ type: "hud.ack", sequence: 1 });
    expect(await h.state()).toMatchObject({ code: null, connected: true, stale: false, frame });
    h.advance(CAST_STALE_MS + 1);
    expect(await h.state()).toMatchObject({ stale: true });
    const reroute = { ...frame, sequence: 2, instruction: "左转", polyline: [...frame.polyline].reverse() };
    await h.send(socket, reroute);
    expect(await h.state()).toMatchObject({ stale: false, frame: reroute });
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "hud.stop" }));
    await closed;
    expect(await h.state()).toMatchObject({ connected: false, frame: null });
    expect((await h.state()).code).toMatch(/^\d{6}$/);
  });

  it("serves paired map images locally without making stale GPS fresh, and clears them on disconnect", async () => {
    const h = await harness();
    const socket = await h.connect();
    await h.send(socket, { type: "hud.join", code: (await h.state()).code });
    await h.send(socket, frame);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    expect(await h.send(socket, { type: "hud.map", sequence: 1, jpeg: jpeg.toString("base64") })).toEqual({
      type: "hud.map.ack",
      sequence: 1
    });
    const response = await fetch(`${h.url}/cast/map`);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(jpeg);
    expect((await h.state()).mapSequence).toBe(1);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(`${h.url}/cast/map`, { headers: { Host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    });
    expect(status).toBe(403);
    h.advance(CAST_STALE_MS + 1);
    await h.send(socket, { type: "hud.map", sequence: 2, jpeg: jpeg.toString("base64") });
    expect((await h.state()).stale).toBe(true);
    expect((await fetch(`${h.url}/cast/map`)).status).toBe(404);
    await h.send(socket, { ...frame, sequence: 2 });
    h.advance(5_001);
    expect((await h.state()).mapSequence).toBeNull();
    expect((await fetch(`${h.url}/cast/map`)).status).toBe(404);
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "hud.stop" }));
    await closed;
    expect((await h.state()).mapSequence).toBeNull();
  });

  it("rejects non-JPEG map payloads from a paired sender", async () => {
    const h = await harness();
    const socket = await h.connect();
    await h.send(socket, { type: "hud.join", code: (await h.state()).code });
    await h.send(socket, frame);
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "hud.map", sequence: 1, jpeg: Buffer.from("<svg/>").toString("base64") }));
    expect((await closed)[0]).toBe(1008);
  });

  it("updates compass direction without making old GPS fresh", async () => {
    const h = await harness();
    const socket = await h.connect();
    await h.send(socket, { type: "hud.join", code: (await h.state()).code });
    await h.send(socket, frame);
    h.advance(CAST_STALE_MS + 1);
    expect(await h.send(socket, { type: "hud.heading", heading: 90 })).toEqual({ type: "hud.heading.ack" });
    expect(await h.state()).toMatchObject({ heading: 90, stale: true });
  });

  it("pushes position updates to the local display without waiting for polling", async () => {
    const h = await harness();
    const socket = await h.connect();
    await h.send(socket, { type: "hud.join", code: (await h.state()).code });
    await h.send(socket, frame);
    const controller = new AbortController();
    const response = await fetch(`${h.url}/cast/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"sequence":1');
      await h.send(socket, { ...frame, sequence: 2, position: { lat: 31.24, lon: 121.48 } });
      const pushed = new TextDecoder().decode((await reader.read()).value);
      expect(pushed).toContain('"sequence":2');
      expect(pushed).toContain('"lat":31.24');
    } finally {
      controller.abort();
    }
  });

  it("keeps an idle sender paired with heartbeats without refreshing stale guidance", async () => {
    const h = await harness();
    const socket = await h.connect();
    await h.send(socket, { type: "hud.join", code: (await h.state()).code });
    await h.send(socket, frame);
    for (let i = 0; i < 20; i++) {
      h.advance(4_000);
      expect(await h.send(socket, { type: "hud.ping" })).toEqual({ type: "hud.pong" });
    }
    // Let the real receiver watchdog run after 80 seconds of simulated idle GPS.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await h.state()).toMatchObject({ connected: true, code: null, stale: true, frame });
    await h.send(socket, { ...frame, sequence: 2 });
    expect(await h.state()).toMatchObject({ connected: true, stale: false });
    const closed = once(socket, "close");
    h.advance(30_001); // A dead peer must still lose ownership.
    await closed;
    expect(await h.state()).toMatchObject({ connected: false, frame: null });
  });

  it("rejects frames before pairing and a second sender cannot evict the owner", async () => {
    const h = await harness();
    const bad = await h.connect();
    const rejected = once(bad, "close");
    bad.send(JSON.stringify(frame));
    expect((await rejected)[0]).toBe(1008);
    const { code } = await h.state();
    const owner = await h.connect();
    await h.send(owner, { type: "hud.join", code });
    await h.send(owner, frame);
    const second = await h.connect();
    const closed = once(second, "close");
    second.send(JSON.stringify({ type: "hud.join", code }));
    expect((await closed)[0]).toBe(1008);
    expect(await h.state()).toMatchObject({ connected: true, frame });
  });

  it("clears the route on disconnect or out-of-order frames", async () => {
    const h = await harness();
    const socket = await h.connect();
    await h.send(socket, { type: "hud.join", code: (await h.state()).code });
    await h.send(socket, frame);
    const closed = once(socket, "close");
    socket.send(JSON.stringify(frame));
    await closed;
    expect(await h.state()).toMatchObject({ frame: null, connected: false });
  });

  it("expires codes and bounds guesses", async () => {
    const h = await harness();
    const { code } = await h.state();
    h.advance(300_001);
    const socket = await h.connect();
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "hud.join", code }));
    expect((await closed)[0]).toBe(1008);
    const next = (await h.state()).code;
    for (let i = 0; i < 5; i++) {
      const client = await h.connect();
      const done = once(client, "close");
      client.send(JSON.stringify({ type: "hud.join", code: i === 4 ? next : "000000" }));
      expect((await done)[0]).toBe(1008);
    }
  });

  it("blocks browser senders and rebinding reads of the pairing code", async () => {
    const h = await harness();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(h.url + "/cast/state", { headers: { Host: "attacker.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    });
    expect(status).toBe(403);
    const client = new WebSocket(h.url.replace("http:", "ws:") + "/cast/socket", { origin: "http://attacker.example" });
    await once(client, "error");
  });

  it("accepts bounded upcoming turns and rejects invalid optional geometry", () => {
    const turn = { lat: 31.24, lon: 121.48, instruction: "右转", distance: 120 };
    expect(parseCastFrame({ ...frame, turns: [turn] }).turns).toEqual([turn]);
    expect(parseCastFrame(frame).turns).toBeUndefined();
    for (const turns of [
      Array(4).fill(turn),
      [{ ...turn, lat: 91 }],
      [{ ...turn, distance: -1 }],
      [{ ...turn, instruction: 4 }]
    ]) {
      expect(() => parseCastFrame({ ...frame, turns })).toThrow();
    }
  });

  it("validates finite coordinates and bounded payloads", () => {
    expect(parseCastFrame(frame)).toEqual(frame);
    for (const bad of [
      { ...frame, polyline: [] },
      { ...frame, polyline: Array(2049).fill(frame.polyline[0]) },
      { ...frame, position: { lat: 91, lon: 2 } },
      { ...frame, seconds: Infinity },
      { ...frame, distance: -1 },
      { ...frame, sequence: 0 },
      { ...frame, instruction: "x".repeat(501) }
    ])
      expect(() => parseCastFrame(bad)).toThrow();
    expect(parseCastFrame({ ...frame, secret: "discard" })).not.toHaveProperty("secret");
  });
});

describe("HUD music command boundary", () => {
  it("allows same-origin local controls but refuses cross-origin, missing-header and GET commands", async () => {
    const control = vi.fn(async () => ({ ok: true, message: "" }));
    const h = await harness(() => ({
      current: { available: true, connected: false, busy: false, player: null, message: "" },
      update: async () => {},
      control,
      connectionControl: async () => ({ ok: true, message: "" }),
      close: () => {}
    }));
    const headers = { "Content-Type": "application/json", "X-HUD-Control": "1", Origin: h.url };
    const body = JSON.stringify({ action: "pause", playerId: "current" });
    expect((await fetch(h.url + "/cast/music", { method: "POST", headers, body })).status).toBe(200);
    expect(control).toHaveBeenCalledWith("pause", "current");
    for (const badHeaders of [
      { ...headers, Origin: "https://other.example" },
      { ...headers, "X-HUD-Control": "" }
    ]) {
      expect((await fetch(h.url + "/cast/music", { method: "POST", headers: badHeaders, body })).status).toBe(403);
    }
    expect((await fetch(h.url + "/cast/music")).status).toBe(403);
    expect((await fetch(h.url + "/cast/music", { method: "POST", headers, body: "null" })).status).toBe(400);
    expect(control).toHaveBeenCalledTimes(1);
  });
});
