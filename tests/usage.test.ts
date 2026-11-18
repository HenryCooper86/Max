import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createUsageMeter, monthOf, usageSettingsFromEnv } from "../server/usage";
import { shouldReconnect } from "../sdk/src/protocol";

const NOV = Date.parse("2026-11-18T10:00:00Z");

function meter(overrides: Partial<Parameters<typeof createUsageMeter>[0]> = {}, request = vi.fn()) {
  let clock = NOV;
  const usage = createUsageMeter(
    { file: path.join(os.tmpdir(), "unused.json"), monthlyMinutes: 0, ...overrides },
    { now: () => clock, request: request as never, persist: false }
  );
  return { usage, advance: (ms: number) => (clock += ms), request };
}

describe("usage meter", () => {
  it("counts connected seconds and tool calls per user and month", () => {
    const { usage, advance } = meter();
    const first = usage.open("s1", "user-1");
    first.toolCall();
    first.toolCall();
    advance(90_000);
    expect(first.close()).toMatchObject({ userId: "user-1", seconds: 90, toolCalls: 2 });
    const anonymous = usage.open("s2", undefined);
    advance(30_000);
    anonymous.close();
    const report = usage.report("2026-11");
    expect(report.totals).toEqual({ sessions: 2, minutes: 2, seconds: 120, toolCalls: 2 });
    expect(report.users[0]).toEqual({ userId: "user-1", sessions: 1, minutes: 1.5, seconds: 90, toolCalls: 2 });
    expect(usage.report("2026-11", "user-1").users).toHaveLength(1);
    expect(usage.report("2026-10").totals.sessions).toBe(0);
  });

  it("records a session once even if closed twice", () => {
    const { usage, advance } = meter();
    const session = usage.open("s1", "u");
    advance(1000);
    session.close();
    session.close();
    expect(usage.report("2026-11").totals.sessions).toBe(1);
  });

  it("limits a user once their minutes, including the session in progress, are used", () => {
    const { usage, advance } = meter({ monthlyMinutes: 2 });
    const session = usage.open("s1", "u");
    advance(60_000);
    expect(usage.overLimit("u")).toBe(false);
    advance(60_000);
    expect(usage.overLimit("u")).toBe(true);
    session.close();
    expect(usage.overLimit("u")).toBe(true);
    // Users without an identity have no allowance to use up, and another user is unaffected.
    expect(usage.overLimit(undefined)).toBe(false);
    expect(usage.overLimit("someone-else")).toBe(false);
  });

  it("starts a fresh allowance each month", () => {
    const { usage, advance } = meter({ monthlyMinutes: 1 });
    usage.open("s1", "u");
    advance(120_000);
    expect(usage.overLimit("u")).toBe(true);
    usage.open("s1", "u").close(); // the open session ends
    advance(14 * 24 * 3600_000); // into December
    expect(monthOf(NOV + 120_000 + 14 * 24 * 3600_000)).toBe("2026-12");
    expect(usage.overLimit("u")).toBe(false);
  });

  it("posts each finished session, signed, to the usage webhook", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const { usage, advance } = meter(
      { webhookUrl: "https://billing.example.com/usage", webhookSecret: "s3cret" },
      request as never
    );
    const session = usage.open("s1", "user-1");
    advance(30_000);
    session.close();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://billing.example.com/usage");
    const body = String(init.body);
    expect(JSON.parse(body)).toMatchObject({ type: "session.usage", userId: "user-1", seconds: 30, minutes: 0.5 });
    const timestamp = init.headers["x-voice-agent-timestamp"];
    expect(init.headers["x-voice-agent-signature"]).toBe(
      `sha256=${createHmac("sha256", "s3cret").update(`${timestamp}.${body}`).digest("hex")}`
    );
  });

  it("refuses a public plain-http webhook", async () => {
    const request = vi.fn();
    const { usage } = meter({ webhookUrl: "http://billing.example.com/usage" }, request);
    usage.open("s1", "u").close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps totals across restarts in the data directory", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
    const settings = usageSettingsFromEnv({ STUDIO_DIR: directory, USAGE_MONTHLY_MINUTES: "500" });
    expect(settings).toMatchObject({ file: path.join(directory, "usage.json"), monthlyMinutes: 500 });
    const first = createUsageMeter(settings, { now: () => NOV });
    first.open("s1", "u").close(NOV + 60_000);
    first.flush();
    const second = createUsageMeter(settings, { now: () => NOV });
    expect(second.report("2026-11").totals.minutes).toBe(1);
  });

  it("the SDK does not reconnect after the minutes run out", () => {
    expect(shouldReconnect(4003, 1)).toBe(false);
    expect(shouldReconnect(1006, 1)).toBe(true);
  });
});
