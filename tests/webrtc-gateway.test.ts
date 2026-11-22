import { afterEach, describe, expect, it } from "vitest";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket } from "werift";
import type { Logger } from "../server/logger";
import {
  PacketOrder,
  createWebRtcGateway,
  webRtcSettingsFromEnv,
  type RtcSocket,
  type WebRtcGateway,
  type WebRtcSettings
} from "../server/webrtc/gateway";
import { loadOpus } from "../server/webrtc/opus";

// These tests run real peer connections over this machine's own network
// interfaces: a client like a browser on one side, the relay's gateway on the
// other. Nothing leaves the machine.

const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const settings = (extra: Partial<WebRtcSettings> = {}): WebRtcSettings => ({
  publicAddresses: [],
  iceServers: [],
  maxSessions: 4,
  ...extra
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

/**
 * Waits until no more audio has arrived for a while and returns how much did.
 * Both peers share this process, so a packet can be in transit for longer than
 * it would be between two machines.
 */
async function settled(audio: unknown[], quietMs = 400): Promise<number> {
  let count = audio.length;
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    await sleep(20);
    if (audio.length !== count) {
      count = audio.length;
      since = Date.now();
    }
  }
  return count;
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A client that does what the browser SDK does: one microphone track, one events channel. */
async function connect(gateway: WebRtcGateway) {
  const peer = new RTCPeerConnection({
    codecs: { audio: [new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2 })] },
    iceServers: []
  });
  closers.push(() => peer.close());
  const microphone = new MediaStreamTrack({ kind: "audio" });
  const transceiver = peer.addTransceiver(microphone, { direction: "sendrecv" });
  const events = peer.createDataChannel("events");
  const received: string[] = [];
  const audio: { at: number; marker: boolean; timestamp: number; payload: Buffer }[] = [];
  events.onMessage.subscribe((message) => received.push(message.toString()));
  transceiver.onTrack.subscribe((track) =>
    track.onReceiveRtp.subscribe((packet) =>
      audio.push({
        at: Date.now(),
        marker: packet.header.marker,
        timestamp: packet.header.timestamp,
        payload: Buffer.from(packet.payload)
      })
    )
  );
  await peer.setLocalDescription(await peer.createOffer());
  let socket: RtcSocket | undefined;
  const answer = await gateway.accept(peer.localDescription!.sdp, (connected) => (socket = connected));
  if (!answer.ok) throw new Error(`offer refused: ${answer.error}`);
  await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  await until(() => socket !== undefined, "the relay's side to open");
  await until(() => events.readyState === "open", "the events channel");

  const encoder = (await loadOpus())(48000);
  closers.push(() => encoder.delete());
  let sequence = 0;
  /** Sends `frames` × 20 ms of a tone from the microphone, in real time or as fast as it goes. */
  const speak = async (frames: number, firstSequence?: number, pauseMs = 20) => {
    if (firstSequence !== undefined) sequence = firstSequence;
    const pcm = Buffer.alloc(960 * 2);
    for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(9000 * Math.sin(i / 8)), i * 2);
    for (let i = 0; i < frames; i++) {
      const header = new RtpHeader({ payloadType: 96, sequenceNumber: sequence & 0xffff, timestamp: sequence * 960 });
      sequence += 1;
      microphone.writeRtp(new RtpPacket(header, encoder.encode(pcm, 960)));
      if (pauseMs > 0) await sleep(pauseMs);
      else if (i % 20 === 19) await sleep(1);
    }
  };
  // The first packets on a new connection can be lost while it settles, in
  // either direction. Send some both ways first, and count from after them.
  socket!.send(Buffer.alloc(960 * 10, 1), { binary: true });
  await speak(10);
  await settled(audio, 250);
  audio.length = 0;
  return { peer, events, received, audio, socket: socket!, speak };
}

function gatewayFor(extra: Partial<WebRtcSettings> = {}, connectTimeoutMs?: number) {
  const gateway = createWebRtcGateway(settings(extra), {
    log: logger,
    ...(connectTimeoutMs ? { connectTimeoutMs } : {})
  });
  closers.push(() => gateway.close());
  return gateway;
}

/** What the socket hands a session, as the relay's connection handler would collect it. */
function collect(socket: RtcSocket) {
  const texts: string[] = [];
  const frames: Buffer[] = [];
  const closes: number[] = [];
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) frames.push(data);
    else texts.push(data.toString("utf8"));
  });
  socket.on("close", (code: number) => closes.push(code));
  return { texts, frames, closes };
}

describe("webRtcSettingsFromEnv", () => {
  it("is off unless WEBRTC=on", () => {
    expect(webRtcSettingsFromEnv({})).toEqual({ problems: [] });
    expect(webRtcSettingsFromEnv({ WEBRTC: "off", WEBRTC_PUBLIC_IP: "203.0.113.5" }).settings).toBeUndefined();
  });

  it("reads addresses, ports, ICE servers and the session limit", () => {
    const { settings: read, problems } = webRtcSettingsFromEnv({
      WEBRTC: "on",
      WEBRTC_PUBLIC_IP: "203.0.113.5, 2001:db8::1",
      WEBRTC_UDP_PORTS: "50000-50100",
      WEBRTC_ICE_SERVERS: '[{"urls":"turn:turn.example.com:3478","username":"u","credential":"c"}]',
      WEBRTC_MAX_SESSIONS: "25"
    });
    expect(problems).toEqual([]);
    expect(read).toEqual({
      publicAddresses: ["203.0.113.5", "2001:db8::1"],
      portRange: [50000, 50100],
      iceServers: [{ urls: "turn:turn.example.com:3478", username: "u", credential: "c" }],
      maxSessions: 25
    });
  });

  it("lowers the session limit to the number of ports it was given", () => {
    const { settings: read, problems } = webRtcSettingsFromEnv({ WEBRTC: "on", WEBRTC_UDP_PORTS: "50000-50009" });
    expect(read?.maxSessions).toBe(10);
    expect(problems).toEqual(["WEBRTC_UDP_PORTS has 10 ports, so at most 10 WebRTC sessions can run at once, not 100"]);
    expect(webRtcSettingsFromEnv({ WEBRTC: "on", WEBRTC_UDP_PORTS: "50000-50100" }).problems).toEqual([]);
  });

  it("reports what it cannot use and carries on with the rest", () => {
    const { settings: read, problems } = webRtcSettingsFromEnv({
      WEBRTC: "on",
      WEBRTC_PUBLIC_IP: "voice.example.com",
      WEBRTC_UDP_PORTS: "80-90",
      WEBRTC_ICE_SERVERS: '{"urls":"stun:x"}',
      WEBRTC_MAX_SESSIONS: "many"
    });
    expect(problems).toHaveLength(4);
    expect(read).toEqual({ publicAddresses: [], iceServers: [], maxSessions: 100 });
  });
});

describe("PacketOrder", () => {
  const packet = (n: number) => Buffer.from([n]);
  const feed = (order: PacketOrder, sequences: number[]) =>
    sequences.flatMap((sequence) => order.push(sequence, packet(sequence & 0xff)).map((payload) => payload[0]));

  it("hands on packets that arrive in order, across the 16-bit wrap", () => {
    expect(feed(new PacketOrder(), [65_534, 65_535, 0, 1])).toEqual([254, 255, 0, 1]);
  });

  it("puts a late packet back in its place", () => {
    // 3 arrives after 4 and 5, as a packet resent after a loss does.
    expect(feed(new PacketOrder(), [1, 2, 4, 5, 3, 6])).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gives a missing packet up after three newer ones, and drops it if it comes after that", () => {
    const order = new PacketOrder();
    expect(feed(order, [1, 2])).toEqual([1, 2]);
    expect(feed(order, [4, 5])).toEqual([]);
    expect(feed(order, [6])).toEqual([4, 5, 6]);
    expect(feed(order, [3])).toEqual([]);
    expect(feed(order, [7])).toEqual([7]);
  });

  it("drops duplicates", () => {
    expect(feed(new PacketOrder(), [1, 2, 2, 1, 3, 5, 5, 4])).toEqual([1, 2, 3, 4, 5]);
  });

  it("starts again when the sender does", () => {
    const order = new PacketOrder();
    expect(feed(order, [100, 101])).toEqual([100, 101]);
    expect(feed(order, [9000 & 0xffff, 9001])).toEqual([9000 & 0xff, 9001 & 0xff]);
    expect(feed(order, [20, 21])).toEqual([20, 21]);
  });

  it("forgets what it was waiting for when reset", () => {
    const order = new PacketOrder();
    expect(feed(order, [1, 3])).toEqual([1]);
    order.reset();
    expect(feed(order, [50, 2, 51])).toEqual([50, 51]);
  });

  it("keeps its own copy of a packet that has to wait", () => {
    const order = new PacketOrder();
    order.push(1, packet(1));
    const reused = packet(3);
    order.push(3, reused);
    reused[0] = 99;
    expect(order.push(2, packet(2)).map((payload) => payload[0])).toEqual([2, 3]);
  });
});

describe("offers", () => {
  it("refuses what is not an offer with an audio track and a data channel", async () => {
    const gateway = gatewayFor();
    for (const sdp of [undefined, "", 7, "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", "x".repeat(20_001)]) {
      const answer = await gateway.accept(sdp, () => undefined);
      expect(answer).toMatchObject({ ok: false, status: 400 });
    }
    const garbled = await gateway.accept(
      "v=0\r\na=group:BUNDLE 0 1\r\nm=audio nonsense\r\nm=application nonsense\r\n",
      () => undefined
    );
    expect(garbled).toMatchObject({ ok: false, status: 400 });
    expect(gateway.active()).toBe(0);
  });

  it("refuses an offer that would make the relay open more than one transport", async () => {
    const gateway = gatewayFor();
    const peer = new RTCPeerConnection({});
    closers.push(() => peer.close());
    peer.addTransceiver("audio", { direction: "sendrecv" });
    peer.createDataChannel("events");
    await peer.setLocalDescription(await peer.createOffer());
    const offer = peer.localDescription!.sdp;
    expect(offer).toMatch(/^a=group:BUNDLE /m);
    // A second audio section, a video section, or the same two sections on separate transports.
    const audio = offer.slice(offer.indexOf("m=audio"), offer.indexOf("m=application"));
    for (const sdp of [
      offer + audio,
      offer + audio.replace("m=audio", "m=video"),
      offer.replace(/^a=group:BUNDLE .*\r\n/m, ""),
      offer.replace(/^a=group:BUNDLE .*$/m, "a=group:BUNDLE 0")
    ]) {
      expect(await gateway.accept(sdp, () => undefined)).toMatchObject({ ok: false, status: 400 });
    }
    expect(gateway.active()).toBe(0);
    // The untouched offer is fine.
    expect((await gateway.accept(offer, () => undefined)).ok).toBe(true);
  });

  it("limits how many peers one address may have connecting at the same time", async () => {
    const gateway = gatewayFor({ maxSessions: 50 }, 400);
    const peer = new RTCPeerConnection({});
    closers.push(() => peer.close());
    peer.addTransceiver("audio", { direction: "sendrecv" });
    peer.createDataChannel("events");
    await peer.setLocalDescription(await peer.createOffer());
    const offer = peer.localDescription!.sdp;
    // The answers are never used, so these peers stay half-open.
    for (let i = 0; i < 8; i += 1) expect((await gateway.accept(offer, () => undefined, "198.51.100.9")).ok).toBe(true);
    expect(await gateway.accept(offer, () => undefined, "198.51.100.9")).toMatchObject({ ok: false, status: 503 });
    // Somebody else is not held up by them.
    expect((await gateway.accept(offer, () => undefined, "198.51.100.10")).ok).toBe(true);
    // Once they have timed out, the address may try again.
    await until(() => gateway.active() === 0, "the half-open peers to be dropped", 5000);
    expect((await gateway.accept(offer, () => undefined, "198.51.100.9")).ok).toBe(true);
  }, 20_000);

  it("says at once when no UDP port is free, so the client need not wait to fall back", async () => {
    // Other tests and other programs may hold ports: take a range of two, well out of the way.
    const gateway = gatewayFor({ maxSessions: 50, portRange: [53_210, 53_211] }, 400);
    const peer = new RTCPeerConnection({});
    closers.push(() => peer.close());
    peer.addTransceiver("audio", { direction: "sendrecv" });
    peer.createDataChannel("events");
    await peer.setLocalDescription(await peer.createOffer());
    const offer = peer.localDescription!.sdp;
    const answers = [];
    for (let i = 0; i < 3; i += 1) answers.push(await gateway.accept(offer, () => undefined, `198.51.100.${i}`));
    expect(answers.filter((answer) => answer.ok)).toHaveLength(2);
    expect(answers[2]).toMatchObject({ ok: false, status: 503 });
    // The refused peer holds no place.
    expect(gateway.active()).toBe(2);
  });

  it("tells a client only the public addresses, when the relay has been given them", async () => {
    const peer = new RTCPeerConnection({});
    closers.push(() => peer.close());
    peer.addTransceiver("audio", { direction: "sendrecv" });
    peer.createDataChannel("events");
    await peer.setLocalDescription(await peer.createOffer());
    const candidates = (sdp: string) =>
      sdp
        .split("\r\n")
        .filter((line) => line.startsWith("a=candidate:"))
        .map((line) => line.split(" ")[4]);
    const open = await gatewayFor().accept(peer.localDescription!.sdp, () => undefined);
    const behindNat = await gatewayFor({ publicAddresses: ["203.0.113.5"] }).accept(
      peer.localDescription!.sdp,
      () => undefined
    );
    if (!open.ok || !behindNat.ok) throw new Error("an offer was refused");
    expect(candidates(open.sdp).length).toBeGreaterThan(0);
    expect(candidates(behindNat.sdp).length).toBeGreaterThan(0);
    expect(new Set(candidates(behindNat.sdp))).toEqual(new Set(["203.0.113.5"]));
  });

  it("refuses a peer beyond the session limit, and frees the place when one leaves", async () => {
    const gateway = gatewayFor({ maxSessions: 1 });
    const first = await connect(gateway);
    expect(gateway.active()).toBe(1);
    const peer = new RTCPeerConnection({});
    closers.push(() => peer.close());
    peer.addTransceiver("audio", { direction: "sendrecv" });
    peer.createDataChannel("events");
    await peer.setLocalDescription(await peer.createOffer());
    expect(await gateway.accept(peer.localDescription!.sdp, () => undefined)).toMatchObject({ ok: false, status: 503 });
    first.socket.terminate();
    await until(() => gateway.active() === 0, "the place to be freed");
  });

  it("drops a peer that never connects", async () => {
    const gateway = gatewayFor({}, 300);
    const peer = new RTCPeerConnection({});
    closers.push(() => peer.close());
    peer.addTransceiver("audio", { direction: "sendrecv" });
    peer.createDataChannel("events");
    await peer.setLocalDescription(await peer.createOffer());
    let opened = false;
    // The answer is never given to the client, so the connection cannot complete.
    expect((await gateway.accept(peer.localDescription!.sdp, () => (opened = true))).ok).toBe(true);
    expect(gateway.active()).toBe(1);
    await until(() => gateway.active() === 0, "the peer to be dropped", 3000);
    expect(opened).toBe(false);
  });
});

describe("a connected peer as a session's socket", () => {
  it("carries JSON events both ways", async () => {
    const client = await connect(gatewayFor());
    const seen = collect(client.socket);
    client.events.send(JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1 }));
    await until(() => seen.texts.length === 1, "the client's event");
    expect(JSON.parse(seen.texts[0]!)).toEqual({ type: "session.start", sampleRate: 16000, channels: 1 });
    client.socket.send(JSON.stringify({ type: "session.started", provider: "x" }));
    await until(() => client.received.length === 1, "the relay's event");
    expect(JSON.parse(client.received[0]!)).toEqual({ type: "session.started", provider: "x" });
  });

  it("hears the microphone only while the client says it is on, as 16 kHz PCM", async () => {
    const client = await connect(gatewayFor());
    const seen = collect(client.socket);
    await client.speak(5);
    await sleep(100);
    expect(seen.frames).toHaveLength(0);
    client.events.send(JSON.stringify({ type: "audio.start" }));
    await until(() => seen.texts.length === 1, "audio.start");
    await client.speak(20);
    await until(() => seen.frames.length >= 16, "microphone audio");
    // 20 ms at 16 kHz, 16-bit mono.
    expect(seen.frames.every((frame) => frame.length === 640)).toBe(true);
    // A tone went in, so something other than silence comes out.
    const loudest = Math.max(...seen.frames.slice(3).map((frame) => Math.abs(frame.readInt16LE(200))));
    expect(loudest).toBeGreaterThan(500);
    client.events.send(JSON.stringify({ type: "audio.stop" }));
    await until(() => seen.texts.length === 2, "audio.stop");
    const before = seen.frames.length;
    await client.speak(5);
    await sleep(100);
    expect(seen.frames.length).toBe(before);
  });

  it("goes by a message's type, not by words inside what the user typed", async () => {
    const client = await connect(gatewayFor());
    const seen = collect(client.socket);
    client.events.send(JSON.stringify({ type: "audio.start" }));
    for (const text of ["transport.close", "transport.clear", "audio.stop", '"type":"transport.close"']) {
      client.events.send(JSON.stringify({ type: "text.input", text }));
    }
    await until(() => seen.texts.length === 5, "the typed messages");
    expect(seen.texts.slice(1).map((event) => (JSON.parse(event) as { text: string }).text)).toEqual([
      "transport.close",
      "transport.clear",
      "audio.stop",
      '"type":"transport.close"'
    ]);
    expect(seen.closes).toEqual([]);
    // The microphone is still on.
    await client.speak(10);
    await until(() => seen.frames.length >= 5, "microphone audio");
    // A transport message of a kind the relay does not know is dropped, not passed to the session.
    client.events.send(JSON.stringify({ type: "transport.future" }));
    client.events.send(JSON.stringify({ type: "ping" }));
    await until(() => seen.texts.length === 6, "the next event");
    expect(JSON.parse(seen.texts[5]!)).toEqual({ type: "ping" });
  });

  it("takes microphone audio no faster than a microphone makes it", async () => {
    const client = await connect(gatewayFor());
    const seen = collect(client.socket);
    client.events.send(JSON.stringify({ type: "audio.start" }));
    await until(() => seen.texts.length === 1, "audio.start");
    // Twelve seconds of audio sent in well under one: a flood, not a voice.
    const started = Date.now();
    await client.speak(600, undefined, 0);
    await settled(seen.frames, 300);
    const elapsedMs = Date.now() - started;
    const heardMs = seen.frames.reduce((sum, frame) => sum + frame.length / 32, 0);
    // What had been saved up for a burst, plus a little more than the time that passed.
    expect(heardMs).toBeGreaterThan(1000);
    expect(heardMs).toBeLessThan(2000 + elapsedMs * 1.25 + 200);
    expect(heardMs).toBeLessThan(600 * 20 * 0.6);
    // A real voice afterwards is heard again.
    await sleep(500);
    const before = seen.frames.length;
    await client.speak(20);
    await until(() => seen.frames.length >= before + 12, "the voice after the flood");
  }, 20_000);

  it("drops a peer that sends more than the window it was given", async () => {
    const gateway = gatewayFor();
    const client = await connect(gateway);
    const seen = collect(client.socket);
    // What a peer that ignores flow control leaves behind: a window far below zero.
    const sctp = (client.socket.connection.sctpTransport as unknown as { sctp: { advertisedRwnd: number } }).sctp;
    expect(typeof sctp.advertisedRwnd).toBe("number");
    client.events.send(JSON.stringify({ type: "ping" }));
    await until(() => seen.texts.length === 1, "an ordinary event");
    sctp.advertisedRwnd = -1_000_000;
    client.events.send(JSON.stringify({ type: "ping" }));
    await until(() => seen.closes.length === 1, "the peer to be dropped");
    expect(seen.closes).toEqual([1006]);
    expect(seen.texts).toHaveLength(1);
    expect(gateway.active()).toBe(0);
  });

  it("paces the assistant's voice out in real time, however fast it was written", async () => {
    const client = await connect(gatewayFor());
    const second = Buffer.alloc(24_000 * 2);
    for (let i = 0; i < 24_000; i++) second.writeInt16LE(Math.round(9000 * Math.sin(i / 6)), i * 2);
    const started = Date.now();
    // One second of speech, all at once and in awkward pieces.
    client.socket.send(second.subarray(0, 1001), { binary: true });
    client.socket.send(second.subarray(1001));
    await sleep(400);
    expect(client.audio.length).toBeGreaterThan(8);
    expect(client.audio.length).toBeLessThan(35);
    // 50 packets, give or take one the network lost.
    await until(() => client.audio.length >= 47, "the whole second");
    expect(Date.now() - started).toBeGreaterThan(800);
    expect(await settled(client.audio)).toBeLessThanOrEqual(50);
    // The first packet of a burst is marked, and RTP time moves 20 ms a packet.
    const marked = client.audio.filter((packet) => packet.marker);
    expect(marked.length).toBeLessThanOrEqual(1);
    const times = client.audio.map((packet) => packet.timestamp).sort((a, b) => a - b);
    expect(new Set(times.map((time) => (time - times[0]!) % 960))).toEqual(new Set([0]));
    expect(times.at(-1)! - times[0]!).toBeLessThanOrEqual(49 * 960);
    // What arrives decodes to the tone that was sent.
    const decoder = (await loadOpus())(24000);
    closers.push(() => decoder.delete());
    const pcm = decoder.decode(client.audio[30]!.payload);
    expect(pcm.length).toBe(960);
    expect(Math.max(...Array.from({ length: 480 }, (_, i) => Math.abs(pcm.readInt16LE(i * 2))))).toBeGreaterThan(2000);
  });

  it("paces speech that arrives in many small pieces, as the session core writes it", async () => {
    const client = await connect(gatewayFor());
    const started = Date.now();
    // Two seconds of speech in 20 ms pieces, written in one go.
    for (let i = 0; i < 100; i++) client.socket.send(Buffer.alloc(960, 1), { binary: true });
    await sleep(500);
    expect(client.audio.length).toBeGreaterThan(10);
    expect(client.audio.length).toBeLessThan(40);
    await until(() => client.audio.length >= 95, "all of it");
    expect(Date.now() - started).toBeGreaterThan(1750);
    expect(await settled(client.audio)).toBeLessThanOrEqual(100);
    expect(client.audio.filter((packet) => packet.marker).length).toBeLessThanOrEqual(1);
  });

  it("stops what is still to be sent when the page silences the assistant", async () => {
    const client = await connect(gatewayFor());
    const seen = collect(client.socket);
    for (let i = 0; i < 150; i++) client.socket.send(Buffer.alloc(960, 1), { binary: true });
    await until(() => client.audio.length >= 5, "speech to start");
    client.events.send(JSON.stringify({ type: "transport.clear" }));
    // Three seconds were queued; the stream goes quiet long before that.
    expect(await settled(client.audio)).toBeLessThan(75);
    // The session is never told: this is between the page and the transport.
    expect(seen.texts).toEqual([]);
  });

  it("drops queued speech when the user says or types something", async () => {
    const client = await connect(gatewayFor());
    for (const event of [
      { type: "status", state: "asr", detail: "" },
      { type: "transcript", turnId: "1", deliveryId: "1", speaker: "rider", text: "wait" }
    ]) {
      const before = client.audio.length;
      client.socket.send(Buffer.alloc(24_000 * 2 * 2, 1));
      await until(() => client.audio.length >= before + 3, "speech to start");
      client.socket.send(JSON.stringify(event));
      // Two seconds (100 packets) were queued each time.
      expect((await settled(client.audio)) - before).toBeLessThan(50);
    }
    // The assistant's own captions and other statuses interrupt nothing.
    const before = client.audio.length;
    client.socket.send(Buffer.alloc(960 * 25, 1));
    client.socket.send(
      JSON.stringify({ type: "transcript", turnId: "2", deliveryId: "2", speaker: "agent", text: "hi" })
    );
    client.socket.send(JSON.stringify({ type: "status", state: "thinking", detail: "" }));
    await until(() => client.audio.length >= before + 23, "the whole reply");
  });

  it("sends a tail shorter than one frame, padded, instead of holding it", async () => {
    const client = await connect(gatewayFor());
    client.socket.send(Buffer.alloc(960 + 300, 1));
    await until(() => client.audio.length === 2, "both frames");
    expect(await settled(client.audio, 200)).toBe(2);
  });

  it("drops what has not been sent yet when the user speaks over the assistant", async () => {
    const client = await connect(gatewayFor());
    client.socket.send(Buffer.alloc(24_000 * 2 * 3, 1));
    await until(() => client.audio.length >= 5, "speech to start");
    client.socket.send(JSON.stringify({ type: "status", state: "hearing", detail: "" }));
    const heard = await settled(client.audio);
    expect(heard).toBeLessThan(50);
    // The next reply starts a new burst.
    client.socket.send(Buffer.alloc(960 * 10, 1));
    await until(() => client.audio.length >= heard + 8, "the next reply");
    expect(client.audio.slice(heard).filter((packet) => packet.marker).length).toBeLessThanOrEqual(1);
  });

  it("closes after the last of the speech, telling the client why", async () => {
    const client = await connect(gatewayFor());
    const seen = collect(client.socket);
    client.socket.send(Buffer.alloc(960 * 20, 1));
    client.socket.close(4001, "agent");
    expect(client.socket.readyState).toBe(2);
    // Nothing more is accepted, but what was queued still plays out.
    client.socket.send(JSON.stringify({ type: "status", state: "ready" }));
    await until(() => seen.closes.length === 1, "the close");
    expect(seen.closes).toEqual([4001]);
    expect(client.audio.length).toBeGreaterThanOrEqual(17);
    expect(client.received.map((text) => JSON.parse(text))).toEqual([
      { type: "transport.close", code: 4001, reason: "agent" }
    ]);
    expect(client.socket.readyState).toBe(3);
  });

  it("ends as a normal close when the client says it is leaving, and as a lost one when it vanishes", async () => {
    const gateway = gatewayFor();
    const leaving = await connect(gateway);
    const left = collect(leaving.socket);
    leaving.events.send(JSON.stringify({ type: "transport.close" }));
    await until(() => left.closes.length === 1, "the normal close");
    expect(left.closes).toEqual([1000]);
    expect(left.texts).toEqual([]);

    const vanishing = await connect(gateway);
    const lost = collect(vanishing.socket);
    await vanishing.peer.close();
    await until(() => lost.closes.length === 1, "the lost connection", 12_000);
    expect(lost.closes).toEqual([1006]);
    await until(() => gateway.active() === 0, "both places to be freed");
  }, 20_000);

  it("answers a liveness probe while connected, and closes every peer on shutdown", async () => {
    const gateway = gatewayFor();
    const client = await connect(gateway);
    let pongs = 0;
    client.socket.on("pong", () => (pongs += 1));
    client.socket.ping();
    expect(pongs).toBe(1);
    // A phone changing network is "disconnected" for a moment. That is not dead:
    // the gateway's own grace period decides, not whoever asks in that moment.
    const state = (value: string) =>
      Object.defineProperty(client.socket.connection, "connectionState", { value, configurable: true });
    state("disconnected");
    client.socket.ping();
    expect(pongs).toBe(2);
    state("failed");
    client.socket.ping();
    expect(pongs).toBe(2);
    state("connected");
    expect([...gateway.sockets()]).toEqual([client.socket]);
    const seen = collect(client.socket);
    gateway.close();
    await until(() => seen.closes.length === 1, "the shutdown close");
    expect(seen.closes).toEqual([1001]);
    expect(JSON.parse(client.received.at(-1)!)).toMatchObject({ type: "transport.close", code: 1001 });
  });
});
