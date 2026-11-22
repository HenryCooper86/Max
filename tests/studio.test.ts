/* eslint-disable @typescript-eslint/no-explicit-any -- stored config files are inspected structurally */
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
  ConfigFileError,
  deleteStudioVersion,
  FlowError,
  recordStartupConfig,
  removeStudioLogo,
  restoreStudioConfig,
  saveStudioConfig,
  saveStudioFlow,
  saveStudioLogo,
  studioConfigPath,
  studioFlow,
  studioHistory,
  studioState,
  studioVersion
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

describe("what a deployer wired up survives a Studio save", () => {
  const deployed = {
    name: "Ava",
    device: "app",
    conversation: { endSession: true, idleReminderSeconds: 12 },
    agents: [{ id: "billing", description: "Refunds.", instructions: "Refund politely." }],
    analysis: { summary: true },
    privacy: { redact: ["email"] },
    mcpServers: [{ name: "crm", url: "https://crm.example.com/mcp" }],
    knowledge: { files: ["./kb"], text: "Open nine to five." }
  };

  it("carries the running config's keys into the Studio's file, with knowledge paths pinned", () => {
    setAssistantProfileForTests(assistantProfileFrom(deployed, "/srv/app"));
    saveStudioConfig({ name: "Bea", device: "app" });
    const stored = JSON.parse(fs.readFileSync(studioConfigPath(), "utf8")) as Record<string, any>;
    expect(stored.name).toBe("Bea");
    expect(stored.conversation).toEqual(deployed.conversation);
    expect(stored.agents).toEqual(deployed.agents);
    expect(stored.analysis).toEqual(deployed.analysis);
    expect(stored.privacy).toEqual(deployed.privacy);
    expect(stored.mcpServers).toEqual(deployed.mcpServers);
    // The Studio's file lives elsewhere: a relative path would point at nothing.
    expect(stored.knowledge.files).toEqual([path.resolve("/srv/app", "kb")]);
    expect(stored.knowledge.text).toBe("Open nine to five.");
    // The saved assistant still has them.
    expect(assistant().agents.map((agent) => agent.id)).toEqual(["billing"]);
    expect(assistant().conversation.endSession).toBe(true);
    expect(assistant().redact).toEqual(["email"]);
  });

  it("keeps what the Studio's own file already holds across later saves", () => {
    setAssistantProfileForTests(assistantProfileFrom(deployed, "/srv/app"));
    saveStudioConfig({ name: "Bea", device: "app" });
    saveStudioConfig({ name: "Cy", device: "app", greeting: "Hello." });
    const stored = JSON.parse(fs.readFileSync(studioConfigPath(), "utf8")) as Record<string, any>;
    expect(stored.name).toBe("Cy");
    expect(stored.agents).toEqual(deployed.agents);
    expect(stored.mcpServers).toEqual(deployed.mcpServers);
  });

  it("cannot be set from the Studio itself", () => {
    saveStudioConfig({ name: "Bea", device: "app", mcpServers: [{ name: "evil", url: "https://evil.example/mcp" }] });
    const stored = JSON.parse(fs.readFileSync(studioConfigPath(), "utf8")) as Record<string, any>;
    expect(stored.mcpServers).toBeUndefined();
  });
});

describe("the Studio's history", () => {
  it("keeps every config that was saved, and says who saved it and what changed", () => {
    expect(studioHistory()).toEqual({ ok: true, versions: [] });
    saveStudioConfig({ name: "Iris", greeting: "Hello." }, "nora");
    saveStudioConfig({ name: "Iris", greeting: "Good day.", device: "app" }, "omar");
    const { versions } = studioHistory();
    expect(versions.map((version) => [version.by, version.name, version.changed, version.current])).toEqual([
      ["omar", "Iris", ["device", "greeting"], true],
      ["nora", "Iris", ["greeting", "name"], false],
      // The relay's built-in assistant, as it was before the first save.
      ["defaults", undefined, [], false]
    ]);
    // Saving the same again is not another version.
    saveStudioConfig({ name: "Iris", greeting: "Good day.", device: "app" }, "omar");
    expect(studioHistory().versions).toHaveLength(3);
    // The files sit beside the config, for the relay's user only.
    const kept = fs.readdirSync(path.join(directory, "config-history"));
    expect(kept).toHaveLength(3);
    expect(fs.statSync(path.join(directory, "config-history", kept[0]!)).mode & 0o777).toBe(0o600);
  });

  it("shows one version in full, without the logo's path on the server", () => {
    saveStudioConfig({ name: "Iris" }, "nora");
    saveStudioLogo(SVG);
    const [withLogo] = studioHistory().versions;
    expect(withLogo!.changed).toEqual(["logo"]);
    const shown = studioVersion(withLogo!.id)!;
    expect(shown).toMatchObject({ ok: true, id: withLogo!.id, by: "studio", config: { name: "Iris" } });
    expect(shown.config).not.toHaveProperty("logo");
    expect(studioVersion("1800000000000-00000000")).toBeUndefined();
    expect(studioVersion("../assistant.config")).toBeUndefined();
  });

  it("goes back to an earlier config: the file, the live assistant and a new entry in the history", () => {
    saveStudioConfig({ name: "Iris", greeting: "Hello." }, "nora");
    saveStudioConfig({ name: "Nova", greeting: "Good day." }, "nora");
    const first = studioHistory().versions[1]!;
    const state = restoreStudioConfig(first.id, "omar")!;
    expect(state.assistant.name).toBe("Iris");
    expect(state.restartFor).toEqual([]);
    expect(assistant().name).toBe("Iris");
    expect(JSON.parse(fs.readFileSync(studioConfigPath(), "utf8"))).toEqual({ name: "Iris", greeting: "Hello." });
    const { versions } = studioHistory();
    expect(versions).toHaveLength(4);
    expect(versions[0]).toMatchObject({ by: "omar", restoredFrom: first.id, name: "Iris", current: true });
    // The version it came from says the same; only the newest is marked.
    expect(versions.map((version) => version.current)).toEqual([true, false, false, false]);
    expect(restoreStudioConfig("1800000000000-00000000", "omar")).toBeUndefined();
  });

  it("has a way back to the relay's built-in assistant", () => {
    saveStudioConfig({ name: "Iris", device: "sunglasses" }, "nora");
    const start = studioHistory().versions.at(-1)!;
    expect(start.by).toBe("defaults");
    const state = restoreStudioConfig(start.id, "nora")!;
    expect(state.assistant.name).toBe("Max");
    expect(state.config).toEqual({});
    expect(basePersonaPrompt()).toBe(basePersonaPrompt(DEFAULT_ASSISTANT_PROFILE));
    // Kept once: later saves do not add it again.
    saveStudioConfig({ name: "Nova" }, "nora");
    expect(studioHistory().versions.filter((version) => version.by === "defaults")).toHaveLength(1);
  });

  it("does not bring back a logo whose file is gone, and keeps one whose file is there", () => {
    saveStudioConfig({ name: "Iris" }, "nora");
    saveStudioLogo(SVG);
    const withSvg = studioHistory().versions[0]!;
    saveStudioLogo(PNG);
    const withPng = studioHistory().versions[0]!;
    // The svg was replaced by the png: going back to that config keeps the logo there is now.
    let state = restoreStudioConfig(withSvg.id, "nora")!;
    expect(state.customLogo).toBe(true);
    expect(assistant().logo?.path).toBe(path.join(directory, "brand-logo.png"));
    expect(assistant().configProblems).toEqual([]);
    // A config from before any logo has none; the picture stays on disk for the configs that name it.
    const bare = studioHistory().versions.find((version) => version.by === "nora" && version.name === "Iris")!;
    state = restoreStudioConfig(bare.id, "nora")!;
    expect(state.customLogo).toBe(false);
    expect(fs.existsSync(path.join(directory, "brand-logo.png"))).toBe(true);
    state = restoreStudioConfig(withPng.id, "nora")!;
    expect(state.customLogo).toBe(true);
    // With no logo anywhere, a version that names a missing one is restored without it.
    removeStudioLogo();
    state = restoreStudioConfig(withPng.id, "nora")!;
    expect(state.customLogo).toBe(false);
    expect(JSON.parse(fs.readFileSync(studioConfigPath(), "utf8"))).toEqual({ name: "Iris" });
  });

  it("takes a deleted voice out of every kept config", () => {
    saveStudioConfig({ name: "Iris", voice: { id: "v_0123456789", equalizer: { preset: "warm" } } }, "nora");
    saveStudioConfig({ name: "Nova", voice: { id: "v_0123456789" } }, "nora");
    saveStudioConfig({ name: "Vega" }, "nora");
    // The current config does not use the voice, the kept ones do.
    expect(clearStudioVoice("v_0123456789")).toBe(false);
    const [, nova, iris] = studioHistory().versions;
    expect(studioVersion(iris!.id)!.config).toEqual({ name: "Iris", voice: { equalizer: { preset: "warm" } } });
    expect(studioVersion(nova!.id)!.config).toEqual({ name: "Nova" });
    restoreStudioConfig(iris!.id, "nora");
    expect(assistant().voiceId).toBeUndefined();
  });

  it("names for a restart only what the running relay really has differently", () => {
    fs.writeFileSync(path.join(directory, "faq.md"), "# FAQ\n\nWe ship on Mondays.\n");
    const started = assistantProfileFrom(
      { name: "Iris", knowledge: { files: ["faq.md"] }, privacy: { redact: ["email", "phone"] } },
      directory
    );
    setAssistantProfileForTests(started);
    // The first save from the Studio writes the knowledge base as the loader resolved it.
    saveStudioConfig({ name: "Nova" }, "nora");
    const resolved = studioHistory().versions[0]!;
    expect(studioVersion(resolved.id)!.config).toMatchObject({
      knowledge: { files: [path.join(directory, "faq.md")] }
    });
    expect(restoreStudioConfig(resolved.id, "nora", started)!.restartFor).toEqual([]);
    // The same knowledge base and the same kinds to redact, written another way by hand.
    fs.writeFileSync(
      studioConfigPath(),
      JSON.stringify({ name: "Iris", knowledge: "faq.md", privacy: { redact: ["phone", "email"] } })
    );
    saveStudioConfig({ name: "Vega" }, "nora");
    const byHand = studioHistory().versions[0]!;
    expect(studioVersion(byHand.id)!.config).toMatchObject({ knowledge: "faq.md" });
    expect(restoreStudioConfig(resolved.id, "nora", started)!.restartFor).toEqual([]);
    expect(restoreStudioConfig(byHand.id, "nora", started)!.restartFor).toEqual([]);
    // Against a relay that started with neither, both need a restart.
    expect(restoreStudioConfig(byHand.id, "nora")!.restartFor).toEqual(["tools", "privacy"]);
  });

  it("removes a kept config on request", () => {
    saveStudioConfig({ name: "Iris" }, "nora");
    saveStudioConfig({ name: "Nova" }, "nora");
    const iris = studioHistory().versions[1]!;
    expect(deleteStudioVersion(iris.id)).toBe(true);
    expect(deleteStudioVersion(iris.id)).toBe(false);
    expect(studioHistory().versions.map((version) => version.name)).toEqual(["Nova", undefined]);
    expect(restoreStudioConfig(iris.id, "nora")).toBeUndefined();
  });

  it("says that the file could not be written, and changes nothing, when it cannot be", () => {
    saveStudioConfig({ name: "Iris" }, "nora");
    saveStudioConfig({ name: "Nova" }, "nora");
    const iris = studioHistory().versions[1]!;
    // A directory where the temporary file goes: the write fails.
    fs.mkdirSync(`${studioConfigPath()}.${process.pid}.tmp`);
    expect(() => restoreStudioConfig(iris.id, "nora")).toThrow(ConfigFileError);
    expect(assistant().name).toBe("Nova");
    expect(JSON.parse(fs.readFileSync(studioConfigPath(), "utf8"))).toEqual({ name: "Nova" });
    expect(studioHistory().versions[0]!.name).toBe("Nova");
  });

  it("brings back the keys the Studio does not edit, and says what needs a restart", () => {
    const withTools = {
      name: "Iris",
      version: "one",
      guardrails: { blockedTerms: ["Acme"] },
      analysis: { summary: true },
      tools: [{ name: "ping", description: "Ping.", webhook: { url: "http://localhost:9/ping" } }]
    };
    fs.writeFileSync(studioConfigPath(), JSON.stringify(withTools));
    // A save from the Studio carries those keys along, and is the first version kept.
    saveStudioConfig({ name: "Iris" }, "nora");
    const kept = studioHistory().versions[0]!;
    fs.writeFileSync(studioConfigPath(), JSON.stringify({ name: "Bare" }));
    const state = restoreStudioConfig(kept.id, "nora")!;
    expect(assistant().guardrails?.blockedTerms).toEqual(["Acme"]);
    expect(assistant().version).toBe("one");
    expect(JSON.parse(fs.readFileSync(studioConfigPath(), "utf8"))).toEqual(withTools);
    // The relay in this test started without tools and without an analysis.
    expect(state.restartFor).toEqual(["tools", "analysis"]);
  });

  it("keeps the config the relay started with, once, also when it was edited by hand", () => {
    const raw = { name: "Iris", toolsModule: "./tools.mjs", guardrails: { blockedTerms: ["Acme"] } };
    fs.writeFileSync(studioConfigPath(), JSON.stringify(raw));
    recordStartupConfig({ file: studioConfigPath(), raw });
    recordStartupConfig({ file: studioConfigPath(), raw });
    let { versions } = studioHistory();
    expect(versions).toHaveLength(1);
    // The Studio's own file: kept as written, and it is the current config.
    expect(versions[0]).toMatchObject({ by: "file", name: "Iris", current: true });
    expect(studioVersion(versions[0]!.id)!.config).toEqual(raw);
    // Edited by hand and started again.
    const edited = { ...raw, name: "Nova" };
    fs.writeFileSync(studioConfigPath(), JSON.stringify(edited));
    recordStartupConfig({ file: studioConfigPath(), raw: edited });
    ({ versions } = studioHistory());
    expect(versions.map((version) => [version.by, version.name, version.changed])).toEqual([
      ["file", "Nova", ["name"]],
      ["file", "Iris", []]
    ]);
    // Nothing is kept for a relay on its defaults.
    recordStartupConfig(undefined);
    expect(studioHistory().versions).toHaveLength(2);
  });

  it("makes the paths absolute in a config that was started from another directory", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "studio-elsewhere-"));
    try {
      const raw = { name: "Iris", toolsModule: "./tools.mjs", logo: "brand/logo.svg" };
      fs.mkdirSync(path.join(elsewhere, "brand"));
      fs.writeFileSync(path.join(elsewhere, "brand/logo.svg"), SVG);
      recordStartupConfig({ file: path.join(elsewhere, "assistant.config.json"), raw });
      const [version] = studioHistory().versions;
      // The Studio has no file of its own yet, so nothing is the current config.
      expect(version).toMatchObject({ by: "file", current: false });
      const file = path.join(directory, "config-history", `${version!.id}.json`);
      expect((JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>).config).toEqual({
        name: "Iris",
        toolsModule: path.join(elsewhere, "tools.mjs"),
        logo: path.join(elsewhere, "brand/logo.svg")
      });
      // Going back to it writes the Studio's file, from which those paths still lead to the same files.
      restoreStudioConfig(version!.id, "nora");
      expect(assistant().tools.modulePath).toBe(path.join(elsewhere, "tools.mjs"));
      expect(studioHistory().versions.map((kept) => kept.current)).toEqual([true]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("leaves everything as it was when a kept version's file is damaged", () => {
    saveStudioConfig({ name: "Iris" }, "nora");
    const [version] = studioHistory().versions;
    const file = path.join(directory, "config-history", `${version!.id}.json`);
    saveStudioConfig({ name: "Nova" }, "nora");
    for (const damaged of [
      "{",
      JSON.stringify({ savedAt: 1, by: "x", config: "Iris" }),
      JSON.stringify({ config: {} })
    ]) {
      fs.writeFileSync(file, damaged);
      expect(restoreStudioConfig(version!.id, "nora")).toBeUndefined();
      expect(studioVersion(version!.id)).toBeUndefined();
    }
    expect(assistant().name).toBe("Nova");
    expect(JSON.parse(fs.readFileSync(studioConfigPath(), "utf8"))).toEqual({ name: "Nova" });
    // The list goes on without it.
    expect(studioHistory().versions.map((kept) => kept.name)).toEqual(["Nova", undefined]);
  });
});

describe("the Studio's flow", () => {
  const billing = { id: "billing", description: "Invoices.", instructions: "Find the invoice first." };
  const drawn = [
    { id: "main", handoffs: [{ to: "billing", when: "An invoice or a payment." }], at: [40, 40] },
    { ...billing, tools: ["get_invoice"], handoffs: [], at: [360, 40] }
  ];

  it("shows the start alone on a relay without agents", () => {
    expect(studioFlow()).toEqual({ ok: true, steps: [{ id: "main" }], problems: [] });
  });

  it("saves a flow as the agents key, live at once, and leaves the rest of the config as it is", () => {
    saveStudioConfig({ name: "Iris", greeting: "Hello." }, "nora");
    const flow = saveStudioFlow(drawn, "omar");
    expect(flow.steps).toEqual(drawn);
    expect(assistant().name).toBe("Iris");
    expect(assistant().agents.map((agent) => [agent.id, agent.handoffs])).toEqual([
      ["main", [{ to: "billing", when: "An invoice or a payment." }]],
      ["billing", []]
    ]);
    expect(JSON.parse(fs.readFileSync(studioConfigPath(), "utf8"))).toEqual({
      name: "Iris",
      greeting: "Hello.",
      agents: drawn
    });
    // It is a config like any other: kept in the history, and a save of the form keeps it.
    expect(studioHistory().versions[0]).toMatchObject({ by: "omar", changed: ["agents"], current: true });
    saveStudioConfig({ name: "Nova" }, "nora");
    expect(studioFlow().steps).toEqual(drawn);
  });

  it("takes the flow away again when only an empty start is left", () => {
    saveStudioFlow(drawn, "omar");
    const flow = saveStudioFlow([{ id: "main" }], "omar");
    expect(flow.steps).toEqual([{ id: "main" }]);
    expect(assistant().agents).toEqual([]);
    expect(JSON.parse(fs.readFileSync(studioConfigPath(), "utf8"))).toEqual({});
  });

  it("refuses a flow that is not right in every part, and changes nothing", () => {
    saveStudioFlow(drawn, "omar");
    let thrown: unknown;
    try {
      saveStudioFlow([drawn[0], { ...billing, handoffs: ["legal"] }, { id: "sales" }], "omar");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FlowError);
    expect((thrown as FlowError).problems).toEqual([
      "Agent sales needs instructions.",
      "Agent billing: there is no agent legal to hand over to."
    ]);
    expect(studioFlow().steps).toEqual(drawn);
    expect(studioHistory().versions[0]!.by).toBe("omar");
    expect(studioHistory().versions.filter((version) => version.by === "omar")).toHaveLength(1);
  });

  it("puts the flow into the config the relay started from when the Studio has no file yet", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "studio-elsewhere-"));
    try {
      const raw = { name: "Iris", instructions: "You work for Acme.", toolsModule: "./tools.mjs" };
      const loaded = { file: path.join(elsewhere, "assistant.config.json"), raw };
      setAssistantProfileForTests(assistantProfileFrom(raw, elsewhere));
      saveStudioFlow(drawn, "omar", loaded);
      expect(JSON.parse(fs.readFileSync(studioConfigPath(), "utf8"))).toEqual({
        name: "Iris",
        instructions: "You work for Acme.",
        toolsModule: path.join(elsewhere, "tools.mjs"),
        agents: drawn
      });
      expect(assistant().name).toBe("Iris");
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("says that the file could not be written when it cannot be", () => {
    saveStudioConfig({ name: "Iris" }, "nora");
    fs.mkdirSync(`${studioConfigPath()}.${process.pid}.tmp`);
    expect(() => saveStudioFlow(drawn, "omar")).toThrow(ConfigFileError);
    expect(assistant().agents).toEqual([]);
  });
});
