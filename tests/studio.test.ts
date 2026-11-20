import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assistant,
  assistantProfileFrom,
  basePersonaPrompt,
  DEFAULT_ASSISTANT_PROFILE,
  setAssistantProfileForTests
} from "../server/assistant";
import {
  checkLogoUpload,
  clearStudioVoice,
  removeStudioLogo,
  saveStudioConfig,
  saveStudioLogo,
  studioConfigPath,
  studioState
} from "../server/studio";
import { containsWakePhrase } from "../shared/wake";

// The Studio writes the same file the setup wizard writes, and a save becomes
// the live assistant at once. Each test gets its own directory.

let directory: string;
const savedDir = process.env.STUDIO_DIR;
const savedConfig = process.env.ASSISTANT_CONFIG;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-test-"));
  process.env.STUDIO_DIR = directory;
  delete process.env.ASSISTANT_CONFIG;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.STUDIO_DIR;
  else process.env.STUDIO_DIR = savedDir;
  if (savedConfig === undefined) delete process.env.ASSISTANT_CONFIG;
  else process.env.ASSISTANT_CONFIG = savedConfig;
  setAssistantProfileForTests();
  fs.rmSync(directory, { recursive: true, force: true });
});

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe("studio", () => {
  it("starts from the relay's defaults and offers every device, preset and backend", () => {
    const state = studioState();
    expect(state.config).toEqual({});
    expect(state.assistant.name).toBe("Max");
    expect(state.customLogo).toBe(false);
    expect(state.devices.map((device) => device.id)).toContain("assistive-glasses");
    expect(state.equalizer.presets.length).toBeGreaterThan(10);
    expect(state.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["mock", "doubao", "openai", "local"])
    );
    // Nothing about credentials beyond set / not set.
    expect(JSON.stringify(state)).not.toMatch(/api[_-]?key|secret|token/i);
  });

  it("saves the assistant's voice id and exposes it, and drops a malformed one", () => {
    const saved = saveStudioConfig({ voice: { id: "v_0123456789", equalizer: { preset: "warm" } } });
    expect(saved.assistant.voiceId).toBe("v_0123456789");
    expect(assistant().voiceId).toBe("v_0123456789");
    for (const id of ["../etc", "a b", "x".repeat(65), 7]) {
      expect(assistantProfileFrom({ voice: { id } }).voiceId).toBeUndefined();
    }
  });

  it("clears the saved voice id only when it matches, keeping the rest of the voice settings", () => {
    saveStudioConfig({ name: "Max", voice: { id: "v_0123456789", equalizer: { preset: "warm" } } });
    expect(clearStudioVoice("v_aaaaaaaaaa")).toBe(false);
    expect(assistant().voiceId).toBe("v_0123456789");
    expect(clearStudioVoice("v_0123456789")).toBe(true);
    expect(assistant().voiceId).toBeUndefined();
    const stored = JSON.parse(fs.readFileSync(studioConfigPath(), "utf8")) as { voice?: Record<string, unknown> };
    expect(stored.voice?.id).toBeUndefined();
    expect(stored.voice?.equalizer).toBeDefined();
    expect(clearStudioVoice("v_0123456789")).toBe(false);
  });

  it("saves a config, keeps only editable keys, and makes it the live assistant", () => {
    const state = saveStudioConfig({
      name: "Iris",
      device: "assistive-glasses",
      languages: ["en"],
      wake: { names: ["iris", "爱丽丝"] },
      visualizer: "mirror",
      voice: { equalizer: { preset: "clarity" } },
      logo: "/etc/passwd",
      somethingElse: true
    });
    expect(state.assistant).toMatchObject({
      name: "Iris",
      deviceProfile: "assistive-glasses",
      template: "beacon",
      visualizer: "mirror"
    });
    expect(state.config).not.toHaveProperty("logo");
    expect(state.config).not.toHaveProperty("somethingElse");
    expect(assistant().name).toBe("Iris");
    expect(containsWakePhrase("hey iris what is in front of me")).toBe(true);
    expect(containsWakePhrase("Max, hello")).toBe(false);

    const stored = JSON.parse(fs.readFileSync(studioConfigPath(), "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({ name: "Iris", device: "assistive-glasses" });
    expect(stored).not.toHaveProperty("logo");
    // The file is what the loader reads on the next start.
    expect(assistantProfileFrom(stored, directory).preset.id).toBe("assistive-glasses");
  });

  it("rejects a config that is not an object or is absurdly large, leaving the assistant as it was", () => {
    saveStudioConfig({ name: "Nova" });
    expect(() => saveStudioConfig("Nova")).toThrow(/object/);
    expect(() => saveStudioConfig({ name: "Nova", persona: "x".repeat(40_000) })).toThrow(/too large/);
    expect(assistant().name).toBe("Nova");
    expect(JSON.parse(fs.readFileSync(studioConfigPath(), "utf8"))).toEqual({ name: "Nova" });
  });

  it("goes back to the exact original Max when reset", () => {
    saveStudioConfig({ name: "Nova", device: "sunglasses" });
    const state = saveStudioConfig({});
    expect(state.assistant).toMatchObject({ name: "Max", deviceProfile: "motorcycle-helmet" });
    expect(basePersonaPrompt()).toBe(basePersonaPrompt(DEFAULT_ASSISTANT_PROFILE));
  });

  it("keeps Max's own prompts when only the look and sound change", () => {
    saveStudioConfig({
      template: "ember",
      visualizer: "bars",
      voice: { equalizer: { preset: "warm" } },
      accentColor: "#ff8800"
    });
    expect(assistant()).toMatchObject({ template: "ember", visualizer: "bars", isDefault: true });
    expect(basePersonaPrompt()).toBe(basePersonaPrompt(DEFAULT_ASSISTANT_PROFILE));
  });

  it("stores an uploaded logo, survives later edits, and can be removed", () => {
    const uploaded = saveStudioLogo(SVG);
    expect(uploaded.customLogo).toBe(true);
    expect(assistant().logo?.path).toBe(path.join(directory, "brand-logo.svg"));

    // Editing the rest of the config does not drop the logo.
    expect(saveStudioConfig({ name: "Nova" }).customLogo).toBe(true);

    // A PNG replaces the SVG rather than sitting beside it.
    saveStudioLogo(PNG);
    expect(fs.existsSync(path.join(directory, "brand-logo.svg"))).toBe(false);
    expect(assistant().logo?.contentType).toBe("image/png");

    const removed = removeStudioLogo();
    expect(removed.customLogo).toBe(false);
    expect(fs.existsSync(path.join(directory, "brand-logo.png"))).toBe(false);
    expect(removed.assistant.name).toBe("Nova");
  });

  it("only accepts a plain drawing as a logo", () => {
    expect(checkLogoUpload(SVG)).toBe("svg");
    expect(checkLogoUpload(PNG)).toBe("png");
    const svg = (inner: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);
    for (const inner of [
      "<script>alert(1)</script>",
      '<rect onload="alert(1)"/>',
      '<a href="https://example.com"><rect/></a>',
      '<image xlink:href="http://example.com/x.png"/>',
      "<foreignObject><div/></foreignObject>",
      '<a href="javascript:alert(1)"><rect/></a>'
    ]) {
      expect(() => checkLogoUpload(svg(inner)), inner).toThrow(/plain drawing/);
    }
    // In-file references and embedded raster data are fine.
    expect(checkLogoUpload(svg('<use href="#a"/><image href="data:image/png;base64,AAAA"/>'))).toBe("svg");
    expect(() => checkLogoUpload(Buffer.from("just text"))).toThrow(/SVG or PNG/);
    expect(() => checkLogoUpload(Buffer.alloc(0))).toThrow(/empty/);
    expect(() => checkLogoUpload(Buffer.concat([PNG, Buffer.alloc(600 * 1024)]))).toThrow(/512 KB/);
  });

  it("writes to ASSISTANT_CONFIG when the deployment names a file", () => {
    process.env.ASSISTANT_CONFIG = path.join(directory, "custom", "assistant.json");
    saveStudioConfig({ name: "Vee", device: "vr" });
    expect(fs.existsSync(process.env.ASSISTANT_CONFIG)).toBe(true);
    expect(studioState().config).toMatchObject({ name: "Vee" });
  });
});
