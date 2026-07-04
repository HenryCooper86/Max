// Agent speech output: schedules relayed Doubao PCM through a shared
// gain → limiter chain, provides the browser-TTS fallback, and implements
// barge-in (cutting agent audio the moment the rider talks).

import { useCallback, useRef, type MutableRefObject } from "react";
import { detectLanguage } from "../../shared/language";
import { PLAYBACK_GAIN, PLAYBACK_SAMPLE_RATE } from "../lib/constants";
import { selectVoice, VOICE_LOCALE } from "../lib/speech";
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

  // Barge-in: silence whatever the agent is currently saying so the rider can
  // interrupt. Covers both browser TTS and queued Doubao voice audio.
  const stopAgentSpeech = useCallback(() => {
    // Only report a barge-in when the agent was audibly saying something —
    // this runs on every rider ASR partial, and claiming "已打断 Max" while
    // Max was silent fought the server's hearing/asr turn states.
    const wasSpeaking =
      playbackSourcesRef.current.length > 0 || ("speechSynthesis" in window && window.speechSynthesis.speaking);
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
  }, [onInterrupted, transmittingRef]);

  // Browser-TTS fallback, used when Doubao returns reply text but no audio.
  const speak = useCallback(
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

  const playPcm16 = useCallback((audioData: ArrayBuffer) => {
    // Reject empty/odd frames BEFORE lazily creating a context — a stray frame
    // after closePlayback must not resurrect an AudioContext outside a gesture.
    if (!audioData.byteLength || audioData.byteLength % 2 !== 0) return;
    const pcm = new Int16Array(audioData);

    const audioContext = playbackContextRef.current ?? new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    playbackContextRef.current = audioContext;

    // Lazily build a shared gain → limiter → destination chain so every agent
    // buffer is boosted by PLAYBACK_GAIN while the limiter tames the loud peaks.
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
    }

    const buffer = audioContext.createBuffer(1, pcm.length, PLAYBACK_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) {
      channel[i] = Math.max(-1, Math.min(1, pcm[i] / 0x8000));
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
  }, []);

  // Create/resume the playback context inside a user gesture so the first agent
  // reply is audible under browser autoplay policy (Safari is strict about
  // contexts first touched on a later network event).
  const ensurePlaybackContext = useCallback(() => {
    const playback = playbackContextRef.current ?? new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    playbackContextRef.current = playback;
    if (playback.state === "suspended") void playback.resume();
  }, []);

  const closePlayback = useCallback(() => {
    if (playbackContextRef.current) {
      void playbackContextRef.current.close();
      playbackContextRef.current = null;
    }
    playbackGainRef.current = null;
    playbackCursorRef.current = 0;
  }, []);

  return { playPcm16, stopAgentSpeech, speak, ensurePlaybackContext, closePlayback };
}
