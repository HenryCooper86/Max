import { describe, expect, it } from "vitest";
import { IDLE_CLOSE_CODE } from "../shared/agent";
import { authorizedRelayUrl, buildSessionStart, loadConfig, nextBackoffMs } from "../rdk/agent/src/relay";

const BASE_ENV = { MAX_RELAY_URL: "ws://localhost:8787/agent" } as NodeJS.ProcessEnv;
const DEVICE_ID = "rdk-123e4567-e89b-42d3-a456-426614174000";

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
    const event = buildSessionStart(loadConfig(BASE_ENV), DEVICE_ID);
    expect(event.type).toBe("session.start");
    expect(event.sampleRate).toBe(16000);
    expect(event.channels).toBe(1);
    expect(event.platform).toBe("embedded");
    expect(event.deviceLabel).toBe("RDK X5");
  });

  it("echoes a session-memory snapshot when one is known", () => {
    const event = buildSessionStart(loadConfig(BASE_ENV), DEVICE_ID, {
      language: "zh",
      destination: "杭州",
      responseMode: "normal"
    });
    expect(event.memory).toEqual({ language: "zh", destination: "杭州", responseMode: "normal" });
  });

  it("omits memory entirely on a cold start", () => {
    expect(buildSessionStart(loadConfig(BASE_ENV), DEVICE_ID).memory).toBeUndefined();
  });
});

describe("authorizedRelayUrl", () => {
  it("returns the url unchanged when no token is configured", () => {
    expect(authorizedRelayUrl("ws://host:8787/agent", "")).toBe("ws://host:8787/agent");
  });

  it("appends the token the relay expects", () => {
    expect(authorizedRelayUrl("ws://host:8787/agent", "s3cret")).toBe("ws://host:8787/agent?token=s3cret");
  });

  it("preserves existing query parameters", () => {
    expect(authorizedRelayUrl("ws://host:8787/agent?x=1", "s3cret")).toBe("ws://host:8787/agent?x=1&token=s3cret");
  });

  it("replaces an existing token rather than duplicating it", () => {
    expect(authorizedRelayUrl("ws://host:8787/agent?token=old", "new")).toBe("ws://host:8787/agent?token=new");
  });

  it("percent-encodes a token with url-unsafe characters", () => {
    expect(authorizedRelayUrl("ws://host/agent", "a b&c=d")).toBe("ws://host/agent?token=a+b%26c%3Dd");
  });

  it("works over wss", () => {
    expect(authorizedRelayUrl("wss://host/agent", "t")).toBe("wss://host/agent?token=t");
  });

  it("leaves a malformed url alone rather than throwing", () => {
    // A bad MAX_RELAY_URL should surface as a connection error, not a crash
    // inside URL parsing before we ever try.
    expect(authorizedRelayUrl("not a url", "t")).toBe("not a url");
  });
});

describe("relay token config", () => {
  it("defaults to no token", () => {
    expect(loadConfig(BASE_ENV).relayToken).toBe("");
  });

  it("reads MAX_RELAY_TOKEN", () => {
    expect(loadConfig({ ...BASE_ENV, MAX_RELAY_TOKEN: "abc123" }).relayToken).toBe("abc123");
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
