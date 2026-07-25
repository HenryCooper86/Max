import { describe, expect, it } from "vitest";
import { IDLE_CLOSE_CODE } from "../shared/agent";
import { buildSessionStart, loadConfig, nextBackoffMs } from "../rdk/agent/src/relay";

const BASE_ENV = { MAX_RELAY_URL: "ws://localhost:8787/agent" } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("requires a relay URL", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/MAX_RELAY_URL/);
  });

  it("defaults the audio and gallery settings", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.alsaCapture).toBe("plughw:0,0");
    expect(config.alsaPlayback).toBe("plughw:0,0");
    expect(config.galleryMinFreeMb).toBe(1024);
    expect(config.hudPort).toBe(8080);
    expect(config.insecureTls).toBe(false);
  });

  it("keeps insecure TLS off unless explicitly enabled", () => {
    expect(loadConfig({ ...BASE_ENV, MAX_RELAY_INSECURE_TLS: "0" }).insecureTls).toBe(false);
    expect(loadConfig({ ...BASE_ENV, MAX_RELAY_INSECURE_TLS: "yes" }).insecureTls).toBe(false);
    expect(loadConfig({ ...BASE_ENV, MAX_RELAY_INSECURE_TLS: "1" }).insecureTls).toBe(true);
  });

  it("rejects a non-numeric port rather than silently using NaN", () => {
    expect(() => loadConfig({ ...BASE_ENV, MAX_HUD_PORT: "abc" })).toThrow(/MAX_HUD_PORT/);
  });
});

describe("buildSessionStart", () => {
  it("declares the embedded platform and the uplink format", () => {
    const event = buildSessionStart(loadConfig(BASE_ENV));
    expect(event.type).toBe("session.start");
    expect(event.sampleRate).toBe(16000);
    expect(event.channels).toBe(1);
    expect(event.platform).toBe("embedded");
    expect(event.deviceLabel).toBe("RDK X5");
  });

  it("echoes a session-memory snapshot when one is known", () => {
    const event = buildSessionStart(loadConfig(BASE_ENV), {
      language: "zh",
      destination: "杭州",
      responseMode: "normal"
    });
    expect(event.memory).toEqual({ language: "zh", destination: "杭州", responseMode: "normal" });
  });

  it("omits memory entirely on a cold start", () => {
    expect(buildSessionStart(loadConfig(BASE_ENV)).memory).toBeUndefined();
  });
});

describe("nextBackoffMs", () => {
  it("grows exponentially from one second", () => {
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(1)).toBe(2000);
    expect(nextBackoffMs(2)).toBe(4000);
  });

  it("caps so a parked helmet does not back off forever", () => {
    expect(nextBackoffMs(20)).toBe(30000);
  });
});

describe("idle close contract", () => {
  it("uses the shared code the relay actually sends", () => {
    expect(IDLE_CLOSE_CODE).toBe(4001);
  });
});
