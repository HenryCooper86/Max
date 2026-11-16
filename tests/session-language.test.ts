import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_CAPABILITIES } from "../shared/agent";
import { assistantProfileFrom, setAssistantProfileForTests } from "../server/assistant";
import {
  deviceFailureSpeech,
  deviceSuccessSpeech,
  navRouteOkSpeech,
  REROUTE_OK_SPEECH
} from "../server/device-actions";
import { createLogger } from "../server/logger";
import { baseLanguage, buildSessionLanguagePrompt, sessionLanguage } from "../server/prompts";
import type { EngineConfig, EngineEvents, VoiceEngine } from "../server/providers/live/engine";
import { buildLiveInstructions, createLiveProvider } from "../server/providers/live/session";
import { localizeOutgoing, relaySpeech, translateInstruction } from "../server/relay-speech";
import { ADAS_SCENARIOS } from "../shared/adas";
import type { NavRouteEvent } from "../shared/agent";
import { INITIAL_PROGRESS, step } from "../shared/guidance";
import { MOCK_ROUTE } from "../shared/nav-fixtures";
import { createSessionMemory } from "../shared/session";

afterEach(() => setAssistantProfileForTests());

describe("session language", () => {
  it("follows the app's language only when the assistant speaks it and it is not already the default", () => {
    expect(sessionLanguage("en", ["zh", "en"])).toBe("en");
    expect(sessionLanguage("en-US", ["zh", "en"])).toBe("en");
    expect(sessionLanguage("zh", ["zh", "en"])).toBe("");
    expect(sessionLanguage("zh-Hans", ["zh", "en"])).toBe("");
    expect(sessionLanguage("fr", ["zh", "en"])).toBe("");
    expect(sessionLanguage("zh", ["en", "zh"])).toBe("zh");
    expect(sessionLanguage(undefined, ["zh", "en"])).toBe("");
    expect(sessionLanguage("not a tag!", ["zh", "en"])).toBe("");
    expect(baseLanguage("EN_gb")).toBe("en");
  });

  it("tells the model to answer in English, overriding the default-language rule", () => {
    const rule = buildSessionLanguagePrompt("en", ["zh", "en"]);
    expect(rule).toContain("Answer in English by default");
    expect(rule).toContain("优先于上面的默认语言规则");
    expect(buildSessionLanguagePrompt("zh", ["zh", "en"])).toBe("");

    const base = {
      rideContext: { mode: "ride", scenario: "commute" } as const,
      memory: createSessionMemory("ride"),
      weatherRole: "",
      locationRole: "",
      wakeWord: true
    };
    const english = buildLiveInstructions({
      ...base,
      event: { type: "session.start", sampleRate: 16000, channels: 1, language: "en" }
    });
    const chinese = buildLiveInstructions({
      ...base,
      event: { type: "session.start", sampleRate: 16000, channels: 1 }
    });
    // The session rule comes after Max's stock rule, which names Chinese as the default.
    expect(english.indexOf("[Session language]")).toBeGreaterThan(english.indexOf("[语言与交互规则]"));
    expect(chinese).not.toContain("[Session language]");
  });

  it("does not switch an assistant that does not speak the app's language", () => {
    setAssistantProfileForTests(assistantProfileFrom({ name: "小飞", languages: ["zh"] }));
    expect(buildSessionLanguagePrompt("en", ["zh"])).toBe("");
  });
});

describe("relay-spoken lines in English", () => {
  it("translates every device outcome the relay can speak", () => {
    const failures = [
      "permission.contacts",
      "device.locked",
      "unsafe.speed",
      "music.emptyQueue",
      "destination.notFound",
      "route.unavailable",
      "torch.unavailable",
      "permission.camera",
      "storage.full",
      "navigation.notActive",
      "permission.location",
      "gallery.empty",
      "device.noScreen",
      "navigation.cancelled",
      "location.unavailable"
    ];
    for (const reason of failures) {
      const zh = deviceFailureSpeech("torch.set", "failed", reason);
      const en = relaySpeech(zh, "en");
      expect(en, reason).not.toBe(zh);
      expect(en, reason).not.toMatch(/\p{Script=Han}/u);
    }
    // An unknown reason falls back to "<action> didn't work".
    expect(relaySpeech(deviceFailureSpeech("camera.photo", "failed", "mystery"), "en")).toBe("The photo didn't work.");
    expect(relaySpeech(deviceFailureSpeech("navigation.start", "failed", undefined), "en")).toBe(
      "Navigation didn't work."
    );

    const successes = [
      deviceSuccessSpeech({ action: "torch.set", args: { on: true } } as never),
      deviceSuccessSpeech({ action: "camera.photo", args: {} } as never),
      deviceSuccessSpeech({ action: "music.control", args: { control: "next" } } as never),
      deviceSuccessSpeech({ action: "system.shutdown", args: { cancel: false } } as never),
      REROUTE_OK_SPEECH,
      "我看不清。"
    ];
    for (const zh of successes) {
      expect(zh).toBeTruthy();
      expect(relaySpeech(zh!, "en")).not.toMatch(/\p{Script=Han}/u);
    }
  });

  it("translates the navigation summary around the place name", () => {
    expect(relaySpeech(navRouteOkSpeech("人民广场", 3200, 540), "en")).toBe(
      "Found 人民广场. 3.2 km, about 9 minutes. Treat it as a guide and watch the road."
    );
    expect(relaySpeech(navRouteOkSpeech("The Bund", 12_400, 60), "en")).toContain("12 km, about 1 minute.");
  });

  it("leaves Chinese sessions, model replies and client details alone", () => {
    expect(relaySpeech("手电筒开了。", "")).toBe("手电筒开了。");
    expect(relaySpeech("前方 1.4 公里轻微拥堵。", "en")).toBe("前方 1.4 公里轻微拥堵。");
    const spoken = { type: "transcript", speaker: "agent", text: "手电筒开了。", final: true, useBrowserSpeech: true };
    expect(localizeOutgoing(spoken, "en")).toEqual({ ...spoken, text: "Torch on." });
    expect(localizeOutgoing(spoken, "")).toBe(spoken);
    // Not a relay-spoken line: a rider transcript, or an assistant reply with real audio.
    const rider = { ...spoken, speaker: "rider" };
    const withAudio = { ...spoken, useBrowserSpeech: false };
    expect(localizeOutgoing(rider, "en")).toBe(rider);
    expect(localizeOutgoing(withAudio, "en")).toBe(withAudio);
    expect(localizeOutgoing({ type: "status", state: "ready", detail: "手电筒开了。" }, "en")).toMatchObject({
      detail: "手电筒开了。"
    });
  });
});

describe("an English session end to end", () => {
  class FakeClient {
    OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    json: Array<Record<string, unknown>> = [];
    send(data: string | Buffer) {
      if (typeof data === "string") this.json.push(JSON.parse(data) as Record<string, unknown>);
    }
    close() {
      this.readyState = 3;
    }
  }

  it("instructs the backend in English and speaks device outcomes in English", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    let config: EngineConfig | undefined;
    let events: EngineEvents | undefined;
    const engine: VoiceEngine = {
      responseMode: "manual-capable",
      async connect(engineConfig, engineEvents) {
        config = engineConfig;
        events = engineEvents;
      },
      sendAudio() {},
      respond() {},
      cancel() {},
      close() {}
    };
    const provider = createLiveProvider(
      client as never,
      { id: "openai", label: "Test", capabilities: LIVE_CAPABILITIES, createEngine: () => engine },
      createLogger("test"),
      { serverEvent: vi.fn(), serverAudio: vi.fn(), ttsFallback: vi.fn() },
      { wakeWord: false, fetchWeather: async () => Promise.reject(new Error("offline")) }
    );
    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, language: "en", platform: "ios" });
    await provider.startAudio();
    expect(config?.instructions).toContain("Answer in English by default");
    expect(client.json.find((event) => event.type === "session.memory")).toMatchObject({ language: "en" });

    events!.onSpeechStarted();
    events!.onRiderTranscript("Max, turn on the torch", true);
    const command = client.json.find((event) => event.type === "device.command")!;
    expect(command.action).toBe("torch.set");
    await provider.deviceResult?.({
      type: "device.result",
      commandId: command.commandId as string,
      status: "failed",
      reason: "torch.unavailable"
    });
    const spoken = client.json.filter((event) => event.type === "transcript" && event.speaker === "agent").at(-1)!;
    expect(spoken.text).toBe("This device doesn't have a torch I can use.");
    await provider.close();
    vi.useRealTimers();
  });
});

describe("navigation and hazards in English", () => {
  it("translates routing instructions and leaves names and unknown shapes alone", () => {
    const cases: Array<[string, string]> = [
      ["右转进入南京东路", "Turn right onto 南京东路"],
      ["左转", "Turn left"],
      ["到达终点", "Arrive at your destination"],
      ["到达目的地附近", "Arrive at your destination"],
      ["向东北行驶140米左转", "Head north-east for 140 m, then turn left"],
      ["沿人民大道向西行驶1.2公里右转进入西藏中路", "Head west on 人民大道 for 1.2 km, then turn right onto 西藏中路"],
      ["沿中山东一路向北行驶180米", "Head north on 中山东一路 for 180 m"],
      ["沿延安高架路行驶3公里靠右", "Continue on 延安高架路 for 3 km, then keep right"],
      ["向南行驶500米到达目的地", "Head south for 500 m, then arrive at your destination"],
      ["向左前方行驶进入内环高架", "Bear left onto 内环高架"],
      ["左转调头", "Make a U-turn"],
      ["直行进入环岛", "Continue straight into the roundabout"],
      ["右转进入匝道", "Turn right onto the ramp"],
      ["乘坐轮渡过江", "乘坐轮渡过江"],
      ["Turn left onto Main St", "Turn left onto Main St"]
    ];
    for (const [zh, en] of cases) expect(translateInstruction(zh), zh).toBe(en);
  });

  it("translates the prompts the relay composes around them", () => {
    expect(relaySpeech("前方200米，右转进入南京东路", "en")).toBe("In 200 metres, turn right onto 南京东路");
    expect(relaySpeech("右转进入南京东路", "en")).toBe("Turn right onto 南京东路");
    expect(relaySpeech("已偏离路线，正在重新规划。", "en")).toBe("You're off the route. Recalculating.");
    expect(relaySpeech("已到达目的地。", "en")).toBe("You have arrived.");
    expect(relaySpeech("手机定位已断开，导航已暂停。", "en")).toMatch(/paused/);
    expect(relaySpeech("无法重新规划路线，已停止导航。", "en")).toMatch(/stopped/);
    expect(relaySpeech("请确认目的地：外滩。请说“确认导航”或点击确认，确认后开始逐向导航。", "en")).toBe(
      "Confirm the destination: 外滩. Say “确认导航” or tap Confirm to start turn-by-turn guidance."
    );
    // An instruction it cannot translate keeps the whole prompt in Chinese rather than half of it.
    expect(relaySpeech("前方200米，乘坐轮渡过江", "en")).toBe("前方200米，乘坐轮渡过江");
    expect(relaySpeech("前方200米，右转进入南京东路", "")).toBe("前方200米，右转进入南京东路");
  });

  it("adds English beside each route instruction without touching the original", () => {
    const route = {
      type: "nav.route",
      commandId: "c1",
      steps: [
        { instruction: "右转进入南京东路", lat: 1, lon: 2, alongRouteMeters: 600 },
        { instruction: "乘坐轮渡过江", lat: 1, lon: 2, alongRouteMeters: 900 },
        { instruction: "到达终点", lat: 1, lon: 2, alongRouteMeters: 1000 }
      ]
    };
    const english = localizeOutgoing(route, "en") as typeof route & { steps: Array<Record<string, unknown>> };
    expect(english.steps[0]).toEqual({ ...route.steps[0], localizedInstruction: "Turn right onto 南京东路" });
    expect(english.steps[1]).toEqual(route.steps[1]);
    expect(english.steps[2]!.localizedInstruction).toBe("Arrive at your destination");
    expect(route.steps[0]).not.toHaveProperty("localizedInstruction");
    expect(localizeOutgoing(route, "")).toBe(route);
  });

  it("translates every hazard in the catalog", () => {
    for (const scenario of ADAS_SCENARIOS) {
      const event = { type: "hazard.alert", ...scenario, interrupt: true };
      const english = localizeOutgoing(event, "en") as typeof event;
      for (const key of ["label", "message", "advice"] as const) {
        expect(english[key], `${scenario.threat} ${key}`).not.toMatch(/\p{Script=Han}/u);
        expect(english[key]).not.toBe(scenario[key]);
      }
      // Everything a client keys behaviour on is untouched.
      expect(english).toMatchObject({
        threat: scenario.threat,
        direction: scenario.direction,
        severity: scenario.severity
      });
      expect(localizeOutgoing(event, "")).toBe(event);
    }
  });

  it("speaks the localized instruction in the client guidance engine", () => {
    const route: NavRouteEvent = {
      type: "nav.route",
      commandId: "c1",
      destinationName: "外滩",
      destination: MOCK_ROUTE.polyline.at(-1)!,
      distanceMeters: MOCK_ROUTE.distanceMeters,
      etaSeconds: MOCK_ROUTE.etaSeconds,
      polyline: MOCK_ROUTE.polyline,
      steps: MOCK_ROUTE.steps
    };
    const walk = (planned: NavRouteEvent) => {
      const prompts: string[] = [];
      let progress = INITIAL_PROGRESS;
      // Walk the polyline in small strides; the engine speaks as thresholds come due.
      for (let leg = 0; leg < planned.polyline.length - 1; leg += 1) {
        const from = planned.polyline[leg]!;
        const to = planned.polyline[leg + 1]!;
        for (let part = 0; part < 8; part += 1) {
          const t = part / 8;
          const update = step(
            { lat: from.lat + (to.lat - from.lat) * t, lon: from.lon + (to.lon - from.lon) * t },
            planned,
            progress
          );
          progress = update.progress;
          if (update.spokenPrompt) prompts.push(update.spokenPrompt);
        }
      }
      return prompts;
    };

    const chinese = walk(route);
    expect(chinese.some((prompt) => /^前方\d+米，右转进入南京东路$/u.test(prompt))).toBe(true);

    const english = walk(localizeOutgoing(route, "en"));
    expect(english.length).toBe(chinese.length);
    expect(english.some((prompt) => /^In \d+ metres, turn right onto 南京东路$/u.test(prompt))).toBe(true);
    expect(english.every((prompt) => !/前方\d+米/u.test(prompt))).toBe(true);
  });
});
