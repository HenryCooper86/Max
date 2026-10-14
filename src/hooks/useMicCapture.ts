// Mic capture graph: getUserMedia → AudioWorklet (off-thread 16 kHz PCM16
// framing) → WebSocket. Owns the visor voice level, packet stats, and the
// audio-processing readout. Acquired once and reused across sessions.

import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { createPacketWindow, recordDroppedFrame, recordSentFrame, type PacketWindow } from "../../shared/audio";
import { DEFAULT_AUDIO_PROCESSING, DEFAULT_PACKET_STATS, SAMPLE_RATE } from "../lib/constants";
import { readAudioProcessingSettings } from "../lib/utils";
import type { AudioProcessingState, PacketStats, WorkletMessage } from "../types";

type Params = {
  socketRef: MutableRefObject<WebSocket | null>;
  transmittingRef: MutableRefObject<boolean>;
  providerReadyRef: MutableRefObject<boolean>;
};

const MAX_SOCKET_BUFFERED_BYTES = 256 * 1024;

export function useMicCapture({ socketRef, transmittingRef, providerReadyRef }: Params) {
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [packetStats, setPacketStats] = useState<PacketStats>(DEFAULT_PACKET_STATS);
  const [audioProcessing, setAudioProcessing] = useState<AudioProcessingState>(DEFAULT_AUDIO_PROCESSING);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  // In-flight setup promise: two rapid start triggers (double Space press,
  // double-click) must share one getUserMedia, or the loser's MediaStream
  // leaks (mic indicator stays on) and both worklets stream duplicate frames.
  const micSetupRef = useRef<Promise<void> | null>(null);
  // Bumped by releaseMic. A build that started before the bump finished after
  // teardown would otherwise repopulate the refs with a live MediaStream and
  // running AudioContext nothing will ever stop (mic indicator stuck on).
  const micGenerationRef = useRef(0);
  const frameWindowRef = useRef<PacketWindow>(createPacketWindow());
  const frameTimingRef = useRef({ lastAt: 0, deviationTotalMs: 0, samples: 0 });
  const signalQualityRef = useRef({ clippingPct: 0, silencePct: 0 });
  // Last time a dropped-frame count was pushed to React state. During a
  // reconnect with the mic hot, every 20 ms frame is dropped — rendering the
  // HUD 50×/s for a counter nobody can read that fast.
  const lastDropUpdateRef = useRef(0);
  // Last visor level pushed to React state; used to skip re-renders when the
  // quantized level is unchanged (e.g. steady silence during a ride).
  const lastVoiceLevelRef = useRef(0);

  // Acquire the mic + AudioWorklet graph once and reuse it across sessions.
  const ensureMic = useCallback(async () => {
    if (streamRef.current && audioContextRef.current && workletNodeRef.current) {
      if (audioContextRef.current.state === "suspended") await audioContextRef.current.resume();
      return;
    }
    if (!micSetupRef.current) {
      const setup = buildMicGraph().catch((error) => {
        // An abandoned permission prompt may reject after a new setup starts.
        if (micSetupRef.current === setup) micSetupRef.current = null;
        throw error;
      });
      micSetupRef.current = setup;
    }
    return micSetupRef.current;

    async function buildMicGraph() {
      const generation = micGenerationRef.current;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: { ideal: 1 },
          sampleRate: { ideal: SAMPLE_RATE },
          sampleSize: { ideal: 16 }
        } as MediaTrackConstraints
      });
      // releaseMic ran while getUserMedia was pending (unmount/disconnect):
      // free the stream instead of resurrecting a graph nobody will stop.
      if (generation !== micGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("麦克风已在启动过程中被释放");
      }
      let audioContext: AudioContext | null = null;
      let workletNode: AudioWorkletNode | null = null;
      try {
        const [track] = stream.getAudioTracks();
        if (track) setAudioProcessing(readAudioProcessingSettings(track));
        audioContext = new AudioContext();
        if (!audioContext.audioWorklet) {
          throw new Error("此浏览器不支持 AudioWorklet 麦克风采集");
        }

        // addModule can fail on a missing/cached-bad worklet, CSP rejection,
        // or browser implementation error. Everything after getUserMedia is
        // inside this cleanup boundary so none of those failures leaves the
        // mic indicator or an AudioContext alive.
        await audioContext.audioWorklet.addModule("/pcm-worklet.js");
        const source = audioContext.createMediaStreamSource(stream);
        workletNode = new AudioWorkletNode(audioContext, "pcm-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: "explicit"
        });

        workletNode.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
          const message = event.data;
          if (message.type === "frame") {
            if (!transmittingRef.current) return;
            const socket = socketRef.current;
            if (
              providerReadyRef.current &&
              socket?.readyState === WebSocket.OPEN &&
              socket.bufferedAmount + message.pcm.byteLength < MAX_SOCKET_BUFFERED_BYTES
            ) {
              socket.send(message.pcm);
              const now = performance.now();
              const timing = frameTimingRef.current;
              if (timing.lastAt > 0) {
                timing.deviationTotalMs += Math.abs(now - timing.lastAt - 20);
                timing.samples += 1;
              }
              timing.lastAt = now;
              const result = recordSentFrame(frameWindowRef.current, now);
              frameWindowRef.current = result.window;
              if (result.metric) {
                const jitterMs = timing.samples ? Math.round((timing.deviationTotalMs / timing.samples) * 10) / 10 : 0;
                frameTimingRef.current = { lastAt: now, deviationTotalMs: 0, samples: 0 };
                setPacketStats({ ...result.metric, jitterMs, ...signalQualityRef.current });
              }
            } else {
              const result = recordDroppedFrame(frameWindowRef.current);
              frameWindowRef.current = result.window;
              // At most one state update per second — during reconnect backoff
              // every 20 ms frame lands here.
              const now = performance.now();
              if (now - lastDropUpdateRef.current >= 1000) {
                lastDropUpdateRef.current = now;
                setPacketStats((stats) => ({ ...stats, droppedFrames: result.metric.droppedFrames }));
              }
            }
          } else if (message.type === "level") {
            signalQualityRef.current = {
              clippingPct: message.clippingPct ?? signalQualityRef.current.clippingPct,
              silencePct: message.silencePct ?? signalQualityRef.current.silencePct
            };
            // Quantize to ~0.02 and drop no-change updates so a steady level (notably
            // silence) doesn't re-render the whole HUD ~23×/s while transmitting.
            const next = Math.round((transmittingRef.current ? message.value : 0) * 50) / 50;
            if (next !== lastVoiceLevelRef.current) {
              lastVoiceLevelRef.current = next;
              setVoiceLevel(next);
            }
          }
        };

        // Second checkpoint: addModule/worklet setup is async too.
        if (generation !== micGenerationRef.current) {
          throw new Error("麦克风已在启动过程中被释放");
        }

        source.connect(workletNode);
        workletNode.connect(audioContext.destination);

        streamRef.current = stream;
        audioContextRef.current = audioContext;
        workletNodeRef.current = workletNode;
      } catch (error) {
        if (workletNode) {
          workletNode.port.onmessage = null;
          try {
            workletNode.disconnect();
          } catch {
            /* construction/connect may have failed before the node attached */
          }
        }
        stream.getTracks().forEach((track) => track.stop());
        if (audioContext && audioContext.state !== "closed") {
          try {
            await audioContext.close();
          } catch {
            /* preserve the setup error that explains why mic start failed */
          }
        }
        if (generation === micGenerationRef.current) setAudioProcessing(DEFAULT_AUDIO_PROCESSING);
        throw error;
      }
    }
  }, [providerReadyRef, socketRef, transmittingRef]);

  const releaseMic = useCallback(() => {
    transmittingRef.current = false;
    micGenerationRef.current += 1;
    micSetupRef.current = null;
    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    lastVoiceLevelRef.current = 0;
    setVoiceLevel(0);
    setAudioProcessing(DEFAULT_AUDIO_PROCESSING);
  }, [transmittingRef]);

  /** (Un)mutes capture without tearing down the graph, for instant restarts. */
  const setTrackEnabled = useCallback((enabled: boolean) => {
    streamRef.current?.getAudioTracks().forEach((track) => (track.enabled = enabled));
  }, []);

  const resetFrameWindow = useCallback(() => {
    frameWindowRef.current = createPacketWindow();
    frameTimingRef.current = { lastAt: 0, deviationTotalMs: 0, samples: 0 };
    signalQualityRef.current = { clippingPct: 0, silencePct: 0 };
    lastVoiceLevelRef.current = 0;
    setVoiceLevel(0);
  }, []);

  return {
    voiceLevel,
    packetStats,
    setPacketStats,
    audioProcessing,
    ensureMic,
    releaseMic,
    setTrackEnabled,
    resetFrameWindow
  };
}
