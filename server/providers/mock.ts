import type { WebSocket } from "ws";
import type { AgentProvider, SessionStartEvent } from "./types";
import { MOCK_CAPABILITIES } from "../../shared/agent";
import {
  buildRideContextSummary,
  combineHazardLevels,
  describeRideMode,
  rideModeFromScenario,
  scenarioLabel,
  type DemoScenario,
  type RideContext
} from "../../shared/ride";
import { createSessionMemory, updateSessionMemory, type SessionMemory } from "../../shared/session";
import { ADAS_SCENARIOS, formatAdasAlert, type AdasSeverity } from "../../shared/adas";

type MockTurn = {
  rider: string;
  agent: string;
  latencyBase: number;
};

type ScenarioProfile = {
  speedKmh: number;
  routePhase: string;
  network: RideContext["network"];
  batteryPct: number;
  weather: {
    description: string;
    temperatureC: number;
    windSpeedKmh: number;
    isDay: boolean;
    riskLevel: "normal" | "caution" | "critical";
    riderAdvice: string;
  };
  turns: MockTurn[];
};

const SCENARIOS: Record<DemoScenario, ScenarioProfile> = {
  commute: {
    speedKmh: 58,
    routePhase: "城市快速路，距离出口 3.2 km",
    network: "online",
    batteryPct: 82,
    weather: {
      description: "晴间多云",
      temperatureC: 21,
      windSpeedKmh: 12,
      isDay: true,
      riskLevel: "normal",
      riderAdvice: "天气风险较低，保持正常安全骑行。"
    },
    turns: [
      { rider: "帮我找最快回家路线。", agent: "已设置最快回家路线。3.2 公里后靠右下出口。", latencyBase: 96 },
      { rider: "前面堵吗？", agent: "前方 1.4 公里轻微拥堵。我会提前提示变道。", latencyBase: 112 },
      { rider: "导航提示保持简短。", agent: "已切换极简提示。只报下一动作和距离。", latencyBase: 88 }
    ]
  },
  wind: {
    speedKmh: 72,
    routePhase: "跨桥路段，侧风暴露区",
    network: "online",
    batteryPct: 76,
    weather: {
      description: "多云",
      temperatureC: 18,
      windSpeedKmh: 36,
      isDay: true,
      riskLevel: "caution",
      riderAdvice: "保持更大车距，注意横风和低附着路面。"
    },
    turns: [
      { rider: "风变大了，帮我看一下。", agent: "当前横风偏强。建议降速到 60，避开大车侧后方。", latencyBase: 118 },
      { rider: "过桥有什么提醒？", agent: "上桥前收稳油门，双手放松握把，避免急打方向。", latencyBase: 126 },
      { rider: "继续导航。", agent: "继续直行 2 公里。桥面横风段剩余约 900 米。", latencyBase: 104 }
    ]
  },
  fuel: {
    speedKmh: 64,
    routePhase: "高速路，低油量寻找停靠点",
    network: "degraded",
    batteryPct: 69,
    weather: {
      description: "晴",
      temperatureC: 24,
      windSpeedKmh: 10,
      isDay: true,
      riskLevel: "normal",
      riderAdvice: "天气风险较低，保持正常安全骑行。"
    },
    turns: [
      { rider: "帮我找最近的加油站。", agent: "最近加油站在前方 2.1 公里服务区，靠右进入。", latencyBase: 102 },
      { rider: "还有更近的吗？", agent: "没有更近站点。建议保持当前车道，准备 1.4 公里后靠右。", latencyBase: 121 },
      { rider: "到了提醒我。", agent: "会在 800 米和 300 米各提醒一次。", latencyBase: 91 }
    ]
  },
  group: {
    speedKmh: 52,
    routePhase: "小队骑行，队形巡航",
    network: "online",
    batteryPct: 91,
    weather: {
      description: "阴",
      temperatureC: 19,
      windSpeedKmh: 16,
      isDay: true,
      riskLevel: "normal",
      riderAdvice: "天气风险较低，保持正常安全骑行。"
    },
    turns: [
      {
        rider: "把我的预计到达时间发给骑行小队。",
        agent: "预计 18:42 到达。已准备发送，停车后可确认。",
        latencyBase: 109
      },
      { rider: "前车距离提醒打开。", agent: "已开启小队距离提醒。当前跟车距离正常。", latencyBase: 98 },
      { rider: "提醒大家下个路口右转。", agent: "已生成小队提示：下个路口右转，距离 600 米。", latencyBase: 116 }
    ]
  },
  emergency: {
    speedKmh: 18,
    routePhase: "靠边减速中",
    network: "degraded",
    batteryPct: 43,
    weather: {
      description: "小雨",
      temperatureC: 15,
      windSpeedKmh: 22,
      isDay: false,
      riskLevel: "critical",
      riderAdvice: "建议降低速度，尽快寻找安全地点停车等待。"
    },
    turns: [
      { rider: "我需要靠边，车辆有异响。", agent: "先减速，打开双闪。前方 120 米有安全停车带。", latencyBase: 82 },
      { rider: "帮我记录位置。", agent: "已记录当前位置。停车后我可以帮你整理求助信息。", latencyBase: 94 },
      { rider: "现在怎么办？", agent: "保持直线，靠右停车，离开车道后再检查车辆。", latencyBase: 86 }
    ]
  }
};

export function createMockProvider(client: WebSocket): AgentProvider {
  let frameCount = 0;
  let timer: NodeJS.Timeout | undefined;
  // Auto-injected ADAS alerts run on their own cadence, offset from the chat
  // loop, and cycle through the hazard catalog.
  let hazardTimer: NodeJS.Timeout | undefined;
  let hazardIndex = 0;
  let promptIndex = 0;
  let scenario: DemoScenario = "commute";
  let rideContext: RideContext = {
    mode: "navigation",
    scenario,
    speedKmh: SCENARIOS.commute.speedKmh,
    routePhase: SCENARIOS.commute.routePhase,
    network: SCENARIOS.commute.network,
    batteryPct: SCENARIOS.commute.batteryPct
  };
  let audioStartedAt = 0;
  let memory: SessionMemory = createSessionMemory("navigation");

  function send(payload: unknown) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }

  function emitRideContext(hazardOverride?: AdasSeverity) {
    const intelligence = describeRideMode(rideContext.mode);
    let hazardLevel = combineHazardLevels(intelligence.hazardLevel, SCENARIOS[scenario].weather.riskLevel);
    // An active ADAS alert momentarily raises the ride-pulse hazard.
    if (hazardOverride) hazardLevel = combineHazardLevels(hazardLevel, hazardOverride);
    send({
      type: "ride.context",
      mode: rideContext.mode,
      modeLabel: intelligence.modeLabel,
      scenario,
      scenarioLabel: scenarioLabel(scenario),
      speedKmh: rideContext.speedKmh,
      routePhase: rideContext.routePhase,
      network: rideContext.network,
      batteryPct: rideContext.batteryPct,
      hazardLevel,
      glanceableFocus: intelligence.glanceableFocus
    });
  }

  function emitMemory() {
    send({ type: "session.memory", ...memory });
  }

  function emitWeather() {
    const weather = SCENARIOS[scenario].weather;
    send({ type: "weather", ...weather });
  }

  // Walks the turn states (hearing → thinking → speaking → listening) so the
  // hands-free HUD can be exercised without Doubao credentials.
  function emitConversation() {
    const profile = SCENARIOS[scenario];
    const turn = profile.turns[promptIndex % profile.turns.length];
    promptIndex += 1;

    const asrMs = 180 + Math.round(Math.random() * 80);
    const thinkMs = 260 + Math.round(Math.random() * 170);
    const firstAudioMs = turn.latencyBase + Math.round(Math.random() * 55);

    send({ type: "status", state: "hearing", detail: "正在聆听骑手讲话" });
    send({ type: "transcript", speaker: "rider", text: turn.rider, final: true });
    memory = updateSessionMemory(memory, turn.rider, rideContext.mode);
    emitMemory();
    send({ type: "status", state: "thinking", detail: "Max 正在思考" });

    setTimeout(() => {
      send({ type: "status", state: "speaking", detail: "Max 正在回答" });
      send({ type: "transcript", speaker: "agent", text: turn.agent, final: true });
      send({ type: "metric", latencyMs: firstAudioMs });
      send({
        type: "telemetry",
        asrMs,
        thinkMs,
        firstAudioMs,
        totalMs: Date.now() - audioStartedAt + firstAudioMs
      });
      setTimeout(() => send({ type: "status", state: "listening", detail: "免提待命，请讲话" }), 1500);
    }, 650);
  }

  // Simulates an ADAS sensor event: the agent interrupts whatever it is saying
  // and announces the directional warning. Cycles through the hazard catalog so
  // a single demo session exercises rear / front / side alerts.
  function emitHazardAlert() {
    const hazard = ADAS_SCENARIOS[hazardIndex % ADAS_SCENARIOS.length];
    hazardIndex += 1;

    send({
      type: "hazard.alert",
      threat: hazard.threat,
      direction: hazard.direction,
      severity: hazard.severity,
      label: hazard.label,
      message: hazard.message,
      advice: hazard.advice,
      ttcSeconds: hazard.ttcSeconds,
      interrupt: true
    });
    send({ type: "status", state: "speaking", detail: `⚠️ ${hazard.label}` });
    send({ type: "transcript", speaker: "agent", text: formatAdasAlert(hazard), final: true, useBrowserSpeech: true });
    // Raise the ride-pulse hazard for the duration of the alert, then restore.
    emitRideContext(hazard.severity);
    setTimeout(() => {
      emitRideContext();
      send({ type: "status", state: "listening", detail: "预警结束，继续免提" });
    }, (hazard.ttcSeconds + 1) * 1000);
  }

  return {
    async start(event: SessionStartEvent) {
      scenario = event.scenario ?? "commute";
      const profile = SCENARIOS[scenario];
      rideContext = {
        mode: rideModeFromScenario(event.rideMode, scenario),
        scenario,
        speedKmh: profile.speedKmh,
        routePhase: profile.routePhase,
        network: profile.network,
        batteryPct: profile.batteryPct
      };
      memory = createSessionMemory(rideContext.mode);
      send({ type: "session.started", provider: "mock", mode: "mock", capabilities: MOCK_CAPABILITIES });
      emitRideContext();
      emitMemory();
      send({
        type: "status",
        state: "ready",
        detail: `模拟代理已就绪，采样率 ${event.sampleRate} Hz，${buildRideContextSummary(rideContext)}`
      });
    },
    async startAudio() {
      audioStartedAt = Date.now();
      send({ type: "status", state: "listening", detail: "免提待命，请讲话" });
      emitRideContext();
      emitWeather();
      timer = setInterval(emitConversation, 6000);
      emitConversation();
      // Fire the first ADAS alert shortly after start, then on its own cadence
      // (offset from the chat loop) so alerts interrupt mid-conversation.
      hazardTimer = setInterval(emitHazardAlert, 11000);
      setTimeout(emitHazardAlert, 4000);
    },
    async sendAudio(chunk: Buffer) {
      frameCount += 1;
      if (frameCount % 24 === 0) {
        send({ type: "metric", latencyMs: 88 + Math.round(Math.random() * 85) });
      }
      void chunk;
    },
    async stopAudio() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (hazardTimer) clearInterval(hazardTimer);
      hazardTimer = undefined;
      send({ type: "status", state: "ready", detail: "免提已暂停" });
    },
    async close() {
      if (timer) clearInterval(timer);
      if (hazardTimer) clearInterval(hazardTimer);
    }
  };
}
