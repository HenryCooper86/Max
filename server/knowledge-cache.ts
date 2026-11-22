import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddingModel } from "./knowledge-embeddings";

/**
 * A disk cache for knowledge-base embeddings, so a restart embeds only what changed.
 *
 * An entry is a 16-byte key and a vector. The key is a hash of the endpoint URL, the model name and the
 * passage text, so a new model or URL finds nothing and a changed passage finds nothing. The text itself is
 * never stored, and neither is the API key.
 *
 * File layout (little endian): 8 bytes of magic, uint32 dimensions, uint32 count, then `count` keys of 16
 * bytes, then `count * dimensions` float32 values. The file size must match the header exactly, so a truncated
 * or damaged file is rejected whole. `vectors.bin` holds the compacted cache. While embedding runs, progress
 * goes to `part-*.bin` files in the same layout, each written whole and renamed into place; the next
 * compaction merges them and drops entries for passages that no longer exist.
 *
 * Nothing here throws for a bad or missing cache: it says so through `warn` and carries on without it.
 */

const MAGIC = Buffer.from("MAXKBV1\n", "latin1");
const HEADER_BYTES = 16;
const KEY_BYTES = 16;
const MAX_DIMENSIONS = 16_384;
const MAIN_FILE = "vectors.bin";
const PART_FILE = /^part-[0-9a-f]+\.bin$/;
const CHUNKS_PER_WRITE = 256;
/** A cache file larger than this is not read: a 1536-dimension cache of 100,000 passages is about 0.6 GiB. */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** More part files than this are left alone and not read. */
const MAX_PART_FILES = 1000;
/** A temp file this old belongs to a writer that died. */
const STALE_TEMP_MS = 10 * 60 * 1000;

export type CacheEntry = { key: string; vector: Float32Array };
export type LoadedCache = {
  vectors: Map<string, Float32Array>;
  /** Cache files that were read. */
  files: number;
  /** Entries in those files, counting repeats. */
  entries: number;
  /** The part files that were read, damaged or not. Only these are the reader's to remove. */
  parts: string[];
  /** True when a file was unreadable or damaged and so ignored. */
  damaged: boolean;
};

/** The cache directory from the environment, or undefined when `KNOWLEDGE_EMBEDDINGS_CACHE` is `off`.
 *  Default: `knowledge-embeddings` inside the Studio directory (`STUDIO_DIR`, else `~/.max-relay`). */
export function cacheDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.KNOWLEDGE_EMBEDDINGS_CACHE?.trim();
  if (configured?.toLowerCase() === "off") return undefined;
  if (configured) return path.resolve(configured);
  return path.join(env.STUDIO_DIR?.trim() || path.join(os.homedir(), ".max-relay"), "knowledge-embeddings");
}

/** One key per text: 16 bytes of SHA-256 over the URL, the model and the text, as a latin1 string. */
export function cacheKeys(model: EmbeddingModel, texts: string[]): string[] {
  const prefix = `${model.baseUrl}\0${model.model}\0`;
  return texts.map((text) =>
    createHash("sha256").update(prefix).update(text).digest().subarray(0, KEY_BYTES).toString("latin1")
  );
}

async function listCacheFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return [...names.filter((name) => name === MAIN_FILE), ...names.filter((name) => PART_FILE.test(name)).sort()];
}

function parse(buffer: Buffer): { entries: CacheEntry[]; dimensions: number } | string {
  if (buffer.length < HEADER_BYTES || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) return "it is not a cache file";
  const dimensions = buffer.readUInt32LE(8);
  const count = buffer.readUInt32LE(12);
  if (dimensions < 1 || dimensions > MAX_DIMENSIONS) return "its vector size is not valid";
  const vectorStart = HEADER_BYTES + count * KEY_BYTES;
  if (buffer.length !== vectorStart + count * dimensions * 4) return "it is truncated or damaged";
  // Float32Array needs a 4-byte aligned start; a small file read into a shared buffer pool may not have one.
  const aligned = (buffer.byteOffset + vectorStart) % 4 === 0;
  const all = aligned
    ? new Float32Array(buffer.buffer, buffer.byteOffset + vectorStart, count * dimensions)
    : new Float32Array(new Uint8Array(buffer.subarray(vectorStart)).buffer);
  const entries: CacheEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = HEADER_BYTES + i * KEY_BYTES;
    entries.push({
      key: buffer.toString("latin1", at, at + KEY_BYTES),
      vector: all.subarray(i * dimensions, (i + 1) * dimensions)
    });
  }
  return { entries, dimensions };
}

/** Reads every cache file in `dir`. Vectors in one file may differ in size from another's; the caller checks. */
export async function loadVectorCache(dir: string, warn: (message: string) => void): Promise<LoadedCache> {
  const loaded: LoadedCache = { vectors: new Map(), files: 0, entries: 0, parts: [], damaged: false };
  let partsSeen = 0;
  for (const name of await listCacheFiles(dir)) {
    const isPart = name !== MAIN_FILE;
    if (isPart && ++partsSeen > MAX_PART_FILES) {
      if (partsSeen === MAX_PART_FILES + 1)
        warn(`knowledge embedding cache: more than ${MAX_PART_FILES} part files, the rest are ignored`);
      continue;
    }
    // lstat, so a symbolic link is not followed and a FIFO or device is never opened.
    try {
      const stat = await fs.lstat(path.join(dir, name));
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        loaded.damaged = true;
        warn(`knowledge embedding cache: ignoring ${name} because it is not a regular file of a sane size`);
        continue;
      }
    } catch {
      continue;
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(path.join(dir, name));
    } catch {
      loaded.damaged = true;
      warn(`knowledge embedding cache: cannot read ${name}, ignoring it`);
      if (isPart) loaded.parts.push(name);
      continue;
    }
    const parsed = parse(buffer);
    if (typeof parsed === "string") {
      loaded.damaged = true;
      warn(`knowledge embedding cache: ignoring ${name} because ${parsed}`);
      if (isPart) loaded.parts.push(name);
      continue;
    }
    if (isPart) loaded.parts.push(name);
    loaded.files++;
    loaded.entries += parsed.entries.length;
    for (const { key, vector } of parsed.entries) loaded.vectors.set(key, vector);
  }
  return loaded;
}

/** Writes a file whole: a private temp file in the same directory, then a rename over the target. */
async function writeAtomically(dir: string, name: string, entries: CacheEntry[]): Promise<void> {
  const dimensions = entries[0]?.vector.length ?? 0;
  const header = Buffer.alloc(HEADER_BYTES + entries.length * KEY_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(dimensions, 8);
  header.writeUInt32LE(entries.length, 12);
  entries.forEach(({ key }, i) => header.write(key, HEADER_BYTES + i * KEY_BYTES, KEY_BYTES, "latin1"));

  // Neighbouring rows of one matrix are written as a single chunk.
  const chunks: Uint8Array[] = [header];
  let run: { buffer: ArrayBufferLike; start: number; end: number } | undefined;
  const closeRun = () => {
    if (run) chunks.push(new Uint8Array(run.buffer, run.start, run.end - run.start));
    run = undefined;
  };
  for (const { vector } of entries) {
    const start = vector.byteOffset;
    if (run && run.buffer === vector.buffer && run.end === start) run.end = start + vector.byteLength;
    else {
      closeRun();
      run = { buffer: vector.buffer, start, end: start + vector.byteLength };
    }
  }
  closeRun();

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    try {
      for (let i = 0; i < chunks.length; i += CHUNKS_PER_WRITE) {
        const group = chunks.slice(i, i + CHUNKS_PER_WRITE);
        const expected = group.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const { bytesWritten } = await handle.writev(group);
        if (bytesWritten !== expected) throw new Error("short write");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, path.join(dir, name));
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/** Saves entries computed so far as a new part file, so an interrupted start can resume. Returns its name. */
export async function saveVectorPart(dir: string, entries: CacheEntry[]): Promise<string | undefined> {
  if (!entries.length) return undefined;
  const name = `part-${randomBytes(6).toString("hex")}.bin`;
  await writeAtomically(dir, name, entries);
  return name;
}

/** Replaces the cache with exactly `entries` in one file, then removes `parts` (the part files this job read or
 *  wrote; another writer's are left alone) and temp files older than ten minutes. */
export async function compactVectorCache(dir: string, entries: CacheEntry[], parts: string[]): Promise<void> {
  if (!entries.length) return;
  await writeAtomically(dir, MAIN_FILE, entries);
  for (const name of parts) if (PART_FILE.test(name)) await fs.rm(path.join(dir, name), { force: true });
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(".tmp-")) continue;
    try {
      const file = path.join(dir, name);
      if (Date.now() - (await fs.lstat(file)).mtimeMs > STALE_TEMP_MS) await fs.rm(file, { force: true });
    } catch {
      /* gone already */
    }
  }
}
