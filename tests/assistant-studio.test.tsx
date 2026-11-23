import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EQUALIZER_FREQUENCIES } from "../shared/agent";
import { AssistantStudio } from "../src/components/admin/AssistantStudio";
import { SECTION_LEAVE_EVENT } from "../src/lib/section-leave";
import type { ApiResult } from "../src/lib/api-client";
import type { StudioBackends, StudioHistory, StudioRestored, StudioState, StudioVersion } from "../src/lib/studio-api";
import type { VoicesApi } from "../src/lib/voices-api";
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

const voicesApi = {
  listVoices: async () => ({
    ok: true as const,
    data: {
      available: true as const,
      cloning: false,
      design: false,
      voices: [
        { id: "af_heart", name: "Heart", kind: "preset" as const, languages: ["en"] },
        { id: "v_0123456789", name: "Ann", kind: "custom" as const, languages: ["zh"] }
      ],
      attributions: []
    }
  }),
  getLexicon: async () => ({ ok: true as const, data: {} }),
  deleteVoice: async () => ({ ok: true as const, data: undefined })
} as unknown as VoicesApi;

function version(id: string, more: Partial<StudioVersion> = {}): StudioVersion {
  return { id, savedAt: 1_800_000_000_000, by: "nora", changed: [], current: false, ...more };
}

function fakeHistory(versions: StudioVersion[] = []) {
  return {
    fetchStudioHistory: vi.fn(async (): Promise<ApiResult<StudioHistory>> => ({
      ok: true,
      data: { ok: true, versions }
    })),
    restoreStudioVersion: vi.fn<(id: string) => Promise<ApiResult<StudioRestored>>>(async () => ({
      ok: true,
      data: { ...studioState({ name: "Iris" }), restartFor: [] }
    }))
  };
}

let historyApi: ReturnType<typeof fakeHistory>;

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
  historyApi = fakeHistory();
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
      <AssistantStudio
        api={api}
        backendApi={backendApi}
        voicesApi={voicesApi}
        historyApi={historyApi}
        onSaved={onSaved}
        onAuthenticationExpired={onExpired}
      />
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

  it("mounts the Voices section between Sound and Voice backend", async () => {
    await mount(fakeApi(studioState()));
    const headings = root()
      .findAll((node) => node.type === "h3")
      .map(textOf);
    expect(headings.indexOf("声音库")).toBe(headings.indexOf("声音") + 1);
    expect(headings.indexOf("语音后端")).toBe(headings.indexOf("声音库") + 1);
    expect(textOf(root())).toContain("Ann");
  });

  it("treats choosing the assistant's voice as an unsaved change and saves voice.id beside the equalizer", async () => {
    const equalizer = { bands: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1], preamp: -2 };
    const api = fakeApi(studioState({ name: "Iris", languages: ["en"], voice: { equalizer, keep: true } }));
    await mount(api);
    expect(button(/^保存$/).props.disabled).toBe(true);
    const picker = root().find((node) => node.type === "select" && node.props.id?.endsWith("-voice"));
    expect(picker.props.value).toBe("");
    await act(async () => picker.props.onChange({ currentTarget: { value: "v_0123456789" } }));
    expect(status()).toContain("未保存");
    await act(async () => button(/^保存$/).props.onClick());
    expect(api.saveStudio).toHaveBeenCalledWith({
      name: "Iris",
      device: "motorcycle-helmet",
      languages: ["en"],
      voice: { keep: true, id: "v_0123456789", equalizer }
    });
  });

  it("drops a deleted voice from the draft without making it an unsaved change", async () => {
    const api = fakeApi(studioState({ name: "Iris", languages: ["en"], voice: { id: "v_0123456789" } }));
    await mount(api);
    const picker = () => root().find((node) => node.type === "select" && node.props.id?.endsWith("-voice"));
    expect(picker().props.value).toBe("v_0123456789");
    await act(async () => button(/^删除$/).props.onClick());
    await act(async () => button(/确认删除/).props.onClick());
    expect(picker().props.value).toBe("");
    expect(button(/^保存$/).props.disabled).toBe(true);
    expect(status()).toContain("没有未保存");
  });

  it("round-trips a stored voice id, and Default clears it", async () => {
    const api = fakeApi(studioState({ name: "Iris", languages: ["en"], voice: { id: "af_heart" } }));
    await mount(api);
    const picker = () => root().find((node) => node.type === "select" && node.props.id?.endsWith("-voice"));
    expect(picker().props.value).toBe("af_heart");
    expect(button(/^保存$/).props.disabled).toBe(true);
    await act(async () => picker().props.onChange({ currentTarget: { value: "" } }));
    await act(async () => button(/^保存$/).props.onClick());
    const saved = api.saveStudio.mock.calls[0]![0];
    expect(saved).not.toHaveProperty("voice");
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

  describe("history", () => {
    const rows = () =>
      root().findAll((node) => node.type === "li" && node.parent?.props.className === "studioHistoryList");
    const restoreButtons = () => root().findAll((node) => node.type === "button" && /^恢复$/.test(textOf(node).trim()));

    it("lists the configs that have been live, and reads the list again after a save", async () => {
      historyApi = fakeHistory([
        version("1800000060000-aaaaaaaa", {
          savedAt: 1_800_000_060_000,
          name: "Nova",
          version: "v2",
          changed: ["greeting", "guardrails"],
          current: true
        }),
        version("1800000000000-bbbbbbbb", { by: "file", name: "Iris" })
      ]);
      const api = fakeApi(studioState({ name: "Nova" }));
      await mount(api);
      expect(rows()).toHaveLength(2);
      expect(textOf(rows()[0]!)).toContain("Nova · v2");
      expect(textOf(rows()[0]!)).toContain("greeting, guardrails");
      expect(textOf(rows()[0]!)).toContain("当前");
      expect(textOf(rows()[1]!)).toContain("服务器上的配置文件");
      // Only a config that is not the current one can be gone back to.
      expect(restoreButtons()).toHaveLength(1);
      expect(historyApi.fetchStudioHistory).toHaveBeenCalledTimes(1);
      await act(async () => nameInput().props.onChange({ currentTarget: { value: "Vega" } }));
      await act(async () => button(/^保存$/).props.onClick());
      expect(historyApi.fetchStudioHistory).toHaveBeenCalledTimes(2);
    });

    it("goes back to an earlier config behind a confirmation, and says what needs a restart", async () => {
      historyApi = fakeHistory([
        version("1800000060000-aaaaaaaa", { savedAt: 1_800_000_060_000, name: "Nova", current: true }),
        version("1800000000000-bbbbbbbb", { name: "Iris" })
      ]);
      historyApi.restoreStudioVersion.mockResolvedValue({
        ok: true,
        data: { ...studioState({ name: "Iris" }), restartFor: ["tools", "analysis"] }
      });
      const { onSaved } = await mount(fakeApi(studioState({ name: "Nova" })));
      await act(async () => nameInput().props.onChange({ currentTarget: { value: "Unsaved" } }));
      confirmAnswer = false;
      await act(async () => restoreButtons()[0]!.props.onClick());
      expect(historyApi.restoreStudioVersion).not.toHaveBeenCalled();
      // The question says the unsaved edit goes.
      expect(vi.mocked(window.confirm).mock.calls[0]![0]).toContain("未保存的修改会丢失");
      confirmAnswer = true;
      await act(async () => restoreButtons()[0]!.props.onClick());
      expect(historyApi.restoreStudioVersion).toHaveBeenCalledWith("1800000000000-bbbbbbbb");
      expect(nameInput().props.value).toBe("Iris");
      expect(status()).toContain("已恢复");
      expect(status()).toContain("tools、analysis");
      expect(onSaved).toHaveBeenCalledOnce();
      expect(button(/^保存$/).props.disabled).toBe(true);
    });

    it("shows the relay's reason when a version cannot be restored, and changes nothing", async () => {
      historyApi = fakeHistory([version("1800000000000-bbbbbbbb", { name: "Iris" })]);
      historyApi.restoreStudioVersion.mockResolvedValue({
        ok: false,
        error: { kind: "http", status: 404, message: "There is no such version." }
      });
      const { onSaved } = await mount(fakeApi(studioState({ name: "Nova" })));
      confirmAnswer = true;
      await act(async () => restoreButtons()[0]!.props.onClick());
      expect(textOf(root().find((node) => node.props.className === "studioHistoryError"))).toBe(
        "There is no such version."
      );
      expect(nameInput().props.value).toBe("Nova");
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("shows six at first and the rest on request, and says so when there is nothing yet", async () => {
      historyApi = fakeHistory(
        Array.from({ length: 9 }, (_, index) => version(`180000000000${index}-cccccccc`, { name: `N${index}` }))
      );
      await mount(fakeApi(studioState({ name: "Nova" })));
      expect(rows()).toHaveLength(6);
      await act(async () => button(/显示全部 9 份/).props.onClick());
      expect(rows()).toHaveLength(9);
      act(() => renderer?.unmount());
      historyApi = fakeHistory([]);
      await mount(fakeApi(studioState()));
      expect(rows()).toHaveLength(0);
      expect(textOf(root().find((node) => node.props.className === "studioHistory"))).toContain("还没有历史版本");
    });
  });
});
