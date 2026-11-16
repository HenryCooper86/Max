import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { EQUALIZER_PRESETS } from "../server/audio-eq";
import { DEVICE_PRESETS, devicePreset, isKnownDevice } from "../server/device-presets";
import { VOICE_PROVIDERS } from "../server/providers/catalog";
import { localPipelineSettings } from "../server/providers/live/pipeline";

/**
 * `npm run setup` — makes the kit yours in a minute.
 *
 * Asks who the assistant is and which voice backend it uses, then writes
 * `assistant.config.json` and merges the chosen settings into `.env`. Existing
 * `.env` lines it does not manage are left exactly as they are. Nothing is
 * sent anywhere: keys go from your keyboard to your own `.env`.
 */

const root = process.cwd();
const envPath = path.join(root, ".env");
const assistantPath = path.join(root, "assistant.config.json");

const KEY_FOR: Record<string, string | undefined> = {
  doubao: "DOUBAO_API_KEY",
  openai: "OPENAI_API_KEY",
  grok: "XAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  pipeline: "PIPELINE_API_KEY"
};

/** Replaces or appends `KEY=value` lines, keeping everything else. Exported for tests. */
export function mergeEnv(existing: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates));
  const lines = existing.split("\n").map((line) => {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!match || !pending.has(match[1]!)) return line;
    const value = pending.get(match[1]!)!;
    pending.delete(match[1]!);
    return `${match[1]}=${value}`;
  });
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

/** The three stages of the local pipeline, as the wizard asks about them. */
export const LOCAL_STAGES = [
  { key: "STT", label: "Speech-to-text", server: "Speaches / whisper.cpp", model: "Speech-to-text model" },
  { key: "LLM", label: "Chat model", server: "Ollama / llama.cpp / vLLM / LM Studio", model: "Chat model name" },
  { key: "TTS", label: "Text-to-speech", server: "Kokoro-FastAPI / openedai-speech", model: "Text-to-speech model" }
] as const;

export type LocalAnswers = Record<"STT" | "LLM" | "TTS", { baseUrl: string; model: string }> & {
  voice: string;
  voiceMale: string;
};

/** The .env lines for a local stack. Only what differs from the relay's own
 *  defaults is written, so the file says what this installation changed. */
export function localEnv(answers: LocalAnswers, defaults: LocalAnswers): Record<string, string> {
  const env: Record<string, string> = { LOCAL_VOICE: "on" };
  for (const { key } of LOCAL_STAGES) {
    const baseUrl = answers[key].baseUrl.trim().replace(/\/+$/, "");
    if (baseUrl && baseUrl !== defaults[key].baseUrl) env[`LOCAL_${key}_BASE_URL`] = baseUrl;
    const model = answers[key].model.trim();
    if (model && model !== defaults[key].model) env[`LOCAL_${key}_MODEL`] = model;
  }
  if (answers.voice.trim() && answers.voice.trim() !== defaults.voice) env.LOCAL_TTS_VOICE = answers.voice.trim();
  if (answers.voiceMale.trim() && answers.voiceMale.trim() !== defaults.voiceMale) {
    env.LOCAL_TTS_VOICE_MALE = answers.voiceMale.trim();
  }
  return env;
}

/** Whether an OpenAI-compatible server answers at `baseUrl`. Any HTTP reply
 *  counts: servers differ on whether /models needs a key or exists at all. */
export async function serverResponds(baseUrl: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    await request(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(2500) });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // Answers are read as a stream of lines rather than with rl.question, so the
  // wizard behaves the same at a keyboard and with answers piped in (a script,
  // a test): piped input arrives all at once and would otherwise be lost.
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string, fallback: string) => {
    process.stdout.write(`${question}${fallback ? ` [${fallback}]` : ""}: `);
    const next = await lines.next();
    if (next.done) process.stdout.write("\n");
    return (next.done ? "" : String(next.value)).trim() || fallback;
  };

  console.log("\nSet up your voice assistant. Press Enter to keep the value in brackets.\n");

  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(assistantPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* first run */
  }

  const name = await ask("Assistant name", typeof current.name === "string" ? current.name : "Max");
  console.log("\nDevices:");
  DEVICE_PRESETS.forEach((preset, index) => console.log(`  ${index + 1}. ${preset.id.padEnd(20)} ${preset.label.en}`));
  const currentDevice = devicePreset(current.device).id;
  const deviceAnswer = await ask("Device (number or id)", currentDevice);
  const device = /^\d+$/.test(deviceAnswer)
    ? (DEVICE_PRESETS[Number(deviceAnswer) - 1]?.id ?? currentDevice)
    : isKnownDevice(deviceAnswer)
      ? devicePreset(deviceAnswer).id
      : currentDevice;
  const chosenDevice = devicePreset(device);
  const languages = (await ask("Languages, most preferred first", "en, zh"))
    .split(/[,\s]+/)
    .map((code) => code.toLowerCase())
    .filter(Boolean);
  const extraNames = (await ask(`Other spellings people or speech recognition use for "${name}" (comma separated)`, ""))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const developer = await ask("Built by (leave empty to not name a maker)", "");
  const template = await ask("Design template (visor, daylight, beacon, ember, holo)", chosenDevice.template);
  const accentColor = await ask("Accent colour (#RRGGBB, Enter to keep the template's)", "");
  console.log(`\nVoice equaliser presets: ${EQUALIZER_PRESETS.map((preset) => preset.id).join(", ")}`);
  const equalizer = await ask("Equaliser preset", chosenDevice.equalizer);
  const visualizer = await ask("Voice display (wave, bars, mirror, dots, ring)", chosenDevice.visualizer);

  console.log("\nVoice backends:");
  VOICE_PROVIDERS.forEach((entry, index) => {
    console.log(`  ${index + 1}. ${entry.label.padEnd(18)} ${entry.description}`);
  });
  const picked = Number(await ask("Default backend number", "1"));
  const provider = VOICE_PROVIDERS[Number.isInteger(picked) ? picked - 1 : 0] ?? VOICE_PROVIDERS[0]!;

  const env: Record<string, string> = { VOICE_PROVIDER: provider.id };
  let localNotes: string[] = [];
  if (provider.id === "local") {
    const stack = localPipelineSettings();
    const defaults: LocalAnswers = {
      STT: { baseUrl: stack.stt.baseUrl, model: stack.stt.model },
      LLM: { baseUrl: stack.llm.baseUrl, model: stack.llm.model },
      TTS: { baseUrl: stack.tts.baseUrl, model: stack.tts.model },
      voice: stack.tts.voice("female"),
      voiceMale: stack.tts.voice("male")
    };
    console.log("\nLocal models run on your own hardware, with no account and no API key.");
    console.log("Each stage is any OpenAI-compatible server. Press Enter to keep the usual defaults.\n");
    const answers: LocalAnswers = {
      ...defaults,
      STT: { ...defaults.STT },
      LLM: { ...defaults.LLM },
      TTS: { ...defaults.TTS }
    };
    for (const { key, label, server, model } of LOCAL_STAGES) {
      answers[key].baseUrl = await ask(`${label} server (${server})`, defaults[key].baseUrl);
      answers[key].model = await ask(model, defaults[key].model);
    }
    answers.voice = await ask("Voice (female)", defaults.voice);
    answers.voiceMale = await ask("Voice (male)", defaults.voiceMale);
    Object.assign(env, localEnv(answers, defaults));

    console.log("\nChecking the three servers…");
    let missing = 0;
    for (const { key, label } of LOCAL_STAGES) {
      const up = await serverResponds(answers[key].baseUrl);
      if (!up) missing += 1;
      console.log(`  ${up ? "✓" : "✗"} ${label.padEnd(15)} ${answers[key].baseUrl}${up ? "" : "  — not answering"}`);
    }
    if (missing) {
      localNotes = [
        "Start the local stack before running the relay:",
        "  docker compose -f docker-compose.local-voice.yml up -d",
        `  docker compose -f docker-compose.local-voice.yml exec ollama ollama pull ${answers.LLM.model}`,
        "See docs/local-models.md for other servers and models."
      ];
    } else {
      localNotes = [
        `If the chat model is not downloaded yet:  ollama pull ${answers.LLM.model}`,
        "See docs/local-models.md for other servers and models."
      ];
    }
  }
  if (provider.id === "local-realtime") {
    env.LOCAL_REALTIME_URL = await ask("Local realtime server URL", "ws://localhost:8000/v1/realtime");
  }
  const keyName = KEY_FOR[provider.id];
  if (keyName) {
    const key = await ask(`${keyName} (Enter to skip and add it to .env yourself)`, "");
    if (key) env[keyName] = key;
  }
  rl.close();

  const profile = {
    name,
    device,
    languages: languages.length ? languages : ["en"],
    ...(developer ? { developer } : {}),
    ...(/^#[0-9a-f]{6}$/i.test(accentColor) ? { accentColor } : {}),
    ...(extraNames.length ? { wake: { names: extraNames } } : {}),
    template,
    ...(["wave", "bars", "mirror", "dots", "ring"].includes(visualizer) ? { visualizer } : {}),
    ...(EQUALIZER_PRESETS.some((preset) => preset.id === equalizer)
      ? { voice: { equalizer: { preset: equalizer } } }
      : {})
  };
  fs.writeFileSync(assistantPath, `${JSON.stringify(profile, null, 2)}\n`);

  let existing = "";
  try {
    existing = fs.readFileSync(envPath, "utf8");
  } catch {
    /* no .env yet */
  }
  fs.writeFileSync(envPath, mergeEnv(existing, env), { mode: 0o600 });

  console.log(`\nWrote ${path.basename(assistantPath)} and updated .env (VOICE_PROVIDER=${provider.id}).`);
  for (const line of localNotes) console.log(line);
  console.log("Start it with:  npm run dev   then open http://localhost:5173\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
