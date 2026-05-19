import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

type SpeechRecognitionEvent = {
  resultIndex?: number;
  results: ArrayLike<{
    0: {
      transcript: string;
    };
    isFinal: boolean;
  }>;
};

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

type AgentEvent =
  | { type: "session.started"; provider: string; mode: string }
  | { type: "status"; state: string; detail: string }
  | { type: "transcript"; speaker: "rider" | "agent"; text: string; final?: boolean }
  | { type: "metric"; noiseDb: number; latencyMs: number }
  | { type: "error"; message: string };

type TranscriptItem = {
  id: number;
  speaker: "rider" | "agent";
  text: string;
};

const SAMPLE_RATE = 16000;
const PCM_FRAME_SAMPLES = 320;
const VISUALIZER_BARS = [0.42, 0.78, 0.56, 0.94, 0.68, 0.84, 0.48, 0.72, 0.6];

function createAgentSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${protocol}://${window.location.host}/agent`);
}

function floatToPcm16Array(float32: Float32Array) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

function downsampleTo16k(input: Float32Array, inputRate: number) {
  if (inputRate === SAMPLE_RATE) return input;
  const ratio = inputRate / SAMPLE_RATE;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    output[i] = input[Math.floor(i * ratio)] ?? 0;
  }
  return output;
}

function useHelmetAgent() {
  const [connected, setConnected] = useState(false);
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("Offline");
  const [provider, setProvider] = useState("mock");
  const [noiseDb, setNoiseDb] = useState(42);
  const [latencyMs, setLatencyMs] = useState(0);
  const [commandText, setCommandText] = useState("");
  const [arkBusy, setArkBusy] = useState(false);
  const [speechListening, setSpeechListening] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackCursorRef = useRef(0);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micSinkRef = useRef<GainNode | null>(null);
  const pcmQueueRef = useRef<Int16Array>(new Int16Array(0));
  const pcmSendTimerRef = useRef<number | null>(null);
  const voiceLevelRef = useRef(0);
  const lastVoiceLevelUpdateRef = useRef(0);
  const speechRef = useRef<BrowserSpeechRecognition | null>(null);
  const speechContinuousRef = useRef(false);
  const speechBufferRef = useRef("");
  const speechFlushTimerRef = useRef<number | null>(null);
  const arkBusyRef = useRef(false);

  const pushTranscript = useCallback((speaker: "rider" | "agent", text: string) => {
    setTranscript((items) => [...items.slice(-7), { id: Date.now() + Math.random(), speaker, text }]);
  }, []);

  const clearSpeechFlushTimer = useCallback(() => {
    if (speechFlushTimerRef.current) window.clearTimeout(speechFlushTimerRef.current);
    speechFlushTimerRef.current = null;
  }, []);

  const stopSpeechCapture = useCallback(() => {
    speechContinuousRef.current = false;
    clearSpeechFlushTimer();
    speechBufferRef.current = "";
    speechRef.current?.stop();
    setSpeechListening(false);
  }, [clearSpeechFlushTimer]);

  const speak = useCallback((text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    utterance.pitch = 0.96;
    window.speechSynthesis.speak(utterance);
  }, []);

  const playPcm16 = useCallback((audioData: ArrayBuffer) => {
    const sampleRate = 24000;
    const audioContext = playbackContextRef.current ?? new AudioContext({ sampleRate });
    playbackContextRef.current = audioContext;

    const pcm = new Int16Array(audioData);
    if (!pcm.length) return;

    const buffer = audioContext.createBuffer(1, pcm.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) {
      channel[i] = Math.max(-1, Math.min(1, pcm[i] / 0x8000));
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    if (audioContext.state === "suspended") void audioContext.resume();

    const startAt = Math.max(audioContext.currentTime, playbackCursorRef.current);
    source.start(startAt);
    playbackCursorRef.current = startAt + buffer.duration;
  }, []);

  const connect = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) return;
    setStatus("Connecting");
    const socket = createAgentSocket();
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnected(true);
      setStatus("Ready");
      socket.send(JSON.stringify({ type: "session.start", sampleRate: SAMPLE_RATE, channels: 1 }));
    });

    socket.addEventListener("message", (message) => {
      if (message.data instanceof ArrayBuffer) {
        playPcm16(message.data);
        return;
      }

      try {
        const event = JSON.parse(String(message.data)) as AgentEvent;
        if (event.type === "session.started") {
          setProvider(event.provider);
          setStatus(event.mode === "mock" ? "Mock route active" : "Doubao live");
        }
        if (event.type === "status") setStatus(event.detail);
        if (event.type === "transcript") {
          pushTranscript(event.speaker, event.text);
          if (event.speaker === "agent" && event.final !== false) speak(event.text);
        }
        if (event.type === "metric") {
          setNoiseDb(event.noiseDb);
          setLatencyMs(event.latencyMs);
        }
        if (event.type === "error") setStatus(event.message);
      } catch {
        setStatus("Unexpected agent message");
      }
    });

    socket.addEventListener("close", () => {
      setConnected(false);
      setListening(false);
      setStatus("Offline");
    });

    socket.addEventListener("error", () => {
      setStatus("Connection error");
    });
  }, [playPcm16, pushTranscript, speak]);

  const waitForSocket = useCallback(async () => {
    connect();
    const socket = socketRef.current;
    if (!socket) throw new Error("Voice socket was not created");
    if (socket.readyState === WebSocket.OPEN) return socket;

    return new Promise<WebSocket>((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve(socket);
      };
      const handleError = () => {
        cleanup();
        reject(new Error("Voice socket failed to open"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
    });
  }, [connect]);

  const stopMic = useCallback(() => {
    stopSpeechCapture();
    if (pcmSendTimerRef.current) window.clearInterval(pcmSendTimerRef.current);
    pcmSendTimerRef.current = null;
    pcmQueueRef.current = new Int16Array(0);
    voiceLevelRef.current = 0;
    setVoiceLevel(0);
    processorRef.current?.disconnect();
    micSinkRef.current?.disconnect();
    audioContextRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    micSinkRef.current = null;
    processorRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;
    setListening(false);
    socketRef.current?.send(JSON.stringify({ type: "audio.stop" }));
  }, [stopSpeechCapture]);

  const startMic = useCallback(async () => {
    try {
      const socket = await waitForSocket();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(1024, 1, 1);
      const micSink = audioContext.createGain();
      micSink.gain.value = 0;
      streamRef.current = stream;
      audioContextRef.current = audioContext;
      processorRef.current = processor;
      micSinkRef.current = micSink;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let sumSquares = 0;
        for (let i = 0; i < input.length; i += 1) {
          sumSquares += input[i] * input[i];
        }
        const rms = Math.sqrt(sumSquares / input.length);
        const nextLevel = Math.min(1, rms * 8);
        voiceLevelRef.current = voiceLevelRef.current * 0.68 + nextLevel * 0.32;
        const now = performance.now();
        if (now - lastVoiceLevelUpdateRef.current > 45) {
          lastVoiceLevelUpdateRef.current = now;
          setVoiceLevel(voiceLevelRef.current);
        }

        const next = floatToPcm16Array(downsampleTo16k(input, audioContext.sampleRate));
        const queued = pcmQueueRef.current;
        const merged = new Int16Array(queued.length + next.length);
        merged.set(queued);
        merged.set(next, queued.length);
        pcmQueueRef.current = merged;
      };

      source.connect(processor);
      processor.connect(micSink);
      micSink.connect(audioContext.destination);
      pcmSendTimerRef.current = window.setInterval(() => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const queued = pcmQueueRef.current;
        if (queued.length < PCM_FRAME_SAMPLES) return;
        const frame = queued.slice(0, PCM_FRAME_SAMPLES);
        pcmQueueRef.current = queued.slice(PCM_FRAME_SAMPLES);
        socket.send(frame.buffer);
      }, 20);
      setListening(true);
      setStatus("Listening");
      socket.send(JSON.stringify({ type: "audio.start" }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Microphone access failed");
      setListening(false);
    }
  }, [waitForSocket]);

  const disconnect = useCallback(() => {
    stopMic();
    playbackContextRef.current?.close();
    playbackContextRef.current = null;
    playbackCursorRef.current = 0;
    socketRef.current?.close();
    socketRef.current = null;
  }, [stopMic]);

  const submitCommand = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? commandText).trim();
      if (!text || arkBusyRef.current) return;

      pushTranscript("rider", text);
      setCommandText("");
      arkBusyRef.current = true;
      setArkBusy(true);
      setStatus("Thinking with Ark");
      const startedAt = performance.now();

      try {
        const response = await fetch("/ark/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        });
        const payload = (await response.json()) as { reply?: string; error?: string; fallback?: boolean };
        if (!response.ok) throw new Error(payload.error ?? "Ark request failed");
        const reply = payload.reply ?? "";
        pushTranscript("agent", reply);
        speak(reply);
        setProvider("ark");
        setLatencyMs(Math.round(performance.now() - startedAt));
        setStatus(payload.fallback ? "Local fallback reply ready" : "Ark reply ready");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Ark request failed";
        const reply = `I heard you, but I cannot reach Ark: ${message}`;
        pushTranscript("agent", reply);
        speak(reply);
        setStatus(message);
      } finally {
        arkBusyRef.current = false;
        setArkBusy(false);
      }
    },
    [commandText, pushTranscript, speak]
  );

  const flushSpeechCommand = useCallback(() => {
    clearSpeechFlushTimer();
    const text = speechBufferRef.current.trim().replace(/\s+/g, " ");
    speechBufferRef.current = "";
    if (!text) return;
    setCommandText(text);
    void submitCommand(text);
  }, [clearSpeechFlushTimer, submitCommand]);

  function startSpeechCapture(continuous: boolean) {
    const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setStatus("Speech recognition is not available in this browser");
      return;
    }

    speechContinuousRef.current = continuous;
    clearSpeechFlushTimer();
    speechBufferRef.current = "";
    speechRef.current?.stop();

    const recognition = new SpeechRecognition();
    speechRef.current = recognition;
    recognition.continuous = continuous;
    recognition.interimResults = continuous;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const results = Array.from(event.results);
      const startIndex = event.resultIndex ?? 0;
      const newResults = results.slice(startIndex);
      const finalText = newResults
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();

      if (!continuous) {
        const command = (finalText || results.map((result) => result[0]?.transcript ?? "").join(" ")).trim();
        setCommandText(command);
        void submitCommand(command);
        return;
      }

      if (finalText) {
        speechBufferRef.current = `${speechBufferRef.current} ${finalText}`.trim();
      }

      const interimText = newResults
        .filter((result) => !result.isFinal)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      setCommandText(`${speechBufferRef.current} ${interimText}`.trim());

      if (speechBufferRef.current) {
        clearSpeechFlushTimer();
        speechFlushTimerRef.current = window.setTimeout(flushSpeechCommand, 1300);
      }
    };
    recognition.onerror = () => {
      setSpeechListening(false);
      if (!continuous) setStatus("Speech command failed");
    };
    recognition.onend = () => {
      setSpeechListening(false);
      if (speechContinuousRef.current) {
        window.setTimeout(() => {
          try {
            recognition.start();
            setSpeechListening(true);
          } catch {
            setStatus("Speech recognition restart failed");
          }
        }, 250);
      }
    };
    setSpeechListening(true);
    setStatus(continuous ? "Listening with Ark voice fallback" : "Listening for command");
    recognition.start();
  }

  const startSpeechCommand = useCallback(() => {
    startSpeechCapture(false);
  }, [submitCommand]);

  useEffect(
    () => () => {
      stopSpeechCapture();
      disconnect();
    },
    [disconnect, stopSpeechCapture]
  );

  return {
    connected,
    listening,
    status,
    provider,
    noiseDb,
    latencyMs,
    commandText,
    arkBusy,
    speechListening,
    voiceLevel,
    transcript,
    setCommandText,
    connect,
    startMic,
    stopMic,
    disconnect,
    submitCommand,
    startSpeechCommand
  };
}

function App() {
  const agent = useHelmetAgent();
  const agentState = useMemo(() => {
    if (agent.listening) return "Listening";
    if (agent.connected) return "Standby";
    return "Offline";
  }, [agent.connected, agent.listening]);

  return (
    <main className="shell">
      <section className="visor" aria-label="Helmet voice agent cockpit">
        <div className="topbar">
          <div>
            <p className="eyebrow">HCT Helmet OS</p>
            <h1>Max Your Motorcycle Helmet AI</h1>
          </div>
          <div className={`signal ${agent.connected ? "online" : ""}`}>
            <span />
            {agent.provider.toUpperCase()}
          </div>
        </div>

        <div className="grid">
          <section className="hudPanel helmetPanel">
            <div className={`helmetVisual ${agent.connected ? "online" : "offline"} ${agent.listening ? "listening" : ""}`} aria-hidden="true">
              <svg viewBox="0 0 420 270" role="img">
                <path
                  className="helmetShell"
                  d="M54 161c4-81 68-132 151-132 93 0 159 61 166 149 2 24-11 45-34 54-45 17-126 26-204 8-50-12-81-39-79-79Z"
                />
                <path
                  className="helmetVisor"
                  d="M155 88h155c22 0 40 18 40 40v13c-48 18-106 25-178 21-27-1-49-24-49-51 0-13 11-23 32-23Z"
                />
                <path
                  className="chin"
                  d="M220 167c40 4 82 0 126-12-5 28-18 46-40 54-31 11-66 17-103 17 17-17 22-36 17-59Z"
                />
                <circle className="micDot" cx="258" cy="205" r="9" />
                <circle className="greenDot" cx="282" cy="205" r="9" />
              </svg>
              <div className={`visorVisualizer ${agent.listening ? "active" : ""}`}>
                {VISUALIZER_BARS.map((weight, index) => {
                  const scale = agent.listening ? Math.max(0.12, Math.min(1, agent.voiceLevel * weight + 0.08)) : 0.12;
                  return <span key={weight + index} style={{ transform: `scaleY(${scale})` }} />;
                })}
              </div>
            </div>
            <div className="primaryControls">
              <button
                className="mainButton"
                onClick={agent.listening ? agent.stopMic : agent.startMic}
                type="button"
              >
                {agent.listening ? "Mute Mic" : "Start Voice"}
              </button>
              <button className="ghostButton" onClick={agent.connected ? agent.disconnect : agent.connect} type="button">
                {agent.connected ? "Disconnect" : "Connect"}
              </button>
            </div>
            <form
              className="commandBar"
              onSubmit={(event) => {
                event.preventDefault();
                void agent.submitCommand();
              }}
            >
              <input
                aria-label="Rider command"
                placeholder="Ask Max: route home, weather ahead, nearest gas..."
                value={agent.commandText}
                onChange={(event) => agent.setCommandText(event.target.value)}
              />
              <button className="ghostButton" type="button" onClick={agent.startSpeechCommand}>
                {agent.speechListening ? "Listening" : "Voice Command"}
              </button>
              <button className="mainButton" type="submit" disabled={agent.arkBusy}>
                {agent.arkBusy ? "Sending" : "Ask Ark"}
              </button>
            </form>
          </section>

          <section className="hudPanel statusPanel">
            <div className="stateBlock">
              <p>Agent</p>
              <strong>{agentState}</strong>
              <span>{agent.status}</span>
            </div>
            <div className="metricRow">
              <div>
                <p>Wind Noise</p>
                <strong>{agent.noiseDb} dB</strong>
              </div>
              <div>
                <p>Latency</p>
                <strong>{agent.latencyMs} ms</strong>
              </div>
            </div>
            <div className="routeStrip">
              <span>Navigation</span>
              <strong>US-101 N</strong>
              <small>Next turn in 1.4 mi</small>
            </div>
          </section>

          <section className="hudPanel transcriptPanel">
            <div className="panelHeader">
              <h2>Conversation</h2>
              <span>{agent.transcript.length ? "Live" : "Idle"}</span>
            </div>
            <div className="transcriptList">
              {(agent.transcript.length ? agent.transcript : [{ id: 1, speaker: "agent" as const, text: "Hi, I am Max Motorcycle Helmet AI assistant. Ask me about routes, weather, nearby stops, or motorcycle issues." }]).map(
                (item) => (
                  <article className={`message ${item.speaker}`} key={item.id}>
                    <span>{item.speaker === "rider" ? "Rider" : "Max"}</span>
                    <p>{item.text}</p>
                  </article>
                )
              )}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
