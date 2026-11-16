import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendSetup } from "../src/components/admin/BackendSetup";
import type { ApiResult } from "../src/lib/api-client";
import type { StudioBackends, StudioBackendsUpdate } from "../src/lib/studio-api";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SECRET = "sk-test-not-a-real-key";

function backends(overrides: Partial<StudioBackends> = {}): StudioBackends {
  return {
    ok: true,
    defaultProvider: "mock",
    switching: true,
    backends: [
      {
        id: "mock",
        label: "Demo",
        kind: "demo",
        description: "Scripted.",
        local: false,
        configured: true,
        requires: "",
        fields: []
      },
      {
        id: "openai",
        label: "OpenAI Realtime",
        kind: "live",
        description: "Live speech.",
        local: false,
        configured: true,
        requires: "OPENAI_API_KEY",
        fields: [
          { env: "OPENAI_API_KEY", label: "API key", kind: "secret", set: true, source: "studio" },
          {
            env: "OPENAI_REALTIME_MODEL",
            label: "Model",
            kind: "text",
            set: true,
            source: "env",
            value: "gpt-realtime",
            placeholder: "gpt-realtime"
          }
        ]
      },
      {
        id: "gemini",
        label: "Gemini Live",
        kind: "live",
        description: "Gemini.",
        local: false,
        configured: false,
        requires: "GEMINI_API_KEY",
        fields: [{ env: "GEMINI_API_KEY", label: "API key", kind: "secret", set: false, source: "unset" }]
      },
      {
        id: "local",
        label: "Local models",
        kind: "pipeline",
        description: "Open-weight.",
        local: true,
        configured: false,
        requires: "LOCAL_VOICE=on",
        fields: [
          { env: "LOCAL_VOICE", label: "Use local models", kind: "toggle", set: false, source: "unset", value: "off" },
          {
            env: "LOCAL_STT_URL",
            label: "Speech-to-text URL",
            kind: "url",
            set: false,
            source: "unset",
            placeholder: "http://localhost:8000/v1"
          }
        ]
      }
    ],
    ...overrides
  };
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: () => {} },
    setTimeout,
    clearTimeout
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function fakeApi(initial = backends()) {
  return {
    fetchStudioBackends: vi.fn(async (): Promise<ApiResult<StudioBackends>> => ({ ok: true, data: initial })),
    saveStudioBackends: vi.fn(async (update: StudioBackendsUpdate): Promise<ApiResult<StudioBackends>> => ({
      ok: true,
      data: update.switching === undefined ? initial : { ...initial, switching: update.switching }
    }))
  };
}

async function mount(api: ReturnType<typeof fakeApi>, onSaved = vi.fn()) {
  await act(async () => {
    renderer = create(<BackendSetup api={api} onSaved={onSaved} onAuthenticationExpired={vi.fn()} />);
  });
  return onSaved;
}

const root = () => renderer!.root;
function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}
const card = (label: string) => root().find((node) => node.type === "details" && textOf(node).includes(label));
const input = (scope: ReactTestInstance, type: string) =>
  scope.find((node) => node.type === "input" && node.props.type === type);
const submit = async (scope: ReactTestInstance) => {
  const form = scope.findByType("form");
  await act(async () => form.props.onSubmit({ preventDefault: () => {} }));
};

describe("Studio voice backend setup", () => {
  it("shows status for each backend and never renders a stored secret", async () => {
    await mount(fakeApi());
    const html = JSON.stringify(renderer!.toJSON());
    expect(textOf(card("OpenAI Realtime"))).toContain("已配置");
    expect(textOf(card("Gemini Live"))).toContain("GEMINI_API_KEY");
    expect(textOf(card("Local models"))).toContain("本地");
    const key = input(card("OpenAI Realtime"), "password");
    expect(key.props.value).toBe("");
    expect(key.props.autoComplete).toBe("new-password");
    expect(key.props.placeholder).toContain("已设置");
    expect(input(card("Gemini Live"), "password").props.placeholder).not.toContain("已设置");
    expect(textOf(card("OpenAI Realtime"))).toContain("来自服务器的 .env");
    expect(input(card("OpenAI Realtime"), "text").props.value).toBe("gpt-realtime");
    expect(textOf(card("Demo"))).toContain("不需要任何设置");
    expect(html).not.toContain("sk-");
  });

  it("saves only the fields that changed, then clears the key input and refreshes", async () => {
    const api = fakeApi();
    const onSaved = await mount(api);
    const gemini = card("Gemini Live");
    await act(async () => input(gemini, "password").props.onChange({ currentTarget: { value: SECRET } }));
    await submit(card("Gemini Live"));
    expect(api.saveStudioBackends).toHaveBeenCalledWith({ values: { GEMINI_API_KEY: SECRET } });
    expect(api.fetchStudioBackends).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(input(card("Gemini Live"), "password").props.value).toBe("");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain(SECRET);
    expect(vi.mocked(window.localStorage.setItem)).not.toHaveBeenCalled();
  });

  it("sends toggles as on/off and leaves untouched fields out", async () => {
    const api = fakeApi();
    await mount(api);
    const toggle = card("Local models").find((node) => node.type === "button" && node.props.role === "switch");
    await act(async () => toggle.props.onClick());
    await submit(card("Local models"));
    expect(api.saveStudioBackends).toHaveBeenCalledWith({ values: { LOCAL_VOICE: "on" } });
  });

  it("clears a key set here back to .env with Remove", async () => {
    const api = fakeApi();
    await mount(api);
    const remove = card("OpenAI Realtime").find((node) => node.type === "button" && textOf(node) === "移除");
    await act(async () => remove.props.onClick());
    await submit(card("OpenAI Realtime"));
    expect(api.saveStudioBackends).toHaveBeenCalledWith({ values: { OPENAI_API_KEY: null } });
  });

  it("offers only set-up backends as the default, and saves the choice and the switch", async () => {
    const api = fakeApi();
    await mount(api);
    const select = root().findByType("select");
    const options = select
      .findAllByType("option")
      .map((option) => [option.props.value, Boolean(option.props.disabled)]);
    expect(options).toEqual([
      ["mock", false],
      ["openai", false],
      ["gemini", true],
      ["local", true]
    ]);
    await act(async () => select.props.onChange({ currentTarget: { value: "openai" } }));
    expect(api.saveStudioBackends).toHaveBeenCalledWith({ defaultProvider: "openai" });
    const switching = root().find(
      (node) => node.type === "button" && node.props.role === "switch" && textOf(node).includes("后端")
    );
    await act(async () => switching.props.onClick());
    expect(api.saveStudioBackends).toHaveBeenCalledWith({ switching: false });
  });

  it("shows the relay's error as-is and keeps the typed value for a retry", async () => {
    const api = fakeApi();
    api.saveStudioBackends.mockResolvedValueOnce({
      ok: false,
      error: { kind: "invalid", status: 400, message: "GEMINI_API_KEY looks malformed." }
    });
    const onSaved = await mount(api);
    await act(async () => input(card("Gemini Live"), "password").props.onChange({ currentTarget: { value: "x" } }));
    await submit(card("Gemini Live"));
    expect(textOf(card("Gemini Live"))).toContain("GEMINI_API_KEY looks malformed.");
    expect(input(card("Gemini Live"), "password").props.value).toBe("x");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
