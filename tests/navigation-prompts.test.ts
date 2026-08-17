import { describe, expect, it, vi } from "vitest";
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

function harness(
  overrides: {
    route?: NavRouteEvent;
    activeRoute?: () => NavRouteEvent | undefined;
    clearRoute?: () => void;
    now?: () => number;
    maxPerMinute?: number;
  } = {}
) {
  const spoken: NavPromptSpeech[] = [];
  const active = Object.prototype.hasOwnProperty.call(overrides, "route") ? overrides.route : route;
  const handle = createNavPromptHandler({
    activeRoute: overrides.activeRoute ?? (() => active),
    speak: (speech) => spoken.push(speech),
    clearRoute: overrides.clearRoute,
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

  it("deduplicates prompt IDs for the active route", () => {
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

  it("does not consume a rate-rejected prompt ID before that ID can be retried", () => {
    let now = 0;
    const { handle, spoken } = harness({ now: () => now, maxPerMinute: 1 });
    handle({ type: "nav.prompt", promptId: "p-1", routeCommandId: "nav-7", kind: "arrived" });
    handle({ type: "nav.prompt", promptId: "p-2", routeCommandId: "nav-7", kind: "offRoute" });
    expect(spoken).toHaveLength(1);

    now = 60_000;
    handle({ type: "nav.prompt", promptId: "p-2", routeCommandId: "nav-7", kind: "offRoute" });
    expect(spoken.map((speech) => speech.text)).toEqual(["已到达目的地。", "已偏离路线，正在重新规划。"]);
  });

  it("invalid, stale, and duplicate events consume neither prompt IDs nor rate budget", () => {
    const invalid = harness({ maxPerMinute: 1 });
    invalid.handle(maneuver({ promptId: "reusable", distanceMeters: -1 }));
    invalid.handle(maneuver({ promptId: "reusable", distanceMeters: 50 }));
    expect(invalid.spoken).toHaveLength(1);

    const stale = harness({ maxPerMinute: 1 });
    stale.handle(maneuver({ promptId: "reusable", routeCommandId: "nav-old" }));
    stale.handle(maneuver({ promptId: "reusable" }));
    expect(stale.spoken).toHaveLength(1);

    const duplicate = harness({ maxPerMinute: 2 });
    duplicate.handle(maneuver({ promptId: "p-1" }));
    duplicate.handle(maneuver({ promptId: "p-1" }));
    duplicate.handle(maneuver({ promptId: "p-2" }));
    expect(duplicate.spoken).toHaveLength(2);
  });

  it("keeps the per-session rate budget exhausted when the active route command changes", () => {
    let active = route;
    const { handle, spoken } = harness({ activeRoute: () => active, maxPerMinute: 1 });
    handle({ type: "nav.prompt", promptId: "r1-prompt", routeCommandId: "nav-7", kind: "arrived" });
    active = { ...route, commandId: "nav-8" };
    handle({ type: "nav.prompt", promptId: "r2-prompt", routeCommandId: "nav-8", kind: "offRoute" });
    expect(spoken).toHaveLength(1);
  });

  it("allows a prompt ID to be reused on a new route while session capacity remains", () => {
    let active = route;
    const { handle, spoken } = harness({ activeRoute: () => active, maxPerMinute: 2 });
    handle({ type: "nav.prompt", promptId: "same-id", routeCommandId: "nav-7", kind: "arrived" });
    active = { ...route, commandId: "nav-8" };
    handle({ type: "nav.prompt", promptId: "same-id", routeCommandId: "nav-8", kind: "offRoute" });
    expect(spoken).toHaveLength(2);
  });

  it("retries a rate-rejected new-route prompt ID at exactly one minute", () => {
    let active = route;
    let now = 0;
    const { handle, spoken } = harness({ activeRoute: () => active, now: () => now, maxPerMinute: 1 });
    handle({ type: "nav.prompt", promptId: "r1-prompt", routeCommandId: "nav-7", kind: "arrived" });
    active = { ...route, commandId: "nav-8" };
    handle({ type: "nav.prompt", promptId: "r2-prompt", routeCommandId: "nav-8", kind: "offRoute" });
    expect(spoken).toHaveLength(1);

    now = 60_000;
    handle({ type: "nav.prompt", promptId: "r2-prompt", routeCommandId: "nav-8", kind: "offRoute" });
    expect(spoken).toHaveLength(2);
  });

  it("bounds retained prompt IDs for a long-running route", () => {
    const { handle, spoken } = harness({ maxPerMinute: 1_000 });
    for (let index = 0; index < 257; index += 1) {
      handle({ type: "nav.prompt", promptId: `p-${index}`, routeCommandId: "nav-7", kind: "arrived" });
    }
    handle({ type: "nav.prompt", promptId: "p-0", routeCommandId: "nav-7", kind: "arrived" });
    expect(spoken).toHaveLength(258);
  });

  describe("clearRoute", () => {
    // Whole-branch-review finding: routeActive() (server/routing.ts's
    // lastRoute) was cleared only by a fresh "start" request, so it read
    // stale-true for the rest of the session after any route that ended by
    // arrival or by giving up — the fabrication guard's honest line would
    // then promise a nav prompt that was never coming again.
    it("clears the route on arrived", () => {
      const cleared = vi.fn();
      const { handle } = harness({ clearRoute: cleared });
      handle({ type: "nav.prompt", promptId: "p-1", routeCommandId: "nav-7", kind: "arrived" });
      expect(cleared).toHaveBeenCalledTimes(1);
    });

    it("clears the route on rerouteFailed", () => {
      const cleared = vi.fn();
      const { handle } = harness({ clearRoute: cleared });
      handle({ type: "nav.prompt", promptId: "p-1", routeCommandId: "nav-7", kind: "rerouteFailed" });
      expect(cleared).toHaveBeenCalledTimes(1);
    });

    it("does NOT clear the route on offRoute, locationLost, or a maneuver prompt", () => {
      const cleared = vi.fn();
      const { handle } = harness({ clearRoute: cleared });
      handle({ type: "nav.prompt", promptId: "p-1", routeCommandId: "nav-7", kind: "offRoute" });
      handle({ type: "nav.prompt", promptId: "p-2", routeCommandId: "nav-7", kind: "locationLost" });
      handle(maneuver({ promptId: "p-3" }));
      expect(cleared).not.toHaveBeenCalled();
    });

    it("does not clear the route for a stale or invalid arrived event", () => {
      const cleared = vi.fn();
      const stale = harness({ clearRoute: cleared });
      stale.handle({ type: "nav.prompt", promptId: "p-1", routeCommandId: "nav-old", kind: "arrived" });
      expect(cleared).not.toHaveBeenCalled();

      const invalidId = harness({ clearRoute: cleared });
      invalidId.handle({ type: "nav.prompt", promptId: " ", routeCommandId: "nav-7", kind: "arrived" });
      expect(cleared).not.toHaveBeenCalled();
    });

    it("omitting clearRoute changes nothing about an arrived prompt still being spoken", () => {
      const { handle, spoken } = harness();
      handle({ type: "nav.prompt", promptId: "p-1", routeCommandId: "nav-7", kind: "arrived" });
      expect(spoken).toEqual([{ text: "已到达目的地。", interrupt: false }]);
    });
  });
});
