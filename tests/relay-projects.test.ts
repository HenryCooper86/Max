/* eslint-disable @typescript-eslint/no-explicit-any -- relay events are inspected structurally */
// A Max Cloud project's session speaks as the project, with the project's
// model key, and none of the relay's own tools.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_CAPABILITIES } from "../shared/agent";
import { assistantLogoProblem, projectAssistantProfile, setAssistantProfileForTests } from "../server/assistant";
import { createLogger } from "../server/logger";
import type { EngineConfig, VoiceEngine } from "../server/providers/live/engine";
import { grokDialect, openAiDialect } from "../server/providers/live/openai-realtime";
import { createLiveProvider } from "../server/providers/live/session";
import { createSessionTokenStore } from "../server/session-tokens";
import type { ToolDefinition } from "../server/tools";

afterEach(() => setAssistantProfileForTests());

const RELAY_TOOL: ToolDefinition = {
  name: "owner_secret_tool",
  description: "The relay owner's tool",
  handler: () => 1
};

class FakeClient {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  json: Array<Record<string, any>> = [];
  send(data: string | Buffer) {
    if (typeof data === "string") this.json.push(JSON.parse(data) as Record<string, any>);
  }
  close() {}
}

async function projectSession(serverTools?: () => readonly ToolDefinition[]) {
  const client = new FakeClient();
  let config: EngineConfig | undefined;
  const engine: VoiceEngine = {
    responseMode: "auto",
    async connect(engineConfig) {
      config = engineConfig;
    },
    sendAudio() {},
    respond() {},
    cancel() {},
    close() {}
  };
  const provider = createLiveProvider(
    client as never,
    { id: "openai", label: "Test", capabilities: LIVE_CAPABILITIES, createEngine: () => engine },
    createLogger("test"),
    undefined,
    {
      fetchWeather: async () => Promise.reject(new Error("offline")),
      profile: projectAssistantProfile({
        name: "Lumi",
        instructions: "You help guests of the Harbor Hotel.",
        greeting: "Welcome to the Harbor Hotel."
      }),
      serverTools: serverTools ?? (() => [])
    }
  );
  await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, language: "en" }, { sessionId: "s" });
  return { client, config: () => config! };
}

describe("project sessions", () => {
  it("speak as the project, not as the relay's assistant", async () => {
    // The relay's own assistant is the stock helmet persona.
    setAssistantProfileForTests();
    const { config } = await projectSession();
    expect(config().instructions).toContain("You are Lumi");
    expect(config().instructions).toContain("Harbor Hotel");
    expect(config().instructions).not.toMatch(/摩托车|helmet/i);
  });

  it("answer without a wake word", async () => {
    const { config } = await projectSession();
    expect(config().manualResponse).toBe(false);
  });

  it("never see the relay owner's tools", async () => {
    const { config } = await projectSession(() => []);
    expect(config().tools).toEqual([]);
    expect(config().instructions).toContain("You have no tools");
    expect(JSON.stringify(config())).not.toContain(RELAY_TOOL.name);
  });

  it("build the persona without disturbing the relay's logo diagnostics", () => {
    const before = assistantLogoProblem();
    projectAssistantProfile({ name: "Lumi" });
    expect(assistantLogoProblem()).toBe(before);
  });
});

describe("project model keys", () => {
  it("override the relay's own key", () => {
    vi.stubEnv("OPENAI_API_KEY", "relay-key");
    vi.stubEnv("XAI_API_KEY", "relay-xai");
    expect(openAiDialect("project-key").apiKey).toBe("project-key");
    expect(openAiDialect().apiKey).toBe("relay-key");
    expect(grokDialect("project-xai").apiKey).toBe("project-xai");
    vi.unstubAllEnvs();
  });
});

describe("project session tokens", () => {
  it("carry the project and its customer", () => {
    const store = createSessionTokenStore(() => 1_000);
    const minted = store.mint({ userId: "guest-7" }, { projectId: "p1", customerId: "c1" });
    if (!minted.ok) throw new Error(minted.error);
    expect(store.grant(minted.token)).toMatchObject({
      userId: "guest-7",
      project: { projectId: "p1", customerId: "c1" }
    });
    const plain = store.mint({});
    if (!plain.ok) throw new Error(plain.error);
    expect(store.grant(plain.token)?.project).toBeUndefined();
  });
});
