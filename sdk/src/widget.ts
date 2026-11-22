/**
 * The `<voice-agent>` custom element: a floating mic button with a live
 * transcript, built on {@link VoiceAgent}. Shadow DOM, no framework.
 *
 * ```html
 * <voice-agent relay="https://relay.example.com" token-url="/api/voice-token" text-input></voice-agent>
 * ```
 */

import { VoiceAgent } from "./client.js";
import type { ClientTool, VoiceAgentError, VoiceAgentOptions } from "./client.js";
import type { TranscriptItem, VoiceGender } from "./protocol.js";
import { resolveLocale, resolveStrings } from "./widget-strings.js";
import type { WidgetStringOverrides, WidgetStrings } from "./widget-strings.js";

export type { WidgetStringOverrides, WidgetStrings } from "./widget-strings.js";

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
  "text-input"
] as const;
/** `lang` only picks the widget's text language; it never reaches the relay. */
const WATCHED = [...OBSERVED, "lang"];
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

/**
 * Server rendering imports this module too (a Next.js client component is
 * still rendered on the server) and `HTMLElement` does not exist there. A
 * stand-in keeps the import from throwing; the element is never constructed or
 * registered outside a browser.
 */
const ElementBase: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

const TEMPLATE = `
<style>
  :host {
    --va-accent: #2f6df6;
    --va-bg: #ffffff;
    --va-fg: #14161a;
    --va-muted: #5b6270;
    --va-line: #e3e6ec;
    --va-user: #eef1f7;
    --va-error: #b3261e; /* 6.5:1 on --va-bg */
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
      --va-error: #ff8a80; /* 7.3:1 on --va-bg */
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
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--va-line); }
  .state { color: var(--va-muted); font-size: 12px; }
  .lines { list-style: none; margin: 0; padding: 12px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 8px; min-height: 64px; }
  .lines li { max-width: 88%; padding: 8px 10px; border-radius: 12px; background: var(--va-user); overflow-wrap: anywhere; }
  .lines li[data-role="agent"] { align-self: flex-start; border: 1px solid var(--va-line); background: transparent; }
  .lines li[data-role="user"] { align-self: flex-end; }
  .lines li[data-final="false"] { opacity: 0.65; }
  .note { margin: 0; padding: 8px 12px; color: var(--va-error); font-size: 13px; }
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
  .small[hidden] { display: none; }
  .actions { display: flex; gap: 8px; }
  .sound { margin: 0 12px 8px; align-self: flex-start; }
  .panel:focus-visible { outline: 3px solid var(--va-accent); outline-offset: -3px; }
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
  @media (prefers-reduced-motion: reduce) {
    .fab, .ring { transition: none; animation: none !important; }
    .ring { transform: none; }
    .fab:hover { transform: none; }
  }
</style>
<div class="root" part="root">
  <section class="panel" part="panel" role="dialog" aria-modal="false" tabindex="-1" hidden>
    <header part="header">
      <span class="state" part="status"></span>
      <span class="actions">
        <button class="small mute" part="mute" type="button" aria-pressed="false"></button>
        <button class="small close" part="close" type="button"></button>
      </span>
    </header>
    <ul class="lines" part="lines" role="log" aria-live="polite" aria-relevant="additions text"></ul>
    <button class="small sound" part="sound" type="button" hidden></button>
    <p class="note" part="note" role="alert"></p>
    <form hidden>
      <input type="text" part="input" maxlength="2000" autocomplete="off" />
      <button class="small" part="send" type="submit"></button>
    </form>
  </section>
  <button class="fab" part="button" type="button" aria-pressed="false">
    <span class="ring" aria-hidden="true"></span>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>
    </svg>
  </button>
  <span class="sr" role="status"></span>
</div>`;

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
 * `bottom-left`, or `inline` to place it in the flow), `text-input`.
 * Set the `tools` property to give the agent client tools, and `strings` to override any of its text (built-in English and
 * Simplified Chinese, chosen from `language`, then `lang`). Dispatches `voice-agent:status`, `:transcript`, `:toolcall`,
 * `:error` and `:warning` events.
 */
export class VoiceAgentElement extends ElementBase {
  static readonly observedAttributes = WATCHED;

  #agent: VoiceAgent | undefined;
  #dirty = false;
  #tools: ClientTool[] = [];
  #off: Array<() => void> = [];
  #lines = new Map<string, HTMLLIElement>();
  #strings: WidgetStringOverrides = {};
  #error: VoiceAgentError | undefined;
  /** The user closed the panel; it stays closed until the next session starts. */
  #dismissed = false;
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
    close: HTMLButtonElement;
    sound: HTMLButtonElement;
    send: HTMLButtonElement;
    live: HTMLElement;
  };

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

  /**
   * Overrides for any of the widget's text, laid over the built-in English or
   * Chinese. Takes effect immediately. See {@link WidgetStrings} for the keys.
   */
  get strings(): WidgetStringOverrides {
    return this.#strings;
  }
  set strings(value: WidgetStringOverrides) {
    this.#strings = value ?? {};
    if (this.#ui) this.#renderAll();
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
      close: select(root, ".close"),
      sound: select(root, ".sound"),
      send: select(root, 'button[type="submit"]'),
      live: select(root, ".sr")
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
    ui.close.addEventListener("click", () => this.#dismiss());
    ui.sound.addEventListener("click", () => {
      void this.#agent?.resumeAudio().then(() => this.#renderStatus());
    });
    ui.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.#agent?.sendText(ui.input.value)) ui.input.value = "";
    });
    this.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !ui.panel.hidden) {
        this.#dismiss();
      }
    });
    this.#renderAll();
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
    this.#renderAll();
  }

  /** Starts a conversation. Call from a user gesture. */
  async start(): Promise<void> {
    this.#dismissed = false;
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
    else {
      await this.start();
      // Keyboard and screen-reader users clicked the button; take them to what it opened.
      if (this.#active() && !this.#ui.panel.hidden) this.#ui.panel.focus();
    }
  }

  /** Closes the panel (and the conversation with it) and gives focus back to the button. */
  #dismiss(): void {
    const hadFocus = this.#root.activeElement !== null && this.#root.activeElement !== this.#ui.fab;
    this.#dismissed = true;
    this.stop();
    this.#renderStatus();
    if (hadFocus) this.#ui.fab.focus();
  }

  #t(): WidgetStrings {
    const locale = resolveLocale(
      this.getAttribute("language"),
      this.closest("[lang]")?.getAttribute("lang"),
      typeof document === "undefined" ? undefined : document.documentElement.lang
    );
    return resolveStrings(locale, this.#strings);
  }

  /** Re-applies attributes and every piece of localised text. */
  #renderAll(): void {
    this.#applyAttributes();
    this.#renderNote();
    this.#renderStatus();
  }

  #renderNote(): void {
    const error = this.#error;
    if (!error) {
      this.#ui.note.textContent = "";
      return;
    }
    const known = (this.#t().errors as Record<string, string | undefined>)[error.code];
    // An unknown code still tells the user something specific before the generic text.
    this.#ui.note.textContent = known ?? (error.message || this.#t().errors.connection);
  }

  #applyAttributes(): void {
    const ui = this.#ui;
    const t = this.#t();
    const label = this.getAttribute("label") || t.label;
    ui.fab.setAttribute("aria-label", label);
    ui.panel.setAttribute("aria-label", t.conversation);
    ui.close.textContent = t.close;
    ui.close.setAttribute("aria-label", t.close);
    ui.sound.textContent = t.enableSound;
    ui.send.textContent = t.send;
    ui.input.setAttribute("aria-label", t.typeMessage);
    ui.input.setAttribute("placeholder", t.typeMessage);
    const accent = this.getAttribute("accent");
    if (accent) this.style.setProperty("--va-accent", accent);
    else this.style.removeProperty("--va-accent");
    ui.form.hidden = !this.hasAttribute("text-input");
  }

  #ensureAgent(): VoiceAgent {
    if (this.#agent && !(this.#dirty && !this.#active())) return this.#agent;
    this.#off.forEach((unsubscribe) => unsubscribe());
    this.#agent?.destroy();
    this.#dirty = false;
    this.#lines.clear();
    this.#ui.list.replaceChildren();
    this.#error = undefined;

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
        this.#error = error;
        this.#renderNote();
        emit("error", { error });
      }),
      agent.on("warning", (warning) => {
        this.#renderStatus();
        emit("warning", { warning });
      }),
      agent.on("audioresume", () => this.#renderStatus()),
      agent.on("level", ({ mic, output }) => this.#ui.fab.style.setProperty("--level", String(Math.max(mic, output))))
    ];
    this.#agent = agent;
    this.#renderNote();
    return agent;
  }

  #renderStatus(): void {
    const ui = this.#ui;
    const status = this.#agent?.status ?? "idle";
    const active = this.#active();
    ui.wrap.dataset.status = status;
    ui.fab.setAttribute("aria-pressed", String(active));
    const t = this.#t();
    ui.panel.hidden = this.#dismissed || (!active && status !== "error" && this.#lines.size === 0);
    ui.state.textContent = t.status[status];
    ui.live.textContent = t.status[status];
    const muted = this.#agent?.muted ?? false;
    ui.mute.setAttribute("aria-pressed", String(muted));
    ui.mute.textContent = muted ? t.unmute : t.mute;
    ui.mute.hidden = !active;
    ui.sound.hidden = !(this.#agent?.audioBlocked ?? false);
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
 * `data-backend`, `data-context`, `data-label`, `data-accent`, `data-position`,
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
