import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters } from "werift";

// A real relay process with WEBRTC=on, and a peer that does what the browser
// SDK does. Everything stays on this machine.

const require = createRequire(import.meta.url);
// tsx is loaded in-process: see tests/server-integration.test.ts for why.
const tsxImport = pathToFileURL(require.resolve("tsx")).href;
const TOKEN = "webrtc-integration-token";
const ORIGIN = "https://app.example";

let relay: ChildProcess | null = null;
let tempDir: string | null = null;
let logs = "";
const peers: RTCPeerConnection[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close().catch(() => undefined);
  if (relay && relay.exitCode === null && relay.signalCode === null) {
    relay.kill("SIGKILL");
    await new Promise<void>((resolve) => relay?.once("exit", () => resolve()));
  }
  relay = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${logs}`);
    await sleep(20);
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function startRelay(extra: Record<string, string>): Promise<string> {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-relay-webrtc-"));
  logs = "";
  // Only what the relay needs: a developer's own .env or shell must not leak in.
  relay = spawn(process.execPath, ["--import", tsxImport, "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: tempDir,
      DOTENV_CONFIG_PATH: path.join(tempDir, "no.env"),
      STUDIO_DIR: tempDir,
      PORT: String(port),
      VOICE_PROVIDER: "mock",
      RELAY_AUTH_TOKEN: TOKEN,
      RELAY_ALLOWED_ORIGINS: ORIGIN,
      ACCOUNTS_FILE: path.join(tempDir, "accounts.json"),
      USER_MEMORY_FILE: "off",
      TESTING_DATABASE: "off",
      TESTING_HISTORY_DIR: "off",
      ...extra
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  relay.stdout?.on("data", (chunk) => (logs += String(chunk)));
  relay.stderr?.on("data", (chunk) => (logs += String(chunk)));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`, { headers: { Connection: "close" } })).ok) return baseUrl;
    } catch {
      // The child is still starting.
    }
    await sleep(25);
  }
  throw new Error(`Relay did not become healthy\n${logs}`);
}

function offer(baseUrl: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/agent/webrtc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

/** Opens a session the way the SDK does and collects the relay's events. */
async function openSession(baseUrl: string) {
  const peer = new RTCPeerConnection({
    codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2 })] },
    iceUseDefaultStunServer: false
  });
  peers.push(peer);
  peer.addTransceiver(new MediaStreamTrack({ kind: "audio" }), { direction: "sendrecv" });
  const channel = peer.createDataChannel("events");
  const events: Record<string, unknown>[] = [];
  channel.onMessage.subscribe((message) => events.push(JSON.parse(message.toString()) as Record<string, unknown>));
  await peer.setLocalDescription(await peer.createOffer());
  const response = await offer(
    baseUrl,
    { sdp: peer.localDescription!.sdp },
    { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN }
  );
  const answer = (await response.json()) as { ok: boolean; sdp: string };
  expect(response.status).toBe(201);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  await until(() => channel.readyState === "open", "the events channel");
  const send = (event: unknown) => channel.send(JSON.stringify(event));
  send({ type: "session.start", sampleRate: 16000, channels: 1, encoding: "pcm_s16le", client: "integration" });
  await until(() => events.some((event) => event.type === "session.started"), "session.started");
  return { peer, events, send, answerSdp: answer.sdp };
}

describe("the WebRTC transport on a running relay", () => {
  it("answers 404 when WebRTC is not turned on", async () => {
    const baseUrl = await startRelay({});
    const response = await offer(baseUrl, { sdp: "v=0" }, { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    // A page on another site must be able to read that answer, to fall back.
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  }, 30_000);

  it("guards signalling like the WebSocket: token, origin, and a well-formed offer", async () => {
    const baseUrl = await startRelay({ WEBRTC: "on" });
    expect(logs).toContain("webrtc ready");

    const preflight = await fetch(`${baseUrl}/agent/webrtc`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
        Connection: "close"
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

    const noToken = await offer(baseUrl, { sdp: "v=0" }, { Origin: ORIGIN });
    expect(noToken.status).toBe(401);
    const wrongToken = await offer(baseUrl, { sdp: "v=0" }, { Authorization: "Bearer nope", Origin: ORIGIN });
    expect(wrongToken.status).toBe(401);
    const wrongOrigin = await offer(
      baseUrl,
      { sdp: "v=0" },
      { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example" }
    );
    expect(wrongOrigin.status).toBe(403);

    const authorized = { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN };
    for (const body of [{}, { sdp: 7 }, { sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" }]) {
      const refused = await offer(baseUrl, body, authorized);
      expect(refused.status).toBe(400);
      await expect(refused.json()).resolves.toMatchObject({ ok: false });
    }
    expect((await offer(baseUrl, "{", authorized)).status).toBe(400);
    expect((await offer(baseUrl, { sdp: "x".repeat(80_000) }, authorized)).status).toBe(413);
    // The token is never written to the log.
    expect(logs).not.toContain(TOKEN);
  }, 30_000);

  it("runs a session over a peer connection, and ends it when the client leaves", async () => {
    const baseUrl = await startRelay({ WEBRTC: "on", WEBRTC_UDP_PORTS: "52000-52100" });
    const session = await openSession(baseUrl);
    expect(session.events.find((event) => event.type === "session.started")).toMatchObject({ provider: "mock" });
    // The relay's candidates use only the ports it was given, and no outside server was asked.
    const candidates = session.answerSdp.split("\r\n").filter((line) => line.startsWith("a=candidate"));
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      const [, , , , , port, , type] = candidate.split(" ");
      expect(Number(port)).toBeGreaterThanOrEqual(52_000);
      expect(Number(port)).toBeLessThanOrEqual(52_100);
      expect(type).toBe("host");
    }

    // The mock backend starts its scripted conversation when the microphone opens.
    session.send({ type: "audio.start" });
    await until(
      () => session.events.some((event) => event.type === "status" && event.state === "listening"),
      "the relay to listen"
    );
    await until(() => session.events.some((event) => event.type === "transcript"), "a transcript line");

    session.send({ type: "transport.close" });
    await until(() => /client disconnected \{"code":1000\}/.test(logs), "the session to end");
  }, 30_000);

  it("tells a connected peer why before the relay shuts down", async () => {
    const baseUrl = await startRelay({ WEBRTC: "on" });
    const session = await openSession(baseUrl);
    const exited = new Promise<number | null>((resolve) => relay?.once("exit", (code) => resolve(code)));
    relay?.kill("SIGTERM");
    await until(() => session.events.some((event) => event.type === "transport.close"), "the closing message");
    expect(session.events.find((event) => event.type === "transport.close")).toMatchObject({ code: 1001 });
    expect(await exited).toBe(0);
  }, 30_000);
});
