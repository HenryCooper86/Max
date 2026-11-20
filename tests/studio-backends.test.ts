import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { voiceProviderSummaries } from "../server/providers/catalog";
import { config } from "../server/runtime-config";
import {
  BACKEND_FIELDS,
  loadStudioBackends,
  resetStudioBackendsForTests,
  saveStudioBackends,
  studioBackendsState
} from "../server/studio-backends";

// Backend setup from the Studio: keys are write-only, values lie over the
// environment, and clearing one falls back to what the environment had.

const KEYS = Object.values(BACKEND_FIELDS).flatMap((fields) => fields.map((field) => field.env));
const savedEnv = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const savedDir = process.env.STUDIO_DIR;
const savedProvider = config.voiceProvider;
const savedSwitching = config.voiceProviderSwitching;
let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-backends-"));
  process.env.STUDIO_DIR = directory;
  for (const key of KEYS) delete process.env[key];
  config.voiceProvider = "mock";
  config.voiceProviderSwitching = true;
  resetStudioBackendsForTests();
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  resetStudioBackendsForTests();
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (savedDir === undefined) delete process.env.STUDIO_DIR;
  else process.env.STUDIO_DIR = savedDir;
  config.voiceProvider = savedProvider;
  config.voiceProviderSwitching = savedSwitching;
  fs.rmSync(directory, { recursive: true, force: true });
});

const backend = (id: string) => studioBackendsState().backends.find((entry) => entry.id === id)!;
const field = (id: string, env: string) => backend(id).fields.find((entry) => entry.env === env)!;

describe("studio voice backends", () => {
  it("lists every backend with its settings and never a secret", () => {
    process.env.OPENAI_API_KEY = "sk-from-env-file";
    process.env.OPENAI_VOICE = "ash";
    resetStudioBackendsForTests();
    const state = studioBackendsState();
    expect(state.backends.map((entry) => entry.id)).toEqual([
      "mock",
      "doubao",
      "openai",
      "grok",
      "gemini",
      "pipeline",
      "local",
      "local-realtime",
      "max-speech"
    ]);
    expect(field("openai", "OPENAI_API_KEY")).toEqual({
      env: "OPENAI_API_KEY",
      label: "API key",
      kind: "secret",
      set: true,
      source: "env"
    });
    expect(field("openai", "OPENAI_VOICE")).toMatchObject({ set: true, source: "env", value: "ash" });
    expect(field("grok", "XAI_API_KEY")).toMatchObject({ set: false, source: "unset" });
    expect(JSON.stringify(state)).not.toContain("sk-from-env-file");
  });

  it("sets up a backend from a key, makes it selectable, and keeps the key off the wire", () => {
    expect(backend("grok").configured).toBe(false);
    const { state, changed } = saveStudioBackends({ values: { XAI_API_KEY: "  xai-secret-123  ", XAI_VOICE: "ara" } });
    expect(changed).toEqual(["XAI_API_KEY", "XAI_VOICE"]);
    expect(process.env.XAI_API_KEY).toBe("xai-secret-123");
    expect(JSON.stringify(state)).not.toContain("xai-secret-123");
    expect(field("grok", "XAI_API_KEY")).toMatchObject({ set: true, source: "studio" });
    expect(field("grok", "XAI_VOICE")).toMatchObject({ value: "ara", source: "studio" });
    expect(voiceProviderSummaries().find((entry) => entry.id === "grok")?.configured).toBe(true);

    // On disk with owner-only permissions.
    const file = path.join(directory, "voice-backends.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).values.XAI_API_KEY).toBe("xai-secret-123");
  });

  it("falls back to the environment's value when a field is cleared", () => {
    process.env.OPENAI_API_KEY = "sk-from-env-file";
    resetStudioBackendsForTests();
    saveStudioBackends({ values: { OPENAI_API_KEY: "sk-from-studio" } });
    expect(process.env.OPENAI_API_KEY).toBe("sk-from-studio");
    saveStudioBackends({ values: { OPENAI_API_KEY: null } });
    expect(process.env.OPENAI_API_KEY).toBe("sk-from-env-file");
    expect(field("openai", "OPENAI_API_KEY")).toMatchObject({ set: true, source: "env" });

    saveStudioBackends({ values: { GEMINI_API_KEY: "g" } });
    saveStudioBackends({ values: { GEMINI_API_KEY: "" } });
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
    expect(backend("gemini").configured).toBe(false);
  });

  it("changes the default backend only to one that is set up", () => {
    expect(() => saveStudioBackends({ defaultProvider: "openai" })).toThrow(/not set up yet.*OPENAI_API_KEY/);
    expect(config.voiceProvider).toBe("mock");
    // A key and the default can arrive in the same save.
    saveStudioBackends({ values: { OPENAI_API_KEY: "sk-x" }, defaultProvider: "openai", switching: false });
    expect(config.voiceProvider).toBe("openai");
    expect(config.voiceProviderSwitching).toBe(false);
    expect(studioBackendsState()).toMatchObject({ defaultProvider: "openai", switching: false });
    expect(() => saveStudioBackends({ defaultProvider: "alexa" })).toThrow(/Unknown voice backend/);
    expect(config.voiceProvider).toBe("openai");
  });

  it("turns on local models and validates their addresses", () => {
    saveStudioBackends({
      values: { LOCAL_VOICE: "on", LOCAL_LLM_BASE_URL: "http://gpu-box.local:11434/v1", LOCAL_LLM_MODEL: "gemma3:12b" }
    });
    expect(backend("local").configured).toBe(true);
    expect(field("local", "LOCAL_LLM_MODEL").value).toBe("gemma3:12b");
    for (const bad of ["not a url", "ftp://host/v1", "http://user:pass@host/v1", "file:///etc/passwd"]) {
      expect(() => saveStudioBackends({ values: { LOCAL_STT_BASE_URL: bad } }), bad).toThrow(/address/);
    }
    expect(() => saveStudioBackends({ values: { LOCAL_VOICE: "maybe" } })).toThrow(/on or off/);
  });

  it("refuses settings it does not own and values that could smuggle another line", () => {
    expect(() => saveStudioBackends({ values: { RELAY_AUTH_TOKEN: "x" } })).toThrow(
      /not a setting the Studio can change/
    );
    expect(() => saveStudioBackends({ values: { PATH: "/tmp" } })).toThrow(/not a setting/);
    expect(() => saveStudioBackends({ values: { OPENAI_VOICE: "a\nRELAY_AUTH_TOKEN=x" } })).toThrow(
      /not a valid value/
    );
    expect(() => saveStudioBackends({ values: { OPENAI_VOICE: "x".repeat(500) } })).toThrow(/not a valid value/);
    expect(() => saveStudioBackends({ values: { OPENAI_VOICE: 7 } })).toThrow(/expected text/);
    expect(() => saveStudioBackends("nope")).toThrow(/Invalid request/);
    expect(process.env.RELAY_AUTH_TOKEN).toBeUndefined();
  });

  it("restores what was saved when the relay starts again", () => {
    saveStudioBackends({ values: { XAI_API_KEY: "xai-1", XAI_VOICE: "ara" }, defaultProvider: "grok" });
    // A restart: the environment is back to what .env provides.
    resetStudioBackendsForTests();
    for (const key of KEYS) delete process.env[key];
    config.voiceProvider = "mock";
    expect(process.env.XAI_API_KEY).toBeUndefined();
    loadStudioBackends();
    expect(process.env.XAI_API_KEY).toBe("xai-1");
    expect(config.voiceProvider).toBe("grok");
  });

  it("falls back to the environment's default when the saved default lost its key", () => {
    saveStudioBackends({ values: { XAI_API_KEY: "xai-1" }, defaultProvider: "grok" });
    saveStudioBackends({ values: { XAI_API_KEY: null } });
    expect(config.voiceProvider).toBe("mock");
  });
});
