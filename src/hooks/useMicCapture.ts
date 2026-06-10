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
};

export function useMicCapture({ socketRef, transmittingRef }: Params) {
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [packetStats, setPacketStats] = useState<PacketStats>(DEFAULT_PACKET_STATS);
  const [audioProcessing, setAudioProcessing] = useState<AudioProcessingState>(DEFAULT_AUDIO_PROCESSING);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const frameWindowRef = useRef<PacketWindow>(createPacketWindow());
  // Last visor level pushed to React state; used to skip re-renders when the
  // quantized level is unchanged (e.g. steady silence during a ride).
  const lastVoiceLevelRef = useRef(0);

  // Acquire the mic + AudioWorklet graph once and reuse it across sessions.
  const ensureMic = useCallback(async () => {
    if (streamRef.current && audioContextRef.current && workletNodeRef.current) {
      if (audioContextRef.current.state === "suspended") await audioContextRef.current.resume();
      return;
    }

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
    const [track] = stream.getAudioTracks();
    if (track) setAudioProcessing(readAudioProcessingSettings(track));
    const audioContext = new AudioContext();
    if (!audioContext.audioWorklet) {
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();
      throw new Error("此浏览器不支持 AudioWorklet 麦克风采集");
    }

    await audioContext.audioWorklet.addModule("/pcm-worklet.js");
    const source = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-capture", {
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
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(message.pcm);
          const now = performance.now();
          const result = recordSentFrame(frameWindowRef.current, now);
          frameWindowRef.current = result.window;
          if (result.metric) setPacketStats(result.metric);
        } else {
          const result = recordDroppedFrame(frameWindowRef.current);
          frameWindowRef.current = result.window;
          setPacketStats((stats) => ({ ...stats, droppedFrames: result.metric.droppedFrames }));
        }
      } else if (message.type === "level") {
        // Quantize to ~0.02 and drop no-change updates so a steady level (notably
        // silence) doesn't re-render the whole HUD ~23×/s while transmitting.
        const next = Math.round((transmittingRef.current ? message.value : 0) * 50) / 50;
        if (next !== lastVoiceLevelRef.current) {
          lastVoiceLevelRef.current = next;
          setVoiceLevel(next);
        }
      }
    };

    source.connect(workletNode);
    workletNode.connect(audioContext.destination);

    streamRef.current = stream;
    audioContextRef.current = audioContext;
    workletNodeRef.current = workletNode;
  }, [socketRef, transmittingRef]);

  const releaseMic = useCallback(() => {
    transmittingRef.current = false;
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
