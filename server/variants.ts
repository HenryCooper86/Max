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
  // The list's ids are part of what is hashed: another test shares people out
  // anew, and does not put the same people first again.
  const test = variants.map((variant) => variant.id).join(",");
  const point =
    (key ? createHash("sha256").update(`variant:${test}:${key}`).digest().readUIntBE(0, 6) / 2 ** 48 : random()) *
    total;
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

/** A reason may be any word, also one every object has ("constructor"): counted in a map. */
type Counted = Omit<VariantTally, "endReasons"> & { seconds: number; reasons: Map<string, number> };

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

// ---- is a difference larger than chance? ----------------------------------------

/** ln Γ(x) for x > 0 (Lanczos), to about fifteen digits: ln n! = lnGamma(n + 1). */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  const y = x - 1;
  let sum = c[0]!;
  for (let i = 1; i < 9; i += 1) sum += c[i]! / (y + i);
  const t = y + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(sum);
}

/**
 * Fisher's exact test, two-sided: how likely a difference at least this
 * large is between two groups that in truth succeed equally often. Exact for
 * any counts, which matters for the small numbers a test starts with.
 */
export function fisherExact(successA: number, failA: number, successB: number, failB: number): number {
  const a = successA + failA;
  const successes = successA + successB;
  const total = a + successB + failB;
  if (a === 0 || total === a || successes === 0 || successes === total) return 1;
  const lnChoose = (n: number, k: number): number => lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);
  const all = lnChoose(total, a);
  /** The chance of `x` successes in the first group, the totals being what they are. */
  const chance = (x: number): number => Math.exp(lnChoose(successes, x) + lnChoose(total - successes, a - x) - all);
  const observed = chance(successA);
  let p = 0;
  for (let x = Math.max(0, a - (total - successes)); x <= Math.min(successes, a); x += 1) {
    const here = chance(x);
    if (here <= observed * (1 + 1e-7)) p += here;
  }
  return Math.min(1, p);
}

type VariantComparison = {
  variant: string;
  /** The variant it is compared with: the first in the list. */
  against: string;
  /** Conversations whose analysis said whether they succeeded, here and there. */
  decided: number;
  againstDecided: number;
  /** The share of those that succeeded. Absent when none was decided. */
  successRate?: number;
  againstSuccessRate?: number;
  /** How likely a difference at least this large is by chance alone. Absent when either has nothing decided. */
  pValue?: number;
  /** The difference is larger than chance explains, at the level `level` says. */
  beyondChance: boolean;
};

const round = (value: number, digits: number): number => Number(value.toPrecision(digits));

/**
 * Each variant's success rate against the first variant's, for the
 * conversations of one version. One in twenty differences between equal
 * variants looks real at 0.05, so the level is divided by the number of
 * comparisons made.
 */
export function compareVariants(
  tallies: readonly Pick<VariantTally, "version" | "variant" | "succeeded" | "failed">[],
  ids: readonly string[],
  version: string | undefined
): { level: number; comparisons: VariantComparison[] } | undefined {
  const [first, ...others] = ids;
  if (first === undefined || others.length === 0) return undefined;
  const of = (id: string): { succeeded: number; failed: number } =>
    tallies.find((tally) => tally.variant === id && tally.version === version) ?? { succeeded: 0, failed: 0 };
  const level = 0.05 / others.length;
  const base = of(first);
  const baseDecided = base.succeeded + base.failed;
  return {
    level: round(level, 3),
    comparisons: others.map((id) => {
      const mine = of(id);
      const decided = mine.succeeded + mine.failed;
      const pValue =
        decided > 0 && baseDecided > 0
          ? fisherExact(mine.succeeded, mine.failed, base.succeeded, base.failed)
          : undefined;
      return {
        variant: id,
        against: first,
        decided,
        againstDecided: baseDecided,
        ...(decided > 0 ? { successRate: round(mine.succeeded / decided, 3) } : {}),
        ...(baseDecided > 0 ? { againstSuccessRate: round(base.succeeded / baseDecided, 3) } : {}),
        ...(pValue !== undefined ? { pValue: round(pValue, 3) } : {}),
        beyondChance: pValue !== undefined && pValue < level
      };
    })
  };
}

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
      // Room for the newest: the group that has been quiet longest goes.
      if (groups.size >= MAX_GROUPS) {
        let oldest: string | undefined;
        for (const [name, other] of groups) {
          if (oldest === undefined || other.lastAt < (groups.get(oldest) as Counted).lastAt) oldest = name;
        }
        if (oldest !== undefined) groups.delete(oldest);
      }
      group = {
        ...(version !== undefined ? { version } : {}),
        ...(variant !== undefined ? { variant } : {}),
        conversations: 0,
        averageSeconds: 0,
        seconds: 0,
        reasons: new Map(),
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
    const reason = (typeof session.endReason === "string" && session.endReason ? session.endReason : "unknown").slice(
      0,
      64
    );
    if (group.reasons.has(reason) || group.reasons.size < MAX_END_REASONS) {
      group.reasons.set(reason, (group.reasons.get(reason) ?? 0) + 1);
    }
    if (isRecord(record.analysis)) {
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
        .map(({ seconds, reasons, ...tally }) => ({
          ...tally,
          endReasons: Object.fromEntries(reasons),
          averageSeconds: tally.conversations ? Math.round(seconds / tally.conversations) : 0,
          firstAt: Number.isFinite(tally.firstAt) ? tally.firstAt : 0
        }))
        .sort((a, b) => b.lastAt - a.lastAt);
    },
    reading: () => reading > 0
  };
}
