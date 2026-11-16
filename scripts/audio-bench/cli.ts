import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mixAtSnr } from "./mix";
import { NOISE_KINDS, synthesizeNoise, type NoiseKind } from "./noise";
import {
  LIMITS,
  errorRate,
  scoreDetection,
  scoreEcho,
  verdictAtLeast,
  verdictAtMost,
  type DetectionScore,
  type Verdict
} from "./score";
import { BENCH_RATE, readBenchWav, toPcm16, writeWav } from "./wav";

/**
 * `npm run bench:audio` — is this hardware good enough for a voice assistant?
 *
 *   generate   write the test recordings: speech in wind, engine and street
 *              noise at several loudness ratios, and a clip of the assistant
 *              talking for the echo test
 *   score      score a folder of recordings against what was really said:
 *              how fast speech is detected, how often noise is mistaken for
 *              it, and how well it is recognised
 *   echo       score a recording of the device's microphone while the
 *              assistant talks
 *
 * Scored as generated, the recordings give the software's own baseline.
 * Played through a speaker at your device and recorded by its microphone,
 * they give your hardware's numbers. docs/audio/test-bench.md walks through it.
 */

type Utterance = { id: string; language: "en" | "zh"; text: string; voice: string };

const UTTERANCES: readonly Utterance[] = [
  { id: "en-weather", language: "en", text: "Max, what's the weather ahead?", voice: "Samantha" },
  { id: "en-navigate", language: "en", text: "Max, navigate to the nearest gas station.", voice: "Samantha" },
  { id: "en-call", language: "en", text: "Max, call home and say I am on my way.", voice: "Samantha" },
  { id: "zh-weather", language: "zh", text: "Max，前面天气怎么样？", voice: "Tingting" },
  { id: "zh-navigate", language: "zh", text: "Max，导航去最近的加油站。", voice: "Tingting" }
];

const ASSISTANT_LINE =
  "In four hundred metres, turn left onto the ring road. Traffic ahead is light, and the weather stays dry for the next hour. You will arrive at about a quarter past six.";

export type ManifestEntry = {
  file: string;
  utterance: string;
  language: "en" | "zh";
  text: string;
  noise: NoiseKind | "clean";
  snrDb: number | null;
  /** Seconds into the file at which speech starts and ends. */
  onsetSeconds: number;
  offsetSeconds: number;
};

export type Manifest = { sampleRate: number; noiseSource: string; entries: ManifestEntry[] };

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function need(program: string): void {
  try {
    execFileSync("which", [program], { stdio: "ignore" });
  } catch {
    throw new Error(`${program} is required for this step and was not found on the PATH.`);
  }
}

/** Speaks a line with the system voice into a bench-rate WAV (macOS `say`). */
function speak(text: string, voice: string, out: string): void {
  const aiff = `${out}.aiff`;
  execFileSync("say", ["-v", voice, "-o", aiff, text]);
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    aiff,
    "-ar",
    String(BENCH_RATE),
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    out
  ]);
  fs.rmSync(aiff, { force: true });
}

function generate(args: string[]): void {
  const out = path.resolve(option(args, "out") ?? "audio-bench");
  const speechDir = option(args, "speech");
  const noiseDir = option(args, "noise");
  const levels = (option(args, "snr") ?? "20,10,5,0").split(",").map(Number);
  if (levels.some((level) => !Number.isFinite(level))) throw new Error("--snr takes numbers, e.g. 20,10,5,0");
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "audio-bench-"));
  try {
    if (!speechDir) {
      need("say");
      need("ffmpeg");
    }
    const speech = new Map<string, Float32Array>();
    for (const utterance of UTTERANCES) {
      const own = speechDir ? path.join(path.resolve(speechDir), `${utterance.id}.wav`) : undefined;
      if (own && !fs.existsSync(own)) continue; // your own recordings may cover only some lines
      const file = own ?? path.join(work, `${utterance.id}.wav`);
      if (!own) speak(utterance.text, utterance.voice, file);
      speech.set(utterance.id, readBenchWav(file));
    }
    if (!speech.size)
      throw new Error(`no speech found in ${speechDir}: expected files named like ${UTTERANCES[0]!.id}.wav`);

    const beds = new Map<NoiseKind, Float32Array>();
    for (const kind of NOISE_KINDS) {
      const own = noiseDir ? path.join(path.resolve(noiseDir), `${kind}.wav`) : undefined;
      beds.set(kind, own && fs.existsSync(own) ? readBenchWav(own) : synthesizeNoise(kind, 20));
    }

    const entries: ManifestEntry[] = [];
    for (const utterance of UTTERANCES) {
      const clean = speech.get(utterance.id);
      if (!clean) continue;
      const cases: [NoiseKind | "clean", number | null][] = [["clean", null]];
      for (const kind of NOISE_KINDS) for (const level of levels) cases.push([kind, level]);
      for (const [noise, snrDb] of cases) {
        const mixed = mixAtSnr(clean, noise === "clean" ? new Float32Array(0) : beds.get(noise)!, snrDb);
        const file = `${utterance.id}_${noise}${snrDb === null ? "" : `_${snrDb}db`}.wav`;
        writeWav(path.join(out, file), mixed.samples);
        entries.push({
          file,
          utterance: utterance.id,
          language: utterance.language,
          text: utterance.text,
          noise,
          snrDb,
          onsetSeconds: mixed.onset / BENCH_RATE,
          offsetSeconds: mixed.offset / BENCH_RATE
        });
      }
    }
    const manifest: Manifest = {
      sampleRate: BENCH_RATE,
      noiseSource: noiseDir ? `recordings in ${noiseDir}, synthesised where missing` : "synthesised",
      entries
    };
    fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    // The assistant talking, for the echo test: play this through the device.
    const reference = path.join(out, "assistant-reference.wav");
    if (!speechDir) speak(ASSISTANT_LINE, "Samantha", reference);
    console.log(`Wrote ${entries.length} recordings and manifest.json to ${out}`);
    if (!speechDir) console.log(`Wrote assistant-reference.wav for the echo test.`);
    console.log(`Noise beds: ${manifest.noiseSource}.`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Sends a recording to an OpenAI-compatible speech-to-text server. */
async function transcribe(samples: Float32Array, language: string, stt: SttSettings): Promise<string> {
  const pcm = toPcm16(samples);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(BENCH_RATE, 24);
  header.writeUInt32LE(BENCH_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  const form = new FormData();
  form.set("model", stt.model);
  form.set("language", language);
  form.set("response_format", "json");
  form.set("file", new Blob([Buffer.concat([header, pcm])], { type: "audio/wav" }), "clip.wav");
  const response = await fetch(`${stt.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: stt.apiKey ? { Authorization: `Bearer ${stt.apiKey}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(`speech-to-text answered HTTP ${response.status}`);
  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text : "";
}

type SttSettings = { baseUrl: string; model: string; apiKey?: string };

function sttSettings(): SttSettings | undefined {
  const baseUrl = process.env.BENCH_STT_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  return {
    baseUrl,
    model: process.env.BENCH_STT_MODEL?.trim() || "whisper-1",
    apiKey: process.env.BENCH_STT_API_KEY?.trim() || undefined
  };
}

export type ScoredEntry = ManifestEntry & DetectionScore & { recognised?: string; errorRate?: number };

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

const MARK: Record<Verdict, string> = { good: "good  ", usable: "usable", poor: "POOR  " };

async function score(args: string[]): Promise<void> {
  const reference = path.resolve(option(args, "dir") ?? "audio-bench");
  const captured = path.resolve(option(args, "captured") ?? reference);
  const manifest = JSON.parse(fs.readFileSync(path.join(reference, "manifest.json"), "utf8")) as Manifest;
  const stt = sttSettings();
  const scored: ScoredEntry[] = [];
  let missing = 0;
  for (const entry of manifest.entries) {
    const file = path.join(captured, entry.file);
    if (!fs.existsSync(file)) {
      missing += 1;
      continue;
    }
    const samples = readBenchWav(file);
    const detection = scoreDetection(
      samples,
      Math.round(entry.onsetSeconds * BENCH_RATE),
      Math.round(entry.offsetSeconds * BENCH_RATE)
    );
    const row: ScoredEntry = { ...entry, ...detection };
    if (stt) {
      row.recognised = await transcribe(samples, entry.language, stt);
      row.errorRate = errorRate(entry.text, row.recognised);
    }
    scored.push(row);
  }
  if (!scored.length) throw new Error(`none of the recordings in manifest.json were found in ${captured}`);

  console.log(
    `\nScored ${scored.length} recordings from ${captured}${missing ? ` (${missing} not found, skipped)` : ""}`
  );
  console.log(
    captured === reference ? "These are the generated files: the software's own baseline." : "These are your captures."
  );
  console.log("\ncondition        detected  onset delay        false starts  recognition error");
  const conditions = [...new Set(scored.map((row) => `${row.noise}${row.snrDb === null ? "" : ` ${row.snrDb} dB`}`))];
  for (const condition of conditions) {
    const rows = scored.filter((row) => `${row.noise}${row.snrDb === null ? "" : ` ${row.snrDb} dB`}` === condition);
    const detected = rows.filter((row) => row.detected).length;
    const delay = mean(rows.flatMap((row) => (row.onsetDelayMs === null ? [] : [row.onsetDelayMs])));
    const falseStarts = rows.reduce((sum, row) => sum + row.falseStarts, 0);
    const errors = mean(rows.flatMap((row) => (row.errorRate === undefined ? [] : [row.errorRate])));
    const delayText =
      delay === null ? "—" : `${Math.round(delay)} ms ${MARK[verdictAtMost(delay, LIMITS.onsetDelayMs)]}`;
    const errorText =
      errors === null
        ? "not measured"
        : `${Math.round(errors * 100)}% ${MARK[verdictAtMost(errors, LIMITS.errorRate)]}`;
    console.log(
      `${condition.padEnd(16)} ${`${detected}/${rows.length}`.padEnd(9)} ${delayText.padEnd(18)} ${String(falseStarts).padEnd(13)} ${errorText}`
    );
  }
  if (!stt) {
    console.log("\nRecognition was not measured: set BENCH_STT_BASE_URL (and BENCH_STT_MODEL, BENCH_STT_API_KEY)");
    console.log("to an OpenAI-compatible speech-to-text server, such as the one your relay uses.");
  }
  const report = path.join(captured, "report.json");
  fs.writeFileSync(
    report,
    `${JSON.stringify({ scoredAt: new Date().toISOString(), limits: LIMITS, entries: scored }, null, 2)}\n`
  );
  console.log(`\nFull results: ${report}`);
}

function echo(args: string[]): void {
  const echoFile = option(args, "echo");
  if (!echoFile)
    throw new Error("--echo <wav> is required: the microphone recorded while the assistant talks and nobody else does");
  const raw = option(args, "raw");
  const speech = option(args, "speech");
  const result = scoreEcho(
    readBenchWav(echoFile),
    raw ? readBenchWav(raw) : undefined,
    speech ? readBenchWav(speech) : undefined
  );
  console.log(`\nEcho at the microphone:        ${result.echoDbfs} dBFS`);
  console.log(
    `Mistaken for the wearer:       ${result.falseInterruptions} time(s)  ${result.falseInterruptions === 0 ? "good" : "POOR: the assistant would cut itself off"}`
  );
  if (result.erleDb !== undefined) {
    console.log(
      `Removed by echo cancellation:  ${result.erleDb} dB  ${MARK[verdictAtLeast(result.erleDb, LIMITS.erleDb)]}`
    );
  }
  if (result.speechOverEchoDb !== undefined) {
    console.log(`Wearer's voice over the echo:  ${result.speechOverEchoDb} dB`);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "generate") generate(args);
  else if (command === "score") await score(args);
  else if (command === "echo") echo(args);
  else {
    console.log("Usage: npm run bench:audio -- <generate|score|echo> [options]");
    console.log("  generate --out DIR [--snr 20,10,5,0] [--speech DIR] [--noise DIR]");
    console.log("  score    --dir DIR [--captured DIR]");
    console.log("  echo     --echo WAV [--raw WAV] [--speech WAV]");
    console.log("See docs/audio/test-bench.md.");
    process.exitCode = command ? 1 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
