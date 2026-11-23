import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantProfileFrom } from "../server/assistant";
import type { ConversationEndedPayload } from "../server/conversation-webhook";
import { compareVariants, createVariantResults, fisherExact, pickVariant, variantSpecsFrom } from "../server/variants";

describe("variantSpecsFrom", () => {
  it("is off without a list", () => {
    expect(variantSpecsFrom(undefined)).toEqual({ variants: [] });
    expect(variantSpecsFrom([])).toEqual({ variants: [] });
  });

  it("reads ids, weights and the keys a variant replaces", () => {
    expect(
      variantSpecsFrom([{ id: "control" }, { id: "warm", weight: 3, greeting: "Hi!", instructions: "Be warm." }])
    ).toEqual({
      variants: [
        { id: "control", weight: 1, overrides: {} },
        { id: "warm", weight: 3, overrides: { greeting: "Hi!", instructions: "Be warm." } }
      ]
    });
  });

  it("turns nothing on when a part of the list is wrong, and says which", () => {
    const problem = (raw: unknown) => {
      const read = variantSpecsFrom(raw);
      expect(read.variants).toEqual([]);
      return read.problem;
    };
    expect(problem("a,b")).toContain("must be a list");
    expect(problem([{ id: "only" }])).toContain("at least two");
    expect(problem(Array.from({ length: 9 }, (_, i) => ({ id: `v${i}` })))).toContain("at most 8");
    expect(problem([{ id: "a" }, "b"])).toContain("variants[1] must be an object");
    expect(problem([{ id: "a" }, { id: "Not OK" }])).toContain("variants[1].id");
    expect(problem([{ id: "a" }, { id: "a" }])).toContain("a is there twice");
    expect(problem([{ id: "a" }, { id: "b", weight: 0 }])).toContain("weight");
    expect(problem([{ id: "a" }, { id: "b", weight: "2" }])).toContain("weight");
    // The relay's tools and the look of the assistant are not a variant's to change.
    expect(problem([{ id: "a" }, { id: "b", mcpServers: [] }])).toContain('cannot change "mcpServers"');
    expect(problem([{ id: "a" }, { id: "b", name: "Other" }])).toContain("A variant may set: instructions");
  });
});

describe("pickVariant", () => {
  const variants = [
    { id: "a", weight: 1 },
    { id: "b", weight: 3 }
  ];

  it("gives the same person the same variant every time", () => {
    const first = pickVariant(variants, "user-17")!.id;
    for (let i = 0; i < 20; i += 1) expect(pickVariant(variants, "user-17", () => i / 20)!.id).toBe(first);
  });

  it("shares people out by weight", () => {
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 4000; i += 1) counts[pickVariant(variants, `user-${i}`)!.id as "a" | "b"] += 1;
    expect(counts.a / 4000).toBeGreaterThan(0.22);
    expect(counts.a / 4000).toBeLessThan(0.28);
  });

  it("shares people out anew for another test", () => {
    const other = [
      { id: "c", weight: 1 },
      { id: "d", weight: 3 }
    ];
    let moved = 0;
    for (let i = 0; i < 2000; i += 1) {
      const first = pickVariant(variants, `user-${i}`)!.id === "a";
      const second = pickVariant(other, `user-${i}`)!.id === "c";
      if (first !== second) moved += 1;
    }
    // Independent draws of 1 in 4 differ for 3 in 8.
    expect(moved / 2000).toBeGreaterThan(0.3);
    expect(moved / 2000).toBeLessThan(0.45);
  });

  it("draws at random for someone it cannot tell from anyone else", () => {
    expect(pickVariant(variants, undefined, () => 0)!.id).toBe("a");
    expect(pickVariant(variants, undefined, () => 0.24)!.id).toBe("a");
    expect(pickVariant(variants, undefined, () => 0.26)!.id).toBe("b");
    expect(pickVariant(variants, undefined, () => 0.9999)!.id).toBe("b");
    expect(pickVariant([], "user-1")).toBeUndefined();
  });
});

describe("a config with variants", () => {
  const config = {
    name: "Ava",
    device: "app",
    version: "2026-11-23",
    instructions: "Be brief.",
    greeting: "Hello.",
    guardrails: { blockedTerms: ["Acme"] },
    variants: [
      { id: "control" },
      { id: "warm", weight: 2, greeting: "Hi! Lovely to hear from you.", guardrails: { blockedTerms: ["Bolt"] } }
    ]
  };

  it("has the assistant as each variant sees it, and its own unchanged", () => {
    const profile = assistantProfileFrom(config);
    expect(profile.version).toBe("2026-11-23");
    expect(profile.greeting).toBe("Hello.");
    expect(profile.variant).toBeUndefined();
    expect(profile.variants.map(({ id, weight }) => [id, weight])).toEqual([
      ["control", 1],
      ["warm", 2]
    ]);
    const [control, warm] = profile.variants.map((variant) => variant.profile);
    expect(control).toMatchObject({ variant: "control", greeting: "Hello.", instructions: "Be brief." });
    expect(control!.guardrails?.blockedTerms).toEqual(["Acme"]);
    // What the variant does not set, it has from the config.
    expect(warm).toMatchObject({
      variant: "warm",
      greeting: "Hi! Lovely to hear from you.",
      instructions: "Be brief."
    });
    expect(warm!.guardrails?.blockedTerms).toEqual(["Bolt"]);
    expect(warm!.name).toBe("Ava");
    // A variant has no variants of its own.
    expect(warm!.variants).toEqual([]);
    expect(profile.configProblems).toEqual([]);
    // The Studio carries both keys into its own file when it saves.
    expect(profile.deployerConfig).toMatchObject({ version: "2026-11-23", variants: config.variants });
  });

  it("reports a variant's own mistakes under its name, and a bad list once", () => {
    const wrong = assistantProfileFrom({
      ...config,
      variants: [{ id: "control" }, { id: "odd", guardrails: { blockedTerms: "Acme" } }]
    });
    expect(wrong.configProblems).toEqual([expect.stringMatching(/^variants: odd: guardrails\.blockedTerms/)]);
    const none = assistantProfileFrom({ ...config, variants: [{ id: "control" }] });
    expect(none.variants).toEqual([]);
    expect(none.configProblems).toEqual([expect.stringContaining("at least two")]);
    // The config and a variant wrong in the same way: said for each.
    const both = assistantProfileFrom({
      ...config,
      guardrails: { blockedTerms: "Acme" },
      variants: [{ id: "control" }, { id: "odd", guardrails: { blockedTerms: "Acme" } }]
    });
    expect(both.configProblems).toHaveLength(2);
    expect(both.configProblems[0]).toMatch(/^guardrails\.blockedTerms/);
    expect(both.configProblems[1]).toMatch(/^variants: odd: guardrails\.blockedTerms/);
    // What is wrong with the config alone is not said again for every variant.
    const baseOnly = assistantProfileFrom({
      ...config,
      guardrails: { blockedTerms: "Acme" },
      variants: [{ id: "a" }, { id: "b", greeting: "Hi." }]
    });
    expect(baseOnly.configProblems).toHaveLength(1);
  });

  it("uses the config's rememberUsers for every variant, and says so only when a variant asks for another", () => {
    const base = { ...config, conversation: { rememberUsers: true, idleReminderSeconds: 20 } };
    const quiet = assistantProfileFrom({
      ...base,
      variants: [{ id: "a" }, { id: "b", conversation: { idleReminderSeconds: 40 } }]
    });
    expect(quiet.configProblems).toEqual([]);
    expect(quiet.variants[1]!.profile.conversation).toMatchObject({ rememberUsers: true, idleReminderSeconds: 40 });
    const asked = assistantProfileFrom({
      ...base,
      variants: [{ id: "a" }, { id: "b", conversation: { rememberUsers: false } }]
    });
    expect(asked.configProblems).toEqual([expect.stringContaining("variants: b: conversation.rememberUsers")]);
    expect(asked.variants[1]!.profile.conversation.rememberUsers).toBe(true);
    expect(assistantProfileFrom({ name: "Ava", device: "app" }).variants).toEqual([]);
  });
});

describe("createVariantResults", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-variants-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let next = 0;
  function record(
    session: Partial<ConversationEndedPayload["session"]>,
    extra: Partial<ConversationEndedPayload> = {}
  ): ConversationEndedPayload {
    next += 1;
    return {
      type: "conversation.ended",
      id: `delivery-${next}`,
      session: {
        id: `session-${next}`,
        backend: "local",
        channel: "web",
        startedAt: 1000,
        endedAt: 1000 + next,
        seconds: 60,
        ...session
      },
      transcript: [],
      ...extra
    };
  }

  it("counts conversations by version and variant: how long, how they ended, what the analysis said", () => {
    const results = createVariantResults();
    results.add(
      record(
        { version: "v2", variant: "a", seconds: 30, endReason: "agent" },
        { analysis: { success: true, sentiment: "positive" } }
      )
    );
    results.add(
      record(
        { version: "v2", variant: "a", seconds: 90, endReason: "client" },
        { analysis: { success: false, sentiment: "negative" } }
      )
    );
    results.add(record({ version: "v2", variant: "a", seconds: 60, endReason: "agent" }));
    results.add(
      record(
        { version: "v2", variant: "b", seconds: 10, endReason: "guardrail" },
        { guardrails: [{ speaker: "assistant", kind: "term", rule: "Acme", at: 1, stopped: true }] }
      )
    );
    results.add(record({ seconds: 5 }));
    const tallies = results.tallies();
    const a = tallies.find((tally) => tally.variant === "a")!;
    expect(a).toMatchObject({
      version: "v2",
      conversations: 3,
      averageSeconds: 60,
      endReasons: { agent: 2, client: 1 },
      analysed: 2,
      succeeded: 1,
      failed: 1,
      sentiment: { positive: 1, neutral: 0, negative: 1 },
      withGuardrailFindings: 0
    });
    expect(a.firstAt).toBeLessThan(a.lastAt);
    expect(tallies.find((tally) => tally.variant === "b")).toMatchObject({
      conversations: 1,
      endReasons: { guardrail: 1 },
      withGuardrailFindings: 1
    });
    // Conversations from before there were variants are counted on their own.
    const plain = tallies.find((tally) => tally.variant === undefined)!;
    expect(plain).toMatchObject({ conversations: 1, endReasons: { unknown: 1 } });
    expect("version" in plain).toBe(false);
    // Something that is not a record is passed over.
    results.add({} as never);
    results.add(null as never);
    expect(results.tallies()).toHaveLength(3);
  });

  it("counts reasons with names every object has, and keeps the newest groups", () => {
    const results = createVariantResults();
    for (const endReason of ["constructor", "constructor", "toString", "__proto__", "x".repeat(200)]) {
      results.add(record({ variant: "a", endReason }));
    }
    results.add(record({ variant: "a" }, { analysis: 5 as never }));
    const [tally] = results.tallies();
    expect(tally!.endReasons).toEqual({
      constructor: 2,
      toString: 1,
      ["__proto__"]: 1,
      ["x".repeat(64)]: 1,
      unknown: 1
    });
    expect(Object.keys(tally!.endReasons)).toContain("__proto__");
    expect(tally!.analysed).toBe(0);
    // More versions than are kept: the ones that have been quiet longest go.
    const many = createVariantResults();
    for (let i = 0; i < 205; i += 1) many.add(record({ version: `v${i}`, endedAt: 1000 + i }));
    const versions = many.tallies().map((item) => item.version);
    expect(versions).toHaveLength(200);
    expect(versions[0]).toBe("v204");
    expect(versions).not.toContain("v0");
  });

  it("counts what an earlier log holds, but not what is yet to end", async () => {
    const file = path.join(dir, "conversations.jsonl");
    const old = [
      record({ variant: "a", endedAt: 5000 }),
      record({ variant: "b", endedAt: 6000 }),
      // Written while the log is being read: this one is reported live too.
      record({ variant: "a", endedAt: Date.now() + 60_000 })
    ];
    fs.writeFileSync(
      file,
      `${old.map((item) => JSON.stringify(item)).join("\n")}\n{"type":"conversation.en\n\nnot json\n`
    );
    const results = createVariantResults();
    const reading = results.readLog(file);
    expect(results.reading()).toBe(true);
    expect(await reading).toBe(2);
    expect(results.reading()).toBe(false);
    results.add(old[2]!);
    const count = (variant: string) => results.tallies().find((tally) => tally.variant === variant)!.conversations;
    expect([count("a"), count("b")]).toEqual([2, 1]);
    // No file yet: nothing to count, and no error.
    expect(await createVariantResults().readLog(path.join(dir, "missing.jsonl"))).toBe(0);
  });
});

describe("whether a difference is larger than chance", () => {
  it("works out Fisher's exact test as the textbooks have it", () => {
    expect(fisherExact(8, 2, 1, 5)).toBeCloseTo(0.034965035, 8);
    expect(fisherExact(3, 1, 1, 3)).toBeCloseTo(0.485714286, 8);
    expect(fisherExact(10, 0, 0, 10)).toBeCloseTo(1.0825088e-5, 11);
    expect(fisherExact(171, 38, 560, 190)).toBeCloseTo(0.034457431, 7);
    expect(fisherExact(600, 400, 650, 350)).toBeCloseTo(0.023592221, 7);
    // The same whichever group is named first, and whichever outcome is called success.
    expect(fisherExact(1, 5, 8, 2)).toBeCloseTo(0.034965035, 8);
    expect(fisherExact(2, 8, 5, 1)).toBeCloseTo(0.034965035, 8);
  });

  it("finds no difference where none can show", () => {
    expect(fisherExact(5, 0, 5, 0)).toBe(1);
    expect(fisherExact(0, 5, 0, 7)).toBe(1);
    expect(fisherExact(0, 0, 4, 2)).toBe(1);
    expect(fisherExact(4, 2, 0, 0)).toBe(1);
    expect(fisherExact(50, 50, 50, 50)).toBeCloseTo(1, 9);
    expect(fisherExact(50, 50, 50, 50)).toBeLessThanOrEqual(1);
  });

  /** One group's verdicts. `null` for a record without a version. */
  const tally = (variant: string | undefined, succeeded: number, failed: number, version: string | null = "v2") => ({
    ...(version !== null ? { version } : {}),
    ...(variant !== undefined ? { variant } : {}),
    succeeded,
    failed
  });

  it("compares each variant with the first, for the conversations of one version", () => {
    const tallies = [
      tally("control", 560, 190),
      tally("warm", 171, 38),
      // Another version's conversations, and those from before the test, are not part of it.
      tally("control", 0, 500, "v1"),
      tally("warm", 500, 0, "v1"),
      tally(undefined, 3, 300)
    ];
    expect(compareVariants(tallies, ["control", "warm"], "v2")).toEqual({
      level: 0.05,
      comparisons: [
        {
          variant: "warm",
          against: "control",
          decided: 209,
          againstDecided: 750,
          successRate: 0.818,
          againstSuccessRate: 0.747,
          pValue: 0.0345,
          beyondChance: true
        }
      ]
    });
  });

  it("asks more of each difference when several are looked at", () => {
    const tallies = [tally("control", 560, 190), tally("warm", 171, 38), tally("brisk", 150, 50)];
    const compared = compareVariants(tallies, ["control", "warm", "brisk"], "v2")!;
    expect(compared.level).toBe(0.025);
    // 0.034 would do for one comparison, and does not for two.
    expect(compared.comparisons[0]).toMatchObject({ variant: "warm", pValue: 0.0345, beyondChance: false });
    expect(compared.comparisons[1]).toMatchObject({ variant: "brisk", against: "control", beyondChance: false });
  });

  it("says nothing of a variant that has no conversation with a verdict yet", () => {
    const compared = compareVariants([tally("control", 20, 5)], ["control", "warm"], "v2")!;
    expect(compared.comparisons).toEqual([
      {
        variant: "warm",
        against: "control",
        decided: 0,
        againstDecided: 25,
        againstSuccessRate: 0.8,
        beyondChance: false
      }
    ]);
    expect(compareVariants([], ["control", "warm"], undefined)!.comparisons[0]).toEqual({
      variant: "warm",
      against: "control",
      decided: 0,
      againstDecided: 0,
      beyondChance: false
    });
  });

  it("counts a config without a version with the records that have none", () => {
    const tallies = [tally("control", 10, 0, null), tally("warm", 0, 10, null), tally("warm", 10, 0, "v2")];
    expect(compareVariants(tallies, ["control", "warm"], undefined)!.comparisons[0]).toMatchObject({
      decided: 10,
      successRate: 0,
      beyondChance: true
    });
  });

  it("has nothing to compare without at least two variants", () => {
    expect(compareVariants([], [], "v2")).toBeUndefined();
    expect(compareVariants([], ["only"], "v2")).toBeUndefined();
  });
});
