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
};

/**
 * Text to raw PCM16 at TTS_RATE, or null.
 *
 * Null rather than throwing, always: this sits on the device-confirmation path,
 * and a confirmation that fails to synthesise must degrade to the silence we
 * have today, never to an exception in the reconciliation.
 */
export function createSynthesizer(options: SynthesizerOptions): (text: string) => Promise<Buffer | null> {
  const {
    appid,
    token,
    voice = DEFAULT_VOICE,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxEntries = DEFAULT_MAX_ENTRIES
  } = options;

  const cache = new Map<string, Buffer>();

  return async function synthesize(text: string): Promise<Buffer | null> {
    if (!appid || !token) return null;

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
      if (!response.ok) return null;
      const body = (await response.json()) as { data?: string };
      if (!body.data) return null;

      const pcm = Buffer.from(body.data, "base64");
      // Only successes are cached. A transient failure must not poison the
      // phrase for the life of the process.
      if (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(text, pcm);
      return pcm;
    } catch {
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

/**
 * Speaks generated text on clients that cannot speak it themselves.
 *
 * Only "embedded": web and mobile already say `useBrowserSpeech` transcripts
 * with their own TTS, so audio as well would double every confirmation.
 *
 * No pacing here. The board's playback caps how far ahead of the DAC audio may
 * sit (MAX_QUEUE_MS = 80, topped up by a 10 ms pump) — the fix that took the
 * reference-to-mic lag from 953 ms to 81 ms. Whatever we hand over is metered
 * by the same mechanism that meters Doubao's own voice.
 */
export function createSpeaker(options: SpeakerOptions): { speak(text: string): Promise<void> } {
  const { synthesize, sendAudio, platform, onError } = options;

  return {
    async speak(text: string): Promise<void> {
      if (!text.trim()) return;
      if (platform() !== "embedded") return;

      try {
        const pcm = await synthesize(text);
        if (!pcm) return;
        sendAudio(pcm);
      } catch (error) {
        // Silence is the documented degradation. Throwing here would take out
        // the reconciliation that tells the rider the truth.
        onError?.(error);
      }
    }
  };
}
