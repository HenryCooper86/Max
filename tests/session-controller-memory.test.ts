import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantProfileFrom, setAssistantProfileForTests } from "../server/assistant";
import { AgentSessionController, type AgentSessionHooks } from "../server/session-controller";
import type { AgentProvider, ProviderSessionContext } from "../server/providers/types";
import {
  clearUserConversationMemory,
  externalUserMemoryKey,
  resetUserMemoryForTests,
  userConversationMemory
} from "../server/user-memory";

// Remembering a user between conversations when the relay knows them only by
// the id their own product put in a session token (`conversation.rememberUsers`).

afterEach(() => {
  setAssistantProfileForTests();
  resetUserMemoryForTests();
});

const remember = (extra: Record<string, unknown> = {}) =>
  setAssistantProfileForTests(
    assistantProfileFrom({ name: "Ava", device: "app", conversation: { rememberUsers: true }, ...extra })
  );

/** One session: what the provider was started with, and a way to make it "say" things. */
async function session(hooks?: AgentSessionHooks, start: Record<string, unknown> = {}) {
  const sent = vi.fn();
  const client = { readyState: 1, OPEN: 1, send: sent, close: vi.fn() } as never;
  let context: ProviderSessionContext | undefined;
  let emit: (payload: unknown) => void = () => {};
  const controller = new AgentSessionController(
    client,
    (socket, telemetry) => {
      emit = (payload) => telemetry.serverEvent(payload, 0);
      const provider: AgentProvider = {
        start: async (_event, ctx) => {
          context = ctx;
          socket.send(JSON.stringify({ type: "session.started", provider: "x", mode: "live", capabilities: {} }));
        },
        startAudio: async () => undefined,
        sendAudio: async () => undefined,
        stopAudio: async () => undefined,
        close: async () => undefined
      };
      return provider;
    },
    undefined,
    "127.0.0.1",
    undefined,
    undefined,
    hooks
  );
  await controller.handleMessage(
    Buffer.from(JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1, ...start })),
    false
  );
  const say = (speaker: "rider" | "agent", text: string) =>
    emit({ type: "transcript", speaker, text, final: true, turnId: `${speaker}-${text.length}` });
  /** The resume id the relay announced for this session. */
  const resumeId = (): string => {
    for (const [payload] of sent.mock.calls) {
      const event = JSON.parse(String(payload)) as { type?: string; resume?: string };
      if (event.type === "session.started" && event.resume) return event.resume;
    }
    throw new Error("no resume id was announced");
  };
  return { controller, context: () => context!, say, resumeId };
}

const asUser = (userId: string, extra: AgentSessionHooks = {}): AgentSessionHooks => ({
  tokenGrant: { userId },
  ...extra
});

describe("remembering a token-identified user between conversations", () => {
  it("is off unless the assistant's owner turns it on", async () => {
    setAssistantProfileForTests(assistantProfileFrom({ name: "Ava", device: "app" }));
    const first = await session(asUser("u-1"));
    first.say("rider", "My dog is called Biscuit.");
    await first.controller.close();
    expect(userConversationMemory(externalUserMemoryKey("u-1"))).toBeNull();
    const second = await session(asUser("u-1"));
    expect(second.context().previousConversation).toBeUndefined();
    await second.controller.close();
  });

  it("gives the next conversation of the same user what was said in the last one", async () => {
    remember();
    const first = await session(asUser("u-1"));
    first.say("rider", "My dog is called Biscuit.");
    first.say("agent", "Lovely name.");
    await first.controller.close();

    const second = await session(asUser("u-1"));
    const previous = second.context().previousConversation!;
    expect(previous.turns.map((turn) => turn.text)).toEqual(["My dog is called Biscuit.", "Lovely name."]);
    await second.controller.close();
  });

  it("never shows one user another user's conversation, and nothing to a session without a user", async () => {
    remember();
    const first = await session(asUser("u-1"));
    first.say("rider", "My dog is called Biscuit.");
    await first.controller.close();

    const other = await session(asUser("u-2"));
    expect(other.context().previousConversation).toBeUndefined();
    await other.controller.close();
    const anonymous = await session();
    anonymous.say("rider", "Nobody in particular here.");
    expect(anonymous.context().previousConversation).toBeUndefined();
    await anonymous.controller.close();
    // Ids that differ only in case or spacing are different users of the product.
    const cased = await session(asUser("U-1"));
    expect(cased.context().previousConversation).toBeUndefined();
    await cased.controller.close();
  });

  it("stores no user id, only a digest of it", async () => {
    remember();
    const first = await session(asUser("jane.doe@example.com"));
    first.say("rider", "Hello.");
    await first.controller.close();
    const key = externalUserMemoryKey("jane.doe@example.com");
    expect(key).toMatch(/^ext-[0-9a-f]{48}$/);
    expect(JSON.stringify(userConversationMemory(key))).not.toContain("jane.doe");
  });

  it("keeps the kinds of personal data the owner redacts out of memory", async () => {
    remember({ privacy: { redact: ["email"] } });
    const first = await session(asUser("u-1"));
    first.say("rider", "Write to me at jane.doe@example.com please.");
    await first.controller.close();
    const stored = userConversationMemory(externalUserMemoryKey("u-1"))!;
    expect(stored.turns[0]!.text).toBe("Write to me at [email] please.");
  });

  it("does not remember the users of a Max Cloud project", async () => {
    remember();
    const first = await session(asUser("u-1", { resumeScope: "cloud:proj-1" }));
    first.say("rider", "My dog is called Biscuit.");
    await first.controller.close();
    expect(userConversationMemory(externalUserMemoryKey("u-1"))).toBeNull();
  });

  it("forgets a user when asked", async () => {
    remember();
    const first = await session(asUser("u-1"));
    first.say("rider", "My dog is called Biscuit.");
    await first.controller.close();
    expect(clearUserConversationMemory(externalUserMemoryKey("u-1"))).toBe(true);
    const second = await session(asUser("u-1"));
    expect(second.context().previousConversation).toBeUndefined();
    await second.controller.close();
  });

  it("leaves the earlier turns to a resumed conversation, which carries its own", async () => {
    remember();
    const first = await session(asUser("u-1"));
    first.say("rider", "Remember that my dog is called Biscuit.");
    first.context().saveResume!({ history: [{ speaker: "user", text: "Remember that my dog is called Biscuit." }] });
    const id = first.resumeId();
    await first.controller.close();

    const resumed = await session(asUser("u-1"), { resume: id });
    expect(resumed.context().resume!.history).toHaveLength(1);
    // The turns are not given twice; what the user asked to be remembered still is.
    expect(resumed.context().previousConversation!.turns).toEqual([]);
    expect(
      resumed
        .context()
        .previousConversation!.facts.map((fact) => fact.text)
        .join(" ")
    ).toContain("Biscuit");
    await resumed.controller.close();

    const fresh = await session(asUser("u-1"));
    expect(fresh.context().previousConversation!.turns).toHaveLength(1);
    await fresh.controller.close();
  });
});
