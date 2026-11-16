import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { EQUALIZER_PRESETS } from "../server/audio-eq";
import { DEVICE_PRESETS, devicePreset, isKnownDevice } from "../server/device-presets";
import { VOICE_PROVIDERS } from "../server/providers/catalog";

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

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, fallback: string) =>
    (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;

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

  console.log("\nVoice backends:");
  VOICE_PROVIDERS.forEach((entry, index) => {
    console.log(`  ${index + 1}. ${entry.label.padEnd(18)} ${entry.description}`);
  });
  const picked = Number(await ask("Default backend number", "1"));
  const provider = VOICE_PROVIDERS[Number.isInteger(picked) ? picked - 1 : 0] ?? VOICE_PROVIDERS[0]!;

  const env: Record<string, string> = { VOICE_PROVIDER: provider.id };
  if (provider.id === "local") env.LOCAL_VOICE = "on";
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
  console.log("Start it with:  npm run dev   then open http://localhost:5173\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
