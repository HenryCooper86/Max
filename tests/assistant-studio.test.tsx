import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EQUALIZER_FREQUENCIES } from "../shared/agent";
import { AssistantStudio, SECTION_LEAVE_EVENT } from "../src/components/admin/AssistantStudio";
import type { ApiResult } from "../src/lib/api-client";
import type { StudioBackends, StudioState } from "../src/lib/studio-api";
import { BUILT_IN_EQUALIZER } from "../src/lib/device-catalog";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function studioState(config: Record<string, unknown> = {}, overrides: Partial<StudioState> = {}): StudioState {
  return {
    ok: true,
    config,
    assistant: {
      name: typeof config.name === "string" ? config.name : "Max",
      device: "helmet",
      wakePhrase: "Max",
      wakeWordEnabled: true,
      languages: ["zh", "en"],
      deviceProfile: typeof config.device === "string" ? config.device : "motorcycle-helmet"
    },
    customLogo: false,
    devices: [],
    equalizer: { ...BUILT_IN_EQUALIZER, frequencies: [...EQUALIZER_FREQUENCIES] },
    providers: [
      { id: "mock", label: "Demo", kind: "demo", configured: true },
      { id: "openai", label: "OpenAI Realtime", kind: "live", configured: false },
      { id: "local", label: "Local models", kind: "pipeline", configured: false, local: true }
    ],
    defaultProvider: "mock",
    ...overrides
  };
}

const ok = (data: StudioState): ApiResult<StudioState> => ({ ok: true, data });
const BACKENDS: StudioBackends = { ok: true, defaultProvider: "mock", switching: true, backends: [] };
const backendApi = {
  fetchStudioBackends: async (): Promise<ApiResult<StudioBackends>> => ({ ok: true, data: BACKENDS }),
  saveStudioBackends: async (): Promise<ApiResult<StudioBackends>> => ({ ok: true, data: BACKENDS })
};

type Listener = (event: Event) => void;
let listeners: Map<string, Set<Listener>>;
let confirmAnswer: boolean;
let renderer: ReactTestRenderer | undefined;

function fire(type: string): boolean {
  const event = new Event(type, { cancelable: true });
  for (const listener of listeners.get(type) ?? []) listener(event);
  return !event.defaultPrevented;
}

beforeEach(() => {
  listeners = new Map();
  confirmAnswer = false;
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => listeners.get(type)?.delete(listener),
    confirm: vi.fn(() => confirmAnswer),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    matchMedia: () => ({ matches: false }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  });
  vi.stubGlobal("document", { hidden: false, addEventListener: () => {}, removeEventListener: () => {} });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function mount(api: Parameters<typeof AssistantStudio>[0]["api"], onSaved = vi.fn(), onExpired = vi.fn()) {
  await act(async () => {
    renderer = create(
      <AssistantStudio api={api} backendApi={backendApi} onSaved={onSaved} onAuthenticationExpired={onExpired} />
    );
  });
  return { onSaved, onExpired };
}

const root = () => renderer!.root;
const nameInput = () =>
  root().find(
    (node) => node.type === "input" && node.props.className === "studioInput" && node.props.placeholder === "Max"
  );
const button = (label: RegExp) =>
  root().find((node: ReactTestInstance) => node.type === "button" && label.test(textOf(node).trim()));
function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}
const status = () =>
  textOf(root().find((node) => node.type === "p" && String(node.props.className).startsWith("studioStatus")));

function fakeApi(initial: StudioState) {
  return {
    fetchStudio: vi.fn(async () => ok(initial)),
    saveStudio: vi.fn(async (config: Record<string, unknown>) => ok(studioState(config))),
    uploadStudioLogo: vi.fn(async () => ok(studioState(initial.config, { customLogo: true }))),
    removeStudioLogo: vi.fn(async () => ok(studioState(initial.config)))
  };
}

describe("admin Studio", () => {
  it("loads a relay on defaults with the running name and a first-run checklist", async () => {
    const api = fakeApi(studioState());
    await mount(api);
    expect(api.fetchStudio).toHaveBeenCalledOnce();
    expect(nameInput().props.value).toBe("Max");
    expect(root().findAll((node) => node.props.className === "studioChecklist")).toHaveLength(1);
  });

  it("tracks unsaved changes, saves the config and asks the app to rebrand", async () => {
    const api = fakeApi(studioState());
    const { onSaved } = await mount(api);
    expect(button(/^保存$/).props.disabled).toBe(true);
    await act(async () => nameInput().props.onChange({ currentTarget: { value: "Iris" } }));
    expect(status()).toContain("未保存");
    expect(button(/^保存$/).props.disabled).toBe(false);
    await act(async () => button(/^保存$/).props.onClick());
    expect(api.saveStudio).toHaveBeenCalledWith({ name: "Iris", device: "motorcycle-helmet", languages: ["zh", "en"] });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(status()).toContain("已保存");
    expect(button(/^保存$/).props.disabled).toBe(true);
  });

  it("shows the relay's reason when a save is refused and keeps the edit", async () => {
    const api = fakeApi(studioState({ name: "Iris", device: "sunglasses", languages: ["en"] }));
    api.saveStudio.mockResolvedValueOnce({
      ok: false,
      error: { kind: "invalid", status: 400, message: "The assistant config is too large." }
    });
    const { onSaved } = await mount(api);
    await act(async () => nameInput().props.onChange({ currentTarget: { value: "Iris Two" } }));
    await act(async () => button(/^保存$/).props.onClick());
    expect(status()).toBe("The assistant config is too large.");
    expect(nameInput().props.value).toBe("Iris Two");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("will not save a draft with problems", async () => {
    const api = fakeApi(studioState({ name: "Iris", languages: ["en"] }));
    await mount(api);
    await act(async () => nameInput().props.onChange({ currentTarget: { value: " " } }));
    await act(async () => button(/^保存$/).props.onClick());
    expect(api.saveStudio).not.toHaveBeenCalled();
    expect(textOf(root())).toContain("给助手起个名字");
  });

  it("discards back to the saved config", async () => {
    const api = fakeApi(studioState({ name: "Iris", languages: ["en"] }));
    await mount(api);
    await act(async () => nameInput().props.onChange({ currentTarget: { value: "Changed" } }));
    await act(async () => button(/放弃修改/).props.onClick());
    expect(nameInput().props.value).toBe("Iris");
    expect(status()).toContain("没有未保存");
  });

  it("asks before leaving with unsaved changes, and not otherwise", async () => {
    const api = fakeApi(studioState({ name: "Iris", languages: ["en"] }));
    await mount(api);
    expect(fire(SECTION_LEAVE_EVENT)).toBe(true);
    await act(async () => nameInput().props.onChange({ currentTarget: { value: "Changed" } }));
    confirmAnswer = false;
    expect(fire(SECTION_LEAVE_EVENT)).toBe(false);
    expect(fire("admin:beforeleave")).toBe(false);
    confirmAnswer = true;
    expect(fire(SECTION_LEAVE_EVENT)).toBe(true);
  });

  it("resets to defaults behind a confirmation, removing an uploaded logo", async () => {
    const api = fakeApi(studioState({ name: "Iris", languages: ["en"] }, { customLogo: true }));
    api.saveStudio.mockResolvedValueOnce(ok(studioState({}, { customLogo: true })));
    api.removeStudioLogo.mockResolvedValueOnce(ok(studioState({})));
    const { onSaved } = await mount(api);
    confirmAnswer = false;
    await act(async () =>
      root()
        .find((node) => node.type === "button" && node.props.className === "danger")
        .props.onClick()
    );
    expect(api.saveStudio).not.toHaveBeenCalled();
    confirmAnswer = true;
    await act(async () =>
      root()
        .find((node) => node.type === "button" && node.props.className === "danger")
        .props.onClick()
    );
    expect(api.saveStudio).toHaveBeenCalledWith({});
    expect(api.removeStudioLogo).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalled();
    expect(nameInput().props.value).toBe("Max");
  });

  it("signs the admin out when the relay no longer accepts the token", async () => {
    const api = fakeApi(studioState());
    api.fetchStudio.mockResolvedValueOnce({ ok: false, error: { kind: "unauthorized", status: 401, message: "no" } });
    const { onExpired } = await mount(api);
    expect(onExpired).toHaveBeenCalledOnce();
  });
});
