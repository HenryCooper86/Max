import { createHash } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import type { ConversationEndedPayload } from "./conversation-webhook";

/**
 * Variants of the assistant, for A/B tests.
 *
 * The config lists variants, each a few keys that replace the base config's
 * (another greeting, other instructions). Every conversation is given one,
 * the conversation's record names it, and the relay counts how the
 * conversations of each variant went.
 */

const MAX_VARIANTS = 8;
const MAX_WEIGHT = 1000;
const VARIANT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** What a variant may replace: the keys a session reads from its own profile. */
const VARIANT_KEYS = [
  "instructions",
  "persona",
  "greeting",
  "identityNotes",
  "conversation",
  "guardrails",
  "agents"
] as const;

export type VariantSpec = {
  id: string;
  /** Its share of conversations, relative to the other variants' weights. */
  weight: number;
  /** The config keys it replaces, as written. */
  overrides: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Reads the `variants` key of the assistant config. A list that is wrong in any part turns nothing on. */
export function variantSpecsFrom(raw: unknown): { variants: VariantSpec[]; problem?: string } {
  if (raw === undefined || raw === null) return { variants: [] };
  if (!Array.isArray(raw)) return { variants: [], problem: "variants must be a list" };
  if (raw.length === 0) return { variants: [] };
  if (raw.length < 2) return { variants: [], problem: "variants needs at least two entries to compare" };
  if (raw.length > MAX_VARIANTS) return { variants: [], problem: `variants takes at most ${MAX_VARIANTS} entries` };
  const variants: VariantSpec[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) return { variants: [], problem: `variants[${index}] must be an object` };
    const { id, weight = 1, ...overrides } = item;
    if (typeof id !== "string" || !VARIANT_ID.test(id)) {
      return {
        variants: [],
        problem: `variants[${index}].id must be lower-case letters, digits, "-" or "_", at most 32 characters`
      };
    }
    if (variants.some((variant) => variant.id === id))
      return { variants: [], problem: `variants: ${id} is there twice` };
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || weight > MAX_WEIGHT) {
      return { variants: [], problem: `variants: ${id}: weight must be a number above 0, at most ${MAX_WEIGHT}` };
    }
    const unknown = Object.keys(overrides).find((key) => !(VARIANT_KEYS as readonly string[]).includes(key));
    if (unknown !== undefined) {
      return {
        variants: [],
        problem: `variants: ${id} cannot change ${JSON.stringify(unknown.slice(0, 40))}. A variant may set: ${VARIANT_KEYS.join(", ")}`
      };
    }
    variants.push({ id, weight, overrides });
  }
  return { variants };
}

/**
 * The variant for one conversation. With a `key` (who the conversation is
 * with) the same person gets the same variant every time, as long as the
 * list and its weights stay as they are. Without one it is drawn at random.
 */
export function pickVariant<T extends { id: string; weight: number }>(
  variants: readonly T[],
  key: string | undefined,
  random: () => number = Math.random
): T | undefined {
  if (variants.length === 0) return undefined;
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  const point =
    (key ? createHash("sha256").update(`variant:${key}`).digest().readUIntBE(0, 6) / 2 ** 48 : random()) * total;
  let passed = 0;
  for (const variant of variants) {
    passed += variant.weight;
    if (point < passed) return variant;
  }
  return variants.at(-1);
}

// ---- how the conversations of each variant went ---------------------------------

type VariantTally = {
  /** The config's `version` when the conversations took place, if it had one. */
  version?: string;
  /** The variant, or nothing for conversations that had none. */
  variant?: string;
  conversations: number;
  averageSeconds: number;
  /** How the conversations ended, by reason. */
  endReasons: Record<string, number>;
  /** Conversations with an analysis, and what it said. */
  analysed: number;
  succeeded: number;
  failed: number;
  sentiment: { positive: number; neutral: number; negative: number };
  /** Conversations in which a guardrail found something. */
  withGuardrailFindings: number;
  firstAt: number;
  lastAt: number;
};

type Counted = VariantTally & { seconds: number };

export type VariantResults = {
  /** Counts one finished conversation. */
  add(record: ConversationEndedPayload): void;
  /**
   * Counts the conversations a `CONVERSATION_LOG_FILE` held before now: the
   * ones that end from now on are reported with `add`, and are not counted
   * twice when they also turn up in the file. Resolves to how many it counted.
   */
  readLog(file: string): Promise<number>;
  tallies(): VariantTally[];
  /** True while an earlier log is still being read: the tallies are not complete yet. */
  reading(): boolean;
};

/** A reason is the relay's own word, or a tool's: keep the table small whatever it holds. */
const MAX_END_REASONS = 20;
const MAX_GROUPS = 200;

export function createVariantResults(): VariantResults {
  const groups = new Map<string, Counted>();
  let reading = 0;

  function add(record: ConversationEndedPayload): void {
    const session = record?.session;
    if (!session || typeof session.id !== "string") return;
    const version = typeof session.version === "string" ? session.version : undefined;
    const variant = typeof session.variant === "string" ? session.variant : undefined;
    const key = JSON.stringify([version ?? null, variant ?? null]);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= MAX_GROUPS) return;
      group = {
        ...(version !== undefined ? { version } : {}),
        ...(variant !== undefined ? { variant } : {}),
        conversations: 0,
        averageSeconds: 0,
        seconds: 0,
        endReasons: {},
        analysed: 0,
        succeeded: 0,
        failed: 0,
        sentiment: { positive: 0, neutral: 0, negative: 0 },
        withGuardrailFindings: 0,
        firstAt: Number.POSITIVE_INFINITY,
        lastAt: 0
      };
      groups.set(key, group);
    }
    group.conversations += 1;
    group.seconds += Number.isFinite(session.seconds) ? session.seconds : 0;
    const reason = typeof session.endReason === "string" && session.endReason ? session.endReason : "unknown";
    if (reason in group.endReasons || Object.keys(group.endReasons).length < MAX_END_REASONS) {
      group.endReasons[reason] = (group.endReasons[reason] ?? 0) + 1;
    }
    if (record.analysis) {
      group.analysed += 1;
      if (record.analysis.success === true) group.succeeded += 1;
      if (record.analysis.success === false) group.failed += 1;
      const mood = record.analysis.sentiment;
      if (mood === "positive" || mood === "neutral" || mood === "negative") group.sentiment[mood] += 1;
    }
    if (Array.isArray(record.guardrails) && record.guardrails.length > 0) group.withGuardrailFindings += 1;
    if (Number.isFinite(session.endedAt)) {
      group.firstAt = Math.min(group.firstAt, session.endedAt);
      group.lastAt = Math.max(group.lastAt, session.endedAt);
    }
  }

  return {
    add(record) {
      try {
        add(record);
      } catch {
        /* a record of another shape is not counted */
      }
    },
    async readLog(file) {
      reading += 1;
      const before = Date.now();
      let lines = 0;
      try {
        const input = fs.createReadStream(file, { encoding: "utf8" });
        // A file that is not there yet has no conversations in it.
        input.on("error", () => undefined);
        for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as ConversationEndedPayload;
            if (record?.type === "conversation.ended" && !(record.session?.endedAt >= before)) {
              this.add(record);
              lines += 1;
            }
          } catch {
            /* a line cut short by a crash */
          }
        }
      } catch {
        /* what was read until then counts */
      } finally {
        reading -= 1;
      }
      return lines;
    },
    tallies() {
      return [...groups.values()]
        .map(({ seconds, ...tally }) => ({
          ...tally,
          averageSeconds: tally.conversations ? Math.round(seconds / tally.conversations) : 0,
          firstAt: Number.isFinite(tally.firstAt) ? tally.firstAt : 0
        }))
        .sort((a, b) => b.lastAt - a.lastAt);
    },
    reading: () => reading > 0
  };
}
