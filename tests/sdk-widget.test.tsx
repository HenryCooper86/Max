// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceAgentOptions, VoiceAgentStatus } from "../sdk/src/client";

type Handler = (payload: never) => void;

/** Stands in for the real client so the widget can be driven without sockets or audio. */
const fake = vi.hoisted(() => ({ agents: [] as unknown[] }));

vi.mock("../sdk/src/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sdk/src/client")>();
  class FakeAgent {
    status: VoiceAgentStatus = "idle";
    muted = false;
    audioBlocked = false;
    destroyed = false;
    calls: string[] = [];
    startError: Error | undefined;
    private handlers = new Map<string, Set<Handler>>();
    constructor(readonly options: VoiceAgentOptions) {
      fake.agents.push(this);
    }
    on(type: string, handler: Handler) {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set());
      this.handlers.get(type)!.add(handler);
      return () => void this.handlers.get(type)?.delete(handler);
    }
    emit(type: string, payload?: unknown) {
      for (const handler of this.handlers.get(type) ?? []) handler(payload as never);
    }
    setStatus(status: VoiceAgentStatus) {
      this.status = status;
      this.emit("status", status);
    }
    start() {
      this.calls.push("start");
      if (this.startError) {
        const error = this.startError;
        this.emit("error", error);
        this.setStatus("error");
        return Promise.reject(error);
      }
      this.setStatus("listening");
      return Promise.resolve();
    }
    stop() {
      this.calls.push("stop");
      this.muted = false;
      this.setStatus("idle");
    }
    mute() {
      this.muted = true;
    }
    unmute() {
      this.muted = false;
    }
    sendText(text: string) {
      this.calls.push(`text:${text}`);
      return true;
    }
    capabilities: { imageInput?: boolean } | undefined;
    /** What the next sendImage does: resolve to this, or reject when it is an Error. */
    imageResult: boolean | Error = true;
    images: Array<{ source: unknown; options: { text?: string; maxSide?: number } }> = [];
    sendImage(source: unknown, options: { text?: string; maxSide?: number } = {}) {
      this.images.push({ source, options });
      return this.imageResult instanceof Error ? Promise.reject(this.imageResult) : Promise.resolve(this.imageResult);
    }
    resumeAudio() {
      this.calls.push("resumeAudio");
      this.audioBlocked = false;
      this.emit("audioresume");
      return Promise.resolve(true);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { ...actual, VoiceAgent: FakeAgent };
});

import { VoiceAgentError } from "../sdk/src/client";
import { VoiceAgentElement, defineVoiceAgentElement } from "../sdk/src/widget";

interface Fake {
  options: VoiceAgentOptions;
  status: VoiceAgentStatus;
  muted: boolean;
  audioBlocked: boolean;
  destroyed: boolean;
  calls: string[];
  startError: Error | undefined;
  capabilities: { imageInput?: boolean } | undefined;
  imageResult: boolean | Error;
  images: Array<{ source: unknown; options: { text?: string; maxSide?: number } }>;
  emit(type: string, payload?: unknown): void;
  setStatus(status: VoiceAgentStatus): void;
}
const agents = () => fake.agents as Fake[];
const lastAgent = () => agents().at(-1)!;

defineVoiceAgentElement();

function mount(attributes: Record<string, string> = {}): VoiceAgentElement {
  const element = document.createElement("voice-agent") as VoiceAgentElement;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}
const q = <T extends Element>(el: Element, selector: string) => el.shadowRoot!.querySelector<T>(selector)!;
const fab = (el: Element) => q<HTMLButtonElement>(el, ".fab");
const panel = (el: Element) => q<HTMLElement>(el, ".panel");
const note = (el: Element) => q<HTMLElement>(el, ".note");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function open(el: VoiceAgentElement) {
  fab(el).click();
  await flush();
  return lastAgent();
}

beforeEach(() => {
  fake.agents.length = 0;
  document.documentElement.removeAttribute("lang");
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("options from attributes", () => {
  it("builds the client from the attributes when the button is first used", async () => {
    const el = mount({
      relay: "https://relay.example.com",
      token: "vst_abc",
      language: "zh",
      voice: "male",
      backend: "doubao",
      context: "On the pricing page",
      project: "pub_1"
    });
    expect(agents()).toHaveLength(0);
    await open(el);
    expect(lastAgent().options).toEqual({
      url: "https://relay.example.com",
      token: "vst_abc",
      project: "pub_1",
      language: "zh",
      voice: "male",
      backend: "doubao",
      context: "On the pricing page"
    });
  });

  it("passes transport=webrtc to the client, and ignores any other value", async () => {
    await open(mount({ relay: "https://r.example.com", transport: "webrtc" }));
    expect(lastAgent().options.transport).toBe("webrtc");
    await open(mount({ relay: "https://r.example.com", transport: "udp" }));
    expect(lastAgent().options).not.toHaveProperty("transport");
  });

  it("ignores a voice that is not female or male", async () => {
    await open(mount({ relay: "https://r.example.com", voice: "robot" }));
    expect(lastAgent().options).not.toHaveProperty("voice");
  });

  it("passes the tools property and uses token-url for a fresh token on each connect", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ token: "vst_1" }))));
    vi.stubGlobal("fetch", fetchMock);
    const el = mount({ relay: "https://r.example.com", "token-url": "/api/voice-token" });
    el.tools = [{ name: "get_time", description: "Time.", handler: () => "now" }];
    await open(el);
    const options = lastAgent().options;
    expect(options.tools?.map((t) => t.name)).toEqual(["get_time"]);
    const token = options.token as () => Promise<string>;
    expect(await token()).toBe("vst_1");
    expect(await token()).toBe("vst_1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/voice-token", expect.objectContaining({ method: "POST" }));
  });

  it("falls back to GET when the token endpoint answers 405 to POST", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 405 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "vst_2" })));
    vi.stubGlobal("fetch", fetchMock);
    await open(mount({ relay: "https://r.example.com", "token-url": "/t" }));
    expect(await (lastAgent().options.token as () => Promise<string>)()).toBe("vst_2");
    expect(fetchMock.mock.calls.map((c) => (c as unknown as [string, { method: string }])[1].method)).toEqual([
      "POST",
      "GET"
    ]);
  });

  it("applies accent, text-input and the label attribute", () => {
    const el = mount({ accent: "#0a7d5a", "text-input": "", label: "Ask us" });
    expect(el.style.getPropertyValue("--va-accent")).toBe("#0a7d5a");
    expect(q<HTMLFormElement>(el, "form").hidden).toBe(false);
    expect(fab(el).getAttribute("aria-label")).toBe("Ask us");
    el.removeAttribute("accent");
    el.removeAttribute("text-input");
    expect(el.style.getPropertyValue("--va-accent")).toBe("");
    expect(q<HTMLFormElement>(el, "form").hidden).toBe(true);
  });
});

describe("lifecycle", () => {
  it("starts on click, shows the panel, and stops on the next click", async () => {
    const el = mount({ relay: "https://r.example.com" });
    expect(panel(el).hidden).toBe(true);
    const agent = await open(el);
    expect(agent.calls).toEqual(["start"]);
    expect(panel(el).hidden).toBe(false);
    expect(fab(el).getAttribute("aria-pressed")).toBe("true");
    fab(el).click();
    expect(agent.calls).toEqual(["start", "stop"]);
    expect(fab(el).getAttribute("aria-pressed")).toBe("false");
  });

  it("reuses the client between sessions and rebuilds it only after a connection attribute changed while idle", async () => {
    const el = mount({ relay: "https://r.example.com", language: "en" });
    const first = await open(el);
    fab(el).click();
    await open(el);
    expect(agents()).toHaveLength(1);
    fab(el).click();
    el.setAttribute("language", "zh");
    await open(el);
    expect(agents()).toHaveLength(2);
    expect(first.destroyed).toBe(true);
    expect(lastAgent().options.language).toBe("zh");
  });

  it("does not swap the client in the middle of a conversation", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const first = await open(el);
    el.setAttribute("voice", "male");
    expect(agents()).toHaveLength(1);
    expect(first.destroyed).toBe(false);
  });

  it("destroys the client when removed from the page", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const agent = await open(el);
    el.remove();
    expect(agent.destroyed).toBe(true);
    expect(el.agent).toBeUndefined();
  });

  it("shows the status text and mirrors client events as DOM events", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const seen: string[] = [];
    el.addEventListener("voice-agent:status", (e) => seen.push((e as CustomEvent<{ status: string }>).detail.status));
    const agent = await open(el);
    agent.setStatus("thinking");
    expect(q(el, ".state").textContent).toBe("Thinking");
    expect(q(el, '[role="status"]').textContent).toBe("Thinking");
    expect(seen).toEqual(["listening", "thinking"]);
  });

  it("renders transcript lines and updates them in place", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const agent = await open(el);
    const item = { id: "t1", role: "agent", text: "Hel", final: false, at: 1 };
    agent.emit("transcript", { transcript: [item], item });
    const done = { ...item, text: "Hello", final: true };
    agent.emit("transcript", { transcript: [done], item: done });
    const lines = el.shadowRoot!.querySelectorAll(".lines li");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe("Hello");
    expect((lines[0] as HTMLElement).dataset.role).toBe("agent");
  });

  it("sends typed text and clears the box only when it was sent", async () => {
    const el = mount({ relay: "https://r.example.com", "text-input": "" });
    const agent = await open(el);
    const input = q<HTMLInputElement>(el, "input");
    input.value = "hello";
    q<HTMLFormElement>(el, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(agent.calls).toContain("text:hello");
    expect(input.value).toBe("");
  });
});

describe("showing a picture", () => {
  const pictureButton = (el: Element) => q<HTMLButtonElement>(el, ".picture");
  const photo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
  /** Opens a conversation on a relay whose model sees pictures. */
  async function openSeeing(el: VoiceAgentElement) {
    const agent = await open(el);
    agent.capabilities = { imageInput: true };
    agent.setStatus("listening");
    return agent;
  }
  function choose(el: Element, file: Blob) {
    const input = q<HTMLInputElement>(el, ".file");
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
  }

  it("offers the button only when the page asks for it, in a conversation, with a model that sees pictures", async () => {
    const plain = mount({ relay: "https://r.example.com" });
    const agentOfPlain = await openSeeing(plain);
    expect(agentOfPlain.capabilities?.imageInput).toBe(true);
    expect(pictureButton(plain).hidden).toBe(true);
    plain.remove();

    const el = mount({ relay: "https://r.example.com", "image-input": "" });
    expect(pictureButton(el).hidden).toBe(true);
    const agent = await open(el);
    // The relay has not said that its model sees pictures.
    expect(pictureButton(el).hidden).toBe(true);
    agent.capabilities = { imageInput: true };
    agent.setStatus("listening");
    expect(pictureButton(el).hidden).toBe(false);
    expect(pictureButton(el).textContent).toBe("Show a picture");
    fab(el).click();
    await flush();
    expect(pictureButton(el).hidden).toBe(true);
  });

  it("opens the file chooser, sends the chosen picture and shows it in the transcript", async () => {
    const el = mount({ relay: "https://r.example.com", "image-input": "" });
    const agent = await openSeeing(el);
    const clicked = vi.spyOn(q<HTMLInputElement>(el, ".file"), "click").mockImplementation(() => {});
    pictureButton(el).click();
    expect(clicked).toHaveBeenCalledOnce();
    const events: unknown[] = [];
    el.addEventListener("voice-agent:image", (event) => events.push((event as CustomEvent).detail));
    const file = photo();
    choose(el, file);
    await flush();
    expect(agent.images).toEqual([{ source: file, options: {} }]);
    const line = q<HTMLLIElement>(el, ".lines li[data-picture]");
    expect(line.dataset.role).toBe("user");
    const shown = line.querySelector("img");
    // The picture itself where the browser can show one, and words for it either way.
    expect(shown ? shown.alt : line.textContent).toBe("A picture you sent");
    expect(events).toEqual([{ sent: true }]);
    expect(note(el).textContent).toBe("");
    // The chooser is cleared, so the same file can be chosen again.
    expect(q<HTMLInputElement>(el, ".file").value).toBe("");
  });

  it("sends what is typed in the text box with the picture, and clears the box", async () => {
    const el = mount({ relay: "https://r.example.com", "image-input": "", "text-input": "" });
    const agent = await openSeeing(el);
    const input = q<HTMLInputElement>(el, 'input[type="text"]');
    input.value = "  What does this error mean?  ";
    choose(el, photo());
    await flush();
    expect(agent.images[0]!.options).toEqual({ text: "What does this error mean?" });
    expect(input.value).toBe("");
    // Without a text box on the page nothing typed goes along.
    const bare = mount({ relay: "https://r.example.com", "image-input": "" });
    const other = await openSeeing(bare);
    q<HTMLInputElement>(bare, 'input[type="text"]').value = "hidden";
    choose(bare, photo());
    await flush();
    expect(other.images[0]!.options).toEqual({});
  });

  it("says so when the picture was not sent, keeps what was typed, and clears the note on the next one", async () => {
    const el = mount({ relay: "https://r.example.com", "image-input": "", "text-input": "" });
    const agent = await openSeeing(el);
    const input = q<HTMLInputElement>(el, 'input[type="text"]');
    input.value = "Look";
    agent.imageResult = false;
    choose(el, photo());
    await flush();
    expect(note(el).textContent).toBe("The picture was not sent. Wait a moment and try again.");
    expect(input.value).toBe("Look");
    expect(el.shadowRoot!.querySelectorAll(".lines li")).toHaveLength(0);
    agent.imageResult = new VoiceAgentError("image", "Could not prepare the picture: not an image");
    choose(el, photo());
    await flush();
    expect(note(el).textContent).toBe("This picture could not be used. Choose a JPEG or PNG photo or screenshot.");
    agent.imageResult = true;
    choose(el, photo());
    await flush();
    expect(note(el).textContent).toBe("");
    expect(el.shadowRoot!.querySelectorAll(".lines li[data-picture]")).toHaveLength(1);
  });

  it("takes one picture at a time, and none without a conversation", async () => {
    const el = mount({ relay: "https://r.example.com", "image-input": "" });
    await expect(el.sendImage(photo())).resolves.toBe(false);
    const agent = await openSeeing(el);
    const first = el.sendImage(photo(), { text: "one", maxSide: 512 });
    // While the first is being prepared the button is off and a second call sends nothing.
    expect(pictureButton(el).disabled).toBe(true);
    await expect(el.sendImage(photo())).resolves.toBe(false);
    await expect(first).resolves.toBe(true);
    expect(pictureButton(el).disabled).toBe(false);
    expect(agent.images.map((image) => image.options)).toEqual([{ text: "one", maxSide: 512 }]);
  });

  it("shows a data URL as it is, and words in Chinese for a Chinese page", async () => {
    const el = mount({ relay: "https://r.example.com", "image-input": "", language: "zh" });
    await openSeeing(el);
    expect(pictureButton(el).textContent).toBe("发送图片");
    await el.sendImage("data:image/png;base64,iVBORw0KGgo=");
    const shown = q<HTMLImageElement>(el, ".lines li[data-picture] img");
    expect(shown.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(shown.alt).toBe("你发送的图片");
  });
});

describe("mute", () => {
  it("toggles mute and keeps the button label and aria-pressed in step", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const agent = await open(el);
    const mute = q<HTMLButtonElement>(el, ".mute");
    expect(mute.hidden).toBe(false);
    expect(mute.textContent).toBe("Mute");
    mute.click();
    expect(agent.muted).toBe(true);
    expect(mute.textContent).toBe("Unmute");
    expect(mute.getAttribute("aria-pressed")).toBe("true");
    mute.click();
    expect(agent.muted).toBe(false);
    expect(mute.textContent).toBe("Mute");
  });

  it("hides the mute button when there is no conversation", () => {
    expect(q<HTMLButtonElement>(mount(), ".mute").hidden).toBe(true);
  });
});

describe("error notes", () => {
  const cases: Array<[string, RegExp]> = [
    ["microphone", /Microphone access was blocked/],
    ["token", /Could not start a session/],
    ["connection", /Could not reach the assistant/],
    ["relay", /reported a problem/],
    ["audio", /Audio playback failed/],
    ["usage_limit", /voice minutes are used up/],
    ["unauthorized", /did not accept this session/]
  ];
  for (const [code, pattern] of cases) {
    it(`shows a specific message for ${code}`, async () => {
      const el = mount({ relay: "https://r.example.com" });
      const agent = await open(el);
      agent.emit("error", new VoiceAgentError(code as never, "raw text"));
      expect(note(el).textContent).toMatch(pattern);
    });
  }

  it("falls back to the error's own message for an unknown code, then to the generic text", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const agent = await open(el);
    agent.emit("error", new VoiceAgentError("quota" as never, "Seats exhausted"));
    expect(note(el).textContent).toBe("Seats exhausted");
    agent.emit("error", new VoiceAgentError("quota" as never, ""));
    expect(note(el).textContent).toMatch(/Could not reach the assistant/);
  });

  it("shows the panel with the note after a failed start, and the DOM event carries the error", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const events: unknown[] = [];
    el.addEventListener("voice-agent:error", (e) => events.push((e as CustomEvent).detail.error));
    await open(el);
    fab(el).click(); // stop
    lastAgent().startError = new VoiceAgentError("usage_limit", "x");
    fab(el).click(); // start again: refused
    await flush();
    expect(panel(el).hidden).toBe(false);
    expect(note(el).textContent).toMatch(/used up/);
    expect((events[0] as VoiceAgentError).code).toBe("usage_limit");
  });

  it("clears the note when a new client is built", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const agent = await open(el);
    agent.emit("error", new VoiceAgentError("relay", "x"));
    agent.setStatus("error");
    el.setAttribute("backend", "other");
    await open(el);
    expect(note(el).textContent).toBe("");
  });

  it("re-renders the note when the language changes", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const agent = await open(el);
    agent.emit("error", new VoiceAgentError("usage_limit", "x"));
    el.setAttribute("language", "zh");
    expect(note(el).textContent).toBe("本月的语音时长已用完。");
  });

  it("lets strings override a message, and the override wins over the built-in", async () => {
    const el = mount({ relay: "https://r.example.com" });
    el.strings = { errors: { usage_limit: "Upgrade your plan." } };
    const agent = await open(el);
    agent.emit("error", new VoiceAgentError("usage_limit", "x"));
    expect(note(el).textContent).toBe("Upgrade your plan.");
  });
});

describe("localisation", () => {
  it("is English by default", () => {
    const el = mount({ "text-input": "" });
    expect(fab(el).getAttribute("aria-label")).toBe("Talk to the assistant");
    expect(panel(el).getAttribute("aria-label")).toBe("Conversation");
    expect(q(el, "input").getAttribute("aria-label")).toBe("Type a message");
    expect(q(el, "input").getAttribute("placeholder")).toBe("Type a message");
  });

  it("uses Chinese for language=zh, including every screen-reader label", () => {
    const el = mount({ language: "zh-CN", "text-input": "" });
    expect(fab(el).getAttribute("aria-label")).toBe("与助手对话");
    expect(panel(el).getAttribute("aria-label")).toBe("对话");
    expect(q(el, "input").getAttribute("aria-label")).toBe("输入消息");
    expect(q(el, ".close").getAttribute("aria-label")).toBe("关闭");
    expect(q(el, ".mute").textContent).toBe("静音");
    expect(q(el, ".state").textContent).toBe("空闲");
    expect(q(el, '[role="status"]').textContent).toBe("空闲");
  });

  it("falls back to the element's lang, then the document's, then English", () => {
    document.documentElement.setAttribute("lang", "zh-Hans");
    expect(fab(mount()).getAttribute("aria-label")).toBe("与助手对话");

    const wrapper = document.createElement("div");
    wrapper.setAttribute("lang", "en");
    const el = document.createElement("voice-agent");
    wrapper.append(el);
    document.body.append(wrapper);
    expect(fab(el).getAttribute("aria-label")).toBe("Talk to the assistant");

    document.documentElement.removeAttribute("lang");
    expect(fab(mount({ language: "fr" })).getAttribute("aria-label")).toBe("Talk to the assistant");
  });

  it("prefers the language attribute over lang", () => {
    document.documentElement.setAttribute("lang", "zh");
    expect(fab(mount({ language: "en" })).getAttribute("aria-label")).toBe("Talk to the assistant");
  });

  it("follows a change of lang or language after mounting", () => {
    const el = mount();
    el.setAttribute("lang", "zh");
    expect(fab(el).getAttribute("aria-label")).toBe("与助手对话");
    el.removeAttribute("lang");
    el.setAttribute("language", "zh");
    expect(q(el, ".state").textContent).toBe("空闲");
    el.setAttribute("language", "en");
    expect(q(el, ".state").textContent).toBe("Idle");
  });

  it("applies strings overrides at once and keeps the label attribute above them", () => {
    const el = mount({ label: "Ask Max" });
    el.strings = { label: "ignored", mute: "Hush", status: { idle: "Ready when you are" } };
    expect(fab(el).getAttribute("aria-label")).toBe("Ask Max");
    expect(q(el, ".state").textContent).toBe("Ready when you are");
    expect(q(el, ".mute").textContent).toBe("Hush");
    expect(q(el, ".close").textContent).toBe("Close");
    el.removeAttribute("label");
    expect(fab(el).getAttribute("aria-label")).toBe("ignored");
  });

  it("ignores undefined and unknown override entries", () => {
    const el = mount();
    el.strings = { mute: undefined, nonsense: "x", status: { idle: undefined } } as never;
    expect(q(el, ".state").textContent).toBe("Idle");
  });
});

describe("accessibility", () => {
  it("gives the panel a non-modal dialog role with a name", () => {
    const p = panel(mount());
    expect(p.getAttribute("role")).toBe("dialog");
    expect(p.getAttribute("aria-modal")).toBe("false");
    expect(p.getAttribute("aria-label")).toBe("Conversation");
  });

  it("themes the error colour through --va-error in both colour schemes", () => {
    const html = q(mount(), "style").textContent!;
    expect(html).toContain("color: var(--va-error)");
    expect(html).toMatch(/--va-error: #b3261e/);
    expect(html).toMatch(/prefers-color-scheme: dark[\s\S]*--va-error: #ff8a80/);
  });

  it("moves focus into the panel when a session opens", async () => {
    const el = mount({ relay: "https://r.example.com" });
    fab(el).focus();
    await open(el);
    expect(el.shadowRoot!.activeElement).toBe(panel(el));
  });

  it("closes on Escape, stops the session and returns focus to the button", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const agent = await open(el);
    expect(el.shadowRoot!.activeElement).toBe(panel(el));
    panel(el).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(agent.calls).toContain("stop");
    expect(panel(el).hidden).toBe(true);
    expect(el.shadowRoot!.activeElement).toBe(fab(el));
  });

  it("closes with the close button, and reopens on the next start", async () => {
    const el = mount({ relay: "https://r.example.com" });
    await open(el);
    q<HTMLButtonElement>(el, ".mute").focus();
    q<HTMLButtonElement>(el, ".close").click();
    expect(panel(el).hidden).toBe(true);
    expect(el.shadowRoot!.activeElement).toBe(fab(el));
    await open(el);
    expect(panel(el).hidden).toBe(false);
  });

  it("closes a panel that is only showing a transcript after the session ended", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const agent = await open(el);
    const item = { id: "t1", role: "agent", text: "Hi", final: true, at: 1 };
    agent.emit("transcript", { transcript: [item], item });
    fab(el).click();
    expect(panel(el).hidden).toBe(false);
    panel(el).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    expect(panel(el).hidden).toBe(true);
  });

  it("ignores Escape while the panel is closed", () => {
    const el = mount({ relay: "https://r.example.com" });
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(agents()).toHaveLength(0);
  });
});

describe("blocked audio", () => {
  it("offers a localised tap-to-enable button that resumes audio, and hides it afterwards", async () => {
    const el = mount({ relay: "https://r.example.com" });
    const agent = await open(el);
    const sound = q<HTMLButtonElement>(el, ".sound");
    expect(sound.hidden).toBe(true);
    const events: unknown[] = [];
    el.addEventListener("voice-agent:warning", (e) => events.push((e as CustomEvent).detail.warning.code));
    agent.audioBlocked = true;
    agent.emit("warning", { code: "audio_blocked", message: "x" });
    expect(sound.hidden).toBe(false);
    expect(sound.textContent).toBe("Tap to enable sound");
    expect(events).toEqual(["audio_blocked"]);
    sound.click();
    await flush();
    expect(agent.calls).toContain("resumeAudio");
    expect(sound.hidden).toBe(true);
  });

  it("uses Chinese text for the button", () => {
    const el = mount({ language: "zh" });
    expect(q(el, ".sound").textContent).toBe("点按以开启声音");
  });
});
