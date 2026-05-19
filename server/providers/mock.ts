import type { WebSocket } from "ws";
import type { AgentProvider, SessionStartEvent } from "./types";

const riderPrompts = [
  "头盔麦克风测试。帮我找最快回家路线。",
  "风变大了。导航提示保持简短。",
  "帮我找这条路线最近的加油站。",
  "把我的预计到达时间发给骑行小队。"
];

const agentReplies = [
  "回家路线已设置。沿 US-101 North 继续 11 英里。",
  "降噪已开启。我会保持提示简短。",
  "最近加油站在前方 2.1 英里右侧。",
  "预计到达时间已发送。当前到达时间是 18:42。"
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
        detail: `模拟代理已就绪，采样率 ${event.sampleRate} Hz`
      });
    },
    async startAudio() {
      send({ type: "status", state: "listening", detail: "正在通过头盔麦克风收听" });
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
      send({ type: "status", state: "ready", detail: "麦克风已静音" });
    },
    async close() {
      if (timer) clearInterval(timer);
    }
  };
}
