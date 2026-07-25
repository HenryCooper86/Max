import { describe, expect, it } from "vitest";
import { initialHudState, reduceHud } from "../rdk/agent/src/hud/state";

describe("reduceHud", () => {
  it("starts offline and idle", () => {
    const state = initialHudState();
    expect(state.connection).toBe("offline");
    expect(state.turnState).toBe("idle");
    expect(state.transcript).toEqual([]);
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
    expect(state.transcript.length).toBe(1);
    expect(state.transcript[0]).toEqual({
      speaker: "agent",
      text: "今天天气不错",
      final: true,
      turnId: "t1"
    });
  });

  it("records latency and errors", () => {
    let state = reduceHud(initialHudState(), { type: "metric", latencyMs: 420 });
    expect(state.latencyMs).toBe(420);
    state = reduceHud(state, { type: "error", message: "relay exploded" });
    expect(state.lastError).toBe("relay exploded");
  });

  it("does not mutate the previous state", () => {
    const before = initialHudState();
    reduceHud(before, { type: "status", state: "speaking", detail: "" });
    expect(before.turnState).toBe("idle");
  });
});
