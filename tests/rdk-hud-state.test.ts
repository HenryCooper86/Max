import { describe, expect, it } from "vitest";
import type { RdkNavigationSnapshot } from "../rdk/agent/src/navigation/controller";
import {
  HUD_TRANSCRIPT_LIMIT,
  initialHudState,
  reduceHud,
  type HudCompanion,
  type HudEvent
} from "../rdk/agent/src/hud/state";

function navigation(overrides: Partial<RdkNavigationSnapshot> = {}): RdkNavigationSnapshot {
  return {
    phase: "guiding",
    destinationName: "人民广场",
    instruction: "前方右转",
    distanceToManeuverMeters: 180,
    remainingMeters: 3_200,
    remainingSeconds: 720,
    offRoute: false,
    location: { connection: "sharing", usable: true, horizontalAccuracyMeters: 8, ageMs: 400 },
    ...overrides
  };
}

describe("reduceHud", () => {
  it("starts with exact offline, unpaired, and empty navigation truth", () => {
    expect(initialHudState()).toEqual({
      connection: "offline",
      turnState: "idle",
      transcript: [],
      latencyMs: null,
      lastError: null,
      companion: { paired: false, locationState: "unpaired" },
      navigation: null,
      route: null,
      discovery: "off"
    });
  });

  it("tracks connection state", () => {
    const state = reduceHud(initialHudState(), { type: "connection", state: "ready", detail: "" });
    expect(state.connection).toBe("ready");
  });

  it("tracks turn state from status events", () => {
    const state = reduceHud(initialHudState(), { type: "status", state: "thinking", detail: "" });
    expect(state.turnState).toBe("thinking");
  });

  it("appends a new transcript turn", () => {
    const state = reduceHud(initialHudState(), {
      type: "transcript",
      turnId: "t1",
      deliveryId: "d1",
      speaker: "rider",
      text: "你好",
      final: false
    });
    expect(state.transcript).toEqual([{ speaker: "rider", text: "你好", final: false, turnId: "t1" }]);
  });

  it("updates a partial turn in place rather than duplicating it", () => {
    let state = reduceHud(initialHudState(), {
      type: "transcript",
      turnId: "t1",
      deliveryId: "d1",
      speaker: "agent",
      text: "今天",
      final: false
    });
    state = reduceHud(state, {
      type: "transcript",
      turnId: "t1",
      deliveryId: "d1",
      speaker: "agent",
      text: "今天天气不错",
      final: true
    });
    expect(state.transcript).toEqual([{ speaker: "agent", text: "今天天气不错", final: true, turnId: "t1" }]);
  });

  it("caps the transcript at the most recent turns instead of growing for the life of the process", () => {
    let state = initialHudState();
    for (let turn = 0; turn < HUD_TRANSCRIPT_LIMIT + 10; turn += 1) {
      state = reduceHud(state, {
        type: "transcript",
        turnId: `t${turn}`,
        deliveryId: `d${turn}`,
        speaker: "rider",
        text: `第${turn}句`,
        final: true
      });
    }
    expect(state.transcript).toHaveLength(HUD_TRANSCRIPT_LIMIT);
    // The oldest ten fell off the front; the newest is still last.
    expect(state.transcript[0]?.turnId).toBe("t10");
    expect(state.transcript.at(-1)?.turnId).toBe(`t${HUD_TRANSCRIPT_LIMIT + 9}`);
  });

  it("updates a retained turn in place at the cap rather than evicting it", () => {
    let state = initialHudState();
    for (let turn = 0; turn < HUD_TRANSCRIPT_LIMIT; turn += 1) {
      state = reduceHud(state, {
        type: "transcript",
        turnId: `t${turn}`,
        deliveryId: `d${turn}`,
        speaker: "agent",
        text: "部分",
        final: false
      });
    }
    // A streaming partial for the oldest retained turn must not count as a new
    // turn: the transcript stays exactly as long, in the same order.
    state = reduceHud(state, {
      type: "transcript",
      turnId: "t0",
      deliveryId: "d0",
      speaker: "agent",
      text: "完整的一句",
      final: true
    });
    expect(state.transcript).toHaveLength(HUD_TRANSCRIPT_LIMIT);
    expect(state.transcript[0]).toEqual({ speaker: "agent", text: "完整的一句", final: true, turnId: "t0" });
  });

  it("records latency and errors", () => {
    let state = reduceHud(initialHudState(), { type: "metric", latencyMs: 420 });
    expect(state.latencyMs).toBe(420);
    state = reduceHud(state, { type: "error", message: "relay exploded" });
    expect(state.lastError).toBe("relay exploded");
  });

  it("updates only pairing-owned companion fields from relay pairing events", () => {
    const before = reduceHud(initialHudState(), {
      type: "rdk.companion",
      companion: {
        paired: false,
        locationState: "sharing",
        horizontalAccuracyMeters: 7,
        lastFixAgeMs: 250
      }
    });
    const after = reduceHud(before, {
      type: "companion.pairing",
      code: "123456",
      expiresAt: 10_000,
      paired: true
    });

    expect(after.companion).toEqual({
      pairingCode: "123456",
      pairingExpiresAt: 10_000,
      paired: true,
      locationState: "sharing",
      horizontalAccuracyMeters: 7,
      lastFixAgeMs: 250
    });
  });

  it.each(["connected", "sharing", "stopped", "stale", "unpaired"] as const)(
    "updates only the location connection for phone status %s",
    (locationState) => {
      const before = reduceHud(initialHudState(), {
        type: "rdk.companion",
        companion: {
          pairingCode: "654321",
          pairingExpiresAt: 20_000,
          paired: true,
          locationState: "sharing",
          horizontalAccuracyMeters: 6,
          lastFixAgeMs: 500
        }
      });
      const after = reduceHud(before, { type: "phone.location.status", state: locationState });

      expect(after.companion).toEqual({
        pairingCode: "654321",
        pairingExpiresAt: 20_000,
        paired: true,
        locationState,
        horizontalAccuracyMeters: 6,
        lastFixAgeMs: 500
      });
    }
  );

  it("replaces and defensively copies a synthetic companion snapshot without raw coordinates", () => {
    const companion = {
      pairingCode: "112233",
      pairingExpiresAt: 30_000,
      paired: false,
      locationState: "sharing",
      horizontalAccuracyMeters: 9,
      lastFixAgeMs: 750,
      lat: 31.2304,
      lon: 121.4737
    } as HudCompanion & { lat: number; lon: number };
    const state = reduceHud(initialHudState(), { type: "rdk.companion", companion });
    companion.pairingCode = "999999";
    companion.horizontalAccuracyMeters = 99;

    expect(state.companion).toEqual({
      pairingCode: "112233",
      pairingExpiresAt: 30_000,
      paired: false,
      locationState: "sharing",
      horizontalAccuracyMeters: 9,
      lastFixAgeMs: 750
    });
    expect(JSON.stringify(state)).not.toContain("31.2304");
    expect(JSON.stringify(state)).not.toContain("121.4737");
  });

  it("defensively copies navigation and nested location without retaining unexpected coordinates", () => {
    const snapshot = navigation();
    Object.assign(snapshot.location!, { lat: 31.2304, lon: 121.4737 });
    const state = reduceHud(initialHudState(), { type: "rdk.navigation", navigation: snapshot });
    snapshot.instruction = "caller changed it";
    snapshot.location!.horizontalAccuracyMeters = 45;

    expect(state.navigation).toEqual(navigation());
    expect(JSON.stringify(state)).not.toContain("31.2304");
    expect(JSON.stringify(state)).not.toContain("121.4737");
  });

  it("keeps the frozen instruction, distances, and summary supplied by a paused snapshot", () => {
    const paused = navigation({
      phase: "paused",
      instruction: "保持直行",
      distanceToManeuverMeters: 88,
      remainingMeters: 1_600,
      remainingSeconds: 360,
      location: { connection: "stale", usable: false, ageMs: 10_001, reason: "stale" }
    });

    expect(reduceHud(initialHudState(), { type: "rdk.navigation", navigation: paused }).navigation).toEqual(paused);
  });

  it.each(["stop", "arrival", "start failure", "reroute failure"])("clears navigation explicitly after %s", () => {
    const active = reduceHud(initialHudState(), { type: "rdk.navigation", navigation: navigation() });
    expect(reduceHud(active, { type: "rdk.navigation", navigation: null }).navigation).toBeNull();
  });

  it("carries rider position when present in navigation snapshot", () => {
    const snapshot = navigation({ position: { lat: 31.2304, lon: 121.4737 } });
    const state = reduceHud(initialHudState(), { type: "rdk.navigation", navigation: snapshot });
    expect(state.navigation?.position).toEqual({ lat: 31.2304, lon: 121.4737 });
  });

  it("defensively copies rider position to prevent caller mutations from affecting stored state", () => {
    const position = { lat: 31.2304, lon: 121.4737 };
    const snapshot = navigation({ position });
    const state = reduceHud(initialHudState(), { type: "rdk.navigation", navigation: snapshot });
    position.lat = 0;
    position.lon = 0;

    expect(state.navigation?.position).toEqual({ lat: 31.2304, lon: 121.4737 });
  });

  it("omits position field when not supplied, keeping it optional", () => {
    const snapshot = navigation();
    const state = reduceHud(initialHudState(), { type: "rdk.navigation", navigation: snapshot });
    expect(state.navigation).not.toHaveProperty("position");
  });

  it("does not mutate previous state or reuse caller-owned synthetic objects", () => {
    const before = initialHudState();
    const event: HudEvent = { type: "rdk.navigation", navigation: navigation() };
    const after = reduceHud(before, event);

    expect(before).toEqual(initialHudState());
    expect(after).not.toBe(before);
    expect(after.navigation).not.toBe(event.navigation);
  });

  it("tracks discovery transport status", () => {
    const state = reduceHud(initialHudState(), { type: "rdk.discovery", discovery: "mdns" });
    expect(state.discovery).toBe("mdns");
    expect(initialHudState().discovery).toBe("off");
  });

  describe("rdk.route", () => {
    const geometry = () => ({
      destinationName: "人民广场",
      polyline: [
        { lat: 31.23, lon: 121.47 },
        { lat: 31.235, lon: 121.47 },
        { lat: 31.24, lon: 121.47 }
      ],
      steps: [{ lat: 31.235, lon: 121.47 }]
    });

    it("starts with no route", () => {
      expect(initialHudState().route).toBeNull();
    });

    it("holds the route and deep-copies its geometry from the caller", () => {
      const route = geometry();
      const state = reduceHud(initialHudState(), { type: "rdk.route", route });
      route.polyline[0]!.lat = 0;
      route.steps[0]!.lon = 0;
      route.destinationName = "changed";

      expect(state.route).toEqual(geometry());
    });

    it("clears the route when navigation ends", () => {
      const active = reduceHud(initialHudState(), { type: "rdk.route", route: geometry() });

      expect(reduceHud(active, { type: "rdk.route", route: null }).route).toBeNull();
    });

    it("cannot retain route geometry once the navigation snapshot is cleared", () => {
      const withRoute = reduceHud(initialHudState(), { type: "rdk.route", route: geometry() });
      const active = reduceHud(withRoute, {
        type: "rdk.navigation",
        navigation: { phase: "guiding", destinationName: "人民广场" }
      });

      expect(reduceHud(active, { type: "rdk.navigation", navigation: null })).toMatchObject({
        navigation: null,
        route: null
      });
    });

    it("replaces geometry wholesale on a reroute rather than merging", () => {
      const active = reduceHud(initialHudState(), { type: "rdk.route", route: geometry() });
      const rerouted = reduceHud(active, {
        type: "rdk.route",
        route: { polyline: [{ lat: 31.3, lon: 121.5 }], steps: [] }
      });

      expect(rerouted.route).toEqual({ polyline: [{ lat: 31.3, lon: 121.5 }], steps: [] });
    });
  });
});
