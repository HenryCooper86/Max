import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../server/logger";
import { telnyxCarrier, type TelnyxSettings } from "../server/telephony/telnyx";
import {
  createTelephony,
  type CallProgress,
  type StreamSocket,
  type TelephonySettings
} from "../server/telephony/twilio-calls";
import { twilioSignature } from "../server/telephony/twilio-stream";

// What a caller who watches a placed call is told, and the status callback the
// carrier sends for calls nobody answers. The carriers are stand-ins.

const TOKEN = "test-auth-token";
const SID = "ACtest0123456789";
const ORIGIN = "https://relay.example.com";
const SECRET = "telnyx-hook-secret-0123456789";
const PUBLIC = "https://voice.example.com";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Listener = (...args: unknown[]) => void;

class FakeSocket implements StreamSocket {
  readyState = 1;
  private listeners = new Map<string, Listener[]>();
  send(): void {}
  close(): void {}
  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  twilio(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
}

const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const deps = () => ({
  log: logger(),
  openSession: () => ({ handleMessage: vi.fn(async () => {}), close: vi.fn() })
});

function twilio(overrides: Partial<TelephonySettings> = {}) {
  const request = vi.fn(async () => json({ sid: "CAout1" }, 201));
  const settings: TelephonySettings = {
    authToken: TOKEN,
    accountSid: SID,
    phoneNumber: "+14155550199",
    transferTargets: new Map(),
    maxCalls: 20,
    ...overrides
  };
  const telephony = createTelephony(settings, { ...deps(), request: request as unknown as typeof fetch });
  return { telephony, request };
}

function telnyx(overrides: Partial<TelnyxSettings> = {}) {
  const request = vi.fn(async () => json({ from: "+1", to: "+1", status: "queued" }));
  const settings: TelnyxSettings = {
    webhookSecret: SECRET,
    apiKey: "KEY",
    accountSid: "acct",
    applicationSid: "app",
    phoneNumber: "+14155550100",
    publicUrl: PUBLIC,
    transferTargets: new Map(),
    maxCalls: 20,
    ...overrides
  };
  const telephony = createTelephony(settings, deps(), telnyxCarrier(settings, request as unknown as typeof fetch));
  return { telephony, request };
}

/** Places a watched Twilio call and returns the plan's voice and status URLs. */
async function placeWatched(harness: ReturnType<typeof twilio>, input: Record<string, unknown> = {}) {
  const events: CallProgress[] = [];
  const result = await harness.telephony.placeCall({ to: "+14155550123", ...input }, ORIGIN, (p) => events.push(p));
  const [, init] = harness.request.mock.calls.at(-1) as unknown as [string, RequestInit];
  const form = new URLSearchParams(String(init.body));
  return { events, result, form, voiceUrl: form.get("Url") ?? "", statusUrl: form.get("StatusCallback") ?? "" };
}

function twilioVoice(harness: ReturnType<typeof twilio>, url: string, params: Record<string, string> = {}) {
  const all = { CallSid: "CAout1", From: "+14155550199", To: "+14155550123", AnsweredBy: "human", ...params };
  return harness.telephony.voiceWebhook({ url, params: all, signature: twilioSignature(TOKEN, url, all) });
}

function twilioStatus(harness: ReturnType<typeof twilio>, url: string, params: Record<string, string>, token = TOKEN) {
  const all = { CallSid: "CAout1", ...params };
  return harness.telephony.statusWebhook({ url, params: all, signature: twilioSignature(token, url, all) });
}

const ticketOf = (body: string): string => /<Parameter name="ticket" value="([^"]+)"\/>/.exec(body)![1]!;

async function connectStream(harness: ReturnType<typeof twilio>, body: string, callSid = "CAout1") {
  const socket = new FakeSocket();
  harness.telephony.handleStream(socket);
  socket.twilio({
    event: "start",
    start: { streamSid: "MZ1", callSid, accountSid: SID, customParameters: { ticket: ticketOf(body) } }
  });
  await vi.advanceTimersByTimeAsync(0);
  return socket;
}

describe("watching a placed call", () => {
  it("tells the watcher when the call is answered and when it ends, with its length", async () => {
    const harness = twilio();
    const { events, voiceUrl } = await placeWatched(harness);
    const response = twilioVoice(harness, voiceUrl);
    expect(events).toEqual([{ type: "answered", callSid: "CAout1" }]);
    const socket = await connectStream(harness, response.body);
    await vi.advanceTimersByTimeAsync(42_000);
    socket.emit("close");
    expect(events).toEqual([
      { type: "answered", callSid: "CAout1" },
      { type: "ended", callSid: "CAout1", reason: "caller", durationMs: 42_000 }
    ]);
  });

  it("reports a machine with whether a message was left", async () => {
    const harness = twilio();
    const left = await placeWatched(harness, { voicemailMessage: "Call us back." });
    twilioVoice(harness, left.voiceUrl, { AnsweredBy: "machine_end_beep" });
    expect(left.events).toEqual([
      { type: "machine", callSid: "CAout1", answeredBy: "machine_end_beep", voicemailLeft: true }
    ]);

    const silent = await placeWatched(harness);
    twilioVoice(harness, silent.voiceUrl, { AnsweredBy: "machine_start" });
    expect(silent.events[0]).toMatchObject({ type: "machine", voicemailLeft: false });

    const fax = await placeWatched(harness, { voicemailMessage: "Hello" });
    twilioVoice(harness, fax.voiceUrl, { AnsweredBy: "fax" });
    expect(fax.events[0]).toMatchObject({ type: "machine", answeredBy: "fax", voicemailLeft: false });
  });

  it.each(["busy", "no-answer", "failed", "canceled"] as const)(
    "reports %s from the status callback",
    async (outcome) => {
      const harness = twilio();
      const { events, statusUrl } = await placeWatched(harness);
      expect(twilioStatus(harness, statusUrl, { CallStatus: outcome })).toEqual({ status: 200 });
      expect(events).toEqual([{ type: "unanswered", callSid: "CAout1", status: outcome }]);
    }
  );

  it("gives the carrier a status URL only for a watched call", async () => {
    const harness = twilio();
    const { form, statusUrl } = await placeWatched(harness);
    expect(statusUrl).toMatch(/^https:\/\/relay\.example\.com\/telephony\/twilio\/status\?plan=[A-Za-z0-9_-]+$/);
    expect(form.get("StatusCallbackMethod")).toBe("POST");

    await harness.telephony.placeCall({ to: "+14155550123" }, ORIGIN);
    const [, init] = harness.request.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect([...new URLSearchParams(String(init.body)).keys()]).not.toContain("StatusCallback");
  });

  it("reports unknown when nothing is heard within three minutes", async () => {
    const harness = twilio();
    const { events } = await placeWatched(harness);
    await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(events).toEqual([{ type: "unknown" }]);
  });

  it("reports unknown when the call is answered but its stream never connects", async () => {
    const harness = twilio();
    const { events, voiceUrl } = await placeWatched(harness);
    twilioVoice(harness, voiceUrl);
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1);
    expect(events).toEqual([{ type: "answered", callSid: "CAout1" }, { type: "unknown" }]);
  });

  it("does not time out a call whose conversation is going on", async () => {
    const harness = twilio();
    const { events, voiceUrl } = await placeWatched(harness);
    const response = twilioVoice(harness, voiceUrl);
    const socket = await connectStream(harness, response.body);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(events).toEqual([{ type: "answered", callSid: "CAout1" }]);
    socket.emit("close");
    expect(events.at(-1)).toMatchObject({ type: "ended", durationMs: 10 * 60_000 });
  });

  it("gives one last word only: a completed status after the end, or a replayed status, adds nothing", async () => {
    const harness = twilio();
    const { events, voiceUrl, statusUrl } = await placeWatched(harness);
    const response = twilioVoice(harness, voiceUrl);
    const socket = await connectStream(harness, response.body);
    // The carrier's callback can come before the stream's end, or after it.
    expect(twilioStatus(harness, statusUrl, { CallStatus: "completed" }).status).toBe(200);
    socket.emit("close");
    expect(twilioStatus(harness, statusUrl, { CallStatus: "completed" }).status).toBe(200);
    expect(twilioStatus(harness, statusUrl, { CallStatus: "busy" }).status).toBe(200);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(events.map((event) => event.type)).toEqual(["answered", "ended"]);

    const unanswered = await placeWatched(harness);
    twilioStatus(harness, unanswered.statusUrl, { CallStatus: "no-answer" });
    twilioStatus(harness, unanswered.statusUrl, { CallStatus: "no-answer" });
    twilioStatus(harness, unanswered.statusUrl, { CallStatus: "failed" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(unanswered.events).toEqual([{ type: "unanswered", callSid: "CAout1", status: "no-answer" }]);
  });

  it("ignores a status for a call that was answered but never reached its stream, until the timer", async () => {
    const harness = twilio();
    const { events, voiceUrl, statusUrl } = await placeWatched(harness);
    twilioVoice(harness, voiceUrl);
    twilioStatus(harness, statusUrl, { CallStatus: "failed" });
    expect(events.map((event) => event.type)).toEqual(["answered"]);
  });

  it("ignores statuses that are not final, and plans it does not know", async () => {
    const harness = twilio();
    const { events, statusUrl } = await placeWatched(harness);
    expect(twilioStatus(harness, statusUrl, { CallStatus: "ringing" }).status).toBe(200);
    expect(twilioStatus(harness, statusUrl, { CallStatus: "completed" }).status).toBe(200);
    const other = `${ORIGIN}/telephony/twilio/status?plan=nothing`;
    expect(twilioStatus(harness, other, { CallStatus: "busy" }).status).toBe(200);
    expect(events).toEqual([]);
  });

  it("refuses a status callback with a wrong signature, and changes nothing", async () => {
    const harness = twilio();
    const { events, statusUrl } = await placeWatched(harness);
    expect(twilioStatus(harness, statusUrl, { CallStatus: "busy" }, "other-token")).toEqual({ status: 403 });
    expect(
      harness.telephony.statusWebhook({
        url: statusUrl,
        params: { CallSid: "CAout1", CallStatus: "busy" },
        signature: undefined
      })
    ).toEqual({ status: 403 });
    expect(events).toEqual([]);
  });

  it("keeps a failing watcher out of the call", async () => {
    const harness = twilio();
    let calls = 0;
    await harness.telephony.placeCall({ to: "+14155550123" }, ORIGIN, () => {
      calls += 1;
      throw new Error("boom");
    });
    const [, init] = harness.request.mock.calls.at(-1) as unknown as [string, RequestInit];
    const voiceUrl = new URLSearchParams(String(init.body)).get("Url")!;
    const response = twilioVoice(harness, voiceUrl);
    expect(response.status).toBe(200);
    expect(response.body).toContain("<Stream");
    expect(calls).toBe(1);
  });

  it("hears nothing about a call that could not be placed", async () => {
    const harness = twilio();
    harness.request.mockImplementation(async () => json({}, 500));
    const events: CallProgress[] = [];
    const result = await harness.telephony.placeCall({ to: "+14155550123" }, ORIGIN, (p) => events.push(p));
    expect(result).toMatchObject({ ok: false, status: 502 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(events).toEqual([]);
  });

  it("explains why calls cannot be placed", () => {
    expect(twilio({ accountSid: undefined }).telephony.placeProblem()).toContain("TWILIO_ACCOUNT_SID");
    expect(twilio().telephony.placeProblem()).toBeUndefined();
    expect(telnyx({ publicUrl: undefined }).telephony.placeProblem()).toContain("TELEPHONY_PUBLIC_URL");
  });
});

describe("the relay's lines and watched calls", () => {
  it("counts a call that is still ringing as a line taken", async () => {
    const harness = twilio({ maxCalls: 1 });
    const first = await placeWatched(harness);
    expect(first.result.ok).toBe(true);
    // The first has not been answered yet, and will need the only line when it is.
    const second = await harness.telephony.placeCall({ to: "+14155550124" }, ORIGIN, () => undefined);
    expect(second).toMatchObject({ ok: false, status: 429 });
    twilioStatus(harness, first.statusUrl, { CallStatus: "no-answer" });
    expect((await placeWatched(harness)).result.ok).toBe(true);
  });

  it("frees the line a call was to have when nothing is heard of it", async () => {
    const harness = twilio({ maxCalls: 1 });
    const first = await placeWatched(harness);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(first.events).toEqual([{ type: "unknown" }]);
    expect((await placeWatched(harness)).result.ok).toBe(true);
    // Given up on: a late answer is not a conversation nobody is counting.
    expect(twilioVoice(harness, first.voiceUrl).body).not.toContain("<Stream");
  });

  it("tells the watcher when someone picked up and every line was taken", async () => {
    const harness = twilio({ maxCalls: 1 });
    const placed = await placeWatched(harness);
    // An inbound call takes the line while the outbound one rings.
    const inboundUrl = `${ORIGIN}/telephony/twilio/voice`;
    const inbound = twilioVoice(harness, inboundUrl, { CallSid: "CAin1", From: "+14155550150", To: "+14155550199" });
    await connectStream(harness, inbound.body, "CAin1");
    const answer = twilioVoice(harness, placed.voiceUrl);
    expect(answer.body).toContain("<Reject");
    expect(placed.events).toEqual([{ type: "refused", callSid: "CAout1" }]);
    // The carrier's word on the hung-up call adds nothing.
    twilioStatus(harness, placed.statusUrl, { CallStatus: "busy" });
    expect(placed.events).toHaveLength(1);
  });

  it("takes the call as placed when it is answered before the carrier's error arrives", async () => {
    const harness = twilio();
    const events: CallProgress[] = [];
    let voiceUrl = "";
    harness.request.mockImplementationOnce((async (_url: string, init: RequestInit) => {
      voiceUrl = new URLSearchParams(String(init.body)).get("Url") ?? "";
      // The call exists and is answered, and then the answer to the request is lost.
      twilioVoice(harness, voiceUrl);
      return json({ message: "gateway timeout" }, 504);
    }) as never);
    const result = await harness.telephony.placeCall({ to: "+14155550123" }, ORIGIN, (p) => events.push(p));
    expect(result).toEqual({ ok: true, callSid: "CAout1" });
    expect(events).toEqual([{ type: "answered", callSid: "CAout1" }]);
  });

  it("says what the carrier answered when it refuses a call", async () => {
    const harness = twilio();
    harness.request.mockImplementationOnce((async () => json({ message: "no" }, 401)) as never);
    expect(await harness.telephony.placeCall({ to: "+14155550123" }, ORIGIN, () => undefined)).toMatchObject({
      ok: false,
      status: 502,
      carrierStatus: 401
    });
  });
});

describe("watching a Telnyx call", () => {
  const CALL_ID = "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg";

  async function place(harness: ReturnType<typeof telnyx>) {
    const events: CallProgress[] = [];
    await harness.telephony.placeCall({ to: "+14155550123" }, "https://attacker.example", (p) => events.push(p));
    const [, init] = harness.request.mock.calls.at(-1) as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    return { events, body, voiceUrl: body.Url!, statusUrl: body.StatusCallback! };
  }

  it("asks Telnyx for a status callback on the secret URL, only when watched", async () => {
    const harness = telnyx();
    const { body, statusUrl } = await place(harness);
    expect(body.StatusCallbackMethod).toBe("POST");
    const url = new URL(statusUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${PUBLIC}/telephony/telnyx/status`);
    expect(url.searchParams.get("key")).toBe(SECRET);

    await harness.telephony.placeCall({ to: "+14155550123" }, "x");
    const [, init] = harness.request.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(Object.keys(JSON.parse(String(init.body)) as object)).not.toContain("StatusCallback");
  });

  it("needs the public URL to carry the secret", async () => {
    const harness = telnyx({ publicUrl: undefined });
    const result = await harness.telephony.placeCall({ to: "+14155550123" }, ORIGIN, () => {});
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it("reports an unanswered call from the status callback", async () => {
    const harness = telnyx();
    const { events, statusUrl } = await place(harness);
    const answer = harness.telephony.statusWebhook({
      url: statusUrl,
      params: { CallSid: CALL_ID, CallStatus: "no-answer" },
      signature: undefined
    });
    expect(answer).toEqual({ status: 200 });
    expect(events).toEqual([{ type: "unanswered", callSid: CALL_ID, status: "no-answer" }]);
    const replay = harness.telephony.statusWebhook({
      url: statusUrl,
      params: { CallSid: CALL_ID, CallStatus: "no-answer" },
      signature: undefined
    });
    expect(replay).toEqual({ status: 200 });
    expect(events).toHaveLength(1);
  });

  it("refuses a status callback without the secret", async () => {
    const harness = telnyx();
    const { events, statusUrl } = await place(harness);
    const wrong = statusUrl.replace(SECRET, "wrong-secret-0123456789abc");
    expect(
      harness.telephony.statusWebhook({ url: wrong, params: { CallStatus: "busy" }, signature: undefined })
    ).toEqual({ status: 403 });
    const bare = statusUrl.replace(/key=[^&]*&/, "");
    expect(
      harness.telephony.statusWebhook({ url: bare, params: { CallStatus: "busy" }, signature: undefined })
    ).toEqual({ status: 403 });
    expect(events).toEqual([]);
  });

  it("reports answered when Telnyx fetches the instructions", async () => {
    const harness = telnyx();
    const { events, voiceUrl } = await place(harness);
    harness.telephony.voiceWebhook({
      url: voiceUrl,
      params: { CallSid: CALL_ID, From: "+14155550100", To: "+14155550123" },
      signature: undefined
    });
    expect(events).toEqual([{ type: "answered", callSid: CALL_ID }]);
  });
});
