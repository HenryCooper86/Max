import { afterEach, describe, expect, it, vi } from "vitest";

// LOG_FORMAT is read once when the logger loads, like LOG_LEVEL.
async function freshLogger(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return import("../server/logger");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("logger output", () => {
  it("keeps the plain text format by default", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const { createLogger } = await freshLogger({ LOG_FORMAT: "", LOG_LEVEL: "info" });
    createLogger("relay").info("listening", { port: 8787 });
    const line = String(out.mock.calls[0]?.[0]);
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z INFO {2}\[relay\] listening \{"port":8787\}$/);
  });

  it("writes one JSON object per line with LOG_FORMAT=json", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { createLogger } = await freshLogger({ LOG_FORMAT: "JSON", LOG_LEVEL: "info" });
    const log = createLogger("sess:ab12cd34");

    log.info("client connected", { address: "198.51.100.7", provider: "mock" });
    log.warn("upstream error", { message: "socket hang up\nsecond line", retries: 2 });
    log.error("failed");
    log.debug("not shown at info");

    expect(out).toHaveBeenCalledTimes(1);
    const info = String(out.mock.calls[0]?.[0]);
    expect(info).not.toContain("\n");
    expect(JSON.parse(info)).toEqual({
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\S+Z$/),
      level: "info",
      scope: "sess:ab12cd34",
      message: "client connected",
      address: "198.51.100.7",
      provider: "mock"
    });

    // A field may not overwrite the line's own keys; it is kept under another name.
    const warning = String(warn.mock.calls[0]?.[0]);
    expect(warning).not.toContain("\n");
    expect(JSON.parse(warning)).toMatchObject({
      level: "warn",
      message: "upstream error",
      field_message: "socket hang up\nsecond line",
      retries: 2
    });
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ level: "error", message: "failed" });
  });

  it("never throws on fields JSON cannot represent", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const { createLogger } = await freshLogger({ LOG_FORMAT: "json", LOG_LEVEL: "info" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    createLogger("relay").info("odd fields", { count: 10n, circular, error: new Error("boom") });
    const parsed = JSON.parse(String(out.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(parsed).toMatchObject({ message: "odd fields", count: "10", error: { name: "Error", message: "boom" } });
    expect(parsed.circular).toEqual({ self: "[circular]" });
  });
});
