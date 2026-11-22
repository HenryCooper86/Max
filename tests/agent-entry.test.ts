import { describe, expect, it } from "vitest";
import { agentEntryFrom, branchTaken } from "../server/agent-entry";
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
      "onEnter: a branch with a condition needs a call whose answer it reads"
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
    expect(condition({ path: "x", failed: true })).toBe('onEnter: a condition with "failed" takes no path');
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
