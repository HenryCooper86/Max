import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  localEnv,
  LOCAL_STAGES,
  mergeEnv,
  mergeProfile,
  CLEAR_ANSWER,
  readCurrentProfile,
  serverResponds,
  type LocalAnswers,
  type ProfileAnswers
} from "../scripts/setup";

describe("setup wizard env merge", () => {
  it("replaces managed keys in place and leaves everything else untouched", () => {
    const before = "# keys\nAMAP_API_KEY=abc\nVOICE_PROVIDER=mock\n# OPENAI_API_KEY=\n\n";
    expect(mergeEnv(before, { VOICE_PROVIDER: "grok", XAI_API_KEY: "k" })).toBe(
      "# keys\nAMAP_API_KEY=abc\nVOICE_PROVIDER=grok\n# OPENAI_API_KEY=\nXAI_API_KEY=k\n"
    );
  });

  it("creates a file from nothing", () => {
    expect(mergeEnv("", { VOICE_PROVIDER: "openai" })).toBe("VOICE_PROVIDER=openai\n");
  });
});

describe("setup wizard assistant config", () => {
  const answers: ProfileAnswers = {
    name: "Ava",
    device: "app",
    languages: ["en"],
    wakeNames: ["Eva"],
    developer: "",
    template: "visor",
    accentColor: "",
    equalizer: "",
    visualizer: "bars"
  };

  it("keeps the keys it does not ask about when run again", () => {
    const current = {
      name: "Max",
      instructions: "You are the voice assistant of the Acme shop.",
      greeting: "Hi!",
      toolsModule: "./agent-tools.ts",
      developer: "Acme",
      accentColor: "#112233",
      wake: { names: ["Macs"], sensitivity: 0.6 },
      voice: { gender: "female", equalizer: { preset: "soft", gains: [1, 2] } }
    };
    expect(mergeProfile(current, { ...answers, equalizer: "clarity" })).toEqual({
      ...current,
      name: "Ava",
      device: "app",
      languages: ["en"],
      template: "visor",
      visualizer: "bars",
      wake: { names: ["Eva"], sensitivity: 0.6 },
      voice: { gender: "female", equalizer: { preset: "clarity", gains: [1, 2] } }
    });
  });

  it("removes what is answered with a dash, keeping the rest of the wake settings", () => {
    const current = { developer: "Acme", accentColor: "#112233", wake: { names: ["Macs"], sensitivity: 0.6 } };
    const cleared = mergeProfile(current, {
      ...answers,
      developer: CLEAR_ANSWER,
      accentColor: CLEAR_ANSWER,
      wakeNames: [CLEAR_ANSWER]
    });
    expect(cleared).not.toHaveProperty("developer");
    expect(cleared).not.toHaveProperty("accentColor");
    expect(cleared.wake).toEqual({ sensitivity: 0.6 });
    expect(mergeProfile({ wake: { names: ["Macs"] } }, { ...answers, wakeNames: [CLEAR_ANSWER] })).not.toHaveProperty(
      "wake"
    );
  });

  it("gives a new device its own look and sound, and keeps them for the same device", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-wizard-"));
    const file = path.join(dir, "assistant.config.json");
    const helmet = {
      name: "Max",
      device: "motorcycle-helmet",
      instructions: "Ride safe.",
      template: "beacon",
      visualizer: "dots",
      voice: { equalizer: { preset: "radio" } }
    };
    // Name, device, languages, wake names, maker, template, accent, equaliser, display, backend 1 (the demo).
    const run = (device: string) => {
      fs.writeFileSync(file, JSON.stringify(helmet));
      const result = spawnSync(path.resolve("node_modules/.bin/tsx"), [path.resolve("scripts/setup.ts")], {
        cwd: dir,
        input: `\n${device}\n\n\n\n\n\n\n\n1\n`,
        encoding: "utf8"
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    };
    try {
      const app = run("app");
      expect(app).toMatchObject({
        device: "app",
        template: "daylight",
        visualizer: "ring",
        instructions: "Ride safe."
      });
      expect(app.voice).toEqual({ equalizer: { preset: "flat" } });
      const same = run("");
      expect(same).toMatchObject({ device: "motorcycle-helmet", template: "beacon", visualizer: "dots" });
      expect(same.voice).toEqual({ equalizer: { preset: "radio" } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to treat an unreadable config as a first run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-wizard-"));
    try {
      const file = path.join(dir, "assistant.config.json");
      expect(readCurrentProfile(file)).toEqual({});
      fs.writeFileSync(file, '{ "name": "Max", ');
      expect(() => readCurrentProfile(file)).toThrow();
      fs.writeFileSync(file, "[]");
      expect(() => readCurrentProfile(file)).toThrow(/not a JSON object/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("setup wizard local models", () => {
  const defaults: LocalAnswers = {
    STT: { baseUrl: "http://localhost:8000/v1", model: "Systran/faster-whisper-small" },
    LLM: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
    TTS: { baseUrl: "http://localhost:8880/v1", model: "kokoro" },
    voice: "af_heart",
    voiceMale: "am_michael"
  };

  it("asks about speech-to-text, the chat model and text-to-speech", () => {
    expect(LOCAL_STAGES.map((stage) => stage.key)).toEqual(["STT", "LLM", "TTS"]);
  });

  it("turns the local backend on and writes only what was changed", () => {
    expect(localEnv(defaults, defaults)).toEqual({ LOCAL_VOICE: "on" });
    expect(
      localEnv(
        {
          ...defaults,
          LLM: { baseUrl: "http://gpu-box.local:8001/v1/", model: "gemma3:12b" },
          TTS: { ...defaults.TTS, model: "piper" },
          voice: "bf_emma"
        },
        defaults
      )
    ).toEqual({
      LOCAL_VOICE: "on",
      LOCAL_LLM_BASE_URL: "http://gpu-box.local:8001/v1",
      LOCAL_LLM_MODEL: "gemma3:12b",
      LOCAL_TTS_MODEL: "piper",
      LOCAL_TTS_VOICE: "bf_emma"
    });
  });

  it("reports whether a local server answers, whatever its reply", async () => {
    const calls: string[] = [];
    const answering = (async (url: string) => {
      calls.push(url);
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await serverResponds("http://localhost:11434/v1/", answering)).toBe(true);
    expect(calls).toEqual(["http://localhost:11434/v1/models"]);
    expect(await serverResponds("http://localhost:11434/v1", dead)).toBe(false);
  });
});
