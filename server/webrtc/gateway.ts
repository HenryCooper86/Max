import { EventEmitter } from "node:events";
import type { MediaStreamTrack, RTCDataChannel, RTCPeerConnection, RtpPacket } from "werift";
import type { Logger } from "../logger";
import { PacketOrder } from "../packet-order";
import { loadOpus, MAX_OPUS_PACKET_BYTES, type OpusCodec, type OpusFactory } from "./opus";

/**
 * WebRTC transport for the `/agent` protocol.
 *
 * A WebSocket runs over TCP: one lost packet holds back everything behind it,
 * which on a poor mobile network is heard as a stall. WebRTC sends audio over
 * UDP with Opus, and the browser's own jitter buffer, loss concealment and
 * echo cancellation do the rest.
 *
 * The protocol itself does not change. A peer connection carries exactly what
 * the WebSocket carries, in two lanes:
 *
 *   data channel "events"   the JSON events, both ways, one event per message
 *   audio track, Opus       the microphone up, the assistant's voice down
 *
 * To the rest of the relay a peer is a socket: {@link RtcSocket} has the part
 * of the `ws` interface a session uses, so authentication, tokens, usage
 * limits, tools and every voice backend work as they do over a WebSocket.
 * Binary frames written to it (24 kHz PCM16, as fast as the model produces
 * them) are paced out as 20 ms Opus packets; Opus packets from the browser
 * are decoded to the 16 kHz PCM16 the relay expects.
 *
 * Three messages exist only on this transport, and no session sees them. A
 * peer connection has no close code, so the relay sends
 * `{ "type": "transport.close", "code", "reason" }` just before it closes, and
 * a client that is leaving on purpose sends `{ "type": "transport.close" }`.
 * A client that silences the assistant sends `{ "type": "transport.clear" }`,
 * because the speech still to be played is held here, not in the page.
 *
 * Signalling is one HTTP request (`POST /agent/webrtc`, see server/index.ts):
 * the browser's offer in, the relay's answer out, candidates included.
 */

export type WebRtcSettings = {
  /** Addresses clients can reach the relay at, when it is behind 1:1 NAT (most clouds). */
  publicAddresses: string[];
  /** UDP ports the relay may use, so a firewall can open exactly these. */
  portRange?: [number, number];
  /** STUN/TURN servers for the relay's own side. */
  iceServers: { urls: string; username?: string; credential?: string }[];
  maxSessions: number;
};

const DEFAULT_MAX_SESSIONS = 100;
const MAX_OFFER_BYTES = 20_000;
/** A peer that has not connected and opened its events channel by then is dropped. */
const CONNECT_TIMEOUT_MS = 15_000;
/** How long a peer may stay "disconnected" (a network change) before it is given up. */
const DISCONNECT_GRACE_MS = 8_000;
/** 20 ms of what the relay sends: 24 kHz mono PCM16. */
const OUT_RATE = 24_000;
const OUT_FRAME_SAMPLES = 480;
const OUT_FRAME_BYTES = OUT_FRAME_SAMPLES * 2;
const FRAME_MS = 20;
/** What the relay expects from a microphone. */
const IN_RATE = 16_000;
/** Opus always counts RTP time at 48 kHz. */
const RTP_TICKS_PER_FRAME = 960;
/** Speech one session may have waiting to be paced out: two minutes, about 6 MB.
 *  Beyond this the newest audio is dropped. */
const MAX_QUEUED_BYTES = OUT_RATE * 2 * 120;
/** The same for all sessions together, so a busy relay's memory stays bounded. */
const MAX_TOTAL_QUEUED_BYTES = 512 * 1024 * 1024;
/** How far past its receive window a peer may go before it is dropped. */
const WINDOW_PROBE_BYTES = 65_536;
/** Peers from one address that may be connecting at the same moment. */
const MAX_PENDING_PER_ADDRESS = 8;
/** Microphone audio is taken a little faster than real time, with this much saved up
 *  for a burst after a network stall. Opus can expand a few bytes into 120 ms of
 *  audio, so without a limit a peer could flood a backend. */
const MIC_BURST_MS = 2_000;
const MIC_RATE_FACTOR = 1.25;
/** The longest a closing socket waits for queued speech to play out. */
const CLOSE_DRAIN_MS = 10_000;
/** A tail shorter than one frame is padded and sent after this much quiet. */
const TAIL_FLUSH_MS = 60;

const IP_ADDRESS = /^[0-9a-fA-F:.]{3,45}$/;

/** Reads the WEBRTC_* variables. No settings unless `WEBRTC=on`. */
export function webRtcSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  settings?: WebRtcSettings;
  problems: string[];
} {
  if (env.WEBRTC?.trim().toLowerCase() !== "on") return { problems: [] };
  const problems: string[] = [];
  const publicAddresses = (env.WEBRTC_PUBLIC_IP ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      if (IP_ADDRESS.test(entry)) return true;
      problems.push(`WEBRTC_PUBLIC_IP: ${entry} is not an IP address`);
      return false;
    });
  let portRange: [number, number] | undefined;
  const ports = env.WEBRTC_UDP_PORTS?.trim();
  if (ports) {
    const match = /^(\d{1,5})-(\d{1,5})$/.exec(ports);
    const low = Number(match?.[1]);
    const high = Number(match?.[2]);
    if (match && low >= 1024 && high <= 65_535 && low <= high) portRange = [low, high];
    else problems.push("WEBRTC_UDP_PORTS must look like 50000-50100, within 1024-65535");
  }
  const iceServers: WebRtcSettings["iceServers"] = [];
  const configured = env.WEBRTC_ICE_SERVERS?.trim();
  if (configured) {
    try {
      const parsed: unknown = JSON.parse(configured);
      if (!Array.isArray(parsed)) throw new Error("not a list");
      for (const entry of parsed as Record<string, unknown>[]) {
        const urls = typeof entry?.urls === "string" ? entry.urls : undefined;
        if (!urls || !/^(stun|turn|turns):[^\s]+$/.test(urls)) throw new Error("bad urls");
        iceServers.push({
          urls,
          ...(typeof entry.username === "string" ? { username: entry.username } : {}),
          ...(typeof entry.credential === "string" ? { credential: entry.credential } : {})
        });
      }
    } catch {
      iceServers.length = 0;
      problems.push('WEBRTC_ICE_SERVERS must be a JSON list like [{"urls":"stun:stun.example.com:3478"}]');
    }
  }
  let maxSessions = DEFAULT_MAX_SESSIONS;
  const max = env.WEBRTC_MAX_SESSIONS?.trim();
  if (max) {
    const value = Number(max);
    if (Number.isInteger(value) && value >= 1) maxSessions = Math.min(value, 5_000);
    else problems.push("WEBRTC_MAX_SESSIONS must be a whole number of at least 1");
  }
  if (portRange && portRange[1] - portRange[0] + 1 < maxSessions) {
    // One session uses one port.
    const ports = portRange[1] - portRange[0] + 1;
    problems.push(
      `WEBRTC_UDP_PORTS has ${ports} ports, so at most ${ports} WebRTC sessions can run at once, not ${maxSessions}`
    );
    maxSessions = ports;
  }
  return { settings: { publicAddresses, ...(portRange ? { portRange } : {}), iceServers, maxSessions }, problems };
}

/** libopus requests: carry a copy of each frame in the next packet, sized for this much loss. */
const OPUS_SET_INBAND_FEC = 4012;
const OPUS_SET_PACKET_LOSS_PERC = 4014;
const EXPECTED_LOSS_PERCENT = 10;
/** The largest JSON event either side may send. Browsers accept this much by default. */
const MAX_EVENT_BYTES = 262_144;

type Modules = {
  werift: typeof import("werift");
  opus: OpusFactory;
};

/** The two libraries are loaded on first use, so a relay that never turns
 *  WebRTC on does not pay for them, and one installed without them still runs. */
async function loadModules(): Promise<Modules> {
  return { werift: await import("werift"), opus: await loadOpus() };
}

/** Speech queued across every socket of a gateway. */
type QueueBudget = { queuedBytes: number };

/** The `type` of a short JSON message, or nothing. Only short messages are parsed:
 *  the ones the transport acts on are a few dozen characters. */
function shortMessageType(text: string): string | undefined {
  if (text.length > 256) return undefined;
  try {
    const type = (JSON.parse(text) as { type?: unknown } | null)?.type;
    return typeof type === "string" ? type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True for the events on which a WebSocket client drops the speech it has
 * buffered: the user started to speak, or said or typed something. Here the
 * buffer is the relay's, so the relay drops it.
 */
function interrupts(event: string): boolean {
  if (!event.includes('"status"') && !event.includes('"transcript"')) return false;
  try {
    const parsed = JSON.parse(event) as { type?: unknown; state?: unknown; speaker?: unknown };
    if (parsed.type === "status") return parsed.state === "hearing" || parsed.state === "asr";
    return parsed.type === "transcript" && parsed.speaker === "rider";
  } catch {
    return false;
  }
}

/**
 * The part of a `ws` WebSocket that a session uses, over a peer connection.
 * Events: "message" (data, isBinary), "close" (code, reason), "error", "pong".
 */
export class RtcSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 1;
  /** Always 0: queued speech is the pacer's business, not backpressure. */
  readonly bufferedAmount = 0;

  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private lastQueuedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private nextSendAt = 0;
  private sequence = Math.floor(Math.random() * 0xffff);
  private timestamp = Math.floor(Math.random() * 0xffffffff);
  private lastSentAt = 0;
  private microphoneOpen = false;
  private micBudgetMs = MIC_BURST_MS;
  private micBudgetAt = 0;
  /** The timer is waiting for a tail to go quiet, not for the next frame's time. */
  private waitingForTail = false;
  private readonly inbound = new PacketOrder();
  private closeTimer: NodeJS.Timeout | undefined;
  private finished = false;

  /** The peer connection this socket runs over. */
  get connection(): RTCPeerConnection {
    return this.peer;
  }

  constructor(
    private readonly peer: RTCPeerConnection,
    private readonly channel: RTCDataChannel,
    private readonly track: MediaStreamTrack,
    private readonly payloadType: number,
    private readonly encoder: OpusCodec,
    private readonly decoder: OpusCodec,
    private readonly rtp: Pick<typeof import("werift"), "RtpPacket" | "RtpHeader">,
    private readonly log: Logger,
    private readonly now: () => number,
    private readonly budget: QueueBudget = { queuedBytes: 0 }
  ) {
    super();
  }

  /** What the session writes: a JSON event, or the assistant's voice as 24 kHz PCM16. */
  send(data: string | Buffer | ArrayBuffer | Uint8Array, options?: unknown, callback?: (error?: Error) => void): void {
    const done = typeof options === "function" ? (options as (error?: Error) => void) : callback;
    if (this.readyState !== this.OPEN) {
      done?.(new Error("the connection is closed"));
      return;
    }
    if (typeof data === "string") {
      if (interrupts(data)) this.clearQueue();
      try {
        this.channel.send(data);
      } catch (error) {
        this.log.warn("webrtc event could not be sent", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } else {
      this.enqueue(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    }
    done?.();
  }

  /**
   * A liveness probe. The peer connection keeps its own (ICE consent checks),
   * and the gateway drops a peer that fails them or stays disconnected past
   * its grace period. So a socket that is still open is alive: a peer that is
   * "disconnected" for a moment while a phone changes network must not be
   * reported dead.
   */
  ping(): void {
    const state = this.peer.connectionState;
    if (this.readyState === this.OPEN && state !== "failed" && state !== "closed") this.emit("pong");
  }

  /** Closes once queued speech has played out, telling the client why first. */
  close(code = 1000, reason = ""): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = this.CLOSING;
    const finish = () => {
      try {
        this.channel.send(JSON.stringify({ type: "transport.close", code, reason: reason.slice(0, 120) }));
      } catch {
        /* the channel is already gone */
      }
      // Give the message a moment to leave before the transport goes.
      this.closeTimer = setTimeout(() => this.finish(code, reason), 150);
    };
    if (this.queuedBytes < OUT_FRAME_BYTES) finish();
    else {
      const deadline = this.now() + Math.min(CLOSE_DRAIN_MS, (this.queuedBytes / (OUT_RATE * 2)) * 1000 + 500);
      const wait = () => {
        if (this.finished) return;
        if (this.queuedBytes < OUT_FRAME_BYTES || this.now() >= deadline) finish();
        else this.closeTimer = setTimeout(wait, 40);
      };
      wait();
    }
  }

  /** Closes at once, with nothing said. */
  terminate(): void {
    this.finish(1006, "");
  }

  /** A JSON event or a transport message from the client's events channel. */
  receiveEvent(text: string): void {
    if (this.readyState !== this.OPEN) return;
    // Decided by the message's type, never by what its text happens to contain:
    // a user may well type "transport.close".
    const type = shortMessageType(text);
    if (type?.startsWith("transport.")) {
      // Messages for the transport itself: the session never sees them.
      if (type === "transport.close") this.finish(1000, "");
      // The page silenced the assistant: nothing more of this reply is sent.
      else if (type === "transport.clear") this.clearQueue();
      return;
    }
    // The microphone track never stops flowing. Its audio counts only while
    // the client says the microphone is on, as over a WebSocket.
    if (type === "audio.start") {
      this.microphoneOpen = true;
      this.micBudgetMs = MIC_BURST_MS;
      this.micBudgetAt = this.now();
    } else if (type === "audio.stop") {
      this.microphoneOpen = false;
      this.inbound.reset();
    }
    this.emit("message", Buffer.from(text, "utf8"), false);
  }

  /** One Opus packet from the client's microphone. */
  receiveAudio(packet: RtpPacket): void {
    if (this.readyState !== this.OPEN || !this.microphoneOpen) return;
    const size = packet.payload.length;
    if (size === 0 || size > MAX_OPUS_PACKET_BYTES) return;
    const now = this.now();
    this.micBudgetMs = Math.min(MIC_BURST_MS, this.micBudgetMs + (now - this.micBudgetAt) * MIC_RATE_FACTOR);
    this.micBudgetAt = now;
    for (const payload of this.inbound.push(packet.header.sequenceNumber, packet.payload)) {
      // More audio than time has passed: not a microphone. Dropped before the work of decoding it.
      if (this.micBudgetMs <= 0) continue;
      let pcm: Buffer;
      try {
        pcm = this.decoder.decode(payload);
      } catch {
        continue;
      }
      this.micBudgetMs -= pcm.length / ((IN_RATE * 2) / 1000);
      if (pcm.length > 0) this.emit("message", pcm, true);
    }
  }

  /** The peer is gone. */
  peerClosed(): void {
    this.finish(1006, "");
  }

  private finish(code: number, reason: string): void {
    if (this.finished) return;
    this.finished = true;
    this.readyState = this.CLOSED;
    if (this.timer) clearTimeout(this.timer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.clearQueue();
    try {
      this.encoder.delete();
      this.decoder.delete();
    } catch {
      /* already freed */
    }
    void this.peer.close().catch(() => undefined);
    this.emit("close", code, Buffer.from(reason, "utf8"));
  }

  private clearQueue(): void {
    this.budget.queuedBytes -= this.queuedBytes;
    this.queue = [];
    this.queuedBytes = 0;
  }

  private enqueue(pcm: Buffer): void {
    if (pcm.length === 0) return;
    if (this.queuedBytes + pcm.length > MAX_QUEUED_BYTES) return;
    if (this.budget.queuedBytes + pcm.length > MAX_TOTAL_QUEUED_BYTES) return;
    this.queue.push(pcm);
    this.queuedBytes += pcm.length;
    this.budget.queuedBytes += pcm.length;
    this.lastQueuedAt = this.now();
    // The clock is kept between writes: speech arrives in small pieces, far
    // faster than it is spoken, and each piece must wait its turn. A timer
    // that is only waiting for a tail to go quiet is looked at again now,
    // because this piece may have completed a frame.
    if (this.timer && this.waitingForTail) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.timer) this.tick();
  }

  /** Takes exactly one frame off the queue, or nothing if less than one is there. */
  private takeFrame(padTail: boolean): Buffer | undefined {
    if (this.queuedBytes === 0) return undefined;
    if (this.queuedBytes < OUT_FRAME_BYTES && !padTail) return undefined;
    const frame = Buffer.alloc(OUT_FRAME_BYTES);
    let filled = 0;
    while (filled < OUT_FRAME_BYTES && this.queue.length > 0) {
      const head = this.queue[0] as Buffer;
      const take = Math.min(head.length, OUT_FRAME_BYTES - filled);
      head.copy(frame, filled, 0, take);
      filled += take;
      if (take === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    this.queuedBytes -= filled;
    this.budget.queuedBytes -= filled;
    return frame;
  }

  private tick(): void {
    this.timer = undefined;
    if (this.finished) return;
    const now = this.now();
    // After a pause, or a stalled event loop, the clock starts again from now:
    // being late must not turn into a burst of packets.
    if (now - this.nextSendAt > 5 * FRAME_MS) this.nextSendAt = now;
    while (now >= this.nextSendAt) {
      const frame = this.takeFrame(now - this.lastQueuedAt >= TAIL_FLUSH_MS);
      if (!frame) break;
      this.sendFrame(frame, now);
      this.nextSendAt += FRAME_MS;
    }
    this.waitingForTail = false;
    if (this.queuedBytes === 0) return;
    // Wake for the next frame's time. With less than a frame left there is
    // nothing to send until more arrives (which wakes this itself) or the tail
    // has been quiet long enough to pad: sleep until then, not in 1 ms steps.
    const after = this.now();
    let wait = this.nextSendAt - after;
    if (this.queuedBytes < OUT_FRAME_BYTES) {
      this.waitingForTail = true;
      wait = Math.max(wait, this.lastQueuedAt + TAIL_FLUSH_MS - after);
    }
    this.timer = setTimeout(() => this.tick(), Math.max(1, Math.min(TAIL_FLUSH_MS, wait)));
  }

  private sendFrame(frame: Buffer, now: number): void {
    // After a pause, RTP time moves on by the length of the pause, and the
    // marker bit tells the receiver a new burst of speech starts here.
    const gap = this.lastSentAt ? now - this.lastSentAt : 0;
    const resumed = !this.lastSentAt || gap > 3 * FRAME_MS;
    if (resumed && gap > 0) {
      this.timestamp = (this.timestamp + Math.round(gap / FRAME_MS) * RTP_TICKS_PER_FRAME) >>> 0;
    } else this.timestamp = (this.timestamp + RTP_TICKS_PER_FRAME) >>> 0;
    this.sequence = (this.sequence + 1) & 0xffff;
    this.lastSentAt = now;
    try {
      const payload = this.encoder.encode(frame, OUT_FRAME_SAMPLES);
      const header = new this.rtp.RtpHeader({
        payloadType: this.payloadType,
        sequenceNumber: this.sequence,
        timestamp: this.timestamp,
        marker: resumed
      });
      this.track.writeRtp(new this.rtp.RtpPacket(header, payload));
    } catch (error) {
      this.log.warn("webrtc audio frame could not be sent", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export type WebRtcGateway = {
  /**
   * Answers a client's offer. `onSocket` runs once the peer has connected and
   * opened its events channel: from there on it is a session's socket.
   */
  accept(
    offerSdp: unknown,
    onSocket: (socket: RtcSocket) => void,
    /** Who is asking, to limit how many peers one address may have connecting at once. */
    address?: string
  ): Promise<{ ok: true; sdp: string } | { ok: false; status: number; error: string }>;
  /** Connected peers, for the idle watchdog and shutdown. */
  sockets(): Iterable<RtcSocket>;
  /** Peers connected or still connecting. */
  active(): number;
  close(): void;
};

export function createWebRtcGateway(
  settings: WebRtcSettings,
  deps: { log: Logger; now?: () => number; connectTimeoutMs?: number }
): WebRtcGateway {
  const { log } = deps;
  const now = deps.now ?? (() => performance.now());
  const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const sockets = new Set<RtcSocket>();
  const peers = new Set<RTCPeerConnection>();
  const pending = new Map<string, number>();
  const budget: QueueBudget = { queuedBytes: 0 };
  let modules: Promise<Modules> | undefined;
  let guardWarned = false;

  /**
   * The library puts no limit on a message it is still putting together, so a
   * peer could send one that never ends. This drops a peer that sends more
   * than the receive window it was given, which no honest peer does. It leans
   * on two of the library's internals, and says so in the log if they are gone.
   */
  function guardReassembly(peer: RTCPeerConnection, exceeded: () => void): void {
    const sctp = (peer.sctpTransport as unknown as { sctp?: Record<string, unknown> } | undefined)?.sctp;
    const receive = sctp?.receiveDataChunk;
    if (!sctp || typeof receive !== "function" || typeof sctp.advertisedRwnd !== "number") {
      if (!guardWarned) log.warn("webrtc: this version of werift gives no way to limit an unfinished message");
      guardWarned = true;
      return;
    }
    sctp.receiveDataChunk = (chunk: unknown) => {
      // The window goes down with every piece held and up when a message is
      // delivered. A sender may probe a closed window with one packet, no more.
      if ((sctp.advertisedRwnd as number) < -WINDOW_PROBE_BYTES) {
        exceeded();
        return undefined;
      }
      return (receive as (chunk: unknown) => unknown).call(sctp, chunk);
    };
  }

  /** With public addresses set, those are the only ones a client is told: the
   *  machine's private, VPN and container addresses are nobody's business. */
  function publicCandidatesOnly(sdp: string): string {
    if (settings.publicAddresses.length === 0) return sdp;
    const allowed = new Set(settings.publicAddresses.map((address) => address.toLowerCase()));
    return sdp
      .split("\r\n")
      .filter((line) => !line.startsWith("a=candidate:") || allowed.has((line.split(" ")[4] ?? "").toLowerCase()))
      .join("\r\n");
  }

  async function accept(
    offerSdp: unknown,
    onSocket: (socket: RtcSocket) => void,
    address = ""
  ): Promise<{ ok: true; sdp: string } | { ok: false; status: number; error: string }> {
    if (typeof offerSdp !== "string" || offerSdp.length === 0 || offerSdp.length > MAX_OFFER_BYTES) {
      return { ok: false, status: 400, error: "sdp must be the offer, as text of at most 20,000 characters." };
    }
    // Exactly the two lanes, on one transport. Every further media section, or
    // sections that are not bundled, would make the relay open more UDP ports.
    const media = offerSdp.match(/^m=\S+/gm) ?? [];
    if (media.length !== 2 || !media.includes("m=audio") || !media.includes("m=application")) {
      return {
        ok: false,
        status: 400,
        error: "The offer needs one audio track and one data channel, and nothing else."
      };
    }
    if (!/^a=group:BUNDLE \S+ \S+\s*$/m.test(offerSdp)) {
      return { ok: false, status: 400, error: "The offer must bundle the audio track and the data channel." };
    }
    if (peers.size >= settings.maxSessions) {
      return { ok: false, status: 503, error: "The relay has no room for another WebRTC session." };
    }
    if ((pending.get(address) ?? 0) >= MAX_PENDING_PER_ADDRESS) {
      return { ok: false, status: 503, error: "Too many WebRTC connections are being set up from this address." };
    }
    let loaded: Modules;
    try {
      loaded = await (modules ??= loadModules());
    } catch (error) {
      modules = undefined;
      log.error("webrtc is on but its libraries could not be loaded", {
        message: error instanceof Error ? error.message : String(error)
      });
      return { ok: false, status: 503, error: "WebRTC is not available on this relay." };
    }
    const { werift } = loaded;
    const peer = new werift.RTCPeerConnection({
      codecs: {
        audio: [
          new werift.RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: 48000,
            channels: 2,
            // Each side may repair a lost packet from the one after it.
            parameters: "minptime=10;useinbandfec=1"
          })
        ]
      },
      maxMessageSize: MAX_EVENT_BYTES,
      bundlePolicy: "max-bundle",
      // The library would otherwise ask a public STUN server for this relay's
      // address. A relay contacts only the servers its operator names.
      iceUseDefaultStunServer: false,
      iceServers: settings.iceServers,
      ...(settings.portRange ? { icePortRange: settings.portRange } : {}),
      ...(settings.publicAddresses.length ? { iceAdditionalHostAddresses: settings.publicAddresses } : {})
    });
    peers.add(peer);
    pending.set(address, (pending.get(address) ?? 0) + 1);
    let waiting = true;
    /** The peer connected, or went away: it no longer counts as connecting. */
    const settled = () => {
      if (!waiting) return;
      waiting = false;
      const left = (pending.get(address) ?? 1) - 1;
      if (left > 0) pending.set(address, left);
      else pending.delete(address);
    };
    let socket: RtcSocket | undefined;
    let dropped = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const drop = (why: string) => {
      if (dropped) return;
      dropped = true;
      settled();
      clearTimeout(connectTimer);
      if (graceTimer) clearTimeout(graceTimer);
      peers.delete(peer);
      if (socket) {
        sockets.delete(socket);
        socket.peerClosed();
      } else {
        log.info("webrtc peer dropped before it connected", { why });
        void peer.close().catch(() => undefined);
      }
    };
    const connectTimer = setTimeout(() => {
      if (!socket) drop("connect timeout");
    }, connectTimeoutMs);
    connectTimer.unref?.();

    try {
      const track = new werift.MediaStreamTrack({ kind: "audio" });
      const transceiver = peer.addTransceiver(track, { direction: "sendrecv" });
      let inbound: (packet: RtpPacket) => void = () => undefined;
      transceiver.onTrack.subscribe((remote) => {
        remote.onReceiveRtp.subscribe((packet) => inbound(packet));
      });
      peer.onDataChannel.subscribe((channel) => {
        if (socket || dropped) return;
        const payloadType = transceiver.codecs[0]?.payloadType ?? 111;
        const encoder = loaded.opus(OUT_RATE);
        encoder.encoderCTL(OPUS_SET_INBAND_FEC, 1);
        encoder.encoderCTL(OPUS_SET_PACKET_LOSS_PERC, EXPECTED_LOSS_PERCENT);
        const created = new RtcSocket(
          peer,
          channel,
          track,
          payloadType,
          encoder,
          loaded.opus(IN_RATE),
          werift,
          log,
          now,
          budget
        );
        socket = created;
        sockets.add(created);
        settled();
        created.once("close", () => {
          sockets.delete(created);
          peers.delete(peer);
          dropped = true;
          clearTimeout(connectTimer);
          if (graceTimer) clearTimeout(graceTimer);
        });
        inbound = (packet) => created.receiveAudio(packet);
        channel.onMessage.subscribe((message) => {
          created.receiveEvent(typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
        });
        channel.stateChanged.subscribe((state) => {
          if (state === "closed") drop("events channel closed");
        });
        clearTimeout(connectTimer);
        onSocket(created);
      });
      peer.connectionStateChange.subscribe((state) => {
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = undefined;
        if (state === "failed" || state === "closed") drop(state);
        // A phone moving between networks is "disconnected" for a moment and comes back.
        else if (state === "disconnected") {
          graceTimer = setTimeout(() => drop("disconnected"), DISCONNECT_GRACE_MS);
          graceTimer.unref?.();
        }
      });
      await peer.setRemoteDescription({ type: "offer", sdp: offerSdp });
      await peer.setLocalDescription(await peer.createAnswer());
      const answer = peer.localDescription?.sdp;
      if (!answer) throw new Error("no answer was produced");
      guardReassembly(peer, () => {
        log.warn("webrtc peer dropped: it sent more than it was allowed to");
        drop("receive window exceeded");
      });
      const told = publicCandidatesOnly(answer);
      if (!/^a=candidate:/m.test(told)) {
        // Every port of WEBRTC_UDP_PORTS is in use. Say so now, so the client
        // falls back at once instead of waiting for a connection that cannot come.
        drop("no free UDP port");
        log.warn("webrtc offer refused: no UDP port is free. Widen WEBRTC_UDP_PORTS or lower WEBRTC_MAX_SESSIONS.");
        return { ok: false, status: 503, error: "The relay has no free UDP port for another WebRTC session." };
      }
      return { ok: true, sdp: told };
    } catch (error) {
      drop("bad offer");
      log.info("webrtc offer refused", { message: error instanceof Error ? error.message : String(error) });
      return { ok: false, status: 400, error: "The offer could not be answered." };
    }
  }

  return {
    accept,
    sockets: () => sockets,
    active: () => peers.size,
    close() {
      const connected = new Set<RTCPeerConnection>();
      for (const socket of [...sockets]) {
        connected.add(socket.connection);
        socket.close(1001, "server shutdown");
      }
      // Peers that never became a socket have nobody to tell.
      for (const peer of [...peers]) if (!connected.has(peer)) void peer.close().catch(() => undefined);
    }
  };
}
