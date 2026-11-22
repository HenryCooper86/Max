import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildKnowledgeIndex,
  createHybridSearch,
  knowledgeConfigFrom,
  knowledgeTool,
  loadKnowledge,
  type KnowledgeConfig,
  type KnowledgeIndex
} from "../server/knowledge";

const context = {
  callId: "c1",
  sessionId: "s1",
  signal: new AbortController().signal,
  log: { info() {}, warn() {} }
};
const call = async (tool: ReturnType<typeof knowledgeTool>, args: Record<string, unknown>) =>
  (await tool.handler(args, context)) as {
    results: { source: string; heading?: string; text: string }[];
    note?: string;
  };

describe("knowledgeConfigFrom", () => {
  const base = "/srv/max";

  it("returns {} when the key is absent", () => {
    expect(knowledgeConfigFrom(undefined, base)).toEqual({});
    expect(knowledgeConfigFrom(null, base)).toEqual({});
  });

  it("accepts a bare string or array and resolves relative paths against the config directory", () => {
    expect(knowledgeConfigFrom("kb", base).config).toEqual({
      paths: ["/srv/max/kb"],
      maxResults: 4,
      chunkChars: 900
    });
    expect(knowledgeConfigFrom(["kb/a.md", "/abs/b.txt", "../c.md"], base).config?.paths).toEqual([
      "/srv/max/kb/a.md",
      "/abs/b.txt",
      "/srv/c.md"
    ]);
  });

  it("accepts the object form with inline text", () => {
    const { config } = knowledgeConfigFrom({ files: "kb", text: " We close on Mondays. ", maxResults: 6 }, base);
    expect(config).toEqual({ paths: ["/srv/max/kb"], text: "We close on Mondays.", maxResults: 6, chunkChars: 900 });
    expect(knowledgeConfigFrom({ text: "only facts" }, base).config).toMatchObject({ paths: [], text: "only facts" });
  });

  it("clamps ranges", () => {
    expect(knowledgeConfigFrom({ files: "a", maxResults: 99, chunkChars: 10 }, base).config).toMatchObject({
      maxResults: 8,
      chunkChars: 200
    });
    expect(knowledgeConfigFrom({ files: "a", maxResults: 0, chunkChars: 99999 }, base).config).toMatchObject({
      maxResults: 1,
      chunkChars: 2000
    });
    expect(knowledgeConfigFrom({ files: "a", maxResults: 2.6 }, base).config?.maxResults).toBe(3);
  });

  it.each([
    [42],
    [true],
    [{ files: 7 }],
    [{ files: ["a", 3] }],
    [{ files: [""] }],
    [{ files: "a", text: 5 }],
    [{ files: "a", maxResults: "4" }],
    [{ files: "a", chunkChars: NaN }],
    [{}],
    [[]]
  ])("reports a problem for %j", (raw) => {
    const result = knowledgeConfigFrom(raw, base);
    expect(result.config).toBeUndefined();
    expect(result.problem).toMatch(/knowledge/);
  });
});

describe("loadKnowledge", () => {
  let dir: string;
  const config = (paths: string[], extra: Partial<KnowledgeConfig> = {}): KnowledgeConfig => ({
    paths,
    maxResults: 4,
    chunkChars: 900,
    ...extra
  });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-knowledge-"));
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    };
    write("kb/returns.md", "# Returns\n\nYou can return items within 30 days.\n");
    write("kb/nested/deep/shipping.txt", "Standard shipping takes 3 to 5 days.");
    write("kb/.secret.md", "# Secret\n\nhidden passphrase xylophone");
    write("kb/.git/config.md", "hidden xylophone");
    write("kb/node_modules/pkg/readme.md", "# Package\n\nmodule xylophone");
    write("kb/image.png", "not text xylophone");
    write("kb/too/many/levels/here/deeper/far.md", "# Far\n\nunreachable xylophone");
    write("kb/big.md", `# Big\n\n${"x".repeat(2 * 1024 * 1024 + 1)}`);
    write("outside/linked.md", "# Linked\n\nsymlinked xylophone");
    fs.symlinkSync(path.join(dir, "outside/linked.md"), path.join(dir, "kb/link.md"));
    fs.symlinkSync(path.join(dir, "outside"), path.join(dir, "kb/linkdir"));
    write("single.txt", "Opening hours are 9 to 5.");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("walks nested folders and skips dot-entries, node_modules, odd extensions, symlinks and oversized files", async () => {
    const { index, problems } = await loadKnowledge(config([path.join(dir, "kb")]));
    expect(index.sources).toEqual(["kb/nested/deep/shipping.txt", "kb/returns.md"].sort());
    expect(index.search("xylophone")).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/big\.md.*larger than 2 MiB/);
    // Passages carry the path relative to the configured path's parent.
    expect(index.search("shipping")[0].source).toBe("kb/nested/deep/shipping.txt");
  });

  it("reports unsupported files named directly, missing paths and inline text", async () => {
    const { index, problems } = await loadKnowledge(
      config([path.join(dir, "kb/image.png"), path.join(dir, "nope"), path.join(dir, "single.txt")], {
        text: "Parking is free."
      })
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/unsupported file type/);
    expect(problems[1]).toMatch(/cannot read/);
    expect(index.sources).toEqual(["single.txt", "config"]);
    expect(index.search("parking")[0].source).toBe("config");
    expect(index.search("hours")[0].source).toBe("single.txt");
  });

  it("stops at 500 files and reports it once", async () => {
    const many = path.join(dir, "many");
    fs.mkdirSync(many);
    for (let i = 0; i < 503; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), `fact number ${i}`);
    const { index, problems } = await loadKnowledge(config([many]));
    expect(index.sources).toHaveLength(500);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/500 files/);
  });

  it("never rejects", async () => {
    const { index, problems } = await loadKnowledge(config([]));
    expect(index.size).toBe(0);
    expect(problems).toEqual([]);
  });
});

describe("chunking", () => {
  it("keeps the heading trail", () => {
    const index = buildKnowledgeIndex([
      {
        source: "p.md",
        text: "# Returns\n\nIntro text.\n\n## International\n\nOverseas parcels take longer.\n\n### Customs\n\nDuties apply.\n\n## Domestic\n\nFree labels."
      }
    ]);
    const heading = (query: string) => index.search(query)[0].heading;
    expect(index.size).toBe(4);
    expect(heading("overseas")).toBe("Returns > International");
    expect(heading("duties")).toBe("Returns > International > Customs");
    expect(heading("labels")).toBe("Returns > Domestic");
    expect(heading("intro")).toBe("Returns");
  });

  it("ignores # lines inside code fences", () => {
    const index = buildKnowledgeIndex([{ source: "c.md", text: "# Setup\n\n```\n# not a heading\nrun it\n```\n" }]);
    expect(index.size).toBe(1);
    expect(index.search("run")[0].heading).toBe("Setup");
  });

  it("packs paragraphs near the target and never splits a paragraph that fits", () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${"word ".repeat(30)}`.trim());
    const index = buildKnowledgeIndex([{ source: "t.txt", text: paragraphs.join("\n\n"), format: "text" }], {
      chunkChars: 400
    });
    expect(index.size).toBeGreaterThan(3);
    const passages = index.search("word paragraph", 50);
    for (const passage of passages) {
      expect(passage.text.length).toBeLessThanOrEqual(400);
      for (const part of passage.text.split("\n\n")) expect(paragraphs).toContain(part);
    }
  });

  it("splits a paragraph over 1.5x the target at sentence ends", () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`);
    const index = buildKnowledgeIndex([{ source: "t.txt", text: sentences.join(" "), format: "text" }], {
      chunkChars: 200
    });
    expect(index.size).toBeGreaterThan(2);
    for (const passage of index.search("sentence", 50)) {
      expect(passage.text.length).toBeLessThanOrEqual(200);
      expect(passage.text).toMatch(/here\.$/);
    }
  });

  it("splits Chinese text at sentence ends without spaces", () => {
    const text = "我们的退货政策很简单。".repeat(60);
    const index = buildKnowledgeIndex([{ source: "z.txt", text, format: "text" }], { chunkChars: 200 });
    expect(index.size).toBeGreaterThan(2);
  });
});

describe("formats", () => {
  it("strips HTML, decodes entities and uses h1-h6 as headings", () => {
    const html = `<!doctype html><html><head><title>Ignored</title><style>.x{color:red}</style></head>
      <body><script>var secret = "zebra";</script>
      <h1>Store &amp; Shop</h1><p>Open daily&nbsp;9&ndash;5.<br>Closed &#39;holidays&#39; &lt;sometimes&gt; &#x4E2D;&#25991;</p>
      <h2>Contact <em>us</em></h2><div>Call &quot;us&quot;</div></body></html>`;
    const index = buildKnowledgeIndex([{ source: "s.html", text: html, format: "html" }]);
    const [first] = index.search("holidays");
    expect(first.heading).toBe("Store & Shop");
    expect(first.text).toContain("Open daily 9–5.");
    expect(first.text).toContain("Closed 'holidays' <sometimes> 中文");
    expect(first.text).not.toMatch(/&amp;|<\/?p>|<br/);
    expect(index.search("call")[0].heading).toBe("Store & Shop > Contact us");
    expect(index.search("zebra")).toEqual([]);
    expect(index.search("color")).toEqual([]);
    expect(index.search("ignored")).toEqual([]);
  });

  it("turns each object of a JSON array into a passage", () => {
    const json = JSON.stringify([
      { sku: "A-1", name: "Kettle", price: 25, tags: ["kitchen"] },
      { sku: "A-2", name: "Toaster", price: 40, note: null }
    ]);
    const index = buildKnowledgeIndex([{ source: "p.json", text: json, format: "json" }]);
    expect(index.size).toBe(2);
    expect(index.search("toaster")[0].text).toBe("sku: A-2\nname: Toaster\nprice: 40");
    expect(index.search("kettle")[0].text).toContain('tags: ["kitchen"]');
  });

  it("pretty-prints other JSON and treats invalid JSON as text", () => {
    const index = buildKnowledgeIndex([
      { source: "a.json", text: '{"policy":{"refund":"fourteen days"}}', format: "json" },
      { source: "b.json", text: "{ not json fourteen", format: "json" }
    ]);
    expect(index.size).toBe(2);
    expect(index.search("refund")[0].text).toContain('"refund": "fourteen days"');
    expect(index.search("not json")[0].source).toBe("b.json");
  });

  it("turns each CSV row into header: value lines, handling quotes", () => {
    const csv = 'item,price,notes\r\nWidget,5,"Small, round"\r\nGadget,9,"Says ""hi"""\r\n\r\nMulti,1,"two\nlines"\r\n';
    const index = buildKnowledgeIndex([{ source: "i.csv", text: csv, format: "csv" }]);
    expect(index.size).toBe(3);
    expect(index.search("widget")[0].text).toBe("item: Widget\nprice: 5\nnotes: Small, round");
    expect(index.search("gadget")[0].text).toContain('notes: Says "hi"');
    expect(index.search("multi")[0].text).toContain("notes: two\nlines");
  });
});

describe("search", () => {
  const corpus = buildKnowledgeIndex([
    {
      source: "kb/returns.md",
      text: "# Returns\n\nYou can return any item within 30 days of delivery for a full refund. Items must be unused and in the original packaging.\n\n## Damaged goods\n\nIf your order A-1042 arrived damaged, contact support and we will send a replacement."
    },
    {
      source: "kb/shipping.md",
      text: "# Shipping\n\nStandard shipping takes 3 to 5 business days. Express delivery takes 1 to 2 days and costs 12.50 dollars.\n\nWe ship to the United States, Canada and Germany."
    },
    {
      source: "kb/hours.md",
      text: "# Opening hours\n\nThe shop is open Monday to Friday from 9am to 6pm. On Saturdays we close at 2pm. We are closed on Sundays and public holidays."
    },
    {
      source: "kb/prices.csv",
      format: "csv",
      text: "product,price,warranty\nEspresso machine,249.99,2 years\nMilk frother,35.50,1 year\nGrinder,89,1 year"
    },
    {
      source: "kb/zh.md",
      text: "# 退货政策\n\n商品在收到后三十天内可以无理由退货。运费由买家承担。\n\n# 营业时间\n\n我们周一至周五上午九点到下午六点营业。"
    },
    {
      source: "kb/ja.txt",
      format: "text",
      text: "返品について\n\n商品は到着から30日以内であれば返品できます。送料はお客様のご負担となります。\n\n配送には通常三日かかります。"
    }
  ]);
  const top = (query: string) => corpus.search(query)[0]?.source;

  it.each([
    ["how do I return something", "kb/returns.md"],
    ["returning an item", "kb/returns.md"],
    ["what are the opening hours", "kb/hours.md"],
    ["are you closed on Sunday", "kb/hours.md"],
    ["how long does shipping take", "kb/shipping.md"],
    ["A-1042", "kb/returns.md"],
    ["a-1042 damaged", "kb/returns.md"],
    ["12.50", "kb/shipping.md"],
    ["249.99", "kb/prices.csv"],
    ["milk frother warranty", "kb/prices.csv"],
    ["退货", "kb/zh.md"],
    ["营业时间是几点", "kb/zh.md"],
    ["返品できますか", "kb/ja.txt"],
    ["配送にかかる日数", "kb/ja.txt"]
  ])("%s -> %s", (query, source) => expect(top(query)).toBe(source));

  it("returns the best passage first with a score, and honours the limit", () => {
    const results = corpus.search("days", 2);
    expect(results.length).toBeLessThanOrEqual(2);
    expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("returns [] when nothing matches or the query is empty", () => {
    expect(corpus.search("quantum chromodynamics")).toEqual([]);
    expect(corpus.search("")).toEqual([]);
    expect(corpus.search("   ??? ")).toEqual([]);
    expect(buildKnowledgeIndex([]).search("anything")).toEqual([]);
  });

  it("ignores stop words in a query unless nothing else is left", () => {
    expect(corpus.search("what is the").length).toBeGreaterThan(0);
    expect(top("the refund")).toBe("kb/returns.md");
  });

  it("does not return the same text twice from one source", () => {
    const text = "# FAQ\n\nWe accept returns within thirty days.";
    const index = buildKnowledgeIndex([
      { source: "faq.md", text },
      { source: "faq.md", text },
      { source: "other.md", text }
    ]);
    const sources = index.search("returns").map((passage) => passage.source);
    expect(sources).toEqual(["faq.md", "other.md"]);
  });

  it("lists sources once", () => {
    expect(corpus.sources).toEqual([
      "kb/returns.md",
      "kb/shipping.md",
      "kb/hours.md",
      "kb/prices.csv",
      "kb/zh.md",
      "kb/ja.txt"
    ]);
    expect(corpus.size).toBeGreaterThanOrEqual(10);
  });
});

describe("knowledgeTool", () => {
  const index = buildKnowledgeIndex([
    { source: "kb/returns.md", text: "# Returns\n\nReturns are accepted within 30 days." },
    { source: "kb/hours.md", text: "# Hours\n\nOpen 9 to 5." }
  ]);

  it("has the expected name, description and parameters", async () => {
    const tool = knowledgeTool(() => index);
    expect(tool.name).toBe("search_knowledge");
    expect(tool.description).toMatch(/before answering/i);
    expect(tool.description).toMatch(/do not know/i);
    expect(tool.parameters).toMatchObject({ type: "object", required: ["query"] });
  });

  it("returns passages without scores", async () => {
    const { results, note } = await call(
      knowledgeTool(() => index),
      { query: "returns" }
    );
    expect(note).toBeUndefined();
    expect(results[0]).toEqual({
      source: "kb/returns.md",
      heading: "Returns",
      text: "Returns are accepted within 30 days."
    });
  });

  it("says so when nothing matches", async () => {
    expect(
      await call(
        knowledgeTool(() => index),
        { query: "spaceship" }
      )
    ).toEqual({
      results: [],
      note: "Nothing in the knowledge base matches. Say you do not know rather than guessing."
    });
  });

  it("throws for a blank query or an unloaded index", async () => {
    const tool = knowledgeTool(() => index);
    await expect(call(tool, { query: "  " })).rejects.toThrow();
    await expect(call(tool, {})).rejects.toThrow();
    await expect(
      call(
        knowledgeTool(() => undefined),
        { query: "x" }
      )
    ).rejects.toThrow("the knowledge base is not loaded");
  });

  it("reads the index on every call", async () => {
    let current = undefined as KnowledgeIndex | undefined;
    const tool = knowledgeTool(() => current);
    await expect(call(tool, { query: "returns" })).rejects.toThrow();
    current = index;
    expect((await call(tool, { query: "returns" })).results).toHaveLength(1);
  });

  it("honours maxResults", async () => {
    const many = buildKnowledgeIndex(
      Array.from({ length: 10 }, (_, i) => ({ source: `d${i}.md`, text: `# Doc ${i}\n\nrefund details ${i}` }))
    );
    const two = await call(
      knowledgeTool(() => many, 2),
      { query: "refund" }
    );
    expect(two.results).toHaveLength(2);
    const four = await call(
      knowledgeTool(() => many),
      { query: "refund" }
    );
    expect(four.results).toHaveLength(4);
  });

  it("keeps the reply under 6,000 characters", async () => {
    const big = buildKnowledgeIndex(
      Array.from({ length: 8 }, (_, i) => ({
        source: `d${i}.txt`,
        format: "text" as const,
        text: `refund ${"policy text ".repeat(120)} ${i}`
      })),
      { chunkChars: 2000 }
    );
    const result = await call(
      knowledgeTool(() => big, 8),
      { query: "refund policy" }
    );
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
    expect(result.results.length).toBeGreaterThanOrEqual(1);

    const single = buildKnowledgeIndex([
      { source: "one.json", format: "json", text: JSON.stringify([{ note: `refund ${"x ".repeat(5000)}` }]) }
    ]);
    const trimmed = await call(
      knowledgeTool(() => single),
      { query: "refund" }
    );
    expect(trimmed.results).toHaveLength(1);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(6000);
    expect(trimmed.results[0].text.endsWith("…")).toBe(true);
  });
});

describe("performance", async () => {
  it("indexes 20,000 passages and answers 50 searches quickly", async () => {
    const words = Array.from({ length: 2000 }, (_, i) => `term${i.toString(36)}`);
    const documents = Array.from({ length: 200 }, (_, d) => ({
      source: `doc${d}.csv`,
      format: "csv" as const,
      text:
        "id,body\n" +
        Array.from(
          { length: 100 },
          (_, r) =>
            `${d * 100 + r},"${Array.from({ length: 20 }, (_, k) => words[(d * 31 + r * 17 + k * 7) % 2000]).join(" ")} refund"`
        ).join("\n")
    }));
    const started = performance.now();
    const index = buildKnowledgeIndex(documents);
    expect(index.size).toBe(20_000);
    for (let i = 0; i < 50; i++)
      expect(index.search(`refund ${words[i * 11]} ${words[i * 13]}`).length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(10_000);

    const searchStart = performance.now();
    for (let i = 0; i < 50; i++) index.search(`refund ${words[i * 11]} ${words[i * 13]}`);
    expect(performance.now() - searchStart).toBeLessThan(1000);
  });
});

// A tiny concept space: each dimension is an idea, and words from different languages of thought land on it.
const CONCEPTS: Record<string, number> = {
  refund: 0,
  refunds: 0,
  reimbursement: 0,
  reimbursed: 0,
  money: 0,
  back: 0,
  courier: 1,
  delivers: 1,
  delivery: 1,
  parcel: 1,
  open: 2,
  hours: 2
};
const embed = (text: string): Float32Array => {
  const vector = new Float32Array(4);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const dimension = CONCEPTS[word];
    if (dimension !== undefined) vector[dimension] = (vector[dimension] as number) + 1;
  }
  const length = Math.hypot(...vector);
  return length ? vector.map((value) => value / length) : vector;
};

const hybridDocs = [
  {
    source: "kb/policies.md",
    text: [
      "# Reimbursement\n\nCustomers are reimbursed within 14 days.",
      "# Delivery\n\nOur courier delivers in 3 days.",
      "# Opening hours\n\nWe open at nine.",
      "# Parking\n\nFree parking behind the shop. The gate code is zebra."
    ].join("\n\n")
  }
];

describe("hybrid search", () => {
  afterEach(() => vi.useRealTimers());

  const setup = (embedQuery = async (text: string) => embed(text), log?: (message: string) => void) => {
    const index = buildKnowledgeIndex(hybridDocs);
    const vectors = index.passageTexts().map(embed);
    return { index, search: createHybridSearch(index, vectors, embedQuery, { log }) };
  };

  it("lists the text to embed with the heading first", () => {
    const { index } = setup();
    expect(index.passageTexts()[0]).toBe("Reimbursement\nCustomers are reimbursed within 14 days.");
    expect(index.passageTexts()).toHaveLength(index.size);
  });

  it("finds a passage that shares no word with the question", async () => {
    const { index, search } = setup();
    expect(index.search("money back")).toEqual([]);
    const found = await search("money back");
    expect(found.map((item) => item.heading)).toEqual(["Reimbursement"]);
  });

  it("still finds a passage that only matches by word", async () => {
    const { search } = setup();
    const found = await search("gate code zebra");
    expect(found.map((item) => item.heading)).toEqual(["Parking"]);
  });

  it("puts a passage both searches agree on first", async () => {
    const { search } = setup();
    const found = await search("courier money back");
    expect(found.map((item) => item.heading)).toEqual(["Delivery", "Reimbursement"]);
    expect(found[0]!.score).toBeGreaterThan(found[1]!.score);
  });

  it("returns at most `limit` passages", async () => {
    const { search } = setup();
    expect(await search("courier money back", 1)).toHaveLength(1);
  });

  it("falls back to keyword search when the embedder rejects, and logs at most once a minute", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const { index, search } = setup(async () => Promise.reject(new Error("down")), log);
    expect(await search("courier")).toEqual(index.search("courier"));
    expect(await search("courier")).toEqual(index.search("courier"));
    expect(log).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    await search("courier");
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("falls back to keyword search when the embedder takes longer than 2 seconds", async () => {
    vi.useFakeTimers();
    const { index, search } = setup(() => new Promise(() => {}));
    const pending = search("courier");
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(index.search("courier"));
  });

  it("falls back when the vectors do not fit the index or the query", async () => {
    const index = buildKnowledgeIndex(hybridDocs);
    const short = createHybridSearch(index, [embed("refund")], async (text) => embed(text));
    expect(await short("courier")).toEqual(index.search("courier"));
    const wide = createHybridSearch(index, index.passageTexts().map(embed), async () => new Float32Array(7).fill(1));
    expect(await wide("courier")).toEqual(index.search("courier"));
  });

  it("drops semantic matches below 0.25 similarity, so an unrelated question finds nothing", async () => {
    const weak = new Float32Array([0.2, 0, 0, Math.sqrt(1 - 0.04)]);
    const { search } = setup(async () => weak);
    expect(await search("something else entirely")).toEqual([]);
    const strong = new Float32Array([0.3, 0, 0, Math.sqrt(1 - 0.09)]);
    const { search: stronger } = setup(async () => strong);
    expect((await stronger("something else entirely")).map((item) => item.heading)).toEqual(["Reimbursement"]);
  });

  it("does not repeat a passage that is indexed twice", async () => {
    const index = buildKnowledgeIndex([...hybridDocs, ...hybridDocs]);
    const search = createHybridSearch(index, index.passageTexts().map(embed), async (text) => embed(text));
    const found = await search("money back", 4);
    expect(found).toHaveLength(1);
  });

  it("works as the searcher of the tool", async () => {
    const { search } = setup();
    const tool = knowledgeTool(() => ({ search }));
    const { results } = await call(tool, { query: "money back" });
    expect(results.map((item) => item.heading)).toEqual(["Reimbursement"]);
  });
});
