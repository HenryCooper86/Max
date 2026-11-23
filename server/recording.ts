import fs from "node:fs";
import path from "node:path";
import type { Logger } from "./logger";

/**
 * Recording a conversation's audio: the user on the left channel, the
 * assistant on the right, as one WAV file per conversation.
 *
 *   CONVERSATION_RECORDING=phone        phone calls only
 *   CONVERSATION_RECORDING=on           every conversation with the relay's own assistant
 *   CONVERSATION_RECORDING_DIR=/path    where the files go (required)
 *   CONVERSATION_RECORDING_KEEP_DAYS=30 delete recordings older than this
 *
 * Off unless asked for. A recording is the one place the relay stores what
 * people said as sound: `privacy.redact` cannot reach into it, and in many
 * places the law requires telling people, or asking them, before recording.
 *
 * The two channels are laid on one timeline by the relay's clock. The user's
 * audio is placed when it arrives. The assistant's audio is sent faster than
 * it is spoken, so it is placed where the client will play it: after what was
 * sent before it. When the user interrupts, the client drops what it has not
 * played, and the recording drops it too, so the file holds what was heard
 * and not what was generated. The client's own delay (the network and its
 * playback buffer, typically a tenth of a second or two) is not known here,
 * so the assistant's channel runs that much early.
 */

export const RECORDING_RATE = 16_000;
/** Stereo PCM16. */
const FRAME_BYTES = 4;
const WAV_HEADER_BYTES = 44;
const FRAMES_PER_MS = RECORDING_RATE / 1000;
/**
 * Audio newer than this may still change (an interruption, or audio that
 * turns out to have been held up on the way), so it stays in memory.
 */
const HOLD_FRAMES = 5 * RECORDING_RATE;
/**
 * The assistant's speech is recorded where it will be played, which can be
 * well after it is sent, and it stays in memory until then. Speech that would
 * be played more than five minutes from now is not recorded: holding it would
 * take memory without bound.
 */
const MAX_AGENT_LEAD_FRAMES = 300 * RECORDING_RATE;
/** The most audio held in memory for one conversation: about 20 MB, and far less as a rule. */
const MAX_WINDOW_BYTES = (HOLD_FRAMES + MAX_AGENT_LEAD_FRAMES + 60 * RECORDING_RATE) * FRAME_BYTES;
/**
 * A piece of the user's audio that is late by no more than this continues the
 * previous piece: it was held up on the way. Later than this, the user's side
 * was silent in between (a muted microphone, a device that sends speech only)
 * or the connection stalled, and the piece starts a new run of audio where
 * the clock says.
 */
const JOIN_FRAMES = RECORDING_RATE / 4;
/**
 * A piece has only just been spoken when it arrives, so a run of the user's
 * audio cannot end after now. When it would, by more than this, its start was
 * held up (a stall, then everything at once) and the run is moved back.
 */
const CATCH_UP_FRAMES = (RECORDING_RATE * 60) / 1000;
/** A client that sends audio faster than time passes is not recorded beyond this lead. */
const MAX_USER_LEAD_FRAMES = 5 * RECORDING_RATE;
/** One second of silence on both channels, written as often as a silent stretch needs. */
const SILENCE = Buffer.alloc(RECORDING_RATE * FRAME_BYTES);
/** Four hours, about 920 MB. Past it the recording stops and the conversation carries on. */
const MAX_FRAMES = 4 * 3600 * RECORDING_RATE;
/** Bytes waiting for a disk that cannot keep up before the recording is given up. */
const MAX_UNWRITTEN_BYTES = 32 * 1024 * 1024;
const RECORDING_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/;
const PRUNE_INTERVAL_MS = 6 * 3600 * 1000;
const MAX_LISTED = 1000;

export type RecordingSettings = {
  mode: "phone" | "on";
  dir: string;
  keepDays?: number;
};

export function recordingSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  settings?: RecordingSettings;
  problems: string[];
} {
  const raw = env.CONVERSATION_RECORDING?.trim().toLowerCase();
  if (!raw || raw === "off") return { problems: [] };
  if (raw !== "phone" && raw !== "on") {
    return { problems: [`CONVERSATION_RECORDING=${raw} is not one of off, phone, on. Nothing is recorded.`] };
  }
  const dir = env.CONVERSATION_RECORDING_DIR?.trim();
  if (!dir) {
    return { problems: ["CONVERSATION_RECORDING needs CONVERSATION_RECORDING_DIR. Nothing is recorded."] };
  }
  const problems: string[] = [];
  let keepDays: number | undefined;
  const rawKeep = env.CONVERSATION_RECORDING_KEEP_DAYS?.trim();
  if (rawKeep) {
    const days = Number(rawKeep);
    if (Number.isInteger(days) && days >= 1 && days <= 3650) keepDays = days;
    else problems.push("CONVERSATION_RECORDING_KEEP_DAYS must be a whole number from 1 to 3650. Recordings are kept.");
  }
  return { settings: { mode: raw, dir: path.resolve(dir), ...(keepDays ? { keepDays } : {}) }, problems };
}

const TAPS = 48;

/** A low-pass filter at 7.2 kHz for audio at 48 kHz, with the gain of 2 that upsampling by 2 needs. */
const LOW_PASS = (() => {
  const cutoff = 7200 / 48_000;
  const taps = new Float64Array(TAPS);
  let sum = 0;
  for (let n = 0; n < TAPS; n += 1) {
    const x = n - (TAPS - 1) / 2;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    // Blackman window.
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (TAPS - 1));
    taps[n] = sinc * w;
    sum += taps[n]!;
  }
  for (let n = 0; n < TAPS; n += 1) taps[n] = (taps[n]! / sum) * 2;
  return taps;
})();

/**
 * PCM16 from 24 kHz to 16 kHz for one stream: up by 2, low-pass, down by 3.
 * It keeps the end of each piece, so pieces of any size give the same result
 * as the whole.
 */
export class Resampler24to16 {
  private tail = new Int16Array(0);
  /** Input samples seen before the current piece. */
  private seen = 0;
  /** The next output sample's number. */
  private next = 0;

  process(pcm24k: Buffer): Buffer {
    const added = Math.floor(pcm24k.length / 2);
    if (added === 0) return Buffer.alloc(0);
    const input = new Int16Array(this.tail.length + added);
    input.set(this.tail);
    for (let i = 0; i < added; i += 1) input[this.tail.length + i] = pcm24k.readInt16LE(i * 2);
    const first = this.seen - this.tail.length;
    const last = this.seen + added - 1;
    // Output n needs input up to floor(3n / 2).
    const output = Buffer.allocUnsafe(Math.max(0, Math.floor((2 * last + 1) / 3) - this.next + 1) * 2);
    let written = 0;
    for (; ; this.next += 1) {
      // Output n sits at sample 3n of the 48 kHz stream, in which input k sits at 2k.
      const position = 3 * this.next;
      const newest = Math.floor(position / 2);
      if (newest > last) break;
      let sum = 0;
      for (let k = newest; k >= first && k >= 0 && position - 2 * k < TAPS; k -= 1) {
        sum += LOW_PASS[position - 2 * k]! * input[k - first]!;
      }
      const value = Math.round(sum);
      output.writeInt16LE(value > 32_767 ? 32_767 : value < -32_768 ? -32_768 : value, written);
      written += 2;
    }
    this.seen += added;
    this.tail = input.slice(Math.max(0, input.length - TAPS / 2));
    return output.subarray(0, written);
  }

  reset(): void {
    this.tail = new Int16Array(0);
    this.seen = 0;
    this.next = 0;
  }
}

export type FinishedRecording = {
  /** The file's name inside the recordings directory. */
  file: string;
  durationMs: number;
  bytes: number;
};

function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(RECORDING_RATE, 24);
  header.writeUInt32LE(RECORDING_RATE * FRAME_BYTES, 28);
  header.writeUInt16LE(FRAME_BYTES, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** One conversation's recording. Nothing it does can throw into the conversation. */
export class ConversationRecording {
  private readonly startedAt: number;
  private readonly resampler = new Resampler24to16();
  /** Stereo frames from `base` on that are not on disk yet. */
  private window: Buffer = Buffer.alloc(0);
  /** The timeline position of the window's first frame: everything before it is written. */
  private base = 0;
  /** Where the user's next audio goes, and the assistant's. */
  private userCursor = 0;
  private agentCursor = 0;
  /** The run of the user's audio now arriving: where it starts, and where the audio before it ended. */
  private runStart: number | undefined;
  private runFloor = 0;
  private stream: fs.WriteStream | undefined;
  /** Bytes of the shared silence waiting to be written: they take no memory of their own. */
  private silenceWaiting = 0;
  private failed = false;
  private finished: Promise<FinishedRecording | undefined> | undefined;

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
    private readonly log?: Logger,
    private readonly onFinished?: () => void
  ) {
    this.startedAt = now();
  }

  /** The user's audio: PCM16 mono at 16 kHz, as it arrives. */
  user(pcm16k: Buffer): void {
    if (this.failed || this.finished) return;
    const frames = Math.floor(pcm16k.length / 2);
    if (frames === 0) return;
    const now = this.nowFrame();
    // A piece has only just been spoken when it arrives: it ends now.
    const arrived = Math.max(0, now - frames);
    if (this.runStart === undefined || arrived - this.userCursor > JOIN_FRAMES) {
      // The first piece, and one after a pause, start a run where the clock says.
      this.runFloor = this.userCursor;
      this.runStart = Math.max(arrived, this.userCursor);
      this.userCursor = this.runStart;
    } else if (this.userCursor - arrived > CATCH_UP_FRAMES) {
      // This piece would end after now, so the run began late: move it back.
      this.pullRunBack(this.userCursor - arrived);
    }
    // Otherwise a piece that is a little late continues the last one without a gap.
    const start = this.userCursor;
    if (start - now > MAX_USER_LEAD_FRAMES) return;
    this.settle(start, now);
    this.put(0, start, pcm16k, frames);
    this.userCursor = start + frames;
  }

  /** The assistant's audio: PCM16 mono at 24 kHz, as it is sent to the client. */
  agent(pcm24k: Buffer): void {
    if (this.failed || this.finished) return;
    const pcm = this.resampler.process(pcm24k);
    const frames = pcm.length / 2;
    if (frames === 0) return;
    const now = this.nowFrame();
    // The client plays it after what it already holds, or now when it holds nothing.
    const start = Math.max(this.agentCursor, now);
    if (start - now > MAX_AGENT_LEAD_FRAMES) return;
    this.settle(start, now);
    this.put(1, start, pcm, frames);
    this.agentCursor = start + frames;
  }

  /** The client dropped the speech it had not played yet (the user interrupted). */
  agentCleared(): void {
    if (this.failed || this.finished) return;
    this.resampler.reset();
    const now = this.nowFrame();
    if (this.agentCursor <= now) return;
    // Speech that lies after now is still in memory: nothing is written before its time.
    const from = Math.max(now, this.base);
    const end = Math.min(this.agentCursor, this.base + this.window.length / FRAME_BYTES);
    for (let frame = from; frame < end; frame += 1) {
      this.window.writeInt16LE(0, (frame - this.base) * FRAME_BYTES + 2);
    }
    this.agentCursor = from;
  }

  /** Ends the recording. Resolves to the file, or to nothing when there was no audio or it failed. */
  close(): Promise<FinishedRecording | undefined> {
    this.finished ??= this.finish().finally(() => this.onFinished?.());
    return this.finished;
  }

  private nowFrame(): number {
    return Math.max(0, Math.floor((this.now() - this.startedAt) * FRAMES_PER_MS));
  }

  /**
   * Moves the run of the user's audio now arriving back by `lead` frames. It
   * does not move into the audio before it, nor into what is on disk already:
   * the part of the run that would land there is dropped.
   */
  private pullRunBack(lead: number): void {
    if (this.runStart === undefined) return;
    const limit = Math.max(this.base, this.runFloor);
    const shift = Math.min(lead, this.userCursor - limit);
    if (shift <= 0) return;
    const from = Math.max(this.runStart, limit + shift);
    const to = Math.min(this.userCursor, this.base + this.window.length / FRAME_BYTES);
    for (let frame = from; frame < to; frame += 1) {
      this.window.writeInt16LE(
        this.window.readInt16LE((frame - this.base) * FRAME_BYTES),
        (frame - shift - this.base) * FRAME_BYTES
      );
    }
    for (let frame = Math.max(to - shift, limit); frame < to; frame += 1) {
      this.window.writeInt16LE(0, (frame - this.base) * FRAME_BYTES);
    }
    this.runStart = Math.max(this.runStart - shift, limit);
    this.userCursor -= shift;
  }

  private put(channel: 0 | 1, at: number, pcm: Buffer, frames: number): void {
    let start = at;
    let offset = 0;
    // What lies before the window is on disk already and cannot be changed.
    if (start < this.base) {
      offset = this.base - start;
      start = this.base;
    }
    const count = Math.min(frames - offset, MAX_FRAMES - start);
    if (count <= 0) return;
    const needed = (start - this.base + count) * FRAME_BYTES;
    if (needed > this.window.length) {
      const roomy = Math.min(Math.max(this.window.length * 2, 64 * 1024), MAX_WINDOW_BYTES);
      const grown = Buffer.alloc(Math.max(needed, roomy));
      this.window.copy(grown);
      this.window = grown;
    }
    let position = (start - this.base) * FRAME_BYTES + channel * 2;
    for (let i = 0; i < count; i += 1, position += FRAME_BYTES) {
      this.window.writeInt16LE(pcm.readInt16LE((offset + i) * 2), position);
    }
  }

  /**
   * Before audio is laid at `start`: writes what can no longer change. Only
   * the past is ever written, so speech that is still to be played can be
   * taken back, and whatever lies before `start` unfilled is known to be silence.
   */
  private settle(start: number, now: number): void {
    this.flushTo(Math.min(start, now - HOLD_FRAMES));
  }

  private flushTo(frame: number): void {
    const until = Math.min(frame, MAX_FRAMES);
    if (until <= this.base || this.failed) return;
    const bytes = (until - this.base) * FRAME_BYTES;
    const held = Math.min(this.window.length, bytes);
    if (held > 0) {
      this.write(Buffer.from(this.window.subarray(0, held)), false);
      if (this.failed) return;
      this.window.copyWithin(0, held);
      this.window.fill(0, this.window.length - held);
    }
    // A stretch the window never grew to cover is silence, however long it is.
    for (let left = bytes - held; left > 0 && !this.failed; left -= SILENCE.length) {
      this.write(left >= SILENCE.length ? SILENCE : SILENCE.subarray(0, left), true);
    }
    this.base = until;
  }

  private write(chunk: Buffer, silence: boolean): void {
    try {
      if (!this.stream) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        // "wx": never write over, or through a link to, something that is already
        // there. Opened here and now, so that a file this recording did not make
        // is never one it later touches.
        const fd = fs.openSync(this.filePath, "wx", 0o600);
        this.stream = fs.createWriteStream(this.filePath, { fd });
        this.stream.on("error", (error) => this.fail(error));
        this.stream.write(wavHeader(0));
      }
      if (silence) {
        this.silenceWaiting += chunk.length;
        this.stream.write(chunk, () => {
          this.silenceWaiting -= chunk.length;
        });
      } else {
        this.stream.write(chunk);
      }
      if (this.stream.writableLength - this.silenceWaiting > MAX_UNWRITTEN_BYTES) {
        this.fail(new Error("the disk cannot keep up"));
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.window = Buffer.alloc(0);
    this.log?.warn("recording stopped", { file: path.basename(this.filePath), reason: reasonOf(error) });
    this.stream?.destroy();
  }

  private async finish(): Promise<FinishedRecording | undefined> {
    // Speech that was sent but not yet played when the conversation ended was never heard.
    const end = Math.max(this.userCursor, Math.min(this.agentCursor, this.nowFrame()));
    this.agentCursor = Math.min(this.agentCursor, end);
    this.flushTo(end);
    this.window = Buffer.alloc(0);
    const stream = this.stream;
    if (!stream) return undefined;
    const dataBytes = this.base * FRAME_BYTES;
    if (!this.failed) {
      try {
        await new Promise<void>((resolve, reject) => {
          stream.once("error", reject);
          stream.end(resolve);
        });
      } catch (error) {
        // The disk gave up at the very end: what reached it still gets its header.
        this.fail(error);
      }
    }
    try {
      // A recording that failed part-way is kept as far as it got, with a header that says so.
      const onDisk = (await fs.promises.stat(this.filePath)).size - WAV_HEADER_BYTES;
      const usable = Math.max(0, Math.min(dataBytes, onDisk - (onDisk % FRAME_BYTES)));
      if (usable === 0) {
        await fs.promises.rm(this.filePath, { force: true });
        return undefined;
      }
      const file = await fs.promises.open(this.filePath, "r+");
      try {
        await file.write(wavHeader(usable), 0, WAV_HEADER_BYTES, 0);
      } finally {
        await file.close();
      }
      const finished = {
        file: path.basename(this.filePath),
        durationMs: Math.round(usable / FRAME_BYTES / FRAMES_PER_MS),
        bytes: WAV_HEADER_BYTES + usable
      };
      // Not every conversation has a record to name its recording: the log always does.
      this.log?.info("recording finished", { file: finished.file, seconds: Math.round(finished.durationMs / 1000) });
      return finished;
    } catch (error) {
      this.log?.warn("recording could not be finished", {
        file: path.basename(this.filePath),
        reason: reasonOf(error)
      });
      return undefined;
    }
  }
}

/** Why a file operation failed, without the path that Node puts in its message. */
function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.message : String(error);
}

export type Recordings = {
  /** Whether this kind of conversation is recorded. */
  records(channel: "web" | "phone"): boolean;
  /** Starts a recording for a conversation. Its id must be a UUID: it becomes the file's name. */
  open(sessionId: string): ConversationRecording | undefined;
  /** The path of a finished recording by its file name: nothing for any other name, or while it is being written. */

  pathOf(file: string): string | undefined;
  /** The finished recordings, newest first: at most a thousand, and whether there are more. */
  list(): Promise<{ recordings: Array<{ file: string; bytes: number; finishedAt: string }>; more: boolean }>;
  /** Deletes recordings older than the retention. Returns how many went. */
  prune(): Promise<number>;
  /** Finishes the recordings still open (shutdown) and stops the retention timer. */
  close(): Promise<void>;
};

export function createRecordings(
  settings: RecordingSettings,
  options: { log?: Logger; now?: () => number } = {}
): Recordings {
  const now = options.now ?? Date.now;
  const { log } = options;

  async function prune(): Promise<number> {
    if (!settings.keepDays) return 0;
    const before = now() - settings.keepDays * 24 * 3600 * 1000;
    let removed = 0;
    try {
      for (const name of await fs.promises.readdir(settings.dir)) {
        // Only what the relay itself put here.
        if (!RECORDING_NAME.test(name)) continue;
        const file = path.join(settings.dir, name);
        const stat = await fs.promises.lstat(file);
        if (!stat.isFile() || stat.mtimeMs >= before || writing.has(name)) continue;
        await fs.promises.rm(file, { force: true });
        removed += 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log?.warn("old recordings could not be removed", { reason: reasonOf(error) });
      }
    }
    if (removed > 0) log?.info("old recordings removed", { removed });
    return removed;
  }

  /** Recordings whose files are not finished yet. */
  const open = new Set<ConversationRecording>();
  const writing = new Set<string>();
  const timer = settings.keepDays ? setInterval(() => void prune(), PRUNE_INTERVAL_MS) : undefined;
  timer?.unref?.();
  if (settings.keepDays) void prune();

  return {
    records: (channel) => settings.mode === "on" || channel === "phone",
    open(sessionId) {
      const name = `${sessionId}.wav`;
      if (!RECORDING_NAME.test(name)) return undefined;
      const recording = new ConversationRecording(path.join(settings.dir, name), now, log, () => {
        open.delete(recording);
        writing.delete(name);
      });
      open.add(recording);
      writing.add(name);
      return recording;
    },
    pathOf(file) {
      if (!RECORDING_NAME.test(file) || writing.has(file)) return undefined;
      const full = path.join(settings.dir, file);
      try {
        return fs.lstatSync(full).isFile() ? full : undefined;
      } catch {
        return undefined;
      }
    },
    async list() {
      const found: Array<{ file: string; bytes: number; at: number }> = [];
      let names: string[] = [];
      try {
        names = await fs.promises.readdir(settings.dir);
      } catch {
        /* nothing has been recorded yet */
      }
      for (const name of names) {
        if (!RECORDING_NAME.test(name) || writing.has(name)) continue;
        try {
          const stat = await fs.promises.lstat(path.join(settings.dir, name));
          if (stat.isFile()) found.push({ file: name, bytes: stat.size, at: stat.mtimeMs });
        } catch {
          /* removed meanwhile */
        }
      }
      found.sort((a, b) => b.at - a.at);
      return {
        recordings: found
          .slice(0, MAX_LISTED)
          .map(({ file, bytes, at }) => ({ file, bytes, finishedAt: new Date(at).toISOString() })),
        more: found.length > MAX_LISTED
      };
    },
    prune,
    async close() {
      if (timer) clearInterval(timer);
      await Promise.allSettled([...open].map((recording) => recording.close()));
    }
  };
}
