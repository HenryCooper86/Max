import { describe, expect, it } from "vitest";
import { IDLE_CLOSE_CODE, PROTOCOL_VERSION } from "../shared/agent";
import { buildSessionStart, loadConfig, nextBackoffMs, relayEndpoint } from "../rdk/agent/src/relay";

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
    expect(event.protocol).toBe(PROTOCOL_VERSION);
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

describe("relayEndpoint", () => {
  const endpoint = (relayUrl: string, relayToken: string) => relayEndpoint({ relayUrl, relayToken });

  it("sends no credentials when no token is configured", () => {
    expect(endpoint("ws://host:8787/agent", "")).toEqual({ url: "ws://host:8787/agent", headers: {} });
  });

  it("carries the token in the Authorization header, never in the URL", () => {
    const result = endpoint("wss://host:8787/agent", "s3cret");
    expect(result.url).toBe("wss://host:8787/agent");
    expect(result.url).not.toContain("s3cret");
    expect(result.headers).toEqual({ Authorization: "Bearer s3cret" });
  });

  it("keeps unrelated query parameters", () => {
    expect(endpoint("wss://host/agent?x=1", "t").url).toBe("wss://host/agent?x=1");
  });

  it("lifts a token pasted into MAX_RELAY_URL out of the URL so it cannot reach access logs", () => {
    const result = endpoint("wss://host/agent?x=1&token=pasted", "");
    expect(result.url).toBe("wss://host/agent?x=1");
    expect(result.headers).toEqual({ Authorization: "Bearer pasted" });
  });

  it("prefers MAX_RELAY_TOKEN over a token in the URL, and still strips the URL one", () => {
    const result = endpoint("wss://host/agent?token=old", "new");
    expect(result.url).toBe("wss://host/agent");
    expect(result.headers).toEqual({ Authorization: "Bearer new" });
  });

  it("leaves a malformed url alone rather than throwing", () => {
    // A bad MAX_RELAY_URL should surface as a connection error, not a crash
    // inside URL parsing before we ever try.
    expect(endpoint("not a url", "t")).toEqual({ url: "not a url", headers: { Authorization: "Bearer t" } });
  });
});

describe("relay transport policy", () => {
  const warnings = () => {
    const lines: string[] = [];
    return { lines, warn: (line: string) => lines.push(line) };
  };

  it("does not warn for wss", () => {
    const w = warnings();
    loadConfig({ MAX_RELAY_URL: "wss://relay.example.com/agent" }, w.warn);
    expect(w.lines).toEqual([]);
  });

  it.each(["ws://localhost:8787/agent", "ws://127.0.0.1:8787/agent", "ws://127.8.8.8/agent", "ws://[::1]:8787/agent"])(
    "does not warn for loopback %s",
    (url) => {
      const w = warnings();
      loadConfig({ MAX_RELAY_URL: url }, w.warn);
      expect(w.lines).toEqual([]);
    }
  );

  it.each(["ws://192.168.1.20:8787/agent", "ws://relay.example.com/agent", "ws://localhost.evil.example/agent"])(
    "warns loudly for plain ws to %s",
    (url) => {
      const w = warnings();
      loadConfig({ MAX_RELAY_URL: url }, w.warn);
      expect(w.lines.join("\n")).toMatch(/WARNING.*unencrypted/i);
    }
  );

  it("refuses to start on plain ws to a remote host when MAX_REQUIRE_TLS=on", () => {
    expect(() =>
      loadConfig({ MAX_RELAY_URL: "ws://192.168.1.20:8787/agent", MAX_REQUIRE_TLS: "on" }, () => {})
    ).toThrow(/MAX_REQUIRE_TLS/);
  });

  it("refuses MAX_RELAY_INSECURE_TLS=1 together with MAX_REQUIRE_TLS=on, naming both variables", () => {
    const env = { MAX_RELAY_URL: "wss://relay.example.com/agent", MAX_REQUIRE_TLS: "on", MAX_RELAY_INSECURE_TLS: "1" };
    expect(() => loadConfig(env, () => {})).toThrow(/MAX_REQUIRE_TLS.*MAX_RELAY_INSECURE_TLS/);
    expect(() => loadConfig({ ...env, MAX_RELAY_INSECURE_TLS: "0" }, () => {})).not.toThrow();
    expect(() => loadConfig({ ...env, MAX_REQUIRE_TLS: "off" }, () => {})).not.toThrow();
    expect(() => loadConfig({ ...env, MAX_RELAY_URL: "ws://127.0.0.1:8787/agent" }, () => {})).not.toThrow();
  });

  it("still allows wss and loopback under MAX_REQUIRE_TLS=on", () => {
    expect(() => loadConfig({ MAX_RELAY_URL: "wss://relay.example.com/agent", MAX_REQUIRE_TLS: "on" })).not.toThrow();
    expect(() => loadConfig({ MAX_RELAY_URL: "ws://127.0.0.1:8787/agent", MAX_REQUIRE_TLS: "on" })).not.toThrow();
  });

  it("refuses an unparseable or non-ws URL under MAX_REQUIRE_TLS=on", () => {
    expect(() => loadConfig({ MAX_RELAY_URL: "not a url", MAX_REQUIRE_TLS: "on" })).toThrow(/MAX_REQUIRE_TLS/);
    expect(() => loadConfig({ MAX_RELAY_URL: "http://host/agent", MAX_REQUIRE_TLS: "on" })).toThrow(/MAX_REQUIRE_TLS/);
  });

  it("rejects an unknown MAX_REQUIRE_TLS value instead of silently staying lax", () => {
    expect(() => loadConfig({ MAX_RELAY_URL: "wss://h/agent", MAX_REQUIRE_TLS: "yes" })).toThrow(/MAX_REQUIRE_TLS/);
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
