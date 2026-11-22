import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as realSleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../server/logger";
import { createCampaigns, type CampaignOptions } from "../server/telephony/campaigns";
import type { CallProgress } from "../server/telephony/twilio-calls";

// Campaigns against a stand-in for placing calls. Nothing here touches a carrier.

type Placed = {
  carrier: string | undefined;
  input: { to: string; context?: string; userId?: string; voicemailMessage?: string };
  watch: (progress: CallProgress) => void;
  at: number;
  origin: string | undefined;
};
type PlaceResult = Awaited<ReturnType<CampaignOptions["place"]>>;

const MONDAY_10_UTC = "2026-06-01T10:00:00Z";
const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger;

let directory: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(MONDAY_10_UTC));
  directory = mkdtempSync(path.join(tmpdir(), "campaigns-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

function setup(options: { file?: string; place?: (placed: Placed) => PlaceResult | Promise<PlaceResult> } = {}) {
  const placed: Placed[] = [];
  let next = 0;
  const campaigns = createCampaigns({
    log: logger(),
    ...(options.file ? { file: options.file } : {}),
    place: async (carrier, input, watch, origin) => {
      const entry = { carrier, input, watch, at: Date.now(), origin };
      placed.push(entry);
      next += 1;
      return options.place ? options.place(entry) : { ok: true, callSid: `CA${next}` };
    }
  });
  return { campaigns, placed };
}

const numbers = (count: number, from = 100): Array<{ to: string }> =>
  Array.from({ length: count }, (_, index) => ({ to: `+1415555${String(from + index).padStart(4, "0")}` }));

function make(harness: ReturnType<typeof setup>, body: Record<string, unknown> = {}) {
  const created = harness.campaigns.create({ calls: numbers(3), ...body });
  if (!created.ok) throw new Error(created.problem);
  return created.campaign.id;
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const statuses = (harness: ReturnType<typeof setup>, id: string) =>
  harness.campaigns.get(id)!.calls.map((call) => call.status);

/** Lets the real file writes finish. The timers are fake; the file system is not. */
async function settleFile() {
  await advance(0);
  await realSleep(30);
}

/**
 * Lets time pass for campaigns kept in a file. Each call is written to disk
 * before it is placed, and that write is real: the clock waits for it.
 */
async function pass(harness: ReturnType<typeof setup>, ms: number) {
  for (let left = ms; left > 0; left -= 500) {
    await advance(Math.min(500, left));
    await harness.campaigns.settled();
    await advance(0);
  }
}

describe("validating a campaign", () => {
  const problem = (body: unknown): string => {
    const result = setup().campaigns.create(body);
    if (result.ok) throw new Error("accepted");
    expect(result.status).toBe(400);
    return result.problem;
  };

  it("accepts a plain list and fills in the defaults", () => {
    const harness = setup();
    const result = harness.campaigns.create({ calls: [{ to: "+14155550123" }] });
    expect(result).toMatchObject({
      ok: true,
      campaign: { status: "running", concurrency: 1, attempts: 1, retryAfterMinutes: 30, total: 1 }
    });
  });

  it("needs a list of one to 5,000 calls", () => {
    for (const body of [undefined, null, [], {}, { calls: "x" }, { calls: [] }, { calls: numbers(5_001) }]) {
      expect(problem(body)).toContain("calls");
    }
    expect(setup().campaigns.create({ calls: numbers(5_000, 0) }).ok).toBe(true);
  });

  it("checks every number and refuses one twice", () => {
    for (const to of ["4155550123", "+0155550123", "+1 415 555 0123", "sip:a@b.c", "", 5, undefined]) {
      expect(problem({ calls: [{ to }] })).toContain("calls[0].to");
    }
    expect(problem({ calls: ["+14155550123"] })).toContain("calls[0]");
    expect(problem({ calls: [{ to: "+14155550123" }, { to: "+14155550124" }, { to: " +14155550123 " }] })).toContain(
      "calls[2].to"
    );
  });

  it("checks the numbers it is given", () => {
    const base = { calls: [{ to: "+14155550123" }] };
    for (const bad of [{ concurrency: 0 }, { concurrency: 51 }, { concurrency: 1.5 }, { concurrency: "2" }]) {
      expect(problem({ ...base, ...bad })).toContain("concurrency");
    }
    for (const bad of [{ attempts: 0 }, { attempts: 6 }]) expect(problem({ ...base, ...bad })).toContain("attempts");
    for (const bad of [{ retryAfterMinutes: 0 }, { retryAfterMinutes: 1441 }]) {
      expect(problem({ ...base, ...bad })).toContain("retryAfterMinutes");
    }
    const edges = { concurrency: 50, attempts: 5, retryAfterMinutes: 1440 };
    expect(setup().campaigns.create({ ...base, ...edges }).ok).toBe(true);
  });

  it("keeps text within the limits placeCall uses", () => {
    const base = { calls: [{ to: "+14155550123" }] };
    expect(problem({ ...base, name: "n".repeat(121) })).toContain("name");
    expect(problem({ ...base, context: "c".repeat(2_001) })).toContain("context");
    expect(problem({ ...base, voicemailMessage: "v".repeat(501) })).toContain("voicemailMessage");
    expect(problem({ calls: [{ to: "+14155550123", context: "c".repeat(2_001) }] })).toContain("calls[0].context");
    expect(problem({ calls: [{ to: "+14155550123", userId: "u".repeat(129) }] })).toContain("calls[0].userId");
    expect(problem({ calls: [{ to: "+14155550123", voicemailMessage: 4 }] })).toContain("calls[0].voicemailMessage");
    const edges = { name: "n".repeat(120), context: "c".repeat(2_000), voicemailMessage: "v".repeat(500) };
    expect(setup().campaigns.create({ ...base, ...edges }).ok).toBe(true);
  });

  it("checks the carrier and the start time", () => {
    const base = { calls: [{ to: "+14155550123" }] };
    expect(problem({ ...base, carrier: "vonage" })).toContain("carrier");
    for (const startAt of ["tomorrow", 5, "2026-06-01", "2026-07-02T10:00:01Z"]) {
      expect(problem({ ...base, startAt })).toContain("startAt");
    }
    expect(setup().campaigns.create({ ...base, startAt: "2026-07-01T10:00:00Z" }).ok).toBe(true);
    expect(setup().campaigns.create({ ...base, startAt: "2026-05-01T10:00:00Z" }).ok).toBe(true);
  });

  it("checks the window", () => {
    const base = { calls: [{ to: "+14155550123" }] };
    const window = { from: "09:00", to: "18:00", timeZone: "Europe/Berlin" };
    expect(setup().campaigns.create({ ...base, window: { ...window, days: ["mon", "fri"] } }).ok).toBe(true);
    const bad: unknown[] = [
      "9 to 6",
      { ...window, from: "9:00" },
      { ...window, to: "24:00" },
      { ...window, from: "18:00", to: "09:00" },
      { ...window, from: "09:00", to: "09:00" },
      { ...window, timeZone: "Mars/Base" },
      { ...window, timeZone: undefined },
      { ...window, days: [] },
      { ...window, days: ["monday"] },
      { ...window, days: ["mon", "mon"] }
    ];
    for (const value of bad) expect(problem({ ...base, window: value })).toContain("window");
  });
});

describe("placing calls", () => {
  it("passes the campaign's context and voicemail message as defaults a call's own value replaces", async () => {
    const harness = setup();
    harness.campaigns.create({
      carrier: "telnyx",
      context: "Confirm Friday.",
      voicemailMessage: "Call us back.",
      calls: [
        { to: "+14155550101" },
        { to: "+14155550102", context: "Special.", userId: "u2", voicemailMessage: "Hi." }
      ],
      concurrency: 2
    });
    await advance(2_500);
    expect(harness.placed.map((entry) => [entry.carrier, entry.input])).toEqual([
      ["telnyx", { to: "+14155550101", context: "Confirm Friday.", voicemailMessage: "Call us back." }],
      ["telnyx", { to: "+14155550102", context: "Special.", userId: "u2", voicemailMessage: "Hi." }]
    ]);
  });

  it("never has more than the concurrency in calls, and places the next when one ends", async () => {
    const harness = setup();
    const id = make(harness, { calls: numbers(5), concurrency: 2 });
    await advance(10_000);
    expect(harness.placed).toHaveLength(2);
    expect(statuses(harness, id)).toEqual(["calling", "calling", "waiting", "waiting", "waiting"]);

    harness.placed[0]!.watch({ type: "answered", callSid: "CA1" });
    await advance(10_000);
    expect(harness.placed).toHaveLength(2);
    expect(statuses(harness, id).slice(0, 2)).toEqual(["answered", "calling"]);

    harness.placed[0]!.watch({ type: "ended", callSid: "CA1", reason: "caller", durationMs: 5_000 });
    await advance(1_000);
    expect(harness.placed).toHaveLength(3);
    expect(harness.campaigns.get(id)!.calls[0]).toMatchObject({
      status: "completed",
      durationMs: 5_000,
      callSid: "CA1"
    });

    // However many end, never more than two are on at once.
    for (const entry of harness.placed.slice(1)) {
      entry.watch({ type: "machine", callSid: "x", answeredBy: "machine_start", voicemailLeft: false });
      await advance(1_000);
      const inProgress = statuses(harness, id).filter((status) => status === "calling" || status === "answered");
      expect(inProgress.length).toBeLessThanOrEqual(2);
    }
  });

  it("leaves at least a second between two placements, across campaigns too", async () => {
    const harness = setup();
    make(harness, { calls: numbers(3), concurrency: 10 });
    make(harness, { calls: numbers(3, 200), concurrency: 10 });
    await advance(30_000);
    expect(harness.placed).toHaveLength(6);
    for (let index = 1; index < harness.placed.length; index += 1) {
      expect(harness.placed[index]!.at - harness.placed[index - 1]!.at).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("retries busy and no-answer after the wait, up to the attempts, and no further", async () => {
    const harness = setup();
    const id = make(harness, { calls: numbers(2), attempts: 2, retryAfterMinutes: 10, concurrency: 2 });
    await advance(3_000);
    harness.placed[0]!.watch({ type: "unanswered", callSid: "CA1", status: "busy" });
    harness.placed[1]!.watch({ type: "unanswered", callSid: "CA2", status: "no-answer" });
    expect(statuses(harness, id)).toEqual(["waiting", "waiting"]);
    await advance(9 * 60_000);
    expect(harness.placed).toHaveLength(2);
    await advance(61_000 + 1_000);
    expect(harness.placed).toHaveLength(4);
    expect(harness.campaigns.get(id)!.calls.map((call) => call.attempts)).toEqual([2, 2]);

    harness.placed[2]!.watch({ type: "unanswered", callSid: "CA1", status: "busy" });
    harness.placed[3]!.watch({ type: "unanswered", callSid: "CA2", status: "no-answer" });
    await advance(60 * 60_000);
    expect(harness.placed).toHaveLength(4);
    expect(statuses(harness, id)).toEqual(["busy", "no-answer"]);
    expect(harness.campaigns.get(id)!.status).toBe("done");
  });

  it("does not retry a failed call, a voicemail, a completed call or an unknown one", async () => {
    const harness = setup();
    const id = make(harness, { calls: numbers(4), attempts: 5, retryAfterMinutes: 1, concurrency: 4 });
    await advance(5_000);
    const [a, b, c, d] = harness.placed;
    a!.watch({ type: "unanswered", callSid: "CA1", status: "failed" });
    b!.watch({ type: "machine", callSid: "CA2", answeredBy: "machine_start", voicemailLeft: true });
    c!.watch({ type: "ended", callSid: "CA3", reason: "agent", durationMs: 1_000 });
    d!.watch({ type: "unknown" });
    await advance(10 * 60_000);
    expect(harness.placed).toHaveLength(4);
    expect(statuses(harness, id)).toEqual(["failed", "voicemail", "completed", "unknown"]);
    expect(harness.campaigns.get(id)!.calls[1]).toMatchObject({ answeredBy: "machine_start" });
  });

  it("maps a canceled call to failed, and ignores events after a call has settled", async () => {
    const harness = setup();
    const id = make(harness, { calls: numbers(1) });
    await advance(2_000);
    const watch = harness.placed[0]!.watch;
    watch({ type: "unanswered", callSid: "CA1", status: "canceled" });
    watch({ type: "ended", callSid: "CA1", reason: "late", durationMs: 1 });
    expect(harness.campaigns.get(id)!.calls[0]).toMatchObject({ status: "failed" });
  });

  it("does not count a 429 as an attempt, and tries again in a few seconds", async () => {
    let refuse = 2;
    const harness = setup({
      place: () =>
        refuse-- > 0 ? { ok: false, status: 429, error: "Every line is busy." } : { ok: true, callSid: "CA9" }
    });
    const id = make(harness, { calls: numbers(1), attempts: 1 });
    await advance(100);
    expect(harness.placed).toHaveLength(1);
    expect(harness.campaigns.get(id)!.calls[0]).toMatchObject({ status: "waiting", attempts: 0 });
    expect(harness.campaigns.get(id)!.calls[0]!.lastAttemptAt).toBeUndefined();
    await advance(4_000);
    expect(harness.placed).toHaveLength(1);
    await advance(2_000);
    expect(harness.placed).toHaveLength(2);
    await advance(6_000);
    expect(harness.placed).toHaveLength(3);
    expect(harness.campaigns.get(id)!.calls[0]).toMatchObject({ status: "calling", attempts: 1, callSid: "CA9" });
  });

  it("marks a call failed, with the reason, when placing it is refused", async () => {
    const harness = setup({
      place: (entry) =>
        entry.input.to.endsWith("0100")
          ? { ok: false, status: 400, error: "voicemailMessage needs answering-machine detection." }
          : { ok: false, status: 503, error: "Set TELNYX_API_KEY." }
    });
    const id = make(harness, { calls: numbers(2), concurrency: 2 });
    await advance(5_000);
    expect(harness.campaigns.get(id)!.calls).toMatchObject([
      { status: "failed", endedReason: "voicemailMessage needs answering-machine detection.", attempts: 1 },
      { status: "failed", endedReason: "Set TELNYX_API_KEY." }
    ]);
    expect(harness.campaigns.get(id)!.status).toBe("done");
  });

  it("marks a call failed when placing it throws, without stopping the others", async () => {
    let first = true;
    const harness = setup({
      place: () => {
        if (first) {
          first = false;
          throw new Error("boom +14155550100");
        }
        return { ok: true, callSid: "CA2" };
      }
    });
    const id = make(harness, { calls: numbers(2), concurrency: 2 });
    await advance(5_000);
    expect(statuses(harness, id)).toEqual(["failed", "calling"]);
    expect(harness.campaigns.get(id)!.calls[0]!.endedReason).not.toContain("+1415");
  });

  it("refuses to create a campaign when calls cannot be placed at all", () => {
    const campaigns = createCampaigns({
      log: logger(),
      place: async () => ({ ok: true, callSid: "x" }),
      notReady: (carrier) => (carrier === "telnyx" ? "Set TELNYX_API_KEY." : undefined)
    });
    expect(campaigns.create({ carrier: "telnyx", calls: numbers(1) })).toEqual({
      ok: false,
      status: 503,
      problem: "Set TELNYX_API_KEY."
    });
    expect(campaigns.create({ calls: numbers(1) }).ok).toBe(true);
    expect(campaigns.list()).toHaveLength(1);
  });

  it("hands the creating request's address to every placement", async () => {
    const harness = setup();
    harness.campaigns.create({ calls: numbers(1) }, "https://relay.example.com");
    await advance(2_000);
    expect(harness.placed[0]!.origin).toBe("https://relay.example.com");
  });
});

describe("the window and the start time", () => {
  const berlin = { from: "09:00", to: "18:00", timeZone: "Europe/Berlin" };

  it("places calls only inside the window, in its own time zone", async () => {
    // 06:30 UTC is 08:30 in Berlin in June.
    vi.setSystemTime(new Date("2026-06-01T06:30:00Z"));
    const harness = setup();
    const id = make(harness, { calls: numbers(2), window: berlin });
    await advance(20 * 60_000);
    expect(harness.placed).toHaveLength(0);
    expect(harness.campaigns.get(id)).toMatchObject({ status: "running", waitingForWindow: true });

    // 07:00 UTC is 09:00 in Berlin.
    await advance(10 * 60_000 + 1_000);
    expect(harness.placed.length).toBeGreaterThan(0);
    expect(harness.campaigns.get(id)!.waitingForWindow).toBe(false);
  });

  it("stops placing when the window closes, and carries on the next day", async () => {
    // 15:59:59.5 UTC is half a second before the window closes in Berlin.
    vi.setSystemTime(new Date("2026-06-01T15:59:59.500Z"));
    const harness = setup();
    const id = make(harness, { calls: numbers(3), window: berlin });
    await advance(10_000);
    expect(harness.placed).toHaveLength(1);
    harness.placed[0]!.watch({ type: "ended", callSid: "CA1", reason: "caller", durationMs: 1 });
    await advance(60_000);
    expect(harness.placed).toHaveLength(1);
    expect(harness.campaigns.get(id)!.waitingForWindow).toBe(true);
    await advance(15 * 60 * 60_000);
    expect(harness.placed).toHaveLength(2);
  });

  it("reads the day in the window's time zone, not the server's", async () => {
    // Monday 22:30 UTC is already Tuesday 00:30 in Berlin.
    vi.setSystemTime(new Date("2026-06-01T22:30:00Z"));
    const early = { from: "00:00", to: "06:00", timeZone: "Europe/Berlin" };
    const tuesday = setup();
    make(tuesday, { calls: numbers(1), window: { ...early, days: ["tue"] } });
    await advance(5_000);
    expect(tuesday.placed).toHaveLength(1);

    const monday = setup();
    make(monday, { calls: numbers(1), window: { ...early, days: ["mon"] } });
    await advance(5_000);
    expect(monday.placed).toHaveLength(0);
  });

  it("opens in a zone behind UTC, across the date line of the clock", async () => {
    // 02:00 UTC on Tuesday is 22:00 on Monday in New York.
    vi.setSystemTime(new Date("2026-06-02T02:00:00Z"));
    const harness = setup();
    make(harness, {
      calls: numbers(1),
      window: { from: "20:00", to: "23:00", timeZone: "America/New_York", days: ["mon"] }
    });
    await advance(5_000);
    expect(harness.placed).toHaveLength(1);
  });

  it("waits for startAt, and reports the campaign as scheduled", async () => {
    const harness = setup();
    const id = make(harness, { startAt: "2026-06-01T10:30:00Z" });
    await advance(29 * 60_000);
    expect(harness.placed).toHaveLength(0);
    expect(harness.campaigns.get(id)).toMatchObject({ status: "scheduled", startAt: "2026-06-01T10:30:00.000Z" });
    await advance(61_000);
    expect(harness.placed).toHaveLength(1);
    expect(harness.campaigns.get(id)!.status).toBe("running");
  });
});

describe("cancelling and deleting", () => {
  it("stops placing, leaves calls on the line to finish, and does not retry them", async () => {
    const harness = setup();
    const id = make(harness, { calls: numbers(4), concurrency: 2, attempts: 3 });
    await advance(3_000);
    expect(harness.placed).toHaveLength(2);
    const cancelled = harness.campaigns.cancel(id)!;
    expect(cancelled.status).toBe("cancelled");
    expect(statuses(harness, id)).toEqual(["calling", "calling", "cancelled", "cancelled"]);
    expect(harness.campaigns.remove(id)).toMatchObject({ ok: false, status: 409 });

    harness.placed[0]!.watch({ type: "answered", callSid: "CA1" });
    harness.placed[0]!.watch({ type: "ended", callSid: "CA1", reason: "caller", durationMs: 9_000 });
    harness.placed[1]!.watch({ type: "unanswered", callSid: "CA2", status: "busy" });
    await advance(24 * 60 * 60_000);
    expect(harness.placed).toHaveLength(2);
    expect(statuses(harness, id)).toEqual(["completed", "busy", "cancelled", "cancelled"]);
    expect(harness.campaigns.remove(id)).toEqual({ ok: true });
    expect(harness.campaigns.get(id)).toBeUndefined();
  });

  it("knows only the campaigns it has", () => {
    const harness = setup();
    expect(harness.campaigns.cancel("nope")).toBeUndefined();
    expect(harness.campaigns.get("nope")).toBeUndefined();
    expect(harness.campaigns.remove("nope")).toMatchObject({ ok: false, status: 404 });
  });

  it("does not delete a campaign that is running or scheduled", () => {
    const harness = setup();
    const running = make(harness);
    const scheduled = make(harness, { startAt: "2026-06-05T10:00:00Z" });
    expect(harness.campaigns.remove(running)).toMatchObject({ ok: false, status: 409 });
    expect(harness.campaigns.remove(scheduled)).toMatchObject({ ok: false, status: 409 });
  });

  it("summarises by status, newest first", async () => {
    const harness = setup();
    const first = make(harness, { name: "First", calls: numbers(2), concurrency: 2 });
    const second = make(harness, { name: "Second", calls: numbers(1, 300) });
    await advance(5_000);
    harness.placed[0]!.watch({ type: "answered", callSid: "CA1" });
    const [newest, oldest] = harness.campaigns.list();
    expect([newest!.id, oldest!.id]).toEqual([second, first]);
    expect(oldest).toMatchObject({ name: "First", total: 2, counts: { answered: 1, calling: 1, waiting: 0 } });
    expect(JSON.stringify(oldest)).not.toContain("+1415");
  });
});

describe("limits", () => {
  it("allows three campaigns to be scheduled or running, and refuses a fourth", () => {
    const harness = setup();
    const ids = [make(harness), make(harness, { startAt: "2026-06-05T10:00:00Z" }), make(harness)];
    const fourth = harness.campaigns.create({ calls: numbers(1) });
    expect(fourth).toMatchObject({ ok: false, status: 409 });
    expect(fourth.ok ? "" : fourth.problem).toContain("3");
    // A cancelled campaign frees its place.
    harness.campaigns.cancel(ids[0]!);
    expect(harness.campaigns.create({ calls: numbers(1) }).ok).toBe(true);
  });

  it("keeps 50 finished campaigns and drops the oldest", () => {
    const harness = setup();
    const ids: string[] = [];
    for (let index = 0; index < 53; index += 1) {
      const id = make(harness, { calls: numbers(1) });
      harness.campaigns.cancel(id);
      ids.push(id);
    }
    const kept = harness.campaigns.list().map((campaign) => campaign.id);
    expect(kept).toHaveLength(50);
    expect(kept).not.toContain(ids[0]);
    expect(kept).not.toContain(ids[2]);
    expect(kept).toContain(ids[3]);
    expect(kept).toContain(ids[52]);
  });
});

describe("keeping campaigns in a file", () => {
  it("writes the state with mode 0600, and reads it back after a restart", async () => {
    const file = path.join(directory, "campaigns.json");
    const first = setup({ file, place: () => ({ ok: true, callSid: "CA1" }) });
    const id = make(first, { name: "Saved", calls: numbers(3), carrier: "twilio" });
    await pass(first, 3_000);
    await first.campaigns.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ campaigns: [{ id, name: "Saved" }] });

    const second = setup({ file });
    expect(second.campaigns.loadProblem).toBeUndefined();
    expect(second.campaigns.get(id)).toMatchObject({ name: "Saved", carrier: "twilio", total: 3 });
  });

  it("does not dial again a call that was on the line, and carries on with the waiting ones", async () => {
    const file = path.join(directory, "campaigns.json");
    const first = setup({ file });
    const id = make(first, { calls: numbers(3), concurrency: 2 });
    await pass(first, 3_000);
    first.placed[0]!.watch({ type: "answered", callSid: "CA1" });
    first.placed[1]!.watch({ type: "ended", callSid: "CA2", reason: "caller", durationMs: 3_000 });
    await pass(first, 1_000);
    expect(statuses(first, id)).toEqual(["answered", "completed", "calling"]);
    await first.campaigns.close();

    const second = setup({ file });
    expect(statuses(second, id)).toEqual(["unknown", "completed", "unknown"]);
    expect(second.campaigns.get(id)!.calls[0]).toMatchObject({ endedReason: "the relay restarted during the call" });
    await pass(second, 60_000);
    expect(second.placed).toHaveLength(0);
  });

  it("keeps waiting calls, including a retry that is not due yet", async () => {
    const file = path.join(directory, "campaigns.json");
    const first = setup({ file });
    const id = make(first, { calls: numbers(2), attempts: 2, retryAfterMinutes: 5 });
    await pass(first, 2_000);
    first.placed[0]!.watch({ type: "unanswered", callSid: "CA1", status: "busy" });
    await first.campaigns.close();

    const second = setup({ file });
    await pass(second, 2_000);
    // The second number has not been called yet and goes first.
    expect(second.placed.map((entry) => entry.input.to)).toEqual(["+14155550101"]);
    expect(statuses(second, id)[0]).toBe("waiting");
    second.placed[0]!.watch({ type: "ended", callSid: "CA1", reason: "caller", durationMs: 1 });
    await pass(second, 5 * 60_000);
    expect(second.placed.map((entry) => entry.input.to)).toContain("+14155550100");
  });

  it("writes at most about once a second", async () => {
    const file = path.join(directory, "campaigns.json");
    const harness = setup({ file, place: () => ({ ok: true, callSid: "CA1" }) });
    const id = make(harness, { calls: numbers(1) });
    await settleFile();
    expect(JSON.parse(readFileSync(file, "utf8")).campaigns[0].cancelled).toBe(false);

    harness.campaigns.cancel(id);
    await advance(500);
    await realSleep(30);
    expect(JSON.parse(readFileSync(file, "utf8")).campaigns[0].cancelled).toBe(false);
    await advance(600);
    await realSleep(30);
    expect(JSON.parse(readFileSync(file, "utf8")).campaigns[0].cancelled).toBe(true);
  });

  it("works from memory without a file", async () => {
    const harness = setup();
    make(harness);
    await harness.campaigns.close();
    expect(harness.campaigns.loadProblem).toBeUndefined();
  });

  it("starts empty when there is no file yet", () => {
    const harness = setup({ file: path.join(directory, "none.json") });
    expect(harness.campaigns.list()).toEqual([]);
    expect(harness.campaigns.loadProblem).toBeUndefined();
  });

  it.each([
    ["not JSON", "{ nope"],
    ["the wrong shape", JSON.stringify({ campaigns: "many" })],
    [
      "a call with an unknown status",
      JSON.stringify({
        campaigns: [
          {
            id: "a",
            createdAt: "x",
            concurrency: 1,
            attempts: 1,
            calls: [{ to: "+14155550100", attempts: 0, status: "lost" }]
          }
        ]
      })
    ]
  ])("reports a corrupt file (%s) and leaves it alone until a campaign is created", async (_name, content) => {
    const file = path.join(directory, "campaigns.json");
    writeFileSync(file, content);
    const harness = setup({ file });
    expect(harness.campaigns.loadProblem).toContain("CAMPAIGNS_FILE");
    expect(harness.campaigns.list()).toEqual([]);
    await advance(5_000);
    await harness.campaigns.close();
    expect(readFileSync(file, "utf8")).toBe(content);

    const again = setup({ file });
    make(again);
    await settleFile();
    expect(JSON.parse(readFileSync(file, "utf8")).campaigns).toHaveLength(1);
  });
});

describe("not dialling anybody twice", () => {
  it("does not dial again a call it placed just before a crash", async () => {
    const file = path.join(directory, "campaigns.json");
    // The carrier takes its time: the relay dies while it waits for the answer.
    const first = setup({ file, place: () => new Promise<PlaceResult>(() => undefined) });
    const id = make(first, { calls: numbers(2), attempts: 3 });
    await pass(first, 1_000);
    expect(first.placed.map((entry) => entry.input.to)).toEqual(["+14155550100"]);
    // No close(): what is on disk is all a new process has.
    const second = setup({ file });
    expect(second.campaigns.get(id)!.calls[0]).toMatchObject({
      status: "unknown",
      attempts: 1,
      endedReason: "the relay restarted during the call"
    });
    await pass(second, 5_000);
    expect(second.placed.map((entry) => entry.input.to)).toEqual(["+14155550101"]);
    await first.campaigns.close();
    await second.campaigns.close();
  });

  it("knows from the journal alone that a call was placed, when the file is older", async () => {
    const file = path.join(directory, "campaigns.json");
    const first = setup({ file });
    const id = make(first, { calls: numbers(2), concurrency: 2 });
    await pass(first, 3_000);
    await first.campaigns.close();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    // The file as it was before either call: both waiting, and no line of the journal known.
    for (const call of saved.campaigns[0].calls) Object.assign(call, { status: "waiting", attempts: 0 });
    writeFileSync(file, JSON.stringify({ ...saved, journalSeq: 0 }));
    writeFileSync(
      `${file}.journal`,
      `${JSON.stringify({ seq: 1, campaign: id, to: "+14155550100", attempts: 1, at: "2026-06-01T10:00:00.000Z" })}\n{"seq":2,"campa`
    );
    const second = setup({ file });
    expect(statuses(second, id)).toEqual(["unknown", "waiting"]);
    await pass(second, 3_000);
    // The line cut short was never followed by a call: that number is still to be called.
    expect(second.placed.map((entry) => entry.input.to)).toEqual(["+14155550101"]);
    await second.campaigns.close();
    // Once the file knows everything, the journal is gone.
    expect(existsSync(`${file}.journal`)).toBe(false);
  });

  it("places no call that it cannot write down first", async () => {
    const folder = path.join(directory, "later");
    const file = path.join(folder, "campaigns.json");
    const harness = setup({ file });
    const id = make(harness, { calls: numbers(2) });
    await pass(harness, 10_000);
    expect(harness.placed).toHaveLength(0);
    expect(harness.campaigns.get(id)!.calls[0]).toMatchObject({ status: "waiting", attempts: 0 });
    // The disk is back: placing goes on within half a minute.
    mkdirSync(folder);
    await pass(harness, 35_000);
    expect(harness.placed.length).toBeGreaterThan(0);
    await harness.campaigns.close();
  });

  it("stops placing when the relay begins to shut down, and still records how calls end", async () => {
    const file = path.join(directory, "campaigns.json");
    const harness = setup({ file });
    const id = make(harness, { calls: numbers(3) });
    await pass(harness, 500);
    expect(harness.placed).toHaveLength(1);
    harness.campaigns.stop();
    harness.placed[0]!.watch({ type: "ended", callSid: "CA1", reason: "shutdown", durationMs: 2_000 });
    await pass(harness, 10_000);
    expect(harness.placed).toHaveLength(1);
    await harness.campaigns.close();
    expect(
      JSON.parse(readFileSync(file, "utf8")).campaigns[0].calls.map((call: { status: string }) => call.status)
    ).toEqual(["completed", "waiting", "waiting"]);
    expect(statuses(harness, id)).toEqual(["completed", "waiting", "waiting"]);
  });

  it("does not call a number for two campaigns at the same time", async () => {
    const harness = setup();
    make(harness, { calls: numbers(1) });
    const second = make(harness, { calls: numbers(1) });
    await advance(10_000);
    expect(harness.placed).toHaveLength(1);
    expect(statuses(harness, second)).toEqual(["waiting"]);
    harness.placed[0]!.watch({ type: "ended", callSid: "CA1", reason: "caller", durationMs: 1 });
    await advance(2_000);
    expect(harness.placed).toHaveLength(2);
  });

  it("keeps a call that was answered before the carrier's error arrived", async () => {
    const harness = setup({
      place: (entry) => {
        entry.watch({ type: "answered", callSid: "CA9" });
        return { ok: false, status: 502, error: "Twilio could not be reached.", carrierStatus: 0 };
      }
    });
    const id = make(harness, { calls: numbers(1) });
    await advance(1_000);
    expect(harness.campaigns.get(id)!.calls[0]).toMatchObject({ status: "answered", callSid: "CA9" });
    harness.placed[0]!.watch({ type: "ended", callSid: "CA9", reason: "caller", durationMs: 5_000 });
    expect(statuses(harness, id)).toEqual(["completed"]);
  });

  it("tries again later when the relay had no line for someone who picked up", async () => {
    const harness = setup();
    const id = make(harness, { calls: numbers(1), attempts: 2, retryAfterMinutes: 10 });
    await advance(1_000);
    harness.placed[0]!.watch({ type: "refused", callSid: "CA1" });
    expect(harness.campaigns.get(id)!.calls[0]).toMatchObject({ status: "waiting", attempts: 1 });
    await advance(9 * 60_000);
    expect(harness.placed).toHaveLength(1);
    await advance(2 * 60_000);
    expect(harness.placed).toHaveLength(2);
    harness.placed[1]!.watch({ type: "refused", callSid: "CA2" });
    expect(harness.campaigns.get(id)!.calls[0]).toMatchObject({
      status: "failed",
      attempts: 2,
      endedReason: "every line of the relay was busy when the call was answered"
    });
  });

  it("marks a call cancelled when the campaign is cancelled while the lines are full", async () => {
    let cancel = (): void => undefined;
    const harness = setup({
      place: () => {
        cancel();
        return { ok: false, status: 429, error: "Every line is busy." };
      }
    });
    const id = make(harness, { calls: numbers(2) });
    cancel = () => harness.campaigns.cancel(id);
    await advance(1_000);
    expect(statuses(harness, id)).toEqual(["cancelled", "cancelled"]);
    expect(harness.campaigns.get(id)).toMatchObject({ status: "cancelled", counts: { waiting: 0, calling: 0 } });
  });
});

describe("a carrier that cannot be used", () => {
  it("stops the campaign after five calls in a row could not be placed, and says why", async () => {
    const harness = setup({
      place: () => ({ ok: false, status: 502, error: "Twilio refused the call (HTTP 401).", carrierStatus: 401 })
    });
    const id = make(harness, { calls: numbers(8) });
    await advance(60_000);
    expect(harness.placed).toHaveLength(5);
    const campaign = harness.campaigns.get(id)!;
    expect(campaign.status).toBe("cancelled");
    expect(campaign.stoppedReason).toContain("5 calls in a row could not be placed");
    expect(campaign.stoppedReason).toContain("HTTP 401");
    expect(campaign.counts).toMatchObject({ failed: 5, cancelled: 3 });
  });

  it("carries on when the carrier refuses single numbers", async () => {
    let count = 0;
    const harness = setup({
      place: () => {
        count += 1;
        return count <= 6
          ? { ok: false, status: 502, error: "Twilio refused the call (HTTP 400).", carrierStatus: 400 }
          : { ok: true, callSid: `CA${count}` };
      }
    });
    const id = make(harness, { calls: numbers(8), concurrency: 8 });
    await advance(60_000);
    expect(harness.placed).toHaveLength(8);
    expect(harness.campaigns.get(id)!.counts).toMatchObject({ failed: 6, calling: 2 });
  });

  it("starts counting again after a call that could be placed", async () => {
    let count = 0;
    const harness = setup({
      place: () => {
        count += 1;
        return count % 5 === 0
          ? { ok: true, callSid: `CA${count}` }
          : { ok: false, status: 502, error: "Twilio could not be reached.", carrierStatus: 0 };
      }
    });
    const id = make(harness, { calls: numbers(12), concurrency: 12 });
    await advance(60_000);
    expect(harness.placed).toHaveLength(12);
    expect(harness.campaigns.get(id)!.stoppedReason).toBeUndefined();
  });
});

describe("times and saved files that are odd", () => {
  it("waits for a start weeks ahead without spinning", async () => {
    const harness = setup();
    make(harness, { calls: numbers(1), startAt: "2026-06-30T10:00:00Z" });
    const warned = vi.spyOn(process, "emitWarning");
    await advance(3 * 60 * 60_000);
    // One look an hour, not one a millisecond.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
    expect(warned).not.toHaveBeenCalled();
    expect(harness.placed).toHaveLength(0);
    await advance(29 * 24 * 60 * 60_000);
    expect(harness.placed).toHaveLength(1);
    warned.mockRestore();
  });

  it.each([
    ["no offset", "2026-06-02T09:00:00"],
    ["a day that does not exist", "2026-02-31T09:00:00Z"],
    ["a date only", "2026-06-02"],
    ["words", "tomorrow at nine"]
  ])("refuses a start time with %s", (_name, startAt) => {
    const result = setup().campaigns.create({ calls: numbers(1), startAt });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((result as { problem: string }).problem).toContain("startAt must be a time with its offset");
  });

  it("takes a start time with an offset", () => {
    const result = setup().campaigns.create({ calls: numbers(1), startAt: "2026-06-02T09:00:00+02:00" });
    expect(result).toMatchObject({ ok: true, campaign: { startAt: "2026-06-02T07:00:00.000Z", status: "scheduled" } });
  });

  it.each([
    ["a time zone that does not exist", { window: { from: "09:00", to: "18:00", timeZone: "Bad/Zone" } }],
    ["a start that is not a time", { startAt: "soon" }],
    ["no room for a call", { concurrency: 0 }]
  ])("does not load a saved campaign with %s, and keeps running", async (_name, odd) => {
    const file = path.join(directory, "campaigns.json");
    const campaign = {
      id: "a",
      createdAt: "2026-06-01T09:00:00.000Z",
      concurrency: 1,
      attempts: 1,
      retryAfterMinutes: 30,
      cancelled: false,
      calls: [{ to: "+14155550100", attempts: 0, status: "waiting" }],
      ...odd
    };
    writeFileSync(file, JSON.stringify({ version: 1, campaigns: [campaign] }));
    const harness = setup({ file });
    expect(harness.campaigns.loadProblem).toContain("CAMPAIGNS_FILE");
    await pass(harness, 5_000);
    expect(harness.placed).toHaveLength(0);
    await harness.campaigns.close();
  });
});
