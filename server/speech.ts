/**
 * Turning generated text into audio the helmet can play.
 *
 * The relay produces deterministic confirmations ("拍好了。") and sends them as
 * transcript events marked `useBrowserSpeech`. Web and mobile speak those
 * themselves; the board has no transcript case and drops them, so the one
 * client with no screen never hears the line whose whole purpose is that the
 * rider hears the truth rather than the model's chatter.
 *
 * The request shape is copied from rdk/vision/tools/render_alerts.py, which is
 * proven against the real service. 24 kHz mono PCM16 is not a preference: it is
 * what the board's downlink plays.
 */

export const TTS_ENDPOINT = "https://openspeech.bytedance.com/api/v1/tts";
export const TTS_RATE = 24_000;

const DEFAULT_VOICE = "zh_female_qingxin";
const DEFAULT_TIMEOUT_MS = 2_000;
/** The confirmation vocabulary is a handful of phrases; this is headroom, and a
 *  bound so a future caller passing dynamic text cannot grow the map forever. */
const DEFAULT_MAX_ENTRIES = 64;

export type SynthesizerOptions = {
  appid?: string;
  token?: string;
  voice?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxEntries?: number;
  /**
   * Called with a short reason string on each distinct synthesis failure
   * (rejected response, no audio data, timeout, thrown fetch) — never with the
   * token or the request body. The missing-credentials path is NOT a failure
   * (it is the documented configured-off state) and fires this at most once,
   * so a relay with no `DOUBAO_TTS_*` set doesn't log on every confirmation,
   * while a wrong appid/token — which fails on every call — stays visible.
   */
  onFailure?: (reason: string) => void;
};

/**
 * Text to raw PCM16 at TTS_RATE, or null.
 *
 * Null rather than throwing, always: this sits on the device-confirmation path,
 * and a confirmation that fails to synthesise must degrade to the silence we
 * have today, never to an exception in the reconciliation. `onFailure` is the
 * only way a caller can tell "not configured" apart from "rejected" — both
 * return null identically here.
 */
export function createSynthesizer(options: SynthesizerOptions): (text: string) => Promise<Buffer | null> {
  const {
    appid,
    token,
    voice = DEFAULT_VOICE,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    onFailure
  } = options;

  const cache = new Map<string, Buffer>();
  // The configured-off state, not a failure — see onFailure's doc comment.
  // Every call hits this branch when credentials are absent, so it must log
  // at most once rather than once per confirmation.
  let loggedMissingCredentials = false;

  return async function synthesize(text: string): Promise<Buffer | null> {
    if (!appid || !token) {
      if (!loggedMissingCredentials) {
        loggedMissingCredentials = true;
        onFailure?.("not configured — DOUBAO_TTS_APPID/DOUBAO_TTS_TOKEN not set");
      }
      return null;
    }

    const hit = cache.get(text);
    if (hit) return hit;

    const payload = {
      app: { appid, token, cluster: "volcano_tts" },
      user: { uid: "max-relay" },
      audio: { voice_type: voice, encoding: "pcm", rate: TTS_RATE },
      request: { reqid: text.slice(0, 16) || "speech", text, operation: "query" }
    };

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(TTS_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer;${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: abort.signal
      });
      if (!response.ok) {
        onFailure?.(`rejected — http ${response.status}`);
        return null;
      }
      const body = (await response.json()) as { data?: string };
      if (!body.data) {
        onFailure?.("response had no audio data");
        return null;
      }

      const pcm = Buffer.from(body.data, "base64");
      // Only successes are cached. A transient failure must not poison the
      // phrase for the life of the process.
      if (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(text, pcm);
      return pcm;
    } catch (error) {
      onFailure?.(
        abort.signal.aborted ? "timed out" : `request threw — ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

export type SpeakerOptions = {
  synthesize: (text: string) => Promise<Buffer | null>;
  sendAudio: (pcm: Buffer) => void;
  /** The session's client platform. See server/hazard-injector.ts for the same gate. */
  platform: () => string | undefined;
  onError?: (error: unknown) => void;
};

export type SpeakOptions = {
  expiresAt?: number;
  now?: () => number;
  onStart?: () => void;
};

/**
 * 20 ms of 24 kHz mono PCM16: 480 samples * 2 bytes/sample = 960 bytes.
 *
 * This is not a tuning knob, it is a correctness requirement. The board's
 * `pump()` (rdk/agent/src/audio/playback.ts) tests its `MAX_QUEUE_MS` cap
 * BEFORE shifting a chunk off its queue — so the cap bounds when a pump cycle
 * *starts* consuming, never how much of one already-dequeued chunk it may
 * hand to aplay. It cannot subdivide a chunk. One `client.send` here is one
 * WebSocket message, is one `onVoice`, is one `playback.write` call
 * (rdk/agent/src/relay.ts) — one chunk, whatever size it is. Handing over a
 * whole utterance in a single send therefore produces one chunk far larger
 * than MAX_QUEUE_MS can meter (measured: 192,000 bytes / 2000 ms in one write,
 * versus 7,680 bytes / 80 ms per 20 ms chunk), which both misaligns the AEC
 * far-end reference against the mic and, if a barge-in `flush()` lands while
 * that giant chunk is still draining to the DAC, discards audio whose earlier
 * portion the speaker already played — the reference is told to forget sound
 * that is still physically echoing. Chunking at the relay is what makes the
 * board's pacing guarantee hold for this producer, exactly as it already does
 * for Doubao's own voice.
 */
const SPEAKER_CHUNK_BYTES = 960;

/** Splits `pcm` into SPEAKER_CHUNK_BYTES pieces. The final piece may be
 *  smaller than a full chunk, and is still returned — never dropped. */
function chunkPcm(pcm: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += SPEAKER_CHUNK_BYTES) {
    chunks.push(pcm.subarray(offset, Math.min(offset + SPEAKER_CHUNK_BYTES, pcm.length)));
  }
  return chunks;
}

/**
 * Speaks generated text on clients that cannot speak it themselves.
 *
 * Only "embedded": web and mobile already say `useBrowserSpeech` transcripts
 * with their own TTS, so audio as well would double every confirmation.
 *
 * Sent in SPEAKER_CHUNK_BYTES (20 ms) pieces, one `sendAudio` call per chunk —
 * see that constant's comment for why an unchunked send breaks the board's
 * playback pacing instead of merely being unpaced.
 */
export function createSpeaker(options: SpeakerOptions): {
  speak(text: string, options?: SpeakOptions): Promise<void>;
} {
  const { synthesize, sendAudio, platform, onError } = options;
  let tail = Promise.resolve();

  return {
    speak(text: string, speakOptions: SpeakOptions = {}): Promise<void> {
      const run = tail.then(async () => {
        if (!text.trim()) return;
        if (platform() !== "embedded") return;
        const currentTime = speakOptions.now ?? Date.now;
        if (speakOptions.expiresAt !== undefined && currentTime() >= speakOptions.expiresAt) return;

        try {
          speakOptions.onStart?.();
          const pcm = await synthesize(text);
          if (!pcm) return;
          for (const chunk of chunkPcm(pcm)) sendAudio(chunk);
        } catch (error) {
          // Silence is the documented degradation. Throwing here would take out
          // the reconciliation that tells the rider the truth.
          onError?.(error);
        }
      });
      tail = run.catch(() => undefined);
      return run;
    }
  };
}
