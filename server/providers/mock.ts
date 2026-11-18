import { assistant } from "../assistant";
import { sessionLanguage } from "../prompts";
import { localizeOutgoing } from "../relay-speech";
import type { WebSocket } from "ws";
import type { AgentProvider, ProviderSessionContext, ProviderTelemetry, SessionStartEvent } from "./types";
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
import {
  createSessionMemory,
  restoreSessionMemory,
  updateSessionMemory,
  type SessionMemory
} from "../../shared/session";
import { type AdasSeverity } from "../../shared/adas";
import {
  DEVICE_ACTION_TIERS,
  DeviceActivityContext,
  PendingDeviceCommands,
  deviceSuccessSpeech,
  reconcileDeviceResult,
  type DeviceActionName,
  type DeviceActionStatus
} from "../device-actions";
import { createCrashSimulator, createHazardInjector } from "../hazard-injector";
import { metrics } from "../metrics";
import { createTranscriptDelivery, transcriptEvent } from "../transcript-events";
import { createMockVisionProvider } from "../vision";
import { createFrameAssembler } from "../vision-frames";
import { createVisionGovernor } from "../vision-governor";

// Deliberately NOT selectVisionProvider: the mock voice provider is the
// zero-credential demo surface and must never spend Ark quota (spec M1) —
// even when ARK_API_KEY/ARK_MODEL are configured for the real (doubao)
// provider elsewhere in the same process. Module scope, not per-connection,
// because the mock vision provider is stateless (see server/vision.ts).
const mockVisionProvider = createMockVisionProvider();

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
  turns: [MockTurn, ...MockTurn[]];
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
      { rider: "Max，导航去公司", agent: "好的，开始导航，全程约 3 公里。", latencyBase: 96 },
      // Exercises the device-action path end to end without Doubao credentials.
      { rider: "Max，打开手电筒", agent: "好的，手电筒已经打开。", latencyBase: 94 },
      { rider: "Max，拍照", agent: "好的，拍好了。", latencyBase: 92 },
      {
        rider: "你是谁开发的？",
        agent: "我的开发者是 Henry，在网络安全圈里大家叫他 cooph2o，是他打造了我。",
        latencyBase: 90
      },
      { rider: "前面堵吗？", agent: "前方 1.4 公里轻微拥堵。我会提前提示变道。", latencyBase: 112 },
      { rider: "导航提示保持简短。", agent: "已切换极简提示。只报下一动作和距离。", latencyBase: 88 },
      // Exercises the keyless camera.look demo path (spec M1): on the
      // embedded board this dispatches a real device.command and the board
      // answers with camera.frame, describing the frame at zero credential
      // cost via createMockVisionProvider — see server/vision.ts.
      { rider: "你能看到什么", agent: "前方视野清楚，路况正常。", latencyBase: 95 },
      { rider: "前面那个路牌写的什么", agent: "我看看，稍后告诉你路牌上写的什么。", latencyBase: 100 },
      // Exercises the keyless gallery.describe demo path (spec V-B): on iOS
      // this dispatches a real device.command and the client answers with a
      // chunked vision.frames set, assembled and described at zero
      // credential cost via createMockVisionProvider — see server/vision.ts
      // and server/vision-frames.ts.
      { rider: "看看我刚拍的视频", agent: "我看看，稍后告诉你视频里都拍了什么。", latencyBase: 98 },
      { rider: "看看我刚拍的照片", agent: "我看看，稍后告诉你照片里都拍了什么。", latencyBase: 93 },
      // Exercises the keyless watch-frame demo path (spec V-C): on the
      // embedded board this toggles the proactive scene-watching governor —
      // see createVisionGovernor below and server/vision-governor.ts.
      { rider: "开启环境观察", agent: "好的，我开始帮你留意路况。", latencyBase: 91 }
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
  },
  adas: {
    speedKmh: 68,
    routePhase: "城市道路，主动安全预警演示",
    network: "online",
    batteryPct: 80,
    weather: {
      description: "多云",
      temperatureC: 20,
      windSpeedKmh: 14,
      isDay: true,
      riskLevel: "caution",
      riderAdvice: "保持警觉，留意周围车辆与盲区。"
    },
    turns: [
      { rider: "周围有什么要注意的吗？", agent: "我在帮你盯着前后方和盲区，有危险会立刻提醒。", latencyBase: 96 },
      { rider: "继续。", agent: "好的，保持当前车道，注意车距。", latencyBase: 90 }
    ]
  },
  crash: {
    speedKmh: 0,
    routePhase: "事故演示 — 练习取消与升级",
    network: "online",
    batteryPct: 58,
    weather: {
      description: "多云",
      temperatureC: 24,
      windSpeedKmh: 12,
      isDay: true,
      riskLevel: "critical",
      riderAdvice: "演示：几秒后触发疑似摔车，练习「我没事」取消或等待升级。"
    },
    turns: [
      {
        rider: "刚才发生了什么？",
        agent: "刚才是事故演示。检测到疑似摔车后我会先问你还好吗；你不回应就会拉响警报，最后通知紧急联系人。",
        latencyBase: 320
      }
    ]
  }
};

// Order of scenarios on the guided demo ride: everyday riding first, then the
// hazard-heavy chapters so the demo escalates naturally toward ADAS/emergency.
const GUIDED_TOUR: [DemoScenario, ...DemoScenario[]] = ["commute", "wind", "fuel", "group", "adas", "emergency"];
/** One guided chapter shows ~2 turns at the 6 s conversation cadence. */
const GUIDED_CHAPTER_MS = 14_000;

export function createMockProvider(
  client: WebSocket,
  telemetry?: ProviderTelemetry,
  // Injectable clock for the watch governor's budget/cooldown/adas-window
  // rules, which compare timestamps rather than run on setTimeout — the mock
  // has no other seam for a test to control that math (contrast with the
  // frame assembler's timeout, which vi.useFakeTimers() already covers via
  // its own setTimeout). Defaults to the governor's own Date.now default.
  now?: () => number
): AgentProvider {
  let frameCount = 0;
  let timer: NodeJS.Timeout | undefined;
  let promptIndex = 0;
  let scenario: DemoScenario = "commute";
  let guided = false;
  let guidedTimer: NodeJS.Timeout | undefined;
  // Captured at session.start so the hazard injector can suppress simulated
  // alerts on the embedded board, which detects hazards for real.
  let sessionPlatform: string | undefined;
  let captureNavigationStop: ProviderSessionContext["captureNavigationStop"];
  let guidedStep = 0;
  // True from the moment a scripted turn begins (emitConversation) until its
  // 650 ms reply timer fires — the mock's stand-in for "a rider turn is
  // mid-flight", since the mock has no real ASR/TTS state machine to read.
  let replyPending = false;
  let rideContext: RideContext = {
    mode: "navigation",
    scenario,
    speedKmh: SCENARIOS.commute.speedKmh,
    routePhase: SCENARIOS.commute.routePhase,
    network: SCENARIOS.commute.network,
    batteryPct: SCENARIOS.commute.batteryPct
  };
  let memory: SessionMemory = createSessionMemory("navigation");
  const pendingDeviceCommands = new PendingDeviceCommands();
  const deviceActivity = new DeviceActivityContext();

  // Companion to pendingDeviceCommands, scoped to gallery.describe frame
  // sets — same reasoning as server/providers/doubao.ts's twin: vision.frames
  // chunks all arrive before device.result (wire order), so
  // pendingDeviceCommands.peek() is enough while a set is still assembling —
  // but the frame assembler's 10 s onIncomplete timer can fire after
  // device.result already resolved (deleted) the pending entry. Keeps the
  // action (for the same "issued for this action" guard visionFrames() runs)
  // and the question (authoritative over a chunk's own claimed question)
  // alive from accept time through completion or timeout, then prunes
  // itself — at most one live entry per in-flight gallery command.
  const recentGalleryCommands = new Map<string, { action: DeviceActionName; question?: string }>();

  // Per-session assembler for gallery.describe's multi-frame sets. Mirrors
  // cameraFrame's guard and detached-async shape below.
  const galleryFrameAssembler = createFrameAssembler({
    onComplete: ({ commandId, frames, question }) => {
      const record = recentGalleryCommands.get(commandId);
      recentGalleryCommands.delete(commandId);
      const finalQuestion = record?.question ?? question;
      // Captured now, synchronously — same reasoning as cameraFrame below:
      // freshly allocated per call, not read from a mutable outer binding.
      const delivery = createTranscriptDelivery();
      void (async () => {
        const description = await mockVisionProvider.describe(frames, finalQuestion);
        send(transcriptEvent(delivery, "agent", description ?? "我看不清。", { final: true, useBrowserSpeech: true }));
      })().catch(() => {});
    },
    onIncomplete: (commandId) => {
      recentGalleryCommands.delete(commandId);
      const delivery = createTranscriptDelivery();
      send(transcriptEvent(delivery, "agent", "我看不清。", { final: true, useBrowserSpeech: true }));
    }
  });

  /** "" keeps the relay's own wording; "en" when the wearer's app is in English. */
  let speechLanguage = "";

  function send(original: unknown) {
    if (client.readyState === client.OPEN) {
      const payload = localizeOutgoing(original, speechLanguage);
      const encoded = JSON.stringify(payload);
      telemetry?.serverEvent(payload, Buffer.byteLength(encoded));
      client.send(encoded);
    }
  }

  /** The mock replays scripted rider lines rather than doing ASR, so the same
   *  extractor runs over the script. This is what lets the whole device-action
   *  feature be demonstrated and QA'd with no Doubao credentials. Gated by
   *  sessionPlatform the same way server/providers/doubao.ts is — see
   *  DeviceActivityContext.commandFor's platform gate. */
  function dispatchDeviceCommand(text: string): void {
    const command = deviceActivity.commandFor(text, sessionPlatform);
    if (!command) return;
    const activity = deviceActivity.track(command);
    const issued = pendingDeviceCommands.issue(
      command.action,
      deviceSuccessSpeech(command),
      Date.now(),
      command.action === "camera.look" || command.action === "gallery.describe" ? command.args.question : undefined,
      command.action === "vision.watch" ? command.args.on : undefined,
      activity
    );
    if (command.action === "navigation.stop") issued.onNavigationStopped = captureNavigationStop?.();
    send({
      type: "device.command",
      commandId: issued.commandId,
      action: command.action,
      args: command.args,
      tier: DEVICE_ACTION_TIERS[command.action]
    });
  }

  // The mock has no upstream conversation, so there is nothing to truncate —
  // only the corrective line is sent.
  function applyDeviceReconciliation(
    action: DeviceActionName,
    result: { status: DeviceActionStatus; reason?: string; detail?: string },
    okSpeech?: string
  ): void {
    const decision = reconcileDeviceResult(action, result, okSpeech);
    if (!decision.truncate || !decision.speech) return;
    send(
      transcriptEvent(createTranscriptDelivery(), "agent", decision.speech, { final: true, useBrowserSpeech: true })
    );
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

  // The in-flight turn's staged timeouts, so stopAudio/close can cancel them —
  // an orphaned pair would report "speaking"/"listening" up to 2.15 s after the
  // rider stopped the mic.
  let turnTimers: NodeJS.Timeout[] = [];

  function clearTurnTimers() {
    for (const turnTimer of turnTimers) clearTimeout(turnTimer);
    turnTimers = [];
    replyPending = false;
  }

  // Walks the turn states (hearing → thinking → speaking → listening) so the
  // hands-free HUD can be exercised without Doubao credentials.
  function emitConversation() {
    // The previous turn's timers have fired or are being superseded.
    clearTurnTimers();
    const profile = SCENARIOS[scenario];
    const turn = profile.turns[promptIndex % profile.turns.length] ?? profile.turns[0];
    promptIndex += 1;

    const asrMs = 180 + Math.round(Math.random() * 80);
    const thinkMs = 260 + Math.round(Math.random() * 170);
    const firstAudioMs = turn.latencyBase + Math.round(Math.random() * 55);
    const riderDelivery = createTranscriptDelivery();
    const agentDelivery = createTranscriptDelivery();

    replyPending = true;
    send({ type: "status", state: "hearing", detail: "正在聆听骑手讲话" });
    send(transcriptEvent(riderDelivery, "rider", turn.rider, { final: true }));
    dispatchDeviceCommand(turn.rider);
    memory = updateSessionMemory(memory, turn.rider, rideContext.mode);
    emitMemory();
    send({ type: "status", state: "thinking", detail: "Max 正在思考" });

    turnTimers.push(
      setTimeout(() => {
        replyPending = false;
        send({ type: "status", state: "speaking", detail: "Max 正在回答" });
        send(transcriptEvent(agentDelivery, "agent", turn.agent, { final: true }));
        send({ type: "metric", latencyMs: firstAudioMs });
        send({
          type: "telemetry",
          asrMs,
          thinkMs,
          firstAudioMs,
          // Per-turn total, like the live path — not time since audio.start,
          // which would grow without bound over a long hands-free session.
          totalMs: asrMs + thinkMs + firstAudioMs
        });
        turnTimers.push(
          setTimeout(() => send({ type: "status", state: "listening", detail: "免提待命，请讲话" }), 1500)
        );
      }, 650)
    );
  }

  // Watch-frame governor (V-C): per-session, mirroring every other piece of
  // session state above. describe/speak reuse the same mock vision provider
  // and transcript idiom as cameraFrame/speakGalleryLine below — a FRESH
  // delivery per watch line, since a watch observation belongs to no rider
  // turn. isSpeechOpen mirrors replyPending, set alongside emitConversation's
  // own "hearing"/"speaking" status events above.
  const visionGovernor = createVisionGovernor({
    describe: (frames, question) => mockVisionProvider.describe(frames, question),
    speak: (line) => {
      send(transcriptEvent(createTranscriptDelivery(), "agent", line, { final: true, useBrowserSpeech: true }));
    },
    isSpeechOpen: () => replyPending,
    onDrop: (reason) => metrics.watchDrop(reason),
    now
  });

  // Notes every injected hazard.alert (below) into the watch governor, same
  // as provider.hazardReport does for a board-detected hazard — a simulated
  // ADAS scenario must gate watching exactly like a real one would.
  //
  // CURRENTLY structurally unreachable: hazardInjector.start() (below)
  // unconditionally no-ops when platform() === "embedded" ("the embedded
  // board detects hazards for real" — see hazard-injector.ts), and
  // vision.watch is only ever dispatchable on platform "embedded"
  // (device-actions.ts's PLATFORM_RESTRICTED_ACTIONS). So no session that
  // can ever enable the watch governor can also have this injector firing.
  // Kept wired for when that gate changes, rather than left as a silent gap.
  function sendWithHazardNote(payload: unknown): void {
    if (payload && typeof payload === "object" && (payload as { type?: unknown }).type === "hazard.alert") {
      visionGovernor.noteHazard();
    }
    send(payload);
  }

  // Simulates an ADAS sensor event: the agent interrupts whatever it is saying
  // and announces the directional warning. Cycles through the hazard catalog so
  // a single demo session exercises rear / front / side alerts.
  const hazardInjector = createHazardInjector({
    send: sendWithHazardNote,
    emitRideContext,
    platform: () => sessionPlatform
  });
  const crashSimulator = createCrashSimulator({ send, platform: () => sessionPlatform });

  /** Applies a scenario's profile to the ride context and refreshes the HUD. */
  function enterScenario(next: DemoScenario, announce: boolean) {
    scenario = next;
    const profile = SCENARIOS[next];
    rideContext = {
      mode: rideModeFromScenario(undefined, next),
      scenario: next,
      speedKmh: profile.speedKmh,
      routePhase: profile.routePhase,
      network: profile.network,
      batteryPct: profile.batteryPct
    };
    promptIndex = 0;
    emitRideContext();
    emitWeather();
    if (announce) {
      send({ type: "status", state: "ready", detail: `巡游演示：进入「${scenarioLabel(next)}」场景` });
    }
    // The ADAS chapter fires its alerts fast so the tour shows them; the other
    // chapters keep the hazard channel quiet to leave room for conversation.
    hazardInjector.stop();
    if (scenario === "adas") hazardInjector.start(5000, 1500);
    crashSimulator.stop();
    if (scenario === "crash") crashSimulator.start(6000);
  }

  function stopGuidedTour() {
    if (guidedTimer) clearInterval(guidedTimer);
    guidedTimer = undefined;
  }

  // Auto-advance through GUIDED_TOUR while hands-free audio is running.
  function startGuidedTour() {
    stopGuidedTour();
    guidedStep = 0;
    enterScenario(GUIDED_TOUR[0], true);
    guidedTimer = setInterval(() => {
      guidedStep += 1;
      if (guidedStep >= GUIDED_TOUR.length) {
        guidedStep = 0;
        send({ type: "status", state: "ready", detail: "巡游演示一轮结束，重新开始" });
      }
      enterScenario(GUIDED_TOUR[guidedStep] ?? GUIDED_TOUR[0], true);
    }, GUIDED_CHAPTER_MS);
  }

  return {
    async start(event: SessionStartEvent, context?: ProviderSessionContext) {
      sessionPlatform = event.platform;
      speechLanguage = sessionLanguage(event.language, assistant().languages);
      captureNavigationStop = context?.captureNavigationStop;
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
      // Mirror the live path: a restarting client's memory snapshot survives.
      memory = restoreSessionMemory(event.memory, rideContext.mode);
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
      send({ type: "status", state: "listening", detail: "免提待命，请讲话" });
      emitRideContext();
      emitWeather();
      // Guard against a second audio.start without an intervening audio.stop,
      // which would otherwise orphan the previous interval.
      if (timer) clearInterval(timer);
      timer = setInterval(emitConversation, 6000);
      emitConversation();
      if (guided) {
        startGuidedTour();
        return;
      }
      // The dedicated ADAS scenario showcases the alerts on a fast cadence; other
      // scenarios sprinkle them in occasionally to interrupt mid-conversation.
      const adasDemo = scenario === "adas";
      hazardInjector.start(adasDemo ? 5000 : 11000, adasDemo ? 2000 : 4000);
      // Mirrors the hazard-injector cadence switch above so picking "crash"
      // directly (not just via the guided tour's enterScenario) still fires
      // crash.simulate.
      crashSimulator.stop();
      if (scenario === "crash") crashSimulator.start(6000);
    },
    async sendAudio(chunk: Buffer) {
      frameCount += 1;
      if (frameCount % 24 === 0) {
        send({ type: "metric", latencyMs: 88 + Math.round(Math.random() * 85) });
      }
      void chunk;
    },
    async deviceResult(event) {
      const receivedAt = Date.now();
      const issued = pendingDeviceCommands.resolve(event.commandId, receivedAt);
      for (const expired of pendingDeviceCommands.expire(receivedAt)) {
        deviceActivity.reconcile(expired.activity, { status: "failed", reason: "timeout" });
        applyDeviceReconciliation(expired.action, { status: "failed", reason: "timeout" });
      }
      if (!issued) return;
      deviceActivity.reconcile(issued.activity, event);
      if (issued.action === "navigation.stop" && (event.status === "ok" || event.reason === "navigation.notActive")) {
        issued.onNavigationStopped?.();
      }
      if (issued.action === "vision.watch" && event.status === "ok") {
        visionGovernor.setEnabled(issued.watchOn === true);
      }
      applyDeviceReconciliation(issued.action, event, issued.okSpeech);
    },
    async hazardReport() {
      visionGovernor.noteHazard();
    },
    async cameraFrame(event) {
      // Mirrors doubao.ts's guard exactly: only describe a frame that
      // answers a camera.look this relay actually issued. Peek — never
      // resolve/consume — so the later device.result for the same
      // commandId still has an entry to resolve. An unrecognised or
      // wrong-action commandId is ignored quietly.
      const issued = pendingDeviceCommands.peek(event.commandId);
      if (!issued || issued.action !== "camera.look") return;

      // Captured now, synchronously — same reasoning as doubao.ts's
      // cameraFrame, even though nothing here can go stale: unlike doubao's
      // per-session agentDelivery, this delivery is freshly allocated per
      // call, not read from a mutable outer binding a later turn could reassign.
      const delivery = createTranscriptDelivery();

      // Detached from the caller for the same reason as doubao.ts: the
      // message queue that awaits this method also carries mic PCM and
      // audio.stop, and must not stall behind a vision call. The mock's
      // describe() never actually blocks or throws (see server/vision.ts),
      // but this stays symmetric with the live path's contract rather than
      // assuming that will always hold.
      void (async () => {
        const description = await mockVisionProvider.describe([event.image], issued.question);
        send(transcriptEvent(delivery, "agent", description ?? "我看不清。", { final: true, useBrowserSpeech: true }));
      })().catch(() => {});
    },
    async visionFrames(event) {
      // Branch on reason FIRST. Watch frames (V-C) are unsolicited and carry
      // no commandId — handed to the governor fire-and-forget so a stalled
      // (or gated) describe can never stall the caller's message queue. The
      // `.catch` is a backstop; handleWatchFrame's own try/finally already
      // keeps every rule branch synchronous-safe (see vision-governor.ts).
      if (event.reason === "watch") {
        void visionGovernor.handleWatchFrame(event.image).catch(() => {});
        return;
      }
      // Gallery path (V-B), unchanged. Narrows event.commandId to string for
      // the rest of this function.
      if (!event.commandId) return;
      // Same guard shape as cameraFrame, plus the recentGalleryCommands
      // fallback declared above: a stray extra chunk can arrive after
      // device.result already resolved (deleted) the pending entry, and this
      // keeps recognising it as long as this provider itself opened the set.
      const issued = pendingDeviceCommands.peek(event.commandId) ?? recentGalleryCommands.get(event.commandId);
      if (!issued || issued.action !== "gallery.describe") return;
      if (!recentGalleryCommands.has(event.commandId)) {
        recentGalleryCommands.set(event.commandId, { action: issued.action, question: issued.question });
      }
      galleryFrameAssembler.accept(event);
    },
    async stopAudio() {
      if (timer) clearInterval(timer);
      timer = undefined;
      clearTurnTimers();
      stopGuidedTour();
      hazardInjector.stop();
      crashSimulator.stop();
      send({ type: "status", state: "ready", detail: "免提已暂停" });
    },
    async setGuidedDemo(enabled: boolean) {
      guided = enabled;
      if (!enabled) {
        stopGuidedTour();
        // The tour's ADAS chapter runs the injector on a fast cadence; turning
        // the tour off must not leave it firing. If hands-free audio is still
        // running, fall back to the normal per-scenario cadence.
        hazardInjector.stop();
        if (timer) {
          const adasDemo = scenario === "adas";
          hazardInjector.start(adasDemo ? 5000 : 11000, adasDemo ? 2000 : 4000);
        }
        // Mirrors the hazard-injector fallback above for the crash simulator.
        crashSimulator.stop();
        if (timer && scenario === "crash") crashSimulator.start(6000);
        send({ type: "status", state: "ready", detail: "巡游演示已关闭" });
        return;
      }
      // Audio already running → start touring immediately; otherwise the tour
      // begins on the next startAudio.
      if (timer) startGuidedTour();
      else send({ type: "status", state: "ready", detail: "巡游演示已开启，开启免提后自动巡游场景" });
    },
    async close() {
      if (timer) clearInterval(timer);
      clearTurnTimers();
      stopGuidedTour();
      hazardInjector.stop();
      crashSimulator.stop();
    },
    attachNavOkSpeech(speech: string) {
      pendingDeviceCommands.attachOkSpeech("navigation.start", speech);
    },
    speakNavLine(text: string) {
      send(transcriptEvent(createTranscriptDelivery(), "agent", text, { final: true, useBrowserSpeech: true }));
    },
    speakNavPrompt(speech) {
      send(transcriptEvent(createTranscriptDelivery(), "agent", speech.text, { final: true, useBrowserSpeech: true }));
    }
  };
}
