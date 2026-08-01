import { describe, expect, it, vi } from "vitest";
import { createHazardHandler } from "../rdk/agent/src/hazard";
import { loadConfig } from "../rdk/agent/src/config";

const BASE_ENV = { MAX_RELAY_URL: "ws://localhost:8787/agent" } as NodeJS.ProcessEnv;

const EVENT = {
  event: "hazard",
  threat: "forward_collision",
  direction: "front",
  severity: "critical",
  label: "前车急刹",
  message: "前车急刹，注意保持车距！",
  advice: "立即收油，平稳减速。",
  ttcSeconds: 1.4
};

describe("adas audio config", () => {
  it("defaults to locked, because the M1 gate is unmet", () => {
    expect(loadConfig(BASE_ENV).adasAudio).toBe(false);
  });

  it("arms only on the exact string 1, so a typo cannot arm it", () => {
    expect(loadConfig({ ...BASE_ENV, MAX_ADAS_AUDIO: "1" }).adasAudio).toBe(true);
    expect(loadConfig({ ...BASE_ENV, MAX_ADAS_AUDIO: "true" }).adasAudio).toBe(false);
    expect(loadConfig({ ...BASE_ENV, MAX_ADAS_AUDIO: "yes" }).adasAudio).toBe(false);
    expect(loadConfig({ ...BASE_ENV, MAX_ADAS_AUDIO: "0" }).adasAudio).toBe(false);
  });

  it("has a default clip directory", () => {
    expect(loadConfig(BASE_ENV).adasAudioDir).toBe("/opt/max/rdk/audio/alerts");
  });
});

describe("createHazardHandler", () => {
  it("plays nothing in shadow mode", async () => {
    const play = vi.fn();
    const handler = createHazardHandler({
      armed: false,
      player: { play },
      report: vi.fn(),
      log: () => {}
    });
    await handler.handle(EVENT);
    expect(play).not.toHaveBeenCalled();
  });

  it("does not report upward in shadow mode either", async () => {
    // The board played nothing, so there is no real alert for the transcript.
    // Reporting one would make shadow runs indistinguishable from armed ones in
    // the QA record — the record M2 exists to build.
    const report = vi.fn();
    const handler = createHazardHandler({
      armed: false,
      player: { play: vi.fn() },
      report,
      log: () => {}
    });
    await handler.handle(EVENT);
    expect(report).not.toHaveBeenCalled();
  });

  it("logs the shadow alert so the ride can be reviewed", async () => {
    const lines: string[] = [];
    const handler = createHazardHandler({
      armed: false,
      player: { play: vi.fn() },
      report: vi.fn(),
      log: (line) => lines.push(line)
    });
    await handler.handle(EVENT);
    expect(lines.join(" ")).toContain("forward_collision");
  });

  it("plays and reports when armed", async () => {
    const play = vi.fn().mockResolvedValue(42);
    const report = vi.fn();
    const handler = createHazardHandler({ armed: true, player: { play }, report, log: () => {} });
    await handler.handle(EVENT);
    // Severity travels with the threat so the player can rank its preemption.
    expect(play).toHaveBeenCalledWith("forward_collision", "critical");
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "hazard.report",
        threat: "forward_collision",
        severity: "critical",
        ttcSeconds: 1.4,
        handoverMs: 42
      })
    );
  });

  it("reports even when the clip was missing, so the alert is still recorded", async () => {
    const play = vi.fn().mockResolvedValue(null);
    const report = vi.fn();
    const handler = createHazardHandler({ armed: true, player: { play }, report, log: () => {} });
    await handler.handle(EVENT);
    expect(report).toHaveBeenCalled();
  });

  it("ignores vision events that are not hazards", async () => {
    const play = vi.fn();
    const handler = createHazardHandler({
      armed: true,
      player: { play },
      report: vi.fn(),
      log: () => {}
    });
    await handler.handle({ event: "preview.ready" });
    expect(play).not.toHaveBeenCalled();
  });

  it("ignores a hazard with no threat id rather than playing a guess", async () => {
    const play = vi.fn();
    const handler = createHazardHandler({
      armed: true,
      player: { play },
      report: vi.fn(),
      log: () => {}
    });
    await handler.handle({ event: "hazard" });
    expect(play).not.toHaveBeenCalled();
  });

  it("survives a reporting failure without losing the audio", async () => {
    // Reporting is best-effort and must never cost the rider the warning.
    const play = vi.fn().mockResolvedValue(10);
    const report = vi.fn(() => {
      throw new Error("relay gone");
    });
    const handler = createHazardHandler({ armed: true, player: { play }, report, log: () => {} });
    await expect(handler.handle(EVENT)).resolves.toBeUndefined();
    expect(play).toHaveBeenCalled();
  });
});
