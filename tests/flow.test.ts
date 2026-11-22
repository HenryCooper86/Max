import { describe, expect, it } from "vitest";
import { agentStagesFrom } from "../server/conversation-config";
import { checkFlow, flowFrom } from "../server/flow";

const billing = { id: "billing", description: "Invoices.", instructions: "Find the invoice first." };
const refunds = { id: "refunds", description: "Money back.", instructions: "Refund politely." };

describe("flowFrom", () => {
  it("shows the start alone when there are no agents", () => {
    expect(flowFrom(undefined)).toEqual({ steps: [{ id: "main" }], problems: [] });
    expect(flowFrom([])).toEqual({ steps: [{ id: "main" }], problems: [] });
  });

  it("puts the starting step first, listed or not, and keeps where each step sits", () => {
    const { steps, problems } = flowFrom([
      {
        ...billing,
        tools: ["get_invoice"],
        handoffs: [{ to: "refunds", when: "They want money back." }],
        at: [320.4, 40]
      },
      { ...refunds, handoffs: [], at: [640, -5] },
      { id: "main", instructions: "Greet.", handoffs: ["billing"], at: [0, 99999] }
    ]);
    expect(problems).toEqual([]);
    expect(steps).toEqual([
      { id: "main", instructions: "Greet.", handoffs: [{ to: "billing" }], at: [0, 4000] },
      {
        id: "billing",
        description: "Invoices.",
        instructions: "Find the invoice first.",
        tools: ["get_invoice"],
        handoffs: [{ to: "refunds", when: "They want money back." }],
        at: [320, 40]
      },
      { id: "refunds", description: "Money back.", instructions: "Refund politely.", handoffs: [], at: [640, 0] }
    ]);
    expect(flowFrom([billing]).steps.map((step) => step.id)).toEqual(["main", "billing"]);
  });

  it("leaves out what the relay skips, and says what", () => {
    const { steps, problems } = flowFrom([billing, { id: "sales" }, { ...refunds, at: "left" }]);
    expect(steps.map((step) => step.id)).toEqual(["main", "billing", "refunds"]);
    expect(steps[2]).not.toHaveProperty("at");
    expect(problems).toEqual(["agent sales needs instructions"]);
  });
});

describe("checkFlow", () => {
  it("accepts a flow and returns the agents key to store, which the relay reads the same", () => {
    const drawn = [
      { id: "main", handoffs: [{ to: "billing", when: "An invoice or a payment." }], at: [40, 40] },
      { ...billing, tools: ["get_invoice"], handoffs: [{ to: "refunds" }, { to: "main" }], at: [360, 40] },
      { ...refunds, tools: [], handoffs: [], at: [680, 40] }
    ];
    const checked = checkFlow(drawn);
    expect(checked).toEqual({ agents: drawn });
    const { agents, problems } = agentStagesFrom((checked as { agents: unknown }).agents);
    expect(problems).toEqual([]);
    expect(agents.map((agent) => [agent.id, agent.handoffs?.map((handoff) => handoff.to)])).toEqual([
      ["main", ["billing"]],
      ["billing", ["refunds", "main"]],
      ["refunds", []]
    ]);
  });

  it("stores the starting step only when something is written in it", () => {
    expect(checkFlow([{ id: "main" }, billing])).toEqual({ agents: [billing] });
    expect(checkFlow([{ id: "main", at: [10, 10] }, billing])).toEqual({
      agents: [{ id: "main", at: [10, 10] }, billing]
    });
  });

  it("takes a flow with no step but an empty start as no flow at all", () => {
    expect(checkFlow([])).toEqual({ agents: undefined });
    expect(checkFlow([{ id: "main" }])).toEqual({ agents: undefined });
    expect(checkFlow([{ id: "main", at: [0, 0] }])).toEqual({ agents: undefined });
    // Something written in the start would be lost: that is said, not done.
    expect(checkFlow([{ id: "main", instructions: "Greet." }])).toEqual({
      problems: ["Agents needs at least one agent besides main."]
    });
  });

  it("refuses a flow with any part the relay would skip or shorten", () => {
    const problems = (raw: unknown) => (checkFlow(raw) as { problems: string[] }).problems;
    expect(problems("billing")).toEqual(["The flow must be a list of steps."]);
    expect(problems(Array.from({ length: 13 }, (_, index) => ({ ...billing, id: `s${index}` })))).toEqual([
      "A flow has at most 12 steps."
    ]);
    expect(problems([{ ...billing, instructions: "" }])).toEqual(["Agent billing needs instructions."]);
    expect(problems([billing, { ...billing }])).toEqual([
      "Agent billing is defined twice; the first definition is used."
    ]);
    expect(problems([{ ...billing, handoffs: ["legal"] }])).toEqual([
      "Agent billing: there is no agent legal to hand over to."
    ]);
    expect(problems([{ ...billing, instructions: "x".repeat(8001) }])).toEqual([
      "billing: instructions can be at most 8000 characters"
    ]);
    expect(problems([{ ...billing, description: "x".repeat(401) }])).toEqual([
      "billing: description can be at most 400 characters"
    ]);
    expect(problems([{ ...billing, handoffs: [{ to: "main", when: "x".repeat(301) }] }])).toEqual([
      "billing: the condition of a handoff can be at most 300 characters"
    ]);
    expect(problems([{ ...billing, at: [1] }])).toEqual(["billing: its place on the canvas must be two numbers"]);
    expect(problems([{ ...billing, tools: Array.from({ length: 65 }, (_, index) => `t${index}`) }])).toEqual([
      "billing: at most 64 tools"
    ]);
    expect(problems([billing, 5])).toEqual(["Every agent must be an object."]);
  });
});
