import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// A totals file that is there and cannot be counted on is the owner's billing
// history at risk: counted from as if it were the first run, the next save
// writes an empty ledger over it, and everybody gets their allowance again.
// So it is kept, the relay is not ready, and nothing is saved until the owner
// has dealt with the kept copy. That holds across restarts: a start that
// finds the path free must not pass for a clean one.
describe("a totals file that cannot be counted on", () => {
  const STAMP = new Date(NOV).toISOString();
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-file-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const files = () => fs.readdirSync(directory).sort();
  const content = (name: string) => fs.readFileSync(path.join(directory, name), "utf8");

  /** What every report of a kept copy tells the owner to do about it. */
  const ADVICE =
    "Move or delete it, then start the relay again; to keep its totals, put a good usage.json back as well.";
  /** A ledger an owner could put back. */
  const GOOD = JSON.stringify({
    version: 1,
    months: { "2026-11": { u: { sessions: 1, seconds: 60, toolCalls: 0 } } }
  });

  it("keeps a file that is not JSON, says so, and saves nothing meanwhile", () => {
    const file = path.join(directory, "usage.json");
    fs.writeFileSync(file, "{ nope");
    const usage = createUsageMeter({ file, monthlyMinutes: 5 }, { now: () => NOV });

    const aside = `usage.json.corrupt-${STAMP}`;
    expect(files()).toEqual([aside]);
    expect(content(aside)).toBe("{ nope");
    expect(usage.readinessIssue).toBe(
      `usage-storage-unavailable: usage.json is not JSON, so it was moved aside to ${aside}. Totals started empty, ` +
        `and nothing is saved while the kept copy is there. ${ADVICE}`
    );
    expect(console.error).toHaveBeenCalledOnce();
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain(aside);

    // The limits still hold for as long as the relay runs, on what it counts from zero. It goes nowhere.
    expect(usage.overLimit("u")).toBe(false);
    usage.open("s1", "u").close(NOV + 6 * 60_000);
    usage.flush();
    expect(usage.overLimit("u")).toBe(true);
    expect(files()).toEqual([aside]);
  });

  it("stays unready, and still saves nothing, across a restart while the kept copy is there", () => {
    const file = path.join(directory, "usage.json");
    fs.writeFileSync(file, "{ nope");
    createUsageMeter({ file, monthlyMinutes: 0 }, { now: () => NOV });
    const aside = `usage.json.corrupt-${STAMP}`;
    vi.mocked(console.error).mockClear();

    const restarted = createUsageMeter({ file, monthlyMinutes: 0 }, { now: () => NOV });
    expect(restarted.readinessIssue).toBe(
      `usage-storage-unavailable: ${aside}: kept beside usage.json, and those totals were never loaded. ` +
        `Nothing is saved while a kept copy is there. ${ADVICE}`
    );
    expect(console.error).toHaveBeenCalledOnce();
    restarted.open("s1", "u").close(NOV);
    restarted.flush();
    expect(files()).toEqual([aside]);

    // A good file put back in the meantime is counted on, but written to nothing until the copy is gone.
    fs.writeFileSync(file, GOOD);
    const repaired = createUsageMeter({ file, monthlyMinutes: 0 }, { now: () => NOV });
    expect(repaired.readinessIssue).toContain(`${aside}: kept beside usage.json`);
    expect(repaired.report("2026-11").totals.sessions).toBe(1);
    repaired.open("s2", "u").close(NOV);
    repaired.flush();
    expect(content("usage.json")).toBe(GOOD);
    expect(content(aside)).toBe("{ nope");
  });

  it("counts every file named like a kept copy, and no other file", () => {
    const file = path.join(directory, "usage.json");
    // What an interrupted save leaves behind is not a kept copy, nor is a look-alike name.
    fs.writeFileSync(`${file}.${process.pid}.tmp`, "{}");
    fs.writeFileSync(path.join(directory, "usage.json.corrupt"), "no stamp");
    expect(createUsageMeter({ file, monthlyMinutes: 0 }, { now: () => NOV }).readinessIssue).toBeUndefined();

    const older = "usage.json.corrupt-2026-10-01T00:00:00.000Z";
    fs.writeFileSync(path.join(directory, older), "{ nope");
    fs.writeFileSync(path.join(directory, `usage.json.corrupt-${STAMP}`), "{ nope");
    expect(createUsageMeter({ file, monthlyMinutes: 0 }, { now: () => NOV }).readinessIssue).toBe(
      `usage-storage-unavailable: ${older}, usage.json.corrupt-${STAMP}: kept beside usage.json, and those totals ` +
        "were never loaded. Nothing is saved while a kept copy is there. Move or delete them, then start the relay " +
        "again; to keep their totals, put a good usage.json back as well."
    );
  });

  it.each([
    ["another version", { version: 2, months: {} }],
    ["months that are a list", { version: 1, months: [] }],
    ["a month that is a list", { version: 1, months: { "2026-11": [] } }],
    ["a user whose totals are not", { version: 1, months: { "2026-11": { u: "lost" } } }],
    [
      "a counter that is not a number",
      { version: 1, months: { "2026-11": { u: { sessions: 1, seconds: null, toolCalls: 0 } } } }
    ]
  ])("keeps a file with %s, and counts on without it", (_name, stored) => {
    const file = path.join(directory, "usage.json");
    fs.writeFileSync(file, JSON.stringify(stored));
    const usage = createUsageMeter({ file, monthlyMinutes: 0 }, { now: () => NOV });

    const aside = `usage.json.corrupt-${STAMP}`;
    expect(usage.readinessIssue).toContain(
      `usage-storage-unavailable: usage.json is not a usage file, so it was moved aside to ${aside}.`
    );
    expect(files()).toEqual([aside]);
    // Counting on from it would have thrown, at the latest when a session was added.
    expect(usage.report("2026-11").totals.sessions).toBe(0);
    usage.open("s1", "u").close(NOV);
    usage.flush();
    expect(content(aside)).toBe(JSON.stringify(stored));
    expect(files()).toEqual([aside]);
  });

  it("moves aside a file that cannot be read at all", () => {
    const file = path.join(directory, "usage.json");
    fs.mkdirSync(file);
    const usage = createUsageMeter({ file, monthlyMinutes: 0 }, { now: () => NOV });

    const aside = `usage.json.corrupt-${STAMP}`;
    expect(usage.readinessIssue).toContain(
      `usage-storage-unavailable: usage.json could not be read (EISDIR), so it was moved aside to ${aside}.`
    );
    expect(fs.statSync(path.join(directory, aside)).isDirectory()).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("writes nothing over a file it could not move aside", () => {
    const file = path.join(directory, "usage.json");
    fs.writeFileSync(file, "{ nope");
    // Something is where the file would be moved to, and a file does not replace a directory.
    fs.mkdirSync(path.join(directory, `usage.json.corrupt-${STAMP}`));

    const usage = createUsageMeter({ file, monthlyMinutes: 0 }, { now: () => NOV });
    expect(usage.readinessIssue).toContain(
      "usage-storage-unavailable: usage.json is not JSON, and it could not be moved aside. Nothing is saved"
    );
    usage.open("s1", "u").close(NOV);
    usage.flush();
    expect(files()).toEqual(["usage.json", `usage.json.corrupt-${STAMP}`]);
    expect(content("usage.json")).toBe("{ nope");
  });

  it("is ready again, and saves, once the kept copy is gone", () => {
    const file = path.join(directory, "usage.json");
    const aside = `usage.json.corrupt-${STAMP}`;
    fs.writeFileSync(path.join(directory, aside), "{ nope");
    expect(createUsageMeter({ file, monthlyMinutes: 0 }, { now: () => NOV }).readinessIssue).toContain("kept beside");

    // The owner put a good file back and moved the kept copy away.
    fs.writeFileSync(file, GOOD);
    fs.rmSync(path.join(directory, aside));
    const usage = createUsageMeter({ file, monthlyMinutes: 0 }, { now: () => NOV });
    expect(usage.readinessIssue).toBeUndefined();
    usage.open("s1", "u").close(NOV + 60_000);
    usage.flush();
    expect(JSON.parse(content("usage.json")).months["2026-11"].u).toEqual({ sessions: 2, seconds: 120, toolCalls: 0 });
  });

  it("refuses new sessions while the per-user allowance has no ledger to be enforced from", () => {
    const file = path.join(directory, "usage.json");
    const aside = path.join(directory, `usage.json.corrupt-${STAMP}`);
    fs.writeFileSync(aside, "{ nope");
    // The allowance would start again from zero at every restart.
    expect(createUsageMeter({ file, monthlyMinutes: 5 }, { now: () => NOV }).refusesNewSessions()).toBe(true);
    // Without an allowance the meter only reports, so sessions go on.
    expect(createUsageMeter({ file, monthlyMinutes: 0 }, { now: () => NOV }).refusesNewSessions()).toBe(false);

    fs.rmSync(aside);
    // With a ledger it can read, the allowance holds as usual.
    expect(createUsageMeter({ file, monthlyMinutes: 5 }, { now: () => NOV }).refusesNewSessions()).toBe(false);
  });
});
