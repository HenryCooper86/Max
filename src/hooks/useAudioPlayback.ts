// Agent speech output: schedules relayed Doubao PCM through a shared
// gain → limiter chain, provides the browser-TTS fallback, and implements
// barge-in (cutting agent audio the moment the rider talks).

import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { detectLanguage } from "../../shared/language";
import { PLAYBACK_GAIN, PLAYBACK_SAMPLE_RATE } from "../lib/constants";
import { selectVoice, VOICE_LOCALE } from "../lib/speech";
import { createVoiceAnalyser } from "../lib/visualizer";
import { createWarningAudioPlayer, getWarningClip } from "../lib/warning-audio";
import type { VoiceGender } from "../types";

type Params = {
  voiceGenderRef: MutableRefObject<VoiceGender>;
  transmittingRef: MutableRefObject<boolean>;
  /** Called when barge-in cuts agent speech while the rider is transmitting. */
  onInterrupted: () => void;
};

export function useAudioPlayback({ voiceGenderRef, transmittingRef, onInterrupted }: Params) {
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackCursorRef = useRef(0);
  const playbackSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playbackGainRef = useRef<GainNode | null>(null);
  // Read-only tap after the limiter for the voice display (what is heard).
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null);
  const deferredSpeechRef = useRef<string | null>(null);
  const warningGenerationRef = useRef(0);
  const [warningPlayer] = useState(() =>
    createWarningAudioPlayer({
      onEnded: () => {
        const pending = deferredSpeechRef.current;
        deferredSpeechRef.current = null;
        if (pending) speakNow(pending);
      }
    })
  );

  // Barge-in: silence whatever the agent is currently saying so the rider can
  // interrupt. Covers both browser TTS and queued Doubao voice audio.
  const stopAgentSpeech = useCallback(() => {
    // Only report a barge-in when the agent was audibly saying something —
    // this runs on every rider ASR partial, and claiming "已打断 Max" while
    // Max was silent fought the server's hearing/asr turn states.
    const wasSpeaking =
      warningPlayer.isActive() ||
      playbackSourcesRef.current.length > 0 ||
      ("speechSynthesis" in window && window.speechSynthesis.speaking);
    deferredSpeechRef.current = null;
    warningGenerationRef.current += 1;
    warningPlayer.stop();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    for (const source of playbackSourcesRef.current) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* source already finished */
      }
    }
    playbackSourcesRef.current = [];
    if (playbackContextRef.current) {
      playbackCursorRef.current = playbackContextRef.current.currentTime;
    }
    if (wasSpeaking && transmittingRef.current) onInterrupted();
  }, [onInterrupted, transmittingRef, warningPlayer]);

  // Browser-TTS fallback, used when Doubao returns reply text but no audio.
  const speakNow = useCallback(
    (text: string) => {
      if (!("speechSynthesis" in window) || !text.trim()) return;
      window.speechSynthesis.cancel();
      // Speak each reply in its own language; forcing a Chinese voice makes
      // English replies fall silent.
      const language = detectLanguage(text);
      const gender = voiceGenderRef.current;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = VOICE_LOCALE[language];

      const { voice, matched } = selectVoice(language, gender);
      if (voice) utterance.voice = voice;

      // Most systems ship a single (female) voice per language. When no real
      // gendered voice is found, shift pitch so the toggle is still audible.
      if (gender === "male") {
        utterance.pitch = matched ? 0.9 : 0.6;
        utterance.rate = 0.98;
      } else {
        utterance.pitch = matched ? 1.06 : 1.16;
        utterance.rate = 1.04;
      }
      window.speechSynthesis.speak(utterance);
    },
    [voiceGenderRef]
  );

  const speak = useCallback(
    (text: string) => {
      if (warningPlayer.isActive()) {
        // Ordinary replies already replace older replies; retain the latest one
        // without letting browser TTS talk over the safety announcement.
        deferredSpeechRef.current = text;
        return;
      }
      speakNow(text);
    },
    [speakNow, warningPlayer]
  );

  const playbackOutput = useCallback((audioContext: AudioContext): GainNode => {
    let gain = playbackGainRef.current;
    if (!gain || gain.context !== audioContext) {
      gain = audioContext.createGain();
      gain.gain.value = PLAYBACK_GAIN;
      const limiter = audioContext.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.05;
      gain.connect(limiter);
      limiter.connect(audioContext.destination);
      playbackGainRef.current = gain;
      playbackAnalyserRef.current = createVoiceAnalyser(audioContext, limiter);
    }
    return gain;
  }, []);

  const speakWarning = useCallback(
    (text: string) => {
      const owner = ++warningGenerationRef.current;
      if (!getWarningClip(text, voiceGenderRef.current)) {
        speak(text);
        return Promise.resolve("unknown" as const);
      }
      const context = playbackContextRef.current;
      if (!context || context.state === "closed") {
        speak(text);
        return Promise.resolve("unavailable" as const);
      }
      return warningPlayer
        .play(
          context,
          text,
          voiceGenderRef.current,
          playbackOutput(context),
          (startAt, duration) => {
            playbackCursorRef.current = startAt + duration;
          },
          playbackCursorRef.current
        )
        .then((result) => {
          if (owner !== warningGenerationRef.current) return "cancelled" as const;
          if (result === "unavailable") speak(text);
          return result;
        });
    },
    [playbackOutput, speak, voiceGenderRef, warningPlayer]
  );

  const playPcm16 = useCallback(
    (audioData: ArrayBuffer) => {
      // Reject empty/odd frames BEFORE lazily creating a context — a stray frame
      // after closePlayback must not resurrect an AudioContext outside a gesture.
      if (!audioData.byteLength || audioData.byteLength % 2 !== 0) return;
      const pcm = new Int16Array(audioData);

      const audioContext = playbackContextRef.current ?? new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
      playbackContextRef.current = audioContext;

      // Lazily build a shared gain → limiter → destination chain so every agent
      // buffer is boosted by PLAYBACK_GAIN while the limiter tames the loud peaks.
      const gain = playbackOutput(audioContext);

      const buffer = audioContext.createBuffer(1, pcm.length, PLAYBACK_SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i += 1) {
        channel[i] = Math.max(-1, Math.min(1, (pcm[i] ?? 0) / 0x8000));
      }

      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      if (audioContext.state === "suspended") void audioContext.resume();

      source.onended = () => {
        playbackSourcesRef.current = playbackSourcesRef.current.filter((item) => item !== source);
      };
      playbackSourcesRef.current.push(source);

      const startAt = Math.max(audioContext.currentTime, playbackCursorRef.current);
      source.start(startAt);
      playbackCursorRef.current = startAt + buffer.duration;
    },
    [playbackOutput]
  );

  // Create/resume the playback context inside a user gesture so the first agent
  // reply is audible under browser autoplay policy (Safari is strict about
  // contexts first touched on a later network event).
  const ensurePlaybackContext = useCallback(async () => {
    const playback = playbackContextRef.current ?? new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    playbackContextRef.current = playback;
    if (playback.state === "suspended") await playback.resume();
    // Decode the finite safety vocabulary before the relay/mic can deliver a
    // hazard, rather than paying network/decoder latency inside its TTC window.
    return warningPlayer.preload(playback);
  }, [warningPlayer]);

  const closePlayback = useCallback(() => {
    deferredSpeechRef.current = null;
    warningGenerationRef.current += 1;
    warningPlayer.close();
    if (playbackContextRef.current) {
      void playbackContextRef.current.close();
      playbackContextRef.current = null;
    }
    playbackGainRef.current = null;
    playbackAnalyserRef.current = null;
    playbackCursorRef.current = 0;
    // Drop references to sources whose context is now closed; leaving them would
    // make the next stopAgentSpeech report speech and call .stop() on dead nodes.
    playbackSourcesRef.current = [];
  }, [warningPlayer]);

  const getPlaybackAnalyser = useCallback(() => playbackAnalyserRef.current, []);

  return {
    playPcm16,
    stopAgentSpeech,
    speak,
    speakWarning,
    ensurePlaybackContext,
    closePlayback,
    getPlaybackAnalyser
  };
}
