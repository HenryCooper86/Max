import type { WebSocket } from "ws";
import type { AgentProvider, SessionStartEvent } from "./types";

const riderPrompts = [
  "Helmet mic check. I need the fastest route home.",
  "Wind is picking up. Keep navigation prompts short.",
  "Find the nearest gas station on this route.",
  "Send my ETA to the group ride."
];

const agentReplies = [
  "Route home is set. Stay on US-101 North for 11 miles.",
  "Noise suppression is active. I will use concise prompts.",
  "Nearest gas is 2.1 miles ahead on the right.",
  "ETA shared. Current arrival time is 18:42."
];

export function createMockProvider(client: WebSocket): AgentProvider {
  let frameCount = 0;
  let timer: NodeJS.Timeout | undefined;
  let promptIndex = 0;

  function send(payload: unknown) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }

  function emitConversation() {
    const riderText = riderPrompts[promptIndex % riderPrompts.length];
    const agentText = agentReplies[promptIndex % agentReplies.length];
    promptIndex += 1;

    send({ type: "transcript", speaker: "rider", text: riderText, final: true });
    setTimeout(() => {
      send({ type: "transcript", speaker: "agent", text: agentText, final: true });
      send({
        type: "metric",
        noiseDb: 38 + Math.round(Math.random() * 18),
        latencyMs: 92 + Math.round(Math.random() * 70)
      });
    }, 650);
  }

  return {
    async start(event: SessionStartEvent) {
      send({ type: "session.started", provider: "mock", mode: "mock" });
      send({
        type: "status",
        state: "ready",
        detail: `Mock agent ready at ${event.sampleRate} Hz`
      });
    },
    async startAudio() {
      send({ type: "status", state: "listening", detail: "Listening through helmet mic" });
      timer = setInterval(emitConversation, 4800);
      emitConversation();
    },
    async sendAudio(chunk: Buffer) {
      frameCount += 1;
      if (frameCount % 24 === 0) {
        send({
          type: "metric",
          noiseDb: 36 + Math.round(Math.random() * 20),
          latencyMs: 88 + Math.round(Math.random() * 85)
        });
      }
      void chunk;
    },
    async stopAudio() {
      if (timer) clearInterval(timer);
      timer = undefined;
      send({ type: "status", state: "ready", detail: "Mic muted" });
    },
    async close() {
      if (timer) clearInterval(timer);
    }
  };
}
