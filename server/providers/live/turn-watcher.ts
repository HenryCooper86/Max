import WebSocket, { type RawData } from "ws";
import type { Logger } from "../../logger";
import { env } from "./engine";
import { maxSpeechUrl } from "./max-speech";

/**
 * A turn detector of the relay's own in front of a hosted speech-to-speech
 * backend.
 *
 * OpenAI Realtime, Gemini Live and Grok each decide by themselves when the
 * user has finished speaking, mostly from how long the silence is. With
 * `TURN_DETECTOR=max-speech` the relay decides instead: the microphone audio
 * also goes to a Max Speech server, whose voice detector hears speech begin
 * and whose learned turn detector (Smart Turn) judges from the sound of the
 * last words whether the speaker is done or only pausing. The backend is told
 * where each turn begins and ends and does no detecting of its own.
 *
 *   TURN_DETECTOR             max-speech, or off (the default: the backend's own detection)
 *   TURN_DETECTOR_URL         the Max Speech server; MAX_SPEECH_URL when not set,
 *                             and http://localhost:8790 when neither is
 *   TURN_DETECTOR_EAGERNESS   low, normal or high: how soon a pause may end the turn
 *
 * The detector is a helper, never a requirement: when it cannot be reached as a
 * conversation starts, that conversation uses the backend's own detection. When
 * it goes away in the middle of one, the engine reports its connection lost and
 * the session connects again, which lands on whichever is available then.
 */

const PROTOCOL = "max-speech.session.v1";
/** Longer than a local server needs, shorter than a caller notices. */
const READY_TIMEOUT_MS = 4_000;
/** Audio kept from before the detector said "speech": it hears a word a moment after it began. */
const PREROLL_MS = 600;
const BYTES_PER_MS = 32; // 16 kHz mono PCM16
/** After a turn in which no words were heard: how long the next speech may take to begin and
 *  still be the same turn. A first syllable is sometimes taken for a blip of its own. */
const EMPTY_TURN_GRACE_MS = 1_200;
/** Audio waiting to go to the detector beyond this is not sent: it would only arrive late. */
const MAX_BUFFERED_BYTES = 1_000_000;
const EAGERNESS = ["low", "normal", "high"] as const;

type Eagerness = (typeof EAGERNESS)[number];
type WatcherSettings = { url: string; apiKey: string; eagerness?: Eagerness };

/** What the relay was told to use, and what it could not make sense of. */
export function turnDetectorSettings(read: (...names: string[]) => string | undefined = env): {
  watcher?: WatcherSettings;
  problems: string[];
} {
  const problems: string[] = [];
  const choice = read("TURN_DETECTOR")?.toLowerCase().replace(/_/g, "-");
  if (!choice || choice === "off" || choice === "vendor") return { problems };
  if (choice !== "max-speech") {
    problems.push(`TURN_DETECTOR=${read("TURN_DETECTOR")} is not one of max-speech, off`);
    return { problems };
  }
  let url: string;
  try {
    url = maxSpeechUrl(read("TURN_DETECTOR_URL") ?? read("MAX_SPEECH_URL"));
  } catch (error) {
    problems.push(`TURN_DETECTOR: ${error instanceof Error ? error.message : String(error)}`);
    return { problems };
  }
  const raw = read("TURN_DETECTOR_EAGERNESS")?.toLowerCase();
  const eagerness = EAGERNESS.find((value) => value === raw);
  if (raw && !eagerness) problems.push(`TURN_DETECTOR_EAGERNESS=${raw} is not one of ${EAGERNESS.join(", ")}`);
  return {
    watcher: { url, apiKey: read("TURN_DETECTOR_API_KEY") ?? read("MAX_SPEECH_API_KEY") ?? "", eagerness },
    problems
  };
}

export type TurnWatcherEvents = {
  onSpeechStarted(): void;
  /** `heard`: whether the detector's own transcriber made out any words in the turn. */
  onTurnEnded(heard: boolean): void;
  /** The detector went away after it had been ready. */
  onLost(reason: string): void;
};

/** Listens to the microphone and says where turns begin and end. */
export type TurnWatcher = {
  /** Resolves once the detector is listening; rejects when it is not there. */
  connect(languages: string[], events: TurnWatcherEvents): Promise<void>;
  /** Microphone audio: 16 kHz mono PCM16. */
  sendAudio(pcm: Buffer): void;
  /** The microphone went quiet for good (muted, released): a turn left open ends now. */
  endInput(): void;
  close(): void;
};

function rawToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}

type ServerMessage = {
  type?: string;
  code?: string;
  message?: string;
  text?: string;
  protocol?: string;
  idle_timeout_s?: number;
};

/** A Max Speech session used for its ears only: nothing is ever spoken through it. */
export function createMaxSpeechTurnWatcher(
  log: Logger,
  settings: WatcherSettings,
  createSocket: (url: string, headers: Record<string, string>) => WebSocket = (url, headers) =>
    new WebSocket(url, { headers })
): TurnWatcher {
  let socket: WebSocket | undefined;
  let ready = false;
  let closed = false;
  let keepAlive: NodeJS.Timeout | undefined;
  let heardSince = false;

  const sendJson = (message: Record<string, unknown>) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  return {
    connect(languages, events) {
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        let lastError: string | undefined;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
          socket?.terminate();
        };
        const timer = setTimeout(
          () => fail(new Error(`no answer from ${settings.url} within ${READY_TIMEOUT_MS / 1000} seconds`)),
          READY_TIMEOUT_MS
        );
        let upstream: WebSocket;
        try {
          upstream = createSocket(
            settings.url,
            settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : ({} as Record<string, string>)
          );
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        socket = upstream;
        upstream.on("open", () =>
          sendJson({
            type: "session.update",
            languages,
            ...(settings.eagerness ? { turn: { eagerness: settings.eagerness } } : {})
          })
        );
        upstream.on("message", (raw, isBinary) => {
          if (isBinary || closed) return;
          let message: ServerMessage;
          try {
            message = JSON.parse(rawToString(raw)) as ServerMessage;
          } catch {
            return;
          }
          switch (message.type) {
            case "ready": {
              if (settled) return;
              if (message.protocol !== PROTOCOL) log.warn("turn detector protocol differs", { got: message.protocol });
              settled = true;
              ready = true;
              clearTimeout(timer);
              // A server that closes quiet sessions: a muted microphone must not look like one.
              const idle = message.idle_timeout_s;
              if (typeof idle === "number" && idle > 0) {
                keepAlive = setInterval(
                  () => {
                    if (!heardSince) sendJson({ type: "session.update" });
                    heardSince = false;
                  },
                  Math.max(1_000, (idle * 1000) / 2)
                );
                keepAlive.unref?.();
              }
              resolve();
              return;
            }
            case "speech.started":
              if (ready) events.onSpeechStarted();
              return;
            case "transcript.final":
              // The words are the backend's to hear; whether there were any says if this was a turn at all.
              if (ready) events.onTurnEnded(Boolean(message.text?.trim()));
              return;
            case "error":
              lastError = [message.code, message.message].filter(Boolean).join(": ");
              log.debug("turn detector error", { code: message.code, message: message.message });
              // Audio was dropped and the server began the turn again: what was open is over.
              if (ready && message.code === "overrun") events.onTurnEnded(true);
              return;
            default:
              return;
          }
        });
        upstream.on("unexpected-response", (_request, response) =>
          fail(new Error(`${settings.url} answered HTTP ${response.statusCode}`))
        );
        upstream.on("error", (error) => fail(new Error(`${settings.url}: ${error.message}`)));
        upstream.on("close", (code, reason) => {
          const detail = `closed (${code}${reason.length ? ` ${reason.toString("utf8").slice(0, 120)}` : ""})`;
          if (keepAlive) clearInterval(keepAlive);
          if (!settled) {
            fail(new Error(`${settings.url} ${detail}${lastError ? `: ${lastError}` : ""}`));
            return;
          }
          const wasReady = ready;
          ready = false;
          if (wasReady && !closed) events.onLost(detail);
        });
      });
    },
    sendAudio(pcm) {
      if (!ready || closed || socket?.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
      heardSince = true;
      socket.send(pcm);
    },
    endInput() {
      if (ready && !closed) sendJson({ type: "turn.end" });
    },
    close() {
      closed = true;
      ready = false;
      if (keepAlive) clearInterval(keepAlive);
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
      socket = undefined;
    }
  };
}

/** What an engine does with the turns the detector finds. */
export type TurnTakingHooks = {
  /** Audio for the backend: only what belongs to a turn reaches it. */
  forward(pcm: Buffer): void;
  /** The user began to speak. Called before the audio of that moment is forwarded. */
  onStart(): void;
  /** The user has finished: the backend may answer. */
  onEnd(): void;
  /** What began as a turn was a noise: nothing was said, and there is nothing to answer. */
  onAbandon(): void;
  /** The detector went away in the middle of the conversation. An open turn has been ended. */
  onLost(reason: string): void;
};

export type TurnTaking = {
  /** Whether a detector of the relay's own is set up at all. Without one there is nothing to wait for. */
  readonly wanted: boolean;
  /** Whether the relay is taking the turns of this connection. */
  readonly on: boolean;
  /** Resolves to whether the relay's detector is in charge. Never rejects. */
  connect(languages: string[]): Promise<boolean>;
  audio(pcm: Buffer): void;
  endInput(): void;
  close(): void;
};

/**
 * Turn-taking for one engine connection: the detector, and the gate that lets
 * the microphone through to the backend only while the user is speaking (with
 * the moment before, which the detector needed to notice).
 */
export function createTurnTaking(
  log: Logger,
  hooks: TurnTakingHooks,
  makeWatcher: (log: Logger) => TurnWatcher | undefined = (watcherLog) => {
    const { watcher } = turnDetectorSettings();
    return watcher ? createMaxSpeechTurnWatcher(watcherLog, watcher) : undefined;
  }
): TurnTaking {
  const made = makeWatcher(log);
  let watcher: TurnWatcher | undefined;
  let on = false;
  let closed = false;
  let speaking = false;
  let kept: Buffer[] = [];
  let keptBytes = 0;
  /** Runs while a turn without words waits to see whether speech follows at once. */
  let emptyTimer: NodeJS.Timeout | undefined;

  function clearEmpty(): void {
    if (emptyTimer) clearTimeout(emptyTimer);
    emptyTimer = undefined;
  }

  function keep(pcm: Buffer): void {
    kept.push(pcm);
    keptBytes += pcm.length;
    while (kept.length > 1 && keptBytes - kept[0]!.length >= PREROLL_MS * BYTES_PER_MS) {
      keptBytes -= kept.shift()!.length;
    }
  }

  const events: TurnWatcherEvents = {
    onSpeechStarted() {
      if (!on) return;
      // Speech right after a turn without words: that turn was its first sound, and goes on.
      clearEmpty();
      if (speaking) return;
      speaking = true;
      hooks.onStart();
      for (const pcm of kept) hooks.forward(pcm);
      kept = [];
      keptBytes = 0;
    },
    onTurnEnded(heard) {
      if (!on || !speaking) return;
      if (!heard) {
        emptyTimer ??= setTimeout(() => {
          emptyTimer = undefined;
          if (!on || !speaking) return;
          speaking = false;
          hooks.onAbandon();
        }, EMPTY_TURN_GRACE_MS);
        emptyTimer.unref?.();
        return;
      }
      clearEmpty();
      speaking = false;
      hooks.onEnd();
    },
    onLost(reason) {
      if (!on) return;
      log.warn("the relay's turn detector went away", { reason });
      clearEmpty();
      if (speaking) {
        speaking = false;
        hooks.onEnd();
      }
      on = false;
      hooks.onLost(reason);
    }
  };

  return {
    wanted: Boolean(made),
    get on() {
      return on;
    },
    async connect(languages) {
      if (!made || closed) return false;
      try {
        await made.connect(languages, events);
      } catch (error) {
        made.close();
        log.warn("the relay's turn detector is not available: this conversation uses the backend's own", {
          message: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
      if (closed) {
        made.close();
        return false;
      }
      watcher = made;
      on = true;
      return true;
    },
    audio(pcm) {
      if (!on) {
        hooks.forward(pcm);
        return;
      }
      watcher?.sendAudio(pcm);
      if (speaking) hooks.forward(pcm);
      else keep(pcm);
    },
    endInput() {
      if (on) watcher?.endInput();
    },
    close() {
      closed = true;
      on = false;
      speaking = false;
      clearEmpty();
      kept = [];
      keptBytes = 0;
      (watcher ?? made)?.close();
      watcher = undefined;
    }
  };
}
