import { describe, expect, it } from "vitest";
import {
  agentEntryFrom,
  branchTaken,
  collectFrom,
  collected,
  entryValues,
  filled,
  filledArguments,
  savedFrom
} from "../server/agent-entry";
import { agentStagesFrom } from "../server/conversation-config";
import { checkFlow, flowFrom } from "../server/flow";

describe("what an agent does on arriving, as it is written in the config", () => {
  it("reads a sentence, a call and the branches", () => {
    expect(
      agentEntryFrom({
        say: "  One moment,\n I am looking up your order. ",
        call: { tool: "find_order", arguments: { which: "latest" } },
        next: [
          { to: "tracking", if: { path: "status", in: ["shipped", "packed"] } },
          { to: "refunds", if: { path: "order.total", above: 100 } },
          { to: "human", if: { failed: true } },
          "orders"
        ]
      })
    ).toEqual({
      entry: {
        say: "One moment, I am looking up your order.",
        call: { tool: "find_order", arguments: { which: "latest" } },
        next: [
          { to: "tracking", if: { path: "status", in: ["shipped", "packed"] } },
          { to: "refunds", if: { path: "order.total", above: 100 } },
          { to: "human", if: { failed: true } },
          { to: "orders" }
        ]
      }
    });
    expect(agentEntryFrom({ call: { tool: "find_order" } }).entry).toEqual({
      call: { tool: "find_order", arguments: {} }
    });
    // A sentence and then on to another agent, with no tool at all.
    expect(agentEntryFrom({ say: "This call is recorded.", next: ["sales"] }).entry).toEqual({
      say: "This call is recorded.",
      next: [{ to: "sales" }]
    });
    expect(agentEntryFrom(undefined)).toEqual({});
    expect(agentEntryFrom({})).toEqual({});
    expect(agentEntryFrom({ say: "  " })).toEqual({});
  });

  it("takes nothing of an onEnter with a mistake in it, and says which", () => {
    const problem = (raw: unknown) => {
      const read = agentEntryFrom(raw);
      expect(read.entry).toBeUndefined();
      return read.problem;
    };
    expect(problem("say hello")).toBe("onEnter must be an object");
    expect(problem({ speak: "Hello." })).toBe('onEnter has no "speak"');
    expect(problem({ say: 5 })).toBe("onEnter: say must be text");
    expect(problem({ say: "x".repeat(501) })).toBe("onEnter: say can be at most 500 characters");
    expect(problem({ call: "find_order" })).toBe('onEnter: call must name a tool, as { "tool": "find_order" }');
    expect(problem({ call: { tool: "find order" } })).toBe(
      'onEnter: call must name a tool, as { "tool": "find_order" }'
    );
    expect(problem({ call: { tool: "t", args: {} } })).toBe('onEnter: a call has no "args"');
    expect(problem({ call: { tool: "t", arguments: [1] } })).toBe("onEnter: the arguments of a call must be an object");
    expect(problem({ call: { tool: "t", arguments: { text: "x".repeat(2000) } } })).toBe(
      "onEnter: the arguments of a call can be at most 2000 characters of JSON"
    );
    // Ending the conversation and handing it over are not a step's to call.
    expect(problem({ call: { tool: "end_session" } })).toContain("onEnter cannot call end_session");
    expect(problem({ call: { tool: "transfer_to_agent", arguments: { agent: "sales" } } })).toContain(
      "onEnter cannot call transfer_to_agent: to move on to another agent use next"
    );
    expect(problem({ next: "sales" })).toBe("onEnter: next must be a list of at most 8 branches");
    expect(problem({ next: [{}] })).toBe(
      'onEnter: every branch needs the id of an agent, as "billing" or { "to": "billing" }'
    );
    expect(problem({ next: [{ to: "a", when: "x" }] })).toBe('onEnter: a branch has no "when"');
    expect(problem({ next: ["a", "b"] })).toBe(
      "onEnter: a branch without a condition is always taken, so it must be the last one"
    );
    // A condition reads the tool's answer.
    expect(problem({ next: [{ to: "a", if: { path: "x", is: 1 } }] })).toBe(
      "onEnter: a branch with a condition needs a call whose answer it reads, or the name of a value to read"
    );
    const call = { tool: "t" };
    const condition = (given: unknown) => problem({ call, next: [{ to: "a", if: given }] });
    expect(condition("x")).toContain('the "if" of a branch must be an object');
    expect(condition({ path: "x" })).toBe(
      "onEnter: a condition needs exactly one of is, in, above, below, exists, failed"
    );
    expect(condition({ is: 1, above: 2 })).toBe(
      "onEnter: a condition needs exactly one of is, in, above, below, exists, failed"
    );
    expect(condition({ equals: 1 })).toBe('onEnter: a condition has no "equals"');
    expect(condition({ path: 5, is: 1 })).toContain("the path of a condition must be text");
    expect(condition({ is: { a: 1 } })).toBe('onEnter: the "is" of a condition must be a text, a number or true/false');
    expect(condition({ in: [] })).toBe('onEnter: the "in" of a condition must be a list of 1 to 16 texts or numbers');
    expect(condition({ above: "3" })).toBe('onEnter: the "above" of a condition must be a number');
    expect(condition({ exists: "yes" })).toBe('onEnter: the "exists" of a condition must be true or false');
    expect(condition({ failed: false })).toBe('onEnter: the "failed" of a condition can only be true');
    expect(condition({ path: "x", failed: true })).toBe(
      'onEnter: a condition with "failed" takes no path and no value'
    );
  });
});

describe("where a conversation goes by what a tool answered", () => {
  const ok = (value: unknown) => ({ ok: true, output: typeof value === "string" ? value : JSON.stringify(value) });
  const taken = (condition: Record<string, unknown>, value: unknown) =>
    branchTaken([{ to: "there", if: condition }], ok(value));

  it("takes the first branch that applies", () => {
    const next = [
      { to: "tracking", if: { path: "status", is: "shipped" } },
      { to: "refunds", if: { path: "total", above: 100 } },
      { to: "orders" }
    ];
    expect(branchTaken(next, ok({ status: "shipped", total: 500 }))).toBe("tracking");
    expect(branchTaken(next, ok({ status: "delivered", total: 500 }))).toBe("refunds");
    expect(branchTaken(next, ok({ status: "delivered", total: 20 }))).toBe("orders");
    expect(branchTaken(next.slice(0, 2), ok({ status: "delivered", total: 20 }))).toBeUndefined();
    expect(branchTaken(undefined, ok({}))).toBeUndefined();
    // With no call there is nothing to read: only a branch without a condition is taken.
    expect(branchTaken([{ to: "sales" }])).toBe("sales");
  });

  it("compares texts without regard to case, and numbers as numbers", () => {
    expect(taken({ path: "status", is: "shipped" }, { status: " Shipped " })).toBe("there");
    expect(taken({ path: "status", is: "shipped" }, { status: "not shipped" })).toBeUndefined();
    expect(taken({ path: "count", is: 3 }, { count: "3" })).toBe("there");
    expect(taken({ path: "vip", is: true }, { vip: true })).toBe("there");
    expect(taken({ path: "vip", is: true }, { vip: false })).toBeUndefined();
    expect(taken({ path: "status", in: ["packed", "shipped"] }, { status: "PACKED" })).toBe("there");
    expect(taken({ path: "status", in: ["packed", "shipped"] }, { status: "lost" })).toBeUndefined();
    expect(taken({ path: "total", above: 100 }, { total: "250.50" })).toBe("there");
    expect(taken({ path: "total", above: 100 }, { total: 100 })).toBeUndefined();
    expect(taken({ path: "total", below: 100 }, { total: 99.9 })).toBe("there");
    // What is no number is neither above nor below one.
    expect(taken({ path: "total", below: 100 }, { total: "a lot" })).toBeUndefined();
    expect(taken({ path: "total", below: 100 }, { total: "" })).toBeUndefined();
    // Nor is what only a program would read as one.
    expect(taken({ path: "total", above: 10 }, { total: "0x20" })).toBeUndefined();
    expect(taken({ path: "total", above: 10 }, { total: "1e3" })).toBeUndefined();
    expect(taken({ path: "total", above: 10 }, { total: " 12.5 " })).toBe("there");
    expect(taken({ path: "total", below: 0 }, { total: "-3" })).toBe("there");
    expect(taken({ path: "total", below: 100 }, { total: null })).toBeUndefined();
    expect(taken({ path: "total", above: 1 }, { total: [5] })).toBeUndefined();
    // An object is not equal to a text.
    expect(taken({ path: "order", is: "[object Object]" }, { order: {} })).toBeUndefined();
  });

  it("follows a path through objects and lists, and takes a missing one as not there", () => {
    const answer = { order: { items: [{ sku: "tent" }, { sku: "stove" }], note: "" }, constructor: "x" };
    expect(taken({ path: "order.items.1.sku", is: "stove" }, answer)).toBe("there");
    expect(taken({ path: "order.items.2.sku", is: "stove" }, answer)).toBeUndefined();
    expect(taken({ path: "order.items.length", above: 0 }, answer)).toBeUndefined();
    expect(taken({ path: "order.customer", exists: false }, answer)).toBe("there");
    expect(taken({ path: "order.customer", exists: true }, answer)).toBeUndefined();
    expect(taken({ path: "order.items", exists: true }, answer)).toBe("there");
    // Empty is not there.
    expect(taken({ path: "order.note", exists: true }, answer)).toBeUndefined();
    // Only what the answer itself holds: nothing every object has.
    expect(taken({ path: "order.toString", exists: true }, answer)).toBeUndefined();
    expect(taken({ path: "__proto__", exists: true }, answer)).toBeUndefined();
    expect(taken({ path: "constructor", is: "x" }, answer)).toBe("there");
  });

  it("reads an answer that is not JSON as its text", () => {
    expect(taken({ is: "yes" }, "Yes")).toBe("there");
    expect(taken({ path: "status", is: "yes" }, "Yes")).toBeUndefined();
    expect(taken({ above: 10 }, "42")).toBe("there");
  });

  it("takes only a branch that asks for it when the call failed", () => {
    const failed = { ok: false, output: '{"error":"the order service is down","status":"shipped"}' };
    const next = [{ to: "tracking", if: { path: "status", is: "shipped" } }, { to: "orders" }];
    expect(branchTaken(next, failed)).toBeUndefined();
    expect(branchTaken([...next.slice(0, 1), { to: "human", if: { failed: true as const } }], failed)).toBe("human");
    // And a call that went well never takes it.
    expect(branchTaken([{ to: "human", if: { failed: true as const } }], ok({ status: "shipped" }))).toBeUndefined();
  });
});

describe("onEnter among the agents", () => {
  const agent = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    description: `About ${id}.`,
    instructions: `Do ${id}.`,
    ...extra
  });

  it("is kept with its agent, with the ids of the agents as they are written", () => {
    const { agents, problems } = agentStagesFrom([
      agent("Orders", {
        onEnter: { call: { tool: "find_order" }, next: [{ to: "refunds", if: { failed: true } }, "MAIN"] }
      }),
      agent("Refunds", { onEnter: { say: "I can help with a refund." } })
    ]);
    expect(problems).toEqual([]);
    expect(agents[0]!.onEnter).toEqual({
      call: { tool: "find_order", arguments: {} },
      next: [{ to: "Refunds", if: { failed: true } }, { to: "main" }]
    });
    expect(agents[1]!.onEnter).toEqual({ say: "I can help with a refund." });
  });

  it("drops an onEnter with a mistake and keeps the agent", () => {
    const { agents, problems } = agentStagesFrom([
      agent("orders", { onEnter: { say: 5 } }),
      agent("refunds", { onEnter: { next: ["nobody"] } }),
      agent("sales", { onEnter: { next: ["sales"] } }),
      agent("tracking", { tools: ["track"], onEnter: { call: { tool: "find_order" } } })
    ]);
    expect(agents.map((one) => [one.id, one.onEnter])).toEqual([
      ["orders", undefined],
      ["refunds", undefined],
      ["sales", undefined],
      ["tracking", undefined]
    ]);
    expect(problems).toEqual([
      "agent orders: onEnter: say must be text",
      "agent tracking: onEnter calls find_order, which is not one of the agent's tools",
      "agent refunds: there is no agent nobody for onEnter to move on to",
      "agent sales: onEnter cannot move on to the agent itself"
    ]);
  });

  it("is part of a flow that is read and saved", () => {
    const steps = [
      { id: "main", handoffs: ["orders"] },
      {
        id: "orders",
        description: "Orders.",
        instructions: "Help with the order.",
        onEnter: { say: "One moment.", call: { tool: "find_order", arguments: {} }, next: [{ to: "main" }] }
      }
    ];
    const checked = checkFlow(steps);
    expect(checked).toEqual({
      agents: [
        { id: "main", handoffs: [{ to: "orders" }] },
        { ...steps[1], handoffs: undefined }
      ].map((step) => JSON.parse(JSON.stringify(step)) as unknown)
    });
    expect(flowFrom((checked as { agents: unknown }).agents).steps[1]!.onEnter).toEqual(steps[1]!.onEnter);
    // A flow with a mistake in an onEnter is not saved with the onEnter left out.
    expect(checkFlow([steps[0], { ...steps[1], onEnter: { say: "Hi.", next: ["nobody"] } }])).toEqual({
      problems: ["Agent orders: there is no agent nobody for onEnter to move on to."]
    });
    expect(checkFlow([steps[0], { ...steps[1], onEnter: { shout: "Hi." } }])).toEqual({
      problems: ['Agent orders: onEnter has no "shout".']
    });
  });
});

describe("the values of a conversation's flow", () => {
  const values = (set: Record<string, string | number | boolean>) => (name: string) => set[name];

  it("reads what an agent needs to be told before a conversation is handed to it", () => {
    expect(
      collectFrom([
        { name: "order_number", description: "  The number of\n the order " },
        { name: "amount", description: "How much to refund", type: "number", required: false }
      ])
    ).toEqual({
      collect: [
        { name: "order_number", description: "The number of the order", type: "text", required: true },
        { name: "amount", description: "How much to refund", type: "number", required: false }
      ]
    });
    expect(collectFrom(undefined)).toEqual({});
    expect(collectFrom([])).toEqual({});
    const problem = (raw: unknown) => collectFrom(raw).problem;
    expect(problem("order")).toBe("collect must be a list of at most 8 values");
    expect(problem(Array.from({ length: 9 }, (_, n) => ({ name: `v${n}`, description: "x" })))).toBe(
      "collect must be a list of at most 8 values"
    );
    expect(problem([{ name: "Order Number", description: "x" }])).toBe(
      "collect: a value's name is lower-case letters, digits and _, starting with a letter"
    );
    expect(
      problem([
        { name: "a", description: "x" },
        { name: "a", description: "y" }
      ])
    ).toBe("collect: a is there twice");
    expect(problem([{ name: "a" }])).toContain("collect: a needs a description");
    expect(problem([{ name: "a", description: "x", type: "date" }])).toBe(
      "collect: the type of a is text, number or boolean"
    );
    expect(problem([{ name: "a", description: "x", required: "no" }])).toBe("collect: required of a is true or false");
    expect(problem([{ name: "a", description: "x", ask: "y" }])).toBe('collect: a value has no "ask"');
  });

  it("takes what the model gave as the type the value has, or not at all", () => {
    expect(collected("  A-1042 \n", "text")).toBe("A-1042");
    expect(collected(1042, "text")).toBe("1042");
    expect(collected("", "text")).toBeUndefined();
    expect(collected({ number: 1 }, "text")).toBeUndefined();
    expect(collected("x".repeat(500), "text")).toHaveLength(200);
    expect(collected("40.5", "number")).toBe(40.5);
    expect(collected(40, "number")).toBe(40);
    expect(collected("forty", "number")).toBeUndefined();
    expect(collected(Number.NaN, "number")).toBeUndefined();
    expect(collected("Yes", "boolean")).toBe(true);
    expect(collected(false, "boolean")).toBe(false);
    expect(collected("maybe", "boolean")).toBeUndefined();
  });

  it("reads save, and a condition on a value", () => {
    const read = agentEntryFrom({
      call: { tool: "find_order", arguments: { number: "{{order_number}}" } },
      save: { status: "order.status", total: " order.total " },
      next: [{ to: "sales", if: { value: "plan", is: "business" } }]
    });
    expect(read.entry).toEqual({
      call: { tool: "find_order", arguments: { number: "{{order_number}}" } },
      save: { status: "order.status", total: "order.total" },
      next: [{ to: "sales", if: { value: "plan", is: "business" } }]
    });
    // A condition on a value reads no tool's answer, and so needs no call.
    expect(agentEntryFrom({ next: [{ to: "sales", if: { value: "plan", is: "business" } }] }).problem).toBeUndefined();
    const problem = (raw: unknown) => agentEntryFrom(raw).problem;
    expect(problem({ save: { status: "status" } })).toBe(
      "onEnter: save keeps parts of a tool's answer, so it needs a call"
    );
    expect(problem({ call: { tool: "t" }, save: { Status: "status" } })).toContain('"Status" is not');
    expect(problem({ call: { tool: "t" }, save: { status: "" } })).toContain("status needs a path");
    expect(problem({ call: { tool: "t" }, save: ["status"] })).toContain("save must be an object");
    expect(problem({ call: { tool: "t" }, next: [{ to: "a", if: { path: "x", value: "y", is: 1 } }] })).toContain(
      "not both"
    );
    expect(problem({ next: [{ to: "a", if: { value: "Not A Name", is: 1 } }] })).toContain(
      "the value of a condition must be the name of a value"
    );
  });

  it("says which values an onEnter reads and which it sets", () => {
    const { entry } = agentEntryFrom({
      say: "Looking up order {{order_number}} for {{ user.id }}.",
      call: { tool: "t", arguments: { a: "{{order_number}}", deep: [{ b: "x {{plan}} y" }], n: 3 } },
      save: { status: "status" },
      next: [{ to: "a", if: { value: "channel", is: "phone" } }]
    });
    expect(entryValues(entry!)).toEqual({
      reads: ["order_number", "user.id", "plan", "channel"],
      sets: ["status"]
    });
  });

  it("fills a sentence, and says what it had no value for", () => {
    const known = values({ order_number: "A-1042", total: 40 });
    expect(filled("Order {{order_number}} is {{ total }} euros.", known)).toEqual({
      text: "Order A-1042 is 40 euros.",
      missing: []
    });
    expect(filled("Order {{order_number}} for {{name}}.", known)).toEqual({
      text: "Order A-1042 for .",
      missing: ["name"]
    });
    // What is no placeholder stays as it was written.
    expect(filled("Use {{ Curly Braces }} and {single}.", known).text).toBe("Use {{ Curly Braces }} and {single}.");
  });

  it("fills arguments, a value alone as the value it is", () => {
    const known = values({ order_number: "A-1042", total: 40, vip: true });
    expect(
      filledArguments(
        {
          number: "{{order_number}}",
          amount: " {{total}} ",
          vip: "{{vip}}",
          note: "Refund of {{total}}",
          list: ["{{total}}"],
          fixed: 7
        },
        known
      )
    ).toEqual({
      arguments: { number: "A-1042", amount: 40, vip: true, note: "Refund of 40", list: [40], fixed: 7 },
      missing: []
    });
    expect(filledArguments({ a: "{{nobody}}", b: "x {{nobody}} {{nothing}}" }, known).missing).toEqual([
      "nobody",
      "nothing"
    ]);
  });

  it("keeps the plain parts of a tool's answer that save names", () => {
    const answer = JSON.stringify({ order: { status: " shipped ", total: 40, items: [1, 2] }, vip: false, note: "" });
    expect(
      savedFrom(
        { status: "order.status", total: "order.total", vip: "vip", items: "order.items", note: "note", gone: "x.y" },
        answer
      )
    ).toEqual({ status: "shipped", total: 40, vip: false });
    expect(savedFrom({ status: "status" }, "not json")).toEqual({});
    expect(savedFrom(undefined, answer)).toEqual({});
  });

  it("moves on by a value of the conversation, with or without a call", () => {
    const known = values({ plan: "Business", seats: "12" });
    expect(
      branchTaken([{ to: "sales", if: { value: "plan", is: "business" } }, { to: "main" }], undefined, known)
    ).toBe("sales");
    expect(branchTaken([{ to: "sales", if: { value: "seats", above: 10 } }], undefined, known)).toBe("sales");
    expect(
      branchTaken([{ to: "sales", if: { value: "nothing", exists: true } }, { to: "main" }], undefined, known)
    ).toBe("main");
    expect(branchTaken([{ to: "sales", if: { value: "nothing", exists: false } }], undefined, known)).toBe("sales");
    // Beside a branch on the tool's answer.
    expect(
      branchTaken(
        [
          { to: "refunds", if: { path: "status", is: "delivered" } },
          { to: "sales", if: { value: "plan", is: "business" } }
        ],
        { ok: true, output: '{"status":"shipped"}' },
        known
      )
    ).toBe("sales");
    // A call that failed takes only a branch that asks for that.
    expect(
      branchTaken([{ to: "sales", if: { value: "plan", is: "business" } }], { ok: false, output: "{}" }, known)
    ).toBeUndefined();
  });

  it("is refused a value nobody sets, and a collect on the agent a conversation starts with", () => {
    const read = agentStagesFrom([
      { id: "main", instructions: "Start.", collect: [{ name: "x", description: "y" }] },
      {
        id: "orders",
        description: "Orders.",
        instructions: "Help.",
        collect: [{ name: "order_number", description: "The order's number" }],
        onEnter: {
          call: { tool: "find_order", arguments: { n: "{{order_number}}", u: "{{user.id}}" } },
          save: { status: "status" }
        }
      },
      {
        id: "tracking",
        description: "Tracking.",
        instructions: "Help.",
        onEnter: { say: "Your order is {{status}}." }
      },
      { id: "refunds", description: "Refunds.", instructions: "Help.", onEnter: { say: "Refunding {{amuont}}." } }
    ]);
    expect(read.problems).toEqual([
      "agent main: collect is asked for at a handover, and a conversation starts with main",
      "agent refunds: onEnter reads {{amuont}}, which no agent collects or saves. The relay's own values are user.id, session.id, channel"
    ]);
    const by = Object.fromEntries(read.agents.map((agent) => [agent.id, agent]));
    expect(by.main!.collect).toBeUndefined();
    expect(by.orders!.collect).toHaveLength(1);
    expect(by.orders!.onEnter).toBeDefined();
    expect(by.tracking!.onEnter).toBeDefined();
    expect(by.refunds!.onEnter).toBeUndefined();
  });

  it("is part of a flow that is drawn and saved", () => {
    const steps = [
      { id: "main", instructions: "Start." },
      {
        id: "orders",
        description: "Orders.",
        instructions: "Help.",
        collect: [{ name: "order_number", description: "The order's number", type: "text", required: true }],
        onEnter: {
          call: { tool: "find_order", arguments: { n: "{{order_number}}" } },
          save: { status: "status" },
          next: [{ to: "main", if: { value: "status", is: "lost" } }]
        }
      }
    ];
    const checked = checkFlow(steps);
    expect("agents" in checked && checked.agents).toEqual(steps);
    expect(flowFrom(steps).steps).toEqual(steps);
    const refused = checkFlow([steps[0], { ...steps[1], collect: [{ name: "Bad Name", description: "x" }] }]);
    expect("problems" in refused && refused.problems.join(" ")).toContain("a value's name is lower-case");
  });
});
