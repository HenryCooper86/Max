import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantProfileFrom } from "../server/assistant";
import type { ConversationEndedPayload } from "../server/conversation-webhook";
import { createVariantResults, pickVariant, variantSpecsFrom } from "../server/variants";

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
