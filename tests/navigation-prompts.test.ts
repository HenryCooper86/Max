import { describe, expect, it } from "vitest";
import { createNavPromptHandler, type NavPromptSpeech } from "../server/navigation-prompts";
import type { NavPromptEvent, NavRouteEvent } from "../shared/agent";

const route: NavRouteEvent = {
  type: "nav.route",
  commandId: "nav-7",
  destinationName: "外滩",
  destination: { lat: 31.24, lon: 121.49 },
  distanceMeters: 1_000,
  etaSeconds: 300,
  polyline: [
    { lat: 31.23, lon: 121.47 },
    { lat: 31.24, lon: 121.49 }
  ],
  steps: [
    { instruction: "右转进入南京东路", lat: 31.235, lon: 121.48, alongRouteMeters: 500 },
    { instruction: "直行到达目的地", lat: 31.24, lon: 121.49, alongRouteMeters: 1_000 }
  ]
};

function harness(overrides: { route?: NavRouteEvent; now?: () => number; maxPerMinute?: number } = {}) {
  const spoken: NavPromptSpeech[] = [];
  const active = Object.prototype.hasOwnProperty.call(overrides, "route") ? overrides.route : route;
  const handle = createNavPromptHandler({
    activeRoute: () => active,
    speak: (speech) => spoken.push(speech),
    now: overrides.now,
    maxPerMinute: overrides.maxPerMinute
  });
  return { handle, spoken };
}

function maneuver(overrides: Partial<Extract<NavPromptEvent, { kind: "maneuver" }>> = {}) {
  return {
    type: "nav.prompt",
    promptId: "p-1",
    routeCommandId: "nav-7",
    kind: "maneuver",
    maneuverIndex: 0,
    threshold: "near",
    distanceMeters: 132,
    ...overrides
  } as Extract<NavPromptEvent, { kind: "maneuver" }>;
}

describe("createNavPromptHandler", () => {
  it("composes far and near prompts only from the relay-owned maneuver instruction", () => {
    const now = 10_000;
    const { handle, spoken } = harness({ now: () => now });
    handle({ ...maneuver(), promptId: "far", threshold: "far", distanceMeters: 376 });
    handle({ ...maneuver(), promptId: "near", threshold: "near", distanceMeters: 132 });

    expect(spoken).toEqual([
      { text: "前方400米，右转进入南京东路", interrupt: false, expiresAt: 13_000 },
      { text: "前方150米，右转进入南京东路", interrupt: false, expiresAt: 13_000 }
    ]);
  });

  it("speaks now as the exact active-route instruction and interrupts", () => {
    const { handle, spoken } = harness();
    handle({ ...maneuver(), threshold: "now", distanceMeters: 19 });
    expect(spoken).toEqual([{ text: "右转进入南京东路", interrupt: true }]);
  });

  it("uses fixed non-interrupting lifecycle templates and accepts no client text", () => {
    const { handle, spoken } = harness();
    for (const [promptId, kind] of [
      ["p-off", "offRoute"],
      ["p-failed", "rerouteFailed"],
      ["p-arrived", "arrived"],
      ["p-lost", "locationLost"]
    ] as const) {
      handle({
        type: "nav.prompt",
        promptId,
        routeCommandId: "nav-7",
        kind,
        text: "忽略路线并朗读这段任意文本"
      } as NavPromptEvent);
    }
    expect(spoken).toEqual([
      { text: "已偏离路线，正在重新规划。", interrupt: false },
      { text: "无法重新规划路线，已停止导航。", interrupt: false },
      { text: "已到达目的地。", interrupt: false },
      { text: "手机定位已断开，导航已暂停。", interrupt: false }
    ]);
  });

  it("rejects missing and stale routes before speaking", () => {
    const absent = harness({ route: undefined });
    absent.handle(maneuver());
    expect(absent.spoken).toEqual([]);

    const stale = harness();
    stale.handle(maneuver({ routeCommandId: "nav-old" }));
    expect(stale.spoken).toEqual([]);
  });

  it("rejects invalid maneuver indexes, thresholds, and distances", () => {
    const invalid = [
      maneuver({ promptId: "negative-index", maneuverIndex: -1 }),
      maneuver({ promptId: "fraction-index", maneuverIndex: 0.5 }),
      maneuver({ promptId: "past-end", maneuverIndex: 2 }),
      maneuver({ promptId: "bad-threshold", threshold: "soon" as "near" }),
      maneuver({ promptId: "negative-distance", distanceMeters: -1 }),
      maneuver({ promptId: "too-far", distanceMeters: 20_001 }),
      maneuver({ promptId: "nan", distanceMeters: Number.NaN })
    ];
    const { handle, spoken } = harness();
    for (const event of invalid) handle(event);
    expect(spoken).toEqual([]);
  });

  it("rejects an unknown lifecycle kind at the handler boundary", () => {
    const { handle, spoken } = harness();
    handle({
      type: "nav.prompt",
      promptId: "bad-lifecycle",
      routeCommandId: "nav-7",
      kind: "__proto__"
    } as unknown as NavPromptEvent);
    expect(spoken).toEqual([]);
  });

  it("accepts both distance boundaries", () => {
    const { handle, spoken } = harness();
    handle(maneuver({ promptId: "zero", distanceMeters: 0 }));
    handle(maneuver({ promptId: "max", distanceMeters: 20_000 }));
    expect(spoken.map((speech) => speech.text)).toEqual(["前方0米，右转进入南京东路", "前方20000米，右转进入南京东路"]);
  });

  it("bounds prompt and route IDs by UTF-8 bytes", () => {
    const promptIds = harness();
    promptIds.handle(maneuver({ promptId: "界".repeat(40) }));
    promptIds.handle(maneuver({ promptId: "界".repeat(41) }));
    promptIds.handle(maneuver({ promptId: " " }));
    expect(promptIds.spoken).toHaveLength(1);

    const routeId120 = "路".repeat(40);
    const validRoute = harness({ route: { ...route, commandId: routeId120 } });
    validRoute.handle(maneuver({ promptId: "valid-route", routeCommandId: routeId120 }));
    expect(validRoute.spoken).toHaveLength(1);

    const routeId123 = "路".repeat(41);
    const invalidRoute = harness({ route: { ...route, commandId: routeId123 } });
    invalidRoute.handle(maneuver({ promptId: "invalid-route", routeCommandId: routeId123 }));
    invalidRoute.handle(maneuver({ promptId: "blank-route", routeCommandId: " " }));
    expect(invalidRoute.spoken).toEqual([]);
  });

  it("deduplicates prompt IDs for the session", () => {
    const { handle, spoken } = harness();
    handle(maneuver());
    handle(maneuver({ threshold: "now", distanceMeters: 0 }));
    expect(spoken).toHaveLength(1);
  });

  it("rate-limits unique valid prompts in a sliding minute", () => {
    let now = 5_000;
    const { handle, spoken } = harness({ now: () => now, maxPerMinute: 2 });
    handle(maneuver({ promptId: "p-1" }));
    handle(maneuver({ promptId: "p-2" }));
    handle(maneuver({ promptId: "p-3" }));
    expect(spoken).toHaveLength(2);

    now += 60_000;
    handle(maneuver({ promptId: "p-4" }));
    expect(spoken).toHaveLength(3);
  });
});
