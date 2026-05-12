import { WebSocket, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import type { AgentProvider, SessionStartEvent } from "./types";

type DoubaoSessionConfig = {
  sampleRate: number;
  channels: number;
};

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when VOICE_PROVIDER=doubao`);
  return value;
}

function buildDoubaoHeaders() {
  const appId = requireEnv("DOUBAO_APP_ID");
  const appKey = requireEnv("DOUBAO_APP_KEY");
  const accessKey = requireEnv("DOUBAO_ACCESS_KEY");
  const resourceId = process.env.DOUBAO_RESOURCE_ID ?? "volc.speech.dialog";

  return {
    "X-Api-App-ID": appId,
    "X-Api-App-Key": appKey,
    "X-Api-Access-Key": accessKey,
    "X-Api-Resource-Id": resourceId,
    "X-Api-Connect-Id": randomUUID()
  };
}

function buildDoubaoStartEvent(config: DoubaoSessionConfig) {
  return {
    type: "StartSession",
    audio: {
      format: "pcm_s16le",
      sample_rate: config.sampleRate,
      channels: config.channels
    },
    dialog: {
      bot_name: process.env.DOUBAO_BOT_NAME ?? "Horizon Helmet",
      system_role:
        process.env.DOUBAO_SYSTEM_ROLE ??
        "You are a motorcycle helmet voice assistant. Keep replies short, hands-free, and safety-first."
    }
  };
}

function normalizeDoubaoMessage(raw: RawData) {
  const data = JSON.parse(raw.toString()) as Record<string, unknown>;
  const type = String(data.type ?? data.event ?? "");

  if (type.includes("transcript")) {
    return {
      type: "transcript",
      speaker: type.includes("user") ? "rider" : "agent",
      text: String(data.text ?? data.content ?? ""),
      final: data.final ?? true
    };
  }

  if (type.includes("response") || type.includes("message")) {
    return {
      type: "transcript",
      speaker: "agent",
      text: String(data.text ?? data.content ?? data.message ?? ""),
      final: true
    };
  }

  return { type: "status", state: "doubao", detail: type || "Doubao event received" };
}

export function createDoubaoProvider(client: WebSocket): AgentProvider {
  let upstream: WebSocket | undefined;
  let started = false;

  function sendClient(payload: unknown) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }

  function connectUpstream(config: DoubaoSessionConfig) {
    const url = process.env.DOUBAO_AGENT_WS_URL ?? "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
    upstream = new WebSocket(url, { headers: buildDoubaoHeaders() });

    upstream.on("open", () => {
      upstream?.send(JSON.stringify(buildDoubaoStartEvent(config)));
      sendClient({ type: "session.started", provider: "doubao", mode: "live" });
      sendClient({ type: "status", state: "ready", detail: "Doubao live agent connected" });
    });

    upstream.on("message", (message) => {
      try {
        const normalized = normalizeDoubaoMessage(message);
        sendClient(normalized);
      } catch {
        sendClient({ type: "status", state: "doubao", detail: "Received non-JSON Doubao payload" });
      }
    });

    upstream.on("close", () => {
      sendClient({ type: "status", state: "closed", detail: "Doubao live agent disconnected" });
    });

    upstream.on("error", (error) => {
      sendClient({ type: "error", message: error.message });
    });
  }

  return {
    async start(event: SessionStartEvent) {
      if (!started) {
        started = true;
        connectUpstream({ sampleRate: event.sampleRate, channels: event.channels });
      }
    },
    async startAudio() {
      upstream?.send(JSON.stringify({ type: "audio.start" }));
    },
    async sendAudio(chunk: Buffer) {
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(chunk);
      }
    },
    async stopAudio() {
      upstream?.send(JSON.stringify({ type: "audio.stop" }));
      sendClient({ type: "status", state: "ready", detail: "Mic muted" });
    },
    async close() {
      upstream?.close();
    }
  };
}
