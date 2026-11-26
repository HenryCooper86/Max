import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { matrixFromVectors, topSelector, topSimilar, type VectorMatrix } from "./knowledge-vectors";
import type { ToolDefinition } from "./tools";

/**
 * Knowledge base: files the relay owner lists in `assistant.config.json`
 * (`knowledge`), indexed at startup and searched by the assistant through the
 * `search_knowledge` tool, so it answers from the business's own policies,
 * prices and product facts instead of guessing.
 *
 * Search is lexical BM25 over passages. By default there are no embeddings and
 * no network, so it works offline, costs nothing per query, and behaves the
 * same in every language: Latin, Cyrillic and other alphabetic scripts are
 * split into words; Chinese, Japanese and Korean runs, which have no spaces,
 * are indexed as single characters plus overlapping pairs. With an embeddings
 * model configured (`knowledge-embeddings.ts`), the registry swaps in hybrid
 * search: BM25 and vector similarity, fused by reciprocal rank. Any failure
 * of the embeddings endpoint falls back to BM25.
 *
 * Nothing in here throws for bad input. An unreadable file, an oversized one
 * or a malformed config is reported as a string and skipped, so one bad entry
 * never stops the relay.
 */

export type KnowledgeConfig = {
  /** Absolute paths of files or directories. */
  paths: string[];
  /** Facts written straight into the config file. */
  text?: string;
  /** Passages returned per search. Default 4, range 1..8. */
  maxResults: number;
  /** Target passage size in characters. Default 900, range 200..2000. */
  chunkChars: number;
};

export type KnowledgeFormat = "markdown" | "text" | "html" | "json" | "csv";
type KnowledgePassage = { source: string; heading?: string; text: string; score: number };
export type KnowledgeIndex = {
  /** Number of indexed passages. */
  readonly size: number;
  /** Display names of the indexed documents. */
  readonly sources: string[];
  search(query: string, limit?: number): KnowledgePassage[];
  /** The text to embed for each passage (heading included), in passage-id order. */
  passageTexts(): string[];
  /** Lexical ranking by passage id, best first. */
  rank(query: string, limit?: number): { id: number; score: number }[];
  /** Turns ranked ids into results, dropping passages that repeat an earlier one. */
  resolve(ranked: { id: number; score: number }[], limit?: number): KnowledgePassage[];
};

/** Anything that can answer a query: the BM25 index, or the hybrid search around it. */
type KnowledgeSearcher = { search(query: string, limit: number): KnowledgePassage[] | Promise<KnowledgePassage[]> };

const DEFAULT_MAX_RESULTS = 4;
const DEFAULT_CHUNK_CHARS = 900;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_DEPTH = 4;
/** The most entries one folder gives: the first in name order. A larger one is cut off and says so, and costs no more than one of twice as many. */
const MAX_FOLDER_ENTRIES = 5_000;
/** What one tool call may put in front of the model: a few paragraphs, not a manual. */
const MAX_TOOL_RESULT_CHARS = 6000;
const MAX_QUERY_TERMS = 64;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const FORMATS: Record<string, KnowledgeFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".csv": "csv"
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampedInteger(value: unknown, name: string, min: number, max: number, fallback: number) {
  if (value === undefined || value === null) return { value: fallback };
  if (typeof value !== "number" || !Number.isFinite(value)) return { problem: `knowledge.${name} must be a number` };
  return { value: Math.min(max, Math.max(min, Math.round(value))) };
}

/** Parses the `knowledge` key of the config file. `baseDir` is the config file's directory;
 *  relative paths resolve against it. Accepts { files: string | string[], text?, maxResults?, chunkChars? }
 *  and, as a shorthand, a bare string or string array of paths. Returns {} when the key is absent. */
export function knowledgeConfigFrom(raw: unknown, baseDir: string): { config?: KnowledgeConfig; problem?: string } {
  if (raw === undefined || raw === null) return {};
  let files: unknown;
  let text: unknown;
  let maxResults: unknown;
  let chunkChars: unknown;
  if (typeof raw === "string" || Array.isArray(raw)) files = raw;
  else if (isRecord(raw)) ({ files, text, maxResults, chunkChars } = raw);
  else return { problem: "knowledge must be a path, a list of paths or an object" };

  const list = files === undefined || files === null ? [] : typeof files === "string" ? [files] : files;
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item.trim()))
    return { problem: "knowledge.files must be a path or a list of paths" };
  if (text !== undefined && text !== null && typeof text !== "string")
    return { problem: "knowledge.text must be a string" };
  const inline = typeof text === "string" ? text.trim() : "";
  if (!list.length && !inline) return { problem: "knowledge lists no files and has no text" };

  const results = clampedInteger(maxResults, "maxResults", 1, 8, DEFAULT_MAX_RESULTS);
  if (results.problem) return { problem: results.problem };
  const chunk = clampedInteger(chunkChars, "chunkChars", 200, 2000, DEFAULT_CHUNK_CHARS);
  if (chunk.problem) return { problem: chunk.problem };

  return {
    config: {
      paths: (list as string[]).map((item) => path.resolve(baseDir, item.trim())),
      ...(inline ? { text: inline } : {}),
      maxResults: results.value ?? DEFAULT_MAX_RESULTS,
      chunkChars: chunk.value ?? DEFAULT_CHUNK_CHARS
    }
  };
}

// ---------------------------------------------------------------------------
// Turning documents into passages
// ---------------------------------------------------------------------------

type Passage = { source: string; heading?: string; text: string };
type Section = { heading?: string; body: string };

/** Splits a long paragraph at sentence ends, then packs sentences up to `target`.
 *  A sentence with no punctuation at all is cut at `target` as a last resort. */
function splitLongParagraph(paragraph: string, target: number): string[] {
  const sentences = paragraph.split(/(?<=[.!?]['")\]]*)\s+|(?<=[。！？])\s*/u).filter((part) => part.trim());
  const pieces: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };
  for (let sentence of sentences) {
    while (sentence.length > target) {
      flush();
      pieces.push(sentence.slice(0, target));
      sentence = sentence.slice(target);
    }
    if (current && current.length + 1 + sentence.length > target) flush();
    current = current ? `${current} ${sentence}` : sentence;
  }
  flush();
  return pieces;
}

/** Packs paragraphs into passages of about `target` characters. A paragraph is
 *  never split unless it alone is over 1.5x the target. */
function packParagraphs(body: string, target: number): string[] {
  const paragraphs = body
    .split(/\n[ \t]*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => (part.length > target * 1.5 ? splitLongParagraph(part, target) : [part]));
  const passages: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + 2 + paragraph.length > target) {
      passages.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) passages.push(current);
  return passages;
}

function sectionsToPassages(source: string, sections: Section[], target: number): Passage[] {
  return sections.flatMap(({ heading, body }) =>
    packParagraphs(body, target).map((text) => ({ source, ...(heading ? { heading } : {}), text }))
  );
}

/** Splits at `#` headings (ignoring any inside code fences), keeping the heading trail. */
function markdownSections(text: string): Section[] {
  const sections: Section[] = [];
  const trail: { level: number; title: string }[] = [];
  let lines: string[] = [];
  let heading: string | undefined;
  let fenced = false;
  const flush = () => {
    sections.push({ heading, body: lines.join("\n") });
    lines = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) {
      lines.push(line);
      continue;
    }
    flush();
    const level = (match[1] ?? "").length;
    while (trail.length && (trail[trail.length - 1]?.level ?? 0) >= level) trail.pop();
    if (match[2]) trail.push({ level, title: match[2] });
    heading = trail.map((entry) => entry.title).join(" > ") || undefined;
  }
  flush();
  return sections;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  euro: "€",
  pound: "£"
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole;
    return code === 0xa0 ? " " : String.fromCodePoint(code);
  });
}

/** Reduces HTML to Markdown-shaped text (`<h1>`-`<h6>` become `#` headings), which the
 *  Markdown splitter then handles. */
function htmlToMarkdown(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level: string, inner: string) => {
      const title = inner.replace(/<[^>]*>/g, "").trim();
      return `\n\n${"#".repeat(Number(level))} ${title}\n\n`;
    })
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(
      /<\/?(?:p|div|section|article|main|header|footer|aside|nav|ul|ol|table|blockquote|pre|form|figure)\b[^>]*>/gi,
      "\n\n"
    )
    .replace(/<\/?(?:li|tr|dt|dd|caption|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(stripped)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function recordPassage(source: string, entries: [string, string][]): Passage | undefined {
  const text = entries
    .filter(([, value]) => value.trim())
    .map(([key, value]) => `${key}: ${value.trim()}`)
    .join("\n");
  return text ? { source, text } : undefined;
}

function jsonPassages(source: string, text: string, target: number): Passage[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return sectionsToPassages(source, [{ body: text }], target);
  }
  if (Array.isArray(value) && value.length && value.every(isRecord))
    return value
      .map((item) =>
        recordPassage(
          source,
          Object.entries(item).map(([key, entry]) => [key, stringifyValue(entry)])
        )
      )
      .filter((passage): passage is Passage => Boolean(passage));
  return sectionsToPassages(source, [{ body: JSON.stringify(value, null, 2) }], target);
}

/** RFC 4180 parsing: quoted fields may hold commas, newlines and doubled quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell.trim())) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (char === '"' && !field) quoted = true;
    else if (char === ",") endField();
    else if (char === "\n") endRow();
    else if (char !== "\r") field += char;
  }
  endRow();
  return rows;
}

function csvPassages(source: string, text: string): Passage[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows
    .map((row) =>
      recordPassage(
        source,
        row.map((cell, i) => [header[i]?.trim() || `column ${i + 1}`, cell])
      )
    )
    .filter((passage): passage is Passage => Boolean(passage));
}

function passagesFrom(source: string, text: string, format: KnowledgeFormat, target: number): Passage[] {
  const clean = text.replace(/^\uFEFF/, "");
  switch (format) {
    case "markdown":
      return sectionsToPassages(source, markdownSections(clean), target);
    case "html":
      return sectionsToPassages(source, markdownSections(htmlToMarkdown(clean)), target);
    case "json":
      return jsonPassages(source, clean, target);
    case "csv":
      return csvPassages(source, clean);
    default:
      return sectionsToPassages(source, [{ body: clean.replace(/\r\n?/g, "\n") }], target);
  }
}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

const CJK_CLASS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}ー";
const TOKEN = new RegExp(
  `[${CJK_CLASS}]+|(?:(?![${CJK_CLASS}])[\\p{L}\\p{N}\\p{M}])+(?:[-._'’](?:(?![${CJK_CLASS}])[\\p{L}\\p{N}\\p{M}])+)*`,
  "gu"
);
const CJK_RUN = new RegExp(`^[${CJK_CLASS}]`, "u");

const STOP_WORDS = new Set(
  (
    "a an and are as at be but by can could did do does for from had has have how i if in into is it its me my of on or " +
    "our please should so tell that the their them then there these they this to was we were what when where which who " +
    "why will with would you your about any tell"
  ).split(" ")
);

const VOWEL = /[aeiouy]/;

function undouble(word: string): string {
  const last = word.charAt(word.length - 1);
  return word.length > 2 && last === word.charAt(word.length - 2) && !"lsz".includes(last) && !VOWEL.test(last)
    ? word.slice(0, -1)
    : word;
}

/** Folds simple plural, `-ing` and `-ed` endings and a trailing `e`, so "returning",
 *  "returned" and "returns" all meet at "return" and "price"/"pricing" at "pric".
 *  Deliberately crude: both sides of a search go through it, so only consistency matters. */
function stem(word: string): string {
  if (word.length < 4 || !/^[a-z]+$/.test(word)) return word;
  let w = word;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5 && VOWEL.test(w.slice(0, -3))) w = undouble(w.slice(0, -3));
  else if (w.endsWith("ed") && w.length > 4 && VOWEL.test(w.slice(0, -2))) w = undouble(w.slice(0, -2));
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Terms for one word token. A compound such as `a-1042` or `3.5` is kept whole and also as its parts. */
function wordTerms(word: string): string[] {
  const parts = word.split(/[-._'’]/).filter((part) => part.length > 1 || /\p{N}/u.test(part));
  if (parts.length === 1 && parts[0] === word) return [stem(word)];
  return [word, ...parts.map(stem)];
}

function cjkTerms(run: string): string[] {
  const chars = Array.from(run);
  const terms = [...chars];
  for (let i = 0; i + 1 < chars.length; i++) terms.push(`${chars[i]}${chars[i + 1]}`);
  return terms;
}

/** Lower-cased terms for indexing, or for a query. A query drops stop words, unless that would leave nothing. */
function tokenize(text: string, query = false): string[] {
  const groups: { term: string[]; stop: boolean }[] = [];
  for (const match of text.normalize("NFKC").toLowerCase().matchAll(TOKEN)) {
    const token = match[0];
    if (CJK_RUN.test(token)) groups.push({ term: cjkTerms(token), stop: false });
    else groups.push({ term: wordTerms(token), stop: query && STOP_WORDS.has(token) });
  }
  const kept = query && groups.some((group) => !group.stop) ? groups.filter((group) => !group.stop) : groups;
  return kept.flatMap((group) => group.term);
}

// ---------------------------------------------------------------------------
// Index and search
// ---------------------------------------------------------------------------

type Posting = { docs: number[]; counts: number[] };

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Builds an index from documents already in memory. */
export function buildKnowledgeIndex(
  documents: { source: string; text: string; format?: KnowledgeFormat }[],
  options: { chunkChars?: number } = {}
): KnowledgeIndex {
  const target = Math.min(2000, Math.max(200, options.chunkChars ?? DEFAULT_CHUNK_CHARS));
  const passages: Passage[] = [];
  const sources: string[] = [];
  for (const document of documents) {
    if (!sources.includes(document.source)) sources.push(document.source);
    // A loop, not push(...list): a long list would overflow the argument limit.
    for (const passage of passagesFrom(document.source, document.text, document.format ?? "markdown", target))
      passages.push(passage);
  }

  const postings = new Map<string, Posting>();
  const lengths = new Float64Array(passages.length);
  passages.forEach((passage, id) => {
    // Heading words are counted twice: a passage under "Returns" is more about returns than one that mentions them.
    const terms = [...tokenize(passage.text), ...tokenize(passage.heading ?? ""), ...tokenize(passage.heading ?? "")];
    lengths[id] = terms.length;
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, count] of counts) {
      let posting = postings.get(term);
      if (!posting) postings.set(term, (posting = { docs: [], counts: [] }));
      posting.docs.push(id);
      posting.counts.push(count);
    }
  });
  const averageLength = passages.length ? lengths.reduce((sum, length) => sum + length, 0) / passages.length : 1;

  // One score slot per passage, reused by every query: a query touches only the slots it sets and clears them.
  const scoreSlots = new Float64Array(passages.length);
  const touched = new Int32Array(passages.length);

  function rank(query: string, limit = Number.POSITIVE_INFINITY): { id: number; score: number }[] {
    const terms = [...new Set(tokenize(query, true))].slice(0, MAX_QUERY_TERMS);
    let count = 0;
    for (const term of terms) {
      const posting = postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (passages.length - posting.docs.length + 0.5) / (posting.docs.length + 0.5));
      for (let i = 0; i < posting.docs.length; i++) {
        const id = posting.docs[i] as number;
        const tf = posting.counts[i] as number;
        const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * (lengths[id] as number)) / averageLength);
        // Every term adds a positive amount, so a slot at zero is one this query has not reached yet.
        if (scoreSlots[id] === 0) touched[count++] = id;
        scoreSlots[id] = (scoreSlots[id] as number) + (idf * tf * (BM25_K1 + 1)) / norm;
      }
    }
    let ranked: { id: number; score: number }[];
    if (limit >= 1 && limit < count) {
      const top = topSelector(limit);
      for (let i = 0; i < count; i++) top.offer(touched[i] as number, scoreSlots[touched[i] as number] as number);
      ranked = top.result();
    } else {
      ranked = Array.from({ length: count }, (_, i) => ({
        id: touched[i] as number,
        score: scoreSlots[touched[i] as number] as number
      })).sort((a, b) => b.score - a.score || a.id - b.id);
      ranked = ranked.slice(0, limit);
    }
    for (let i = 0; i < count; i++) scoreSlots[touched[i] as number] = 0;
    return ranked;
  }

  function resolve(ranked: { id: number; score: number }[], limit = DEFAULT_MAX_RESULTS): KnowledgePassage[] {
    const wanted = Math.min(50, Math.max(1, Math.floor(limit) || DEFAULT_MAX_RESULTS));
    const results: KnowledgePassage[] = [];
    const kept: { source: string; text: string }[] = [];
    for (const { id, score } of ranked) {
      const passage = passages[id];
      if (!passage) continue;
      const text = squash(passage.text);
      // The same text indexed twice (a file and its folder both listed) should not fill the answer.
      if (
        kept.some(
          (other) => other.source === passage.source && (other.text.includes(text) || text.includes(other.text))
        )
      )
        continue;
      kept.push({ source: passage.source, text });
      results.push({ ...passage, score });
      if (results.length >= wanted) break;
    }
    return results;
  }

  // Ranks a bounded head first. Only when duplicates leave it short of the wanted count is every match ranked,
  // so the answer is the same as ranking them all, without sorting 100,000 matches for a common word.
  const search = (query: string, limit = DEFAULT_MAX_RESULTS) => {
    const wanted = Math.min(50, Math.max(1, Math.floor(limit) || DEFAULT_MAX_RESULTS));
    const head = rank(query, wanted * 8);
    const found = resolve(head, limit);
    return found.length >= wanted || head.length < wanted * 8 ? found : resolve(rank(query), limit);
  };
  const passageTexts = () => passages.map((passage) => (passage.heading ? `${passage.heading}\n` : "") + passage.text);

  return { size: passages.length, sources, search, passageTexts, rank, resolve };
}

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

const RRF_K = 60;
const SEMANTIC_FLOOR = 0.25;
const QUERY_EMBED_TIMEOUT_MS = 2000;
const LOG_EVERY_MS = 60_000;

/** BM25 plus vector similarity, fused by reciprocal rank. `vectors` must be L2-normalised and in
 *  `index.passageTexts()` order, as one matrix or as a list of vectors. When the query cannot be embedded in time, that query is answered
 *  by BM25 alone. */
export function createHybridSearch(
  index: KnowledgeIndex,
  vectors: VectorMatrix | Float32Array[],
  embedQuery: (text: string) => Promise<Float32Array>,
  options: { candidates?: number; log?: (message: string) => void } = {}
): (query: string, limit?: number) => Promise<KnowledgePassage[]> {
  const matrix = Array.isArray(vectors) ? matrixFromVectors(vectors) : vectors;
  const candidates = Math.max(1, Math.floor(options.candidates ?? 20));
  let lastLog = Number.NEGATIVE_INFINITY;
  const note = (message: string) => {
    const now = Date.now();
    if (!options.log || now - lastLog < LOG_EVERY_MS) return;
    lastLog = now;
    options.log(message);
  };

  async function embedInTime(query: string): Promise<Float32Array> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        embedQuery(query),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), QUERY_EMBED_TIMEOUT_MS);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return async (query, limit = DEFAULT_MAX_RESULTS) => {
    let queryVector: Float32Array;
    try {
      queryVector = await embedInTime(query);
      if (!matrix || matrix.count !== index.size || (matrix.count > 0 && queryVector.length !== matrix.dimensions))
        throw new Error("vector sizes do not match");
    } catch (error) {
      note(
        `knowledge query embedding failed, using keyword search: ${error instanceof Error ? error.message : "error"}`
      );
      return index.search(query, limit);
    }
    let length = 0;
    for (const value of queryVector) length += value * value;
    length = Math.sqrt(length);
    if (!(length > 0)) return index.search(query, limit);

    // The query is scaled to unit length once, so each passage costs one dot product and nothing else.
    const unit = new Float32Array(queryVector.length);
    for (let i = 0; i < unit.length; i++) unit[i] = (queryVector[i] as number) / length;
    const semantic = topSimilar(matrix as VectorMatrix, unit, candidates, SEMANTIC_FLOOR);

    const fused = new Map<number, number>();
    const add = (list: { id: number }[]) =>
      list.slice(0, candidates).forEach(({ id }, position) => {
        fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + position + 1));
      });
    add(index.rank(query, candidates));
    add(semantic);
    const ranked = [...fused].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id, score]) => ({ id, score }));
    return index.resolve(ranked, limit);
  };
}

// ---------------------------------------------------------------------------
// Loading from disk
// ---------------------------------------------------------------------------

type Found = { file: string; source: string };

function formatOf(file: string): KnowledgeFormat | undefined {
  return FORMATS[path.extname(file).toLowerCase()];
}

/** A folder's first `MAX_FOLDER_ENTRIES` entries in name order, or undefined when it cannot be read. They are
 *  read a batch at a time and, on the way, cut back to that many smallest names, so a folder of any size costs
 *  no more than one of twice that many entries. `cut` says entries were left out. */
async function listFolder(dir: string): Promise<{ entries: Dirent[]; cut: boolean } | undefined> {
  const folder = await fs.opendir(dir).catch(() => undefined);
  if (!folder) return undefined;
  const entries: Dirent[] = [];
  let seen = 0;
  try {
    for await (const entry of folder) {
      entries.push(entry);
      seen += 1;
      // Only the smallest names can matter in the end, so twice as many as are kept are the most worth holding.
      if (entries.length >= 2 * MAX_FOLDER_ENTRIES) {
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        entries.length = MAX_FOLDER_ENTRIES;
      }
    }
  } catch {
    return undefined;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries: entries.slice(0, MAX_FOLDER_ENTRIES), cut: seen > MAX_FOLDER_ENTRIES };
}

/** The files one load takes in, and why the others were left out. */
type Loader = {
  found: Found[];
  problems: string[];
  /** True once nothing more can be taken: the file cap or the budget for all files together is reached. */
  readonly full: boolean;
  /** Takes a file in if it will load: there is room under the file cap, it is small enough for one file and
   *  for all of them together, and it can be read. `problems` says which of these it failed otherwise. */
  take(file: string, source: string): Promise<boolean>;
  /** The file cap was reached, and `first` is the first of what it left out. Said once. */
  reportCap(first: string): void;
};

function createLoader(): Loader {
  const found: Found[] = [];
  const problems: string[] = [];
  let total = 0;
  let capReported = false;
  let budgetSpent = false;
  const reportCap = (first: string) => {
    if (capReported) return;
    capReported = true;
    problems.push(`knowledge is limited to ${MAX_FILES} files; the rest were skipped, from ${first} on`);
  };
  return {
    found,
    problems,
    get full() {
      return found.length >= MAX_FILES || budgetSpent;
    },
    reportCap,
    async take(file, source) {
      if (found.length >= MAX_FILES) {
        reportCap(source);
        return false;
      }
      // Nothing is looked at after the first file that does not fit: "the rest were skipped" is what was said.
      if (budgetSpent) return false;
      let size: number;
      try {
        size = (await fs.stat(file)).size;
      } catch {
        problems.push(`cannot read: ${file}`);
        return false;
      }
      if (size > MAX_FILE_BYTES) {
        problems.push(`skipped ${source}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
        return false;
      }
      if (total + size > MAX_TOTAL_BYTES) {
        budgetSpent = true;
        problems.push(`knowledge is limited to ${MAX_TOTAL_BYTES / 1024 / 1024} MiB in total; the rest were skipped`);
        return false;
      }
      total += size;
      found.push({ file, source });
      return true;
    }
  };
}

/** Lists, under a directory and in name order, the documents the knowledge base takes, and stops as soon as
 *  it is full. Dot-entries, `node_modules`, symbolic links, folders deeper than `MAX_DEPTH` and files of other
 *  types are passed by without a word. The first thing passed by because the knowledge base is full is named. */
async function walk(dir: string, source: string, depth: number, loader: Loader): Promise<void> {
  const listed = await listFolder(dir);
  if (!listed) {
    loader.problems.push(`cannot read folder: ${dir}`);
    return;
  }
  if (listed.cut)
    loader.problems.push(`folder ${source} has more than ${MAX_FOLDER_ENTRIES} entries; the rest were skipped`);
  for (const entry of listed.entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const name = `${source}/${entry.name}`;
    const listable = entry.isDirectory() ? depth < MAX_DEPTH : entry.isFile() && formatOf(entry.name) !== undefined;
    if (!listable) continue;
    // The budget has already said what it left out; the file cap names its first here.
    if (loader.full) {
      if (loader.found.length >= MAX_FILES) loader.reportCap(name);
      return;
    }
    if (entry.isDirectory()) await walk(path.join(dir, entry.name), name, depth + 1, loader);
    else await loader.take(path.join(dir, entry.name), name);
  }
}

/** Reads the configured files and builds the index. Never rejects: a file that cannot be read or does not
 *  fit is left out with a problem string, and the rest load. */
export async function loadKnowledge(config: KnowledgeConfig): Promise<{ index: KnowledgeIndex; problems: string[] }> {
  const loader = createLoader();
  for (const configured of config.paths) {
    const name = path.basename(configured);
    try {
      const stat = await fs.stat(configured);
      if (stat.isDirectory()) await walk(configured, name, 0, loader);
      else if (!stat.isFile()) loader.problems.push(`not a file or folder: ${configured}`);
      else if (!formatOf(configured))
        loader.problems.push(`unsupported file type (use .md .txt .html .json or .csv): ${configured}`);
      else await loader.take(configured, name);
    } catch {
      loader.problems.push(`cannot read: ${configured}`);
    }
  }

  const documents: { source: string; text: string; format: KnowledgeFormat }[] = [];
  for (const { file, source } of loader.found) {
    try {
      documents.push({ source, text: await fs.readFile(file, "utf8"), format: formatOf(file) as KnowledgeFormat });
    } catch {
      loader.problems.push(`cannot read: ${file}`);
    }
  }
  if (config.text) documents.push({ source: "config", text: config.text, format: "markdown" });
  return { index: buildKnowledgeIndex(documents, { chunkChars: config.chunkChars }), problems: loader.problems };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

type ToolResult = { results: { source: string; heading?: string; text: string }[]; note?: string };

/** Keeps the reply under the cap by dropping trailing results, then trimming the last one. */
function fitToCap(results: ToolResult["results"]): ToolResult["results"] {
  const fitted = results.map((result) => ({ ...result }));
  const size = () => JSON.stringify({ results: fitted }).length;
  while (fitted.length > 1 && size() > MAX_TOOL_RESULT_CHARS) fitted.pop();
  const last = fitted[fitted.length - 1];
  while (last && size() > MAX_TOOL_RESULT_CHARS && last.text.length > 1) {
    const excess = size() - MAX_TOOL_RESULT_CHARS;
    last.text = `${last.text.slice(0, Math.max(0, last.text.length - excess - 1)).trimEnd()}…`;
  }
  return fitted;
}

/** The `search_knowledge` tool. `index` is read on every call, so a reloaded index takes effect at once. */
export function knowledgeTool(
  index: () => KnowledgeSearcher | undefined,
  maxResults = DEFAULT_MAX_RESULTS
): ToolDefinition {
  return {
    name: "search_knowledge",
    description:
      "Search the business's own knowledge base (policies, prices, products, opening hours, FAQs). " +
      "Call this before answering any question about the business's facts, policies, prices or products. " +
      "Answer only from the passages returned; if nothing is found, say you do not know instead of guessing.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to look up, in a few key words." } },
      required: ["query"]
    },
    async handler(args): Promise<ToolResult> {
      const current = index();
      if (!current) throw new Error("the knowledge base is not loaded");
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error("query is required");
      const found = await current.search(query, maxResults);
      if (!found.length)
        return {
          results: [],
          note: "Nothing in the knowledge base matches. Say you do not know rather than guessing."
        };
      return {
        results: fitToCap(found.map(({ source, heading, text }) => ({ source, ...(heading ? { heading } : {}), text })))
      };
    }
  };
}
