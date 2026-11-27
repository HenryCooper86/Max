import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createProjectWebhooks, type ProjectConversationPayload } from "../server/cloud/conversation-webhook";
import type { ConversationTurn } from "../server/cloud/conversations";

const START = Date.UTC(2026, 10, 23, 9, 0, 0);
const TURNS: ConversationTurn[] = [
  { at: START + 1_000, speaker: "agent", text: "Hello!" },
  { at: START + 4_000, speaker: "user", text: "Where is my order?" },
  { at: START + 5_000, speaker: "tool", text: "check_order", ok: true, ms: 300 }
];

type Sent = { url: string; headers: Headers; body: string };

/** A server of the customer's that answers each request with the next status of the list. */
function receiver(statuses: Array<number | Error>) {
  const sent: Sent[] = [];
  const request = (async (input: string | URL | Request, init: RequestInit = {}) => {
    sent.push({ url: String(input), headers: new Headers(init.headers), body: String(init.body) });
    const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    if (next instanceof Error) throw next;
    return new Response(next === 204 ? null : "{}", { status: next });
  }) as typeof fetch;
  return { sent, request };
}

function ended(more: Record<string, unknown> = {}) {
  return {
    projectId: "prj_1",
    url: "https://shop.example.com/max/conversations",
    secret: "whsec_test",
    backend: "openai",
    source: "embed",
    sessionId: "sess-1",
    startedAt: START,
    endedAt: START + 61_400,
    seconds: 61.4,
    turns: TURNS,
    ...more
  };
}

const waits: number[] = [];
const sleep = async (ms: number) => void waits.push(ms);

describe("a Max Cloud project's conversation webhook", () => {
  it("sends what was said, signed with the project's secret, like the relay's own webhook", async () => {
    const { sent, request } = receiver([200]);
    const webhooks = createProjectWebhooks({ request, sleep, clock: () => START + 62_000 });
    webhooks.ended(ended());
    await webhooks.drain(1_000);
    expect(sent).toHaveLength(1);
    const { url, headers, body } = sent[0]!;
    expect(url).toBe("https://shop.example.com/max/conversations");
    const payload = JSON.parse(body) as ProjectConversationPayload;
    expect(payload).toMatchObject({
      type: "conversation.ended",
      project: { id: "prj_1" },
      source: "embed",
      session: {
        id: "sess-1",
        backend: "openai",
        channel: "web",
        startedAt: START,
        endedAt: START + 61_400,
        seconds: 61
      },
      transcript: TURNS
    });
    expect(payload.test).toBeUndefined();
    expect(headers.get("x-voice-agent-event")).toBe("conversation.ended");
    expect(headers.get("x-voice-agent-delivery")).toBe(payload.id);
    // The signature a receiver checks: HMAC-SHA256 of "<timestamp>.<body>".
    const timestamp = headers.get("x-voice-agent-timestamp")!;
    expect(headers.get("x-voice-agent-signature")).toBe(
      `sha256=${createHmac("sha256", "whsec_test").update(`${timestamp}.${body}`).digest("hex")}`
    );
    expect(webhooks.last("prj_1")).toEqual({ at: START + 62_000, ok: true, attempts: 1, status: 200 });
  });

  it("names the conversation's user when its session token did", async () => {
    const { sent, request } = receiver([200]);
    const webhooks = createProjectWebhooks({ request, sleep, clock: () => START + 62_000 });
    webhooks.ended(ended({ source: "api", userId: "their-user-42" }));
    webhooks.ended(ended());
    await webhooks.drain(1_000);
    const sessions = sent.map((one) => (JSON.parse(one.body) as ProjectConversationPayload).session);
    expect(sessions[0]).toMatchObject({ id: "sess-1", userId: "their-user-42" });
    // A session without a user has no userId at all, as in the relay's own record.
    expect(sessions[1]).not.toHaveProperty("userId");
  });

  it("tries again when the server is down, and says how it went", async () => {
    waits.length = 0;
    const { sent, request } = receiver([503, new Error("socket hang up"), 200]);
    const webhooks = createProjectWebhooks({ request, sleep });
    webhooks.ended(ended());
    await webhooks.drain(1_000);
    expect(sent).toHaveLength(3);
    expect(waits).toEqual([1_000, 5_000]);
    // One delivery, however often it is tried: a receiver can drop the repeats.
    expect(new Set(sent.map((one) => one.headers.get("x-voice-agent-delivery"))).size).toBe(1);
    expect(webhooks.last("prj_1")).toMatchObject({ ok: true, attempts: 3 });

    const down = receiver([500]);
    const failing = createProjectWebhooks({ request: down.request, sleep });
    failing.ended(ended());
    await failing.drain(1_000);
    expect(down.sent).toHaveLength(4);
    expect(failing.last("prj_1")).toMatchObject({ ok: false, attempts: 4, status: 500, error: "HTTP 500" });
    // A server that cannot be reached is said to be that, in words its owner can act on.
    const gone = receiver([new Error("shop.example.com could not be found: check the address")]);
    const unreachable = createProjectWebhooks({ request: gone.request, sleep });
    unreachable.ended(ended());
    await unreachable.drain(1_000);
    expect(unreachable.last("prj_1")).toMatchObject({
      ok: false,
      attempts: 4,
      error: "shop.example.com could not be found: check the address"
    });
    // An answer that says the request itself is wrong is not asked again.
    const refusing = receiver([401]);
    const refused = createProjectWebhooks({ request: refusing.request, sleep });
    refused.ended(ended());
    await refused.drain(1_000);
    expect(refusing.sent).toHaveLength(1);
    expect(refused.last("prj_1")).toMatchObject({ ok: false, attempts: 1, status: 401 });
  });

  it("sends nothing for a conversation in which nothing was said, or one it could not sign", async () => {
    const { sent, request } = receiver([200]);
    const webhooks = createProjectWebhooks({ request, sleep });
    webhooks.ended(ended({ turns: [] }));
    await webhooks.drain(100);
    expect(sent).toEqual([]);
    expect(webhooks.last("prj_1")).toBeUndefined();
    const unsigned = createProjectWebhooks({ request, sleep });
    unsigned.ended(ended({ secret: undefined }));
    await unsigned.drain(100);
    expect(sent).toEqual([]);
    expect(unsigned.last("prj_1")).toMatchObject({ ok: false, attempts: 0, error: expect.stringContaining("secret") });
  });

  it("does not pile conversations up behind a server that does not answer", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    const request = (async () => {
      asked += 1;
      await held;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const webhooks = createProjectWebhooks({ request, sleep });
    for (let index = 0; index < 25; index += 1) webhooks.ended(ended({ sessionId: `sess-${index}` }));
    // Another project is not held up by this one.
    webhooks.ended(ended({ projectId: "prj_2" }));
    await Promise.resolve();
    expect(asked).toBe(21);
    expect(webhooks.last("prj_1")).toMatchObject({ ok: false, attempts: 0, error: expect.stringContaining("20") });
    release();
    await vi.waitFor(() => expect(webhooks.last("prj_1")).toMatchObject({ ok: true }));
    // And there is room again.
    webhooks.ended(ended());
    await Promise.resolve();
    expect(asked).toBe(22);
    await webhooks.drain(1_000);
  });

  it("holds only so many conversations of all projects at once", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    const request = (async () => {
      asked += 1;
      await held;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const webhooks = createProjectWebhooks({ request, sleep });
    for (let project = 0; project < 25; project += 1) {
      for (let index = 0; index < 10; index += 1) webhooks.ended(ended({ projectId: `prj_${project}` }));
    }
    await Promise.resolve();
    expect(asked).toBe(200);
    expect(webhooks.last("prj_24")).toMatchObject({
      ok: false,
      attempts: 0,
      error: expect.stringContaining("too many")
    });
    release();
    await webhooks.drain(1_000);
  });

  it("does not wait out a pause between tries when the relay stops", async () => {
    const { sent, request } = receiver([500]);
    // The real pauses: one second after the first failure.
    const webhooks = createProjectWebhooks({ request });
    webhooks.ended(ended());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const began = Date.now();
    await webhooks.drain(20);
    await vi.waitFor(() =>
      expect(webhooks.last("prj_1")).toMatchObject({ ok: false, error: "delivery was cancelled" })
    );
    expect(Date.now() - began).toBeLessThan(500);
    expect(sent).toHaveLength(1);
  });

  it("gives up on what is still under way when the relay stops", async () => {
    const request = ((_input: unknown, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const webhooks = createProjectWebhooks({ request, sleep });
    webhooks.ended(ended());
    const began = Date.now();
    await webhooks.drain(50);
    expect(Date.now() - began).toBeLessThan(1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(webhooks.last("prj_1")).toMatchObject({ ok: false, error: "delivery was cancelled" });
  });

  it("sends one sample conversation for the console's test, marked as a test", async () => {
    const { sent, request } = receiver([204]);
    const webhooks = createProjectWebhooks({ request, sleep, clock: () => START });
    const target = { projectId: "prj_1", url: "https://shop.example.com/hook", secret: "whsec_test" };
    expect(await webhooks.test(target)).toMatchObject({ ok: true, status: 204 });
    const payload = JSON.parse(sent[0]!.body) as ProjectConversationPayload;
    expect(payload).toMatchObject({ type: "conversation.ended", test: true, project: { id: "prj_1" }, source: "test" });
    expect(payload.transcript.map((turn) => turn.speaker)).toEqual(["agent", "user", "tool", "agent"]);
    expect(sent[0]!.headers.get("x-voice-agent-signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
    // The header a receiver drops repeats by is the record's own id, as in a real delivery.
    expect(sent[0]!.headers.get("x-voice-agent-delivery")).toBe(payload.id);
    // A test that cannot be signed does not go out and say all is well: no real delivery would.
    const unsigned = receiver([200]);
    expect(
      await createProjectWebhooks({ request: unsigned.request, sleep }).test({ ...target, secret: undefined })
    ).toMatchObject({ ok: false, error: "the signing secret could not be read" });
    expect(unsigned.sent).toEqual([]);
    // A server that is too slow is said to be that.
    const slow = receiver([new Error("cancelled")]);
    expect(await createProjectWebhooks({ request: slow.request, sleep }).test(target)).toMatchObject({
      ok: false,
      error: "your server did not answer within 10 seconds"
    });
    // A test is no delivery: it does not stand in for the last real one.
    expect(webhooks.last("prj_1")).toBeUndefined();
    // What went wrong is said in words, once, with no second try.
    const failing = receiver([500]);
    expect(await createProjectWebhooks({ request: failing.request, sleep }).test(target)).toMatchObject({
      ok: false,
      status: 500,
      error: "your server answered HTTP 500"
    });
    expect(failing.sent).toHaveLength(1);
    const unreachable = receiver([new Error("tool address must be public, not a private one")]);
    expect(await createProjectWebhooks({ request: unreachable.request, sleep }).test(target)).toMatchObject({
      ok: false,
      error: "the address must be public, not a private one"
    });
  });
});
