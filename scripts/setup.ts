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
 * Asks who the assistant is and which voice backend it uses, then updates
 * `assistant.config.json` and merges the chosen settings into `.env`. Keys of
 * an existing config the wizard does not ask about (instructions, greeting,
 * tools and the rest) are kept, as are `.env` lines it does not manage.
 * Nothing is sent anywhere: keys go from your keyboard to your own `.env`.
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

/** What the wizard asks about the assistant itself. */
export type ProfileAnswers = {
  name: string;
  device: string;
  languages: string[];
  wakeNames: string[];
  developer: string;
  template: string;
  accentColor: string;
  equalizer: string;
  visualizer: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Typed as an answer, removes the current value (Enter keeps it). */
export const CLEAR_ANSWER = "-";

/**
 * The assistant config after the wizard: the existing config with the
 * answered keys replaced. Answers left empty or invalid keep what was there,
 * CLEAR_ANSWER removes it, and nested objects (`wake`, `voice`) keep their
 * other keys. Exported for tests.
 */
export function mergeProfile(current: Record<string, unknown>, answers: ProfileAnswers): Record<string, unknown> {
  const profile: Record<string, unknown> = {
    ...current,
    name: answers.name,
    device: answers.device,
    languages: answers.languages.length ? answers.languages : ["en"],
    template: answers.template
  };
  if (answers.developer === CLEAR_ANSWER) delete profile.developer;
  else if (answers.developer) profile.developer = answers.developer;
  if (answers.accentColor === CLEAR_ANSWER) delete profile.accentColor;
  else if (/^#[0-9a-f]{6}$/i.test(answers.accentColor)) profile.accentColor = answers.accentColor;
  const wake = { ...(isRecord(current.wake) ? current.wake : {}) };
  if (answers.wakeNames.length === 1 && answers.wakeNames[0] === CLEAR_ANSWER) {
    delete wake.names;
    if (Object.keys(wake).length) profile.wake = wake;
    else delete profile.wake;
  } else if (answers.wakeNames.length) {
    profile.wake = { ...wake, names: answers.wakeNames };
  }
  if (["wave", "bars", "mirror", "dots", "ring"].includes(answers.visualizer)) profile.visualizer = answers.visualizer;
  if (EQUALIZER_PRESETS.some((preset) => preset.id === answers.equalizer)) {
    const voice = isRecord(current.voice) ? current.voice : {};
    const equalizer = isRecord(voice.equalizer) ? voice.equalizer : {};
    profile.voice = { ...voice, equalizer: { ...equalizer, preset: answers.equalizer } };
  }
  return profile;
}

/** The existing assistant config, `{}` when there is none. Throws on a file
 *  that exists but is not a JSON object, so the wizard never overwrites it. */
export function readCurrentProfile(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${path.basename(file)} is not a JSON object`);
  return parsed;
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

  let current: Record<string, unknown>;
  try {
    current = readCurrentProfile(assistantPath);
  } catch (error) {
    rl.close();
    throw new Error(
      `Cannot read ${path.basename(assistantPath)} (${error instanceof Error ? error.message : String(error)}). ` +
        "Fix or move it, then run the wizard again; it was not changed.",
      { cause: error }
    );
  }
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const currentWake = isRecord(current.wake) && Array.isArray(current.wake.names) ? current.wake.names : [];
  const currentVoice = isRecord(current.voice) ? current.voice : {};
  const currentEqualizer = isRecord(currentVoice.equalizer) ? text(currentVoice.equalizer.preset) : "";

  const name = await ask("Assistant name", text(current.name) || "Max");
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
  // A new device starts from its own look and sound; the same device keeps what was chosen for it.
  const keptLook: Record<string, unknown> = device === currentDevice ? current : {};
  const languages = (
    await ask(
      "Languages, most preferred first",
      Array.isArray(current.languages) && current.languages.length ? current.languages.join(", ") : "en, zh"
    )
  )
    .split(/[,\s]+/)
    .map((code) => code.toLowerCase())
    .filter(Boolean);
  const currentWakeNames = currentWake.filter((item): item is string => typeof item === "string").join(", ");
  const wakeNames = (
    await ask(
      `Other spellings people or speech recognition use for "${name}" (comma separated${currentWakeNames ? `, ${CLEAR_ANSWER} for none` : ""})`,
      currentWakeNames
    )
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const developer = await ask(
    text(current.developer) ? `Built by (${CLEAR_ANSWER} to name no maker)` : "Built by (Enter to name no maker)",
    text(current.developer)
  );
  const template = await ask(
    "Design template (visor, daylight, beacon, ember, holo)",
    text(keptLook.template) || chosenDevice.template
  );
  const accentColor = await ask(
    `Accent colour (#RRGGBB, ${text(current.accentColor) ? `${CLEAR_ANSWER} for` : "Enter for"} the template's)`,
    text(current.accentColor)
  );
  console.log(`\nVoice equaliser presets: ${EQUALIZER_PRESETS.map((preset) => preset.id).join(", ")}`);
  const equalizer = await ask(
    "Equaliser preset",
    (device === currentDevice ? currentEqualizer : "") || chosenDevice.equalizer
  );
  const visualizer = await ask(
    "Voice display (wave, bars, mirror, dots, ring)",
    text(keptLook.visualizer) || chosenDevice.visualizer
  );

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
  if (provider.id === "max-speech") {
    // Max Speech listens and speaks; the chat model is the same LOCAL_LLM_* stage the `local` pipeline uses.
    const llm = localPipelineSettings().llm;
    console.log(
      "\nMax Speech (speech-server/) listens and speaks. Start it with: cd speech-server && uv run max-speech serve"
    );
    env.MAX_SPEECH_URL = await ask("Max Speech session URL", "ws://localhost:8790/v1/speech/session");
    env.LOCAL_LLM_BASE_URL = await ask("Chat model server (Ollama, llama.cpp, vLLM, LM Studio)", llm.baseUrl);
    env.LOCAL_LLM_MODEL = await ask("Chat model", llm.model);
  }
  const keyName = KEY_FOR[provider.id];
  if (keyName) {
    const key = await ask(`${keyName} (Enter to skip and add it to .env yourself)`, "");
    if (key) env[keyName] = key;
  }
  rl.close();

  const profile = mergeProfile(current, {
    name,
    device,
    languages,
    wakeNames,
    developer,
    template,
    accentColor,
    equalizer,
    visualizer
  });
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
