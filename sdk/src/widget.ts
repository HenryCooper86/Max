/**
 * The `<voice-agent>` custom element: a floating mic button with a live
 * transcript, built on {@link VoiceAgent}. Shadow DOM, no framework.
 *
 * ```html
 * <voice-agent relay="https://relay.example.com" token-url="/api/voice-token" text-input></voice-agent>
 * ```
 */

import { VoiceAgent } from "./client.js";
import type { ClientTool, VoiceAgentOptions, VoiceAgentStatus } from "./client.js";
import { parseCharacters, relayHttpBase } from "./protocol.js";
import type { TranscriptItem, VoiceGender } from "./protocol.js";

const OBSERVED = [
  "relay",
  "project",
  "token",
  "token-url",
  "language",
  "voice",
  "backend",
  "context",
  "label",
  "accent",
  "position",
  "text-input",
  "characters"
] as const;
/** Attributes that only matter when a session is created. */
const CONNECTION_ATTRS: ReadonlySet<string> = new Set([
  "relay",
  "project",
  "token",
  "token-url",
  "language",
  "voice",
  "backend",
  "context"
]);

const STATUS_LABELS: Record<VoiceAgentStatus, string> = {
  idle: "Idle",
  connecting: "Connecting",
  ready: "Ready",
  listening: "Listening",
  hearing: "Hearing you",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Something went wrong",
  closed: "Session ended"
};

const ERROR_MESSAGES: Record<string, string> = {
  microphone: "Microphone access was blocked. Allow it in your browser and try again.",
  token: "Could not start a session. Please try again later.",
  connection: "Could not reach the assistant. Please try again.",
  relay: "The assistant reported a problem.",
  audio: "Audio playback failed."
};

const TEMPLATE = `
<style>
  :host {
    --va-accent: #2f6df6;
    --va-bg: #ffffff;
    --va-fg: #14161a;
    --va-muted: #5b6270;
    --va-line: #e3e6ec;
    --va-user: #eef1f7;
    --va-on-accent: #ffffff;
    all: initial;
    display: block;
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--va-fg);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --va-bg: #1b1e24;
      --va-fg: #f1f3f7;
      --va-muted: #9aa3b2;
      --va-line: #2f343d;
      --va-user: #2a2f38;
    }
  }
  :host([position="inline"]) { display: inline-block; position: relative; }
  :host(:not([position="inline"])) { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; }
  :host([position="bottom-left"]) { right: auto; left: 20px; }
  .root { display: flex; flex-direction: column; align-items: flex-end; gap: 12px; }
  :host([position="bottom-left"]) .root { align-items: flex-start; }
  .panel {
    width: min(340px, calc(100vw - 40px));
    max-height: min(420px, 60vh);
    display: flex; flex-direction: column;
    background: var(--va-bg); border: 1px solid var(--va-line); border-radius: 16px;
    box-shadow: 0 8px 32px rgb(0 0 0 / 0.18); overflow: hidden;
  }
  .panel[hidden] { display: none; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--va-line); }
  .state { color: var(--va-muted); font-size: 12px; }
  .lines { list-style: none; margin: 0; padding: 12px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 8px; min-height: 64px; }
  .lines li { max-width: 88%; padding: 8px 10px; border-radius: 12px; background: var(--va-user); overflow-wrap: anywhere; }
  .lines li[data-role="agent"] { align-self: flex-start; border: 1px solid var(--va-line); background: transparent; }
  .lines li[data-role="user"] { align-self: flex-end; }
  .lines li[data-final="false"] { opacity: 0.65; }
  .note { margin: 0; padding: 8px 12px; color: #b3261e; font-size: 13px; }
  .note:empty { display: none; }
  form { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--va-line); }
  form[hidden] { display: none; }
  input {
    flex: 1; min-width: 0; font: inherit; color: inherit; background: transparent;
    border: 1px solid var(--va-line); border-radius: 10px; padding: 8px 10px;
  }
  button { font: inherit; color: inherit; cursor: pointer; }
  .small { background: transparent; border: 1px solid var(--va-line); border-radius: 10px; padding: 6px 10px; }
  .small[aria-pressed="true"] { background: var(--va-user); }
  .fab {
    position: relative; width: 56px; height: 56px; border-radius: 50%; border: 0; padding: 0;
    background: var(--va-accent); color: var(--va-on-accent);
    display: grid; place-items: center; box-shadow: 0 4px 16px rgb(0 0 0 / 0.25);
    transition: transform 0.15s ease;
  }
  .fab:hover { transform: scale(1.05); }
  .fab svg { width: 26px; height: 26px; position: relative; }
  .ring {
    position: absolute; inset: 0; border-radius: 50%; background: var(--va-accent); opacity: 0; pointer-events: none;
    transform: scale(calc(1 + var(--level, 0) * 0.6)); opacity: calc(var(--level, 0) * 0.55);
    transition: transform 0.08s linear, opacity 0.08s linear;
  }
  .root[data-status="connecting"] .ring, .root[data-status="thinking"] .ring {
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse { 50% { opacity: 0.35; transform: scale(1.25); } }
  button:focus-visible, input:focus-visible { outline: 3px solid var(--va-accent); outline-offset: 2px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .root { position: relative; }
  .critters { position: absolute; right: 50px; bottom: -18px; width: 118px; height: 86px; pointer-events: none; }
  :host([position="bottom-left"]) .critters { right: auto; left: 50px; }
  .critters[hidden] { display: none; }
  .critter { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; animation: va-drift 7s ease-in-out infinite; }
  .critter.c1 { inset: auto; left: -46%; top: -40%; width: 70%; height: 70%; animation-duration: 9s; animation-delay: -3s; }
  .critter.c2 { inset: auto; left: 18%; top: -78%; width: 62%; height: 62%; animation-duration: 11s; animation-delay: -6s; }
  .root[data-status="speaking"] .critter { animation: va-bob 0.9s ease-in-out infinite; }
  .root[data-status="listening"] .critters, .root[data-status="hearing"] .critters { transform: translate(-6px, -4px) scale(1.06); }
  .critters { transition: transform 600ms cubic-bezier(0.3, 1.3, 0.5, 1); }
  @keyframes va-drift { 25% { transform: translate(3%, -5%); } 50% { transform: translate(-2%, 2%); } 75% { transform: translate(-4%, -3%); } }
  @keyframes va-bob { 50% { transform: translateY(-6%); } }
  @media (prefers-reduced-motion: reduce) {
    .critter, .critters { animation: none !important; transition: none; }
    .fab, .ring { transition: none; animation: none !important; }
    .ring { transform: none; }
    .fab:hover { transform: none; }
  }
</style>
<div class="root" part="root">
  <section class="panel" part="panel" hidden aria-label="Conversation">
    <header>
      <span class="state"></span>
      <button class="small mute" type="button" aria-pressed="false">Mute</button>
    </header>
    <ul class="lines" role="log" aria-live="polite" aria-relevant="additions text"></ul>
    <p class="note" role="alert"></p>
    <form hidden>
      <input type="text" maxlength="2000" autocomplete="off" aria-label="Type a message" placeholder="Type a message" />
      <button class="small" type="submit">Send</button>
    </form>
  </section>
  <button class="fab" part="button" type="button" aria-pressed="false">
    <span class="ring" aria-hidden="true"></span>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>
    </svg>
  </button>
  <span class="sr" role="status"></span>
  <div class="critters" part="characters" aria-hidden="true" hidden></div>
</div>`;

const CHARACTER_SPEED: Record<string, number> = { thinking: 0.85, speaking: 1.1, listening: 0.9, hearing: 0.9 };

/** Phones and Safari get the animated picture: some play transparent video with a box round it. */
function usesPicture(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const safari = /safari/i.test(navigator.userAgent) && !/chrome|chromium|android|edg/i.test(navigator.userAgent);
  return Boolean(window.matchMedia?.("(pointer: coarse)").matches) || safari;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function select<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`voice-agent: missing ${selector}`);
  return found;
}

async function fetchToken(url: string): Promise<string> {
  const request = async (method: "POST" | "GET") =>
    fetch(url, { method, credentials: "same-origin", headers: { Accept: "application/json" } });
  let response = await request("POST");
  if (response.status === 404 || response.status === 405) response = await request("GET");
  if (!response.ok) throw new Error(`Token endpoint returned ${response.status}`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) throw new Error("Token endpoint did not return a token");
  return body.token;
}

/**
 * `<voice-agent>`: a voice assistant button for any page.
 *
 * Attributes: `relay`, `project` (a Max Cloud public agent id: no backend needed), `token`, `token-url`, `language`, `voice`, `backend`,
 * `context` (facts about the page, for the assistant), `label`, `accent`, `position` (`bottom-right` by default,
 * `bottom-left`, or `inline` to place it in the flow), `text-input`, `characters` (up to three of
 * hummingbird, bee, butterfly, comma-separated: real creatures that hover beside the button).
 * Set the `tools` property to give the agent client tools. Dispatches
 * `voice-agent:status`, `:transcript`, `:toolcall` and `:error` events.
 */
export class VoiceAgentElement extends HTMLElement {
  static readonly observedAttributes = OBSERVED;

  #agent: VoiceAgent | undefined;
  #dirty = false;
  #tools: ClientTool[] = [];
  #off: Array<() => void> = [];
  #lines = new Map<string, HTMLLIElement>();
  readonly #root: ShadowRoot;
  #ui!: {
    wrap: HTMLElement;
    panel: HTMLElement;
    state: HTMLElement;
    list: HTMLUListElement;
    note: HTMLElement;
    form: HTMLFormElement;
    input: HTMLInputElement;
    fab: HTMLButtonElement;
    mute: HTMLButtonElement;
    live: HTMLElement;
    critters: HTMLElement;
  };
  #critterKey = "";

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
  }

  /** Client tools the agent may call. Takes effect the next time a session starts. */
  get tools(): ClientTool[] {
    return this.#tools;
  }
  set tools(value: ClientTool[]) {
    this.#tools = value;
    this.#dirty = true;
  }

  /** The underlying client, once a session has been started. */
  get agent(): VoiceAgent | undefined {
    return this.#agent;
  }

  connectedCallback(): void {
    if (this.#ui) return;
    this.#root.innerHTML = TEMPLATE;
    const root = this.#root;
    this.#ui = {
      wrap: select(root, ".root"),
      panel: select(root, ".panel"),
      state: select(root, ".state"),
      list: select(root, ".lines"),
      note: select(root, ".note"),
      form: select(root, "form"),
      input: select(root, "input"),
      fab: select(root, ".fab"),
      mute: select(root, ".mute"),
      live: select(root, ".sr"),
      critters: select(root, ".critters")
    };
    const ui = this.#ui;
    ui.fab.addEventListener("click", () => void this.#toggle());
    ui.mute.addEventListener("click", () => {
      const agent = this.#agent;
      if (!agent) return;
      if (agent.muted) agent.unmute();
      else agent.mute();
      this.#renderStatus();
    });
    ui.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.#agent?.sendText(ui.input.value)) ui.input.value = "";
    });
    this.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.#active()) {
        this.stop();
        ui.fab.focus();
      }
    });
    this.#applyAttributes();
    this.#renderStatus();
  }

  disconnectedCallback(): void {
    this.#off.forEach((unsubscribe) => unsubscribe());
    this.#off = [];
    this.#agent?.destroy();
    this.#agent = undefined;
  }

  attributeChangedCallback(name: string): void {
    if (!this.#ui) return;
    if (CONNECTION_ATTRS.has(name)) this.#dirty = true;
    this.#applyAttributes();
  }

  /** Starts a conversation. Call from a user gesture. */
  async start(): Promise<void> {
    const agent = this.#ensureAgent();
    try {
      await agent.start();
    } catch {
      /* surfaced through the error event */
    }
  }

  /** Ends the conversation. */
  stop(): void {
    this.#agent?.stop();
  }

  #active(): boolean {
    const status = this.#agent?.status ?? "idle";
    return status !== "idle" && status !== "error" && status !== "closed";
  }

  async #toggle(): Promise<void> {
    if (this.#active()) this.stop();
    else await this.start();
  }

  #applyAttributes(): void {
    const ui = this.#ui;
    const label = this.getAttribute("label") || "Talk to the assistant";
    ui.fab.setAttribute("aria-label", label);
    const accent = this.getAttribute("accent");
    if (accent) this.style.setProperty("--va-accent", accent);
    else this.style.removeProperty("--va-accent");
    ui.form.hidden = !this.hasAttribute("text-input");
    this.#renderCritters();
  }

  /** The creatures beside the button, rebuilt only when the list or the relay changes. */
  #renderCritters(): void {
    const box = this.#ui.critters;
    const ids = parseCharacters(this.getAttribute("characters"));
    const relay = this.getAttribute("relay") ?? "";
    const key = `${relay}|${ids.join(",")}`;
    if (key === this.#critterKey) return;
    this.#critterKey = key;
    box.replaceChildren();
    box.hidden = ids.length === 0 || !relay;
    if (box.hidden) return;
    let base: string;
    try {
      base = relayHttpBase(relay);
    } catch {
      box.hidden = true;
      return;
    }
    const still = reducedMotion();
    const picture = usesPicture();
    ids.forEach((id, index) => {
      const src = `${base}/character/${id}`;
      let element: HTMLImageElement | HTMLVideoElement;
      if (still || picture) {
        element = document.createElement("img");
        element.src = `${src}.${still ? "png" : "webp"}`;
        element.alt = "";
        element.decoding = "async";
      } else {
        const video = document.createElement("video");
        video.src = `${src}.webm`;
        video.poster = `${src}.png`;
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.disablePictureInPicture = true;
        video.setAttribute("muted", "");
        video.setAttribute("playsinline", "");
        element = video;
      }
      element.className = index === 0 ? "critter" : `critter c${index}`;
      element.draggable = false;
      box.append(element);
    });
  }

  #ensureAgent(): VoiceAgent {
    if (this.#agent && !(this.#dirty && !this.#active())) return this.#agent;
    this.#off.forEach((unsubscribe) => unsubscribe());
    this.#agent?.destroy();
    this.#dirty = false;
    this.#lines.clear();
    this.#ui.list.replaceChildren();

    const relay = this.getAttribute("relay");
    const tokenUrl = this.getAttribute("token-url");
    const token = this.getAttribute("token");
    const voice = this.getAttribute("voice");
    const options: VoiceAgentOptions = {
      url: relay ?? "",
      ...(tokenUrl ? { token: () => fetchToken(tokenUrl) } : token ? { token } : {}),
      ...(this.getAttribute("project") ? { project: this.getAttribute("project")! } : {}),
      ...(this.getAttribute("language") ? { language: this.getAttribute("language")! } : {}),
      ...(voice === "female" || voice === "male" ? { voice: voice as VoiceGender } : {}),
      ...(this.getAttribute("backend") ? { backend: this.getAttribute("backend")! } : {}),
      ...(this.getAttribute("context") ? { context: this.getAttribute("context")! } : {}),
      ...(this.#tools.length ? { tools: this.#tools } : {})
    };
    const agent = new VoiceAgent(options);
    const emit = (type: string, detail: unknown) =>
      this.dispatchEvent(new CustomEvent(`voice-agent:${type}`, { detail, bubbles: true, composed: true }));
    this.#off = [
      agent.on("status", (status) => {
        this.#renderStatus();
        emit("status", { status });
      }),
      agent.on("transcript", ({ transcript, item }) => {
        this.#renderLine(item);
        emit("transcript", { transcript, item });
      }),
      agent.on("toolcall", (call) => emit("toolcall", call)),
      agent.on("error", (error) => {
        this.#ui.note.textContent = ERROR_MESSAGES[error.code] ?? error.message;
        emit("error", { error });
      }),
      agent.on("level", ({ mic, output }) => this.#ui.fab.style.setProperty("--level", String(Math.max(mic, output))))
    ];
    this.#agent = agent;
    this.#ui.note.textContent = "";
    return agent;
  }

  #renderStatus(): void {
    const ui = this.#ui;
    const status = this.#agent?.status ?? "idle";
    const active = this.#active();
    ui.wrap.dataset.status = status;
    const speed = CHARACTER_SPEED[status] ?? 1;
    for (const video of ui.critters.querySelectorAll("video")) video.playbackRate = speed;
    ui.fab.setAttribute("aria-pressed", String(active));
    ui.panel.hidden = !active && status !== "error" && this.#lines.size === 0;
    ui.state.textContent = STATUS_LABELS[status];
    ui.live.textContent = STATUS_LABELS[status];
    const muted = this.#agent?.muted ?? false;
    ui.mute.setAttribute("aria-pressed", String(muted));
    ui.mute.textContent = muted ? "Unmute" : "Mute";
    ui.mute.hidden = !active;
    if (!active) ui.fab.style.setProperty("--level", "0");
  }

  #renderLine(item: TranscriptItem): void {
    let line = this.#lines.get(item.id);
    if (!line) {
      line = document.createElement("li");
      this.#lines.set(item.id, line);
      this.#ui.list.append(line);
    }
    line.dataset.role = item.role;
    line.dataset.final = String(item.final);
    line.textContent = item.text;
    this.#ui.list.scrollTop = this.#ui.list.scrollHeight;
    this.#renderStatus();
  }
}

/** Registers `<voice-agent>` if it is not defined yet. */
export function defineVoiceAgentElement(): void {
  if (typeof customElements !== "undefined" && !customElements.get("voice-agent")) {
    customElements.define("voice-agent", VoiceAgentElement);
  }
}

/**
 * Appends a `<voice-agent>` configured from a script tag's `data-*` attributes
 * (`data-relay`, `data-project`, `data-token`, `data-token-url`, `data-language`, `data-voice`,
 * `data-backend`, `data-context`, `data-label`, `data-accent`, `data-position`, `data-characters`,
 * `data-text-input`). Does nothing without `data-relay`.
 *
 * @returns the created element, if any.
 */
export function mountFromScript(script: HTMLScriptElement | null): VoiceAgentElement | undefined {
  if (!script?.dataset.relay) return undefined;
  const element = document.createElement("voice-agent") as VoiceAgentElement;
  for (const name of OBSERVED) {
    const key = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const value = script.dataset[key];
    if (value === undefined) continue;
    element.setAttribute(name === "relay" ? "relay" : name, value);
  }
  const attach = () => document.body.append(element);
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });
  return element;
}
