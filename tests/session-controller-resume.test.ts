import { describe, expect, it, vi } from "vitest";
import { IDLE_CLOSE_CODE } from "../shared/agent";
import { AgentSessionController, type AgentSessionHooks } from "../server/session-controller";
import type { AgentProvider, ProviderSessionContext } from "../server/providers/types";
import type { ToolDefinition } from "../server/tools";

type Sent = Record<string, unknown>;

function setup(hooks?: AgentSessionHooks, authenticatedUser?: { id: string; username: string }) {
  const send = vi.fn();
  const close = vi.fn();
  const client = { readyState: 1, OPEN: 1, send, close } as never;
  let context: ProviderSessionContext | undefined;
  const provider: AgentProvider = {
    start: async () => undefined,
    startAudio: async () => undefined,
    sendAudio: async () => undefined,
    stopAudio: async () => undefined,
    close: async () => undefined
  };
  const controller = new AgentSessionController(
    client,
    (socket) => ({
      ...provider,
      start: async (_event, ctx) => {
        context = ctx;
        socket.send(
          JSON.stringify({ type: "session.started", provider: "x", mode: "live", capabilities: {} }) as never
        );
      }
    }),
    undefined,
    "127.0.0.1",
    undefined,
    authenticatedUser,
    hooks
  );
  const start = async (extra: Record<string, unknown> = {}) => {
    await controller.handleMessage(
      Buffer.from(JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1, ...extra })),
      false
    );
  };
  const started = (): Sent | undefined =>
    send.mock.calls
      .map(([payload]) => {
        try {
          return JSON.parse(String(payload)) as Sent;
        } catch {
          return undefined;
        }
      })
      .find((event) => event?.type === "session.started");
  return { controller, start, started, send, close, context: () => context! };
}

describe("session resumption", () => {
  it("announces a resume id and the protocol in session.started", async () => {
    const s = setup();
    await s.start();
    const event = s.started()!;
    expect(event.resume).toMatch(/^rsm_/);
    expect(event.protocol).toBeDefined();
    expect(event.provider).toBe("x");
    await s.controller.close();
  });

  it("gives the provider saveResume and endSession", async () => {
    const s = setup();
    await s.start();
    expect(typeof s.context().saveResume).toBe("function");
    expect(typeof s.context().endSession).toBe("function");
    expect(s.context().resume).toBeUndefined();
    await s.controller.close();
  });

  it("resumes saved history in a second session under the same id", async () => {
    const first = setup();
    await first.start();
    const id = first.started()!.resume as string;
    first.context().saveResume!({ history: [{ speaker: "user", text: "hi" }] });
    await first.controller.close();

    const second = setup();
    await second.start({ resume: id });
    expect(second.context().resume).toEqual({ history: [{ speaker: "user", text: "hi" }] });
    expect(second.started()!.resume).toBe(id);
    await second.controller.close();
  });

  it("ignores a malformed resume id and starts fresh", async () => {
    const s = setup();
    await s.start({ resume: "not-a-resume-id" });
    expect(s.context().resume).toBeUndefined();
    const id = s.started()!.resume as string;
    expect(id).toMatch(/^rsm_/);
    expect(id).not.toBe("not-a-resume-id");
    await s.controller.close();
  });

  it("ignores a well-formed id the store never issued", async () => {
    const s = setup();
    const unknown = `rsm_${"A".repeat(32)}`;
    await s.start({ resume: unknown });
    expect(s.context().resume).toBeUndefined();
    expect(s.started()!.resume).not.toBe(unknown);
    await s.controller.close();
  });

  it("does not resume for a different token-grant user", async () => {
    const first = setup({ tokenGrant: { userId: "alice" } });
    await first.start();
    const id = first.started()!.resume as string;
    first.context().saveResume!({ history: [{ speaker: "user", text: "secret" }] });

    const other = setup({ tokenGrant: { userId: "bob" } });
    await other.start({ resume: id });
    expect(other.context().resume).toBeUndefined();
    expect(other.started()!.resume).not.toBe(id);

    const same = setup({ tokenGrant: { userId: "alice" } });
    await same.start({ resume: id });
    expect(same.context().resume?.history).toEqual([{ speaker: "user", text: "secret" }]);
    await Promise.all([first, other, same].map((s) => s.controller.close()));
  });

  it("does not resume for a different resumeScope", async () => {
    const first = setup({ resumeScope: "deployment-a" });
    await first.start();
    const id = first.started()!.resume as string;
    first.context().saveResume!({ history: [{ speaker: "agent", text: "hello" }] });

    const other = setup({ resumeScope: "deployment-b" });
    await other.start({ resume: id });
    expect(other.context().resume).toBeUndefined();

    const none = setup();
    await none.start({ resume: id });
    expect(none.context().resume).toBeUndefined();
    await Promise.all([first, other, none].map((s) => s.controller.close()));
  });

  it("keeps an agent in the saved state", async () => {
    const first = setup();
    await first.start();
    const id = first.started()!.resume as string;
    first.context().saveResume!({ history: [], agent: "billing" });
    const second = setup();
    await second.start({ resume: id });
    expect(second.context().resume).toEqual({ history: [], agent: "billing" });
    await Promise.all([first, second].map((s) => s.controller.close()));
  });
});

describe("relay-side ending and channel hooks", () => {
  it("endSession closes the client with the idle close code (final, no auto-reconnect) and the reason", async () => {
    const s = setup();
    await s.start();
    s.context().endSession!("idle");
    expect(s.close).toHaveBeenCalledWith(IDLE_CLOSE_CODE, "idle");
  });

  it("truncates a long end reason to 100 characters", async () => {
    const s = setup();
    await s.start();
    s.context().endSession!("r".repeat(300));
    expect(s.close).toHaveBeenCalledWith(IDLE_CLOSE_CODE, "r".repeat(100));
  });

  it("passes channel, sessionTools and trustedContext to the provider", async () => {
    const tool: ToolDefinition = {
      name: "transfer",
      description: "Transfer the call",
      parameters: { type: "object", properties: {} },
      handler: () => ({})
    };
    const s = setup({
      channel: "phone",
      sessionTools: [tool],
      trustedContext: "Caller number: +15551234567",
      tokenGrant: { userId: "u1", context: "Plan: pro" }
    });
    await s.start();
    expect(s.context().channel).toBe("phone");
    expect(s.context().sessionTools).toEqual([tool]);
    expect(s.context().trustedContext).toBe("Plan: pro\nCaller number: +15551234567");
    expect(s.context().userId).toBe("u1");
    await s.controller.close();
  });

  it("uses trustedContext alone when there is no grant context, and none when neither", async () => {
    const only = setup({ trustedContext: "Caller number: +1555" });
    await only.start();
    expect(only.context().trustedContext).toBe("Caller number: +1555");
    const none = setup();
    await none.start();
    expect(none.context()).not.toHaveProperty("trustedContext");
    expect(none.context()).not.toHaveProperty("channel");
    expect(none.context()).not.toHaveProperty("sessionTools");
    await Promise.all([only, none].map((s) => s.controller.close()));
  });
});
