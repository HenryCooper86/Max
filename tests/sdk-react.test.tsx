// @vitest-environment happy-dom
import { StrictMode, createElement } from "react";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceAgentOptions, VoiceAgentStatus } from "../sdk/src/client";

type Handler = (payload: never) => void;

const fake = vi.hoisted(() => ({ agents: [] as unknown[] }));

vi.mock("../sdk/src/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sdk/src/client")>();
  class FakeAgent {
    status: VoiceAgentStatus = "idle";
    muted = false;
    destroyed = false;
    context: string | undefined;
    private handlers = new Map<string, Set<Handler>>();
    constructor(readonly options: VoiceAgentOptions) {
      fake.agents.push(this);
      this.context = options.context;
    }
    on(type: string, handler: Handler) {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set());
      this.handlers.get(type)!.add(handler);
      return () => void this.handlers.get(type)?.delete(handler);
    }
    emit(type: string, payload?: unknown) {
      for (const handler of this.handlers.get(type) ?? []) handler(payload as never);
    }
    start() {
      this.status = "listening";
      this.emit("status", "listening");
      return Promise.resolve();
    }
    stop() {
      this.status = "idle";
      this.emit("status", "idle");
    }
    mute() {
      this.muted = true;
    }
    unmute() {
      this.muted = false;
    }
    sendText() {
      return true;
    }
    sendImage() {
      return Promise.resolve(true);
    }
    videos: unknown[][] = [];
    startVideo(...args: unknown[]) {
      this.videos.push(args);
      this.emit("video", { active: true, source: args[0] ?? "camera" });
      return Promise.resolve({ id: "stream" });
    }
    stopVideo() {
      this.emit("video", { active: false });
    }
    setContext(text: string) {
      this.context = text;
    }
    destroy() {
      this.destroyed = true;
      this.handlers.clear();
    }
  }
  return { ...actual, VoiceAgent: FakeAgent };
});

import { VoiceAgentError } from "../sdk/src/client";
import { useVoiceAgent } from "../sdk/src/react";
import type { UseVoiceAgentResult } from "../sdk/src/react";

interface Fake {
  options: VoiceAgentOptions;
  destroyed: boolean;
  context: string | undefined;
  emit(type: string, payload?: unknown): void;
  start(): Promise<void>;
}
const agents = () => fake.agents as Fake[];
const live = () => agents().filter((a) => !a.destroyed);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let result: UseVoiceAgentResult;
function Probe({ options }: { options: VoiceAgentOptions }) {
  result = useVoiceAgent(options);
  return null;
}

let renderer: ReactTestRenderer | undefined;
async function render(options: VoiceAgentOptions, wrap?: (children: ReactNode) => ReactNode) {
  const tree = createElement(Probe, { options });
  await act(async () => {
    if (renderer) renderer.update(wrap ? wrap(tree) : tree);
    else renderer = create(wrap ? wrap(tree) : tree);
  });
}

beforeEach(() => {
  fake.agents.length = 0;
  renderer = undefined;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

const base = { url: "https://relay.example.com" };

describe("useVoiceAgent", () => {
  it("creates one client after mount and destroys it on unmount", async () => {
    await render(base);
    expect(live()).toHaveLength(1);
    expect(result.agent).toBe(live()[0]);
    await act(async () => renderer!.unmount());
    renderer = undefined;
    expect(live()).toHaveLength(0);
  });

  it("passes pictures to the client", async () => {
    await render(base);
    await expect(result.sendImage("data:image/png;base64,AAAA", { text: "hi" })).resolves.toBe(true);
  });

  it("passes live video to the client, and says what is being shown", async () => {
    await render(base);
    expect(result.video).toBeUndefined();
    let stream: unknown;
    await act(async () => {
      stream = await result.startVideo("screen", { intervalMs: 2000 });
    });
    expect(stream).toEqual({ id: "stream" });
    expect((live()[0] as unknown as { videos: unknown[][] }).videos).toEqual([["screen", { intervalMs: 2000 }]]);
    expect(result.video).toBe("screen");
    await act(async () => result.stopVideo());
    expect(result.video).toBeUndefined();
  });

  it("does not recreate the client for inline objects, functions and new handlers", async () => {
    const make = (n: number): VoiceAgentOptions => ({
      ...base,
      token: () => Promise.resolve(`t${n}`),
      tools: [{ name: "a", description: "A", parameters: { type: "object", properties: {} }, handler: () => n }]
    });
    await render(make(1));
    const first = result.agent;
    await render(make(2));
    await render(make(3));
    expect(agents()).toHaveLength(1);
    expect(result.agent).toBe(first);
  });

  it("calls the latest token function and tool handler", async () => {
    await render({
      ...base,
      token: () => Promise.resolve("old"),
      tools: [{ name: "a", description: "A", handler: () => 1 }]
    });
    await render({
      ...base,
      token: () => Promise.resolve("new"),
      tools: [{ name: "a", description: "A", handler: () => 2 }]
    });
    const options = agents()[0]!.options;
    expect(await (options.token as () => Promise<string>)()).toBe("new");
    expect(options.tools![0]!.handler({})).toBe(2);
  });

  for (const [name, next] of [
    ["url", { url: "https://other.example.com" }],
    ["token", { token: "vst_new" }],
    ["project", { project: "pub_2" }],
    ["language", { language: "zh" }],
    ["voice", { voice: "male" }],
    ["backend", { backend: "doubao" }],
    ["transport", { transport: "webrtc" }],
    ["iceServers", { iceServers: [{ urls: "stun:stun.example.com" }] }],
    ["tools", { tools: [{ name: "b", description: "B", handler: () => 0 }] }]
  ] as Array<[string, Partial<VoiceAgentOptions>]>) {
    it(`recreates the client when ${name} changes`, async () => {
      await render({ ...base, language: "en", voice: "female", token: "vst_old" });
      const first = agents()[0]!;
      await render({ ...base, language: "en", voice: "female", token: "vst_old", ...next });
      expect(first.destroyed).toBe(true);
      expect(live()).toHaveLength(1);
      expect(result.agent).toBe(live()[0]);
      const { tools, ...rest } = next;
      expect(live()[0]!.options).toMatchObject(rest);
      if (tools) expect(live()[0]!.options.tools?.map((t) => t.name)).toEqual(tools.map((t) => t.name));
    });
  }

  it("resets state when it swaps clients", async () => {
    await render(base);
    await act(async () => void (await result.start()));
    expect(result.status).toBe("listening");
    await render({ ...base, language: "zh" });
    expect(result.status).toBe("idle");
    expect(result.transcript).toEqual([]);
  });

  it("follows context without recreating the client", async () => {
    await render({ ...base, context: "one" });
    await render({ ...base, context: "two" });
    expect(agents()).toHaveLength(1);
    expect(agents()[0]!.context).toBe("two");
  });

  it("survives strict-mode double mounting with exactly one live client", async () => {
    await render(base, (children) => createElement(StrictMode, null, children));
    expect(live()).toHaveLength(1);
    expect(result.agent).toBe(live()[0]);
    expect(agents().length).toBeGreaterThanOrEqual(2);
    await render({ ...base, language: "zh" }, (children) => createElement(StrictMode, null, children));
    expect(live()).toHaveLength(1);
    expect(result.agent).toBe(live()[0]);
    await act(async () => void (await result.start()));
    expect(result.status).toBe("listening");
  });

  it("reports client errors and clears them when start() is called again", async () => {
    await render(base);
    const error = new VoiceAgentError("usage_limit", "used up");
    await act(async () => agents()[0]!.emit("error", error));
    expect(result.error).toBe(error);
    await act(async () => void (await result.start()));
    expect(result.error).toBeUndefined();
  });

  it("rejects start() before mount with a VoiceAgentError", async () => {
    // Effects have not run during the first render pass, so the hook has no client yet.
    let early: Promise<void> | undefined;
    function Early() {
      const value = useVoiceAgent(base);
      early ??= value.start();
      early.catch(() => undefined);
      return null;
    }
    await act(async () => void (renderer = create(createElement(Early))));
    const error = await early!.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceAgentError);
    expect((error as VoiceAgentError).code).toBe("connection");
    expect((error as VoiceAgentError).message).toMatch(/not ready/);
  });

  it("mute and unmute track the client", async () => {
    await render(base);
    await act(async () => result.mute());
    expect(result.isMuted).toBe(true);
    await act(async () => result.unmute());
    expect(result.isMuted).toBe(false);
  });
});
