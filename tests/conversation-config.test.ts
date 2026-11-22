import { describe, expect, it } from "vitest";
import {
  agentRoster,
  agentStagesFrom,
  conversationSettingsFrom,
  DEFAULT_CONVERSATION_SETTINGS,
  MAIN_AGENT,
  type AgentStage
} from "../server/conversation-config";

describe("conversationSettingsFrom", () => {
  it("gives defaults when absent", () => {
    for (const raw of [undefined, null]) {
      const { settings, problems } = conversationSettingsFrom(raw);
      expect(settings).toEqual(DEFAULT_CONVERSATION_SETTINGS);
      expect(problems).toEqual([]);
    }
    expect(DEFAULT_CONVERSATION_SETTINGS).toMatchObject({ maxIdleReminders: 2, endSession: false });
  });

  it("gives a problem for a non-object", () => {
    for (const raw of ["x", 5, true, ["a"]]) {
      const result = conversationSettingsFrom(raw);
      expect(result.problems).toEqual(["conversation must be an object"]);
      expect(result.settings).toEqual(DEFAULT_CONVERSATION_SETTINGS);
    }
  });

  it("clamps idleReminderSeconds to 5..300 and maxDurationSeconds to 30..14400", () => {
    const low = conversationSettingsFrom({ idleReminderSeconds: 1, maxDurationSeconds: 1 }).settings;
    expect(low.idleReminderSeconds).toBe(5);
    expect(low.maxDurationSeconds).toBe(30);
    const high = conversationSettingsFrom({ idleReminderSeconds: 9999, maxDurationSeconds: 99999 }).settings;
    expect(high.idleReminderSeconds).toBe(300);
    expect(high.maxDurationSeconds).toBe(14_400);
    const mid = conversationSettingsFrom({ idleReminderSeconds: 12.4, maxDurationSeconds: 900 }).settings;
    expect(mid.idleReminderSeconds).toBe(12);
    expect(mid.maxDurationSeconds).toBe(900);
  });

  it("leaves the timers off when absent, null or false, and reports unusable values", () => {
    for (const value of [undefined, null, false]) {
      const result = conversationSettingsFrom({ idleReminderSeconds: value, maxDurationSeconds: value });
      expect(result.settings).not.toHaveProperty("idleReminderSeconds");
      expect(result.settings).not.toHaveProperty("maxDurationSeconds");
      expect(result.problems).toEqual([]);
    }
    const bad = conversationSettingsFrom({ idleReminderSeconds: "soon", maxDurationSeconds: -3 });
    expect(bad.settings).not.toHaveProperty("idleReminderSeconds");
    expect(bad.problems).toEqual([
      "conversation.idleReminderSeconds must be a number of seconds",
      "conversation.maxDurationSeconds must be a number of seconds"
    ]);
  });

  it("turns a string reminder into a one-item list", () => {
    expect(conversationSettingsFrom({ idleReminders: "  Are you there?  " }).settings.idleReminders).toEqual([
      "Are you there?"
    ]);
  });

  it("keeps at most 5 reminders of at most 200 characters and drops blanks and non-strings", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"];
    expect(conversationSettingsFrom({ idleReminders: many }).settings.idleReminders).toEqual(["a", "b", "c", "d", "e"]);
    const long = conversationSettingsFrom({ idleReminders: ["x".repeat(500)] }).settings.idleReminders;
    expect(long[0]).toHaveLength(200);
    expect(conversationSettingsFrom({ idleReminders: ["", "  ", 4, "ok"] }).settings.idleReminders).toEqual(["ok"]);
  });

  it("reports reminders that are neither a string nor a list", () => {
    const result = conversationSettingsFrom({ idleReminders: 7 });
    expect(result.problems).toEqual(["conversation.idleReminders must be a list of lines"]);
    expect(result.settings.idleReminders).toEqual([]);
  });

  it("limits maxIdleReminders to 0..10 and reports non-integers", () => {
    expect(conversationSettingsFrom({ maxIdleReminders: 0 }).settings.maxIdleReminders).toBe(0);
    expect(conversationSettingsFrom({ maxIdleReminders: 4 }).settings.maxIdleReminders).toBe(4);
    expect(conversationSettingsFrom({ maxIdleReminders: 50 }).settings.maxIdleReminders).toBe(10);
    expect(conversationSettingsFrom({ maxIdleReminders: -3 }).settings.maxIdleReminders).toBe(0);
    for (const value of [1.5, "2", null, NaN]) {
      const result = conversationSettingsFrom({ maxIdleReminders: value });
      expect(result.problems).toEqual(["conversation.maxIdleReminders must be a whole number"]);
      expect(result.settings.maxIdleReminders).toBe(2);
    }
  });

  it("enables endSession only for exactly true", () => {
    expect(conversationSettingsFrom({ endSession: true }).settings.endSession).toBe(true);
    for (const value of ["true", 1, "yes", false, undefined, null]) {
      expect(conversationSettingsFrom({ endSession: value }).settings.endSession).toBe(false);
    }
  });

  it("trims and caps the farewell", () => {
    expect(conversationSettingsFrom({ farewell: "  Bye!  " }).settings.farewell).toBe("Bye!");
    expect(conversationSettingsFrom({ farewell: "y".repeat(500) }).settings.farewell).toHaveLength(300);
    expect(conversationSettingsFrom({ farewell: "   " }).settings).not.toHaveProperty("farewell");
  });
});

describe("agentStagesFrom", () => {
  const billing = { id: "billing", description: "Invoices and refunds.", instructions: "You handle billing." };

  it("returns nothing for absent input and a problem for a non-array", () => {
    expect(agentStagesFrom(undefined)).toEqual({ agents: [], problems: [] });
    expect(agentStagesFrom(null)).toEqual({ agents: [], problems: [] });
    expect(agentStagesFrom({ id: "x" })).toEqual({ agents: [], problems: ["agents must be a list"] });
    expect(agentStagesFrom("billing").problems).toEqual(["agents must be a list"]);
  });

  it("accepts a valid list and trims fields", () => {
    const { agents, problems } = agentStagesFrom([
      { id: " main ", instructions: "Front desk." },
      { ...billing, description: "  Invoices.  ", tools: [" get_invoice ", "get_invoice", "refund"] }
    ]);
    expect(problems).toEqual([]);
    expect(agents).toEqual([
      {
        id: "main",
        description: "The agent every conversation starts with; handles everything else.",
        instructions: "Front desk."
      },
      { id: "billing", description: "Invoices.", instructions: "You handle billing.", tools: ["get_invoice", "refund"] }
    ]);
  });

  it("reads which agents an agent may hand over to, and when", () => {
    const refunds = { id: "Refunds", description: "Money back.", instructions: "You refund." };
    const { agents, problems } = agentStagesFrom([
      { id: "main", handoffs: ["billing"] },
      { ...billing, handoffs: [{ to: "refunds", when: "  The user wants money back.  " }, { to: "MAIN" }] },
      { ...refunds, handoffs: [] }
    ]);
    expect(problems).toEqual([]);
    expect(agents.map((agent) => agent.handoffs)).toEqual([
      [{ to: "billing" }],
      // Written as the target writes its own id, whatever the case here.
      [{ to: "Refunds", when: "The user wants money back." }, { to: "main" }],
      []
    ]);
    // Absent, and null, both leave every agent open.
    expect(agentStagesFrom([billing]).agents[0]).not.toHaveProperty("handoffs");
    expect(agentStagesFrom([{ ...billing, handoffs: null }]).agents[0]).not.toHaveProperty("handoffs");
    // main is there to hand over to without being listed.
    expect(agentStagesFrom([{ ...billing, handoffs: ["main"] }])).toMatchObject({
      agents: [{ handoffs: [{ to: "main" }] }],
      problems: []
    });
  });

  it("drops a handoff that leads nowhere, and says so", () => {
    const { agents, problems } = agentStagesFrom([
      { ...billing, handoffs: ["legal", "billing", { to: "sales" }, "sales", {}, 5, { to: "sales", when: 7 }] },
      { id: "sales", description: "Buying.", instructions: "You sell." }
    ]);
    expect(agents[0]!.handoffs).toEqual([{ to: "sales" }]);
    expect(problems).toEqual([
      'agent billing: every handoff needs the id of an agent, as "billing" or { "to": "billing" }',
      'agent billing: every handoff needs the id of an agent, as "billing" or { "to": "billing" }',
      "agent billing: there is no agent legal to hand over to",
      "agent billing cannot hand over to itself",
      "agent billing lists the handoff to sales twice; the first is used",
      "agent billing lists the handoff to sales twice; the first is used"
    ]);
    // Not a list at all: the agent is skipped, like one with a bad tool list.
    expect(agentStagesFrom([{ ...billing, handoffs: "sales" }])).toEqual({
      agents: [],
      problems: ["agent billing: handoffs must be a list"]
    });
  });

  it("skips an invalid id", () => {
    for (const id of ["1abc", "has space", "", "x".repeat(33), 5, undefined]) {
      const { agents, problems } = agentStagesFrom([
        { ...billing, id },
        { ...billing, id: "ok" }
      ]);
      expect(agents.map((agent) => agent.id)).toEqual(["ok"]);
      expect(problems[0]).toMatch(/^invalid agent id/);
    }
  });

  it("skips entries that are not objects", () => {
    const { agents, problems } = agentStagesFrom(["billing", null, [], billing]);
    expect(agents.map((agent) => agent.id)).toEqual(["billing"]);
    expect(problems.filter((problem) => problem === "every agent must be an object")).toHaveLength(3);
  });

  it("keeps the first of two ids that differ only by case", () => {
    const { agents, problems } = agentStagesFrom([billing, { ...billing, id: "BILLING", instructions: "other" }]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.instructions).toBe("You handle billing.");
    expect(problems).toEqual(["agent BILLING is defined twice; the first definition is used"]);
  });

  it("needs instructions and a description from a non-main agent", () => {
    const noInstructions = agentStagesFrom([{ id: "a", description: "d" }, billing]);
    expect(noInstructions.problems).toEqual(["agent a needs instructions"]);
    expect(noInstructions.agents.map((agent) => agent.id)).toEqual(["billing"]);
    const noDescription = agentStagesFrom([{ id: "a", instructions: "i" }, billing]);
    expect(noDescription.problems[0]).toMatch(/^agent a needs a description/);
    expect(noDescription.agents.map((agent) => agent.id)).toEqual(["billing"]);
    expect(agentStagesFrom([{ id: "a", instructions: "  ", description: "d" }, billing]).problems[0]).toMatch(
      /needs instructions/
    );
  });

  it("lets main omit both, and normalises its case", () => {
    const { agents, problems } = agentStagesFrom([{ id: "MAIN" }, billing]);
    expect(problems).toEqual([]);
    expect(agents[0]).toMatchObject({ id: "main", instructions: "" });
    expect(agents[0]!.description).not.toBe("");
  });

  it("rejects bad tools lists", () => {
    for (const tools of ["x", [1], [""], ["a", "  "], {}]) {
      const { agents, problems } = agentStagesFrom([
        { ...billing, tools },
        { ...billing, id: "ok" }
      ]);
      expect(agents.map((agent) => agent.id)).toEqual(["ok"]);
      expect(problems).toEqual(["agent billing: tools must be a list of tool names"]);
    }
  });

  it("accepts an empty tools list and caps tools at 64", () => {
    expect(agentStagesFrom([{ ...billing, tools: [] }]).agents[0]!.tools).toEqual([]);
    const tools = Array.from({ length: 80 }, (_, index) => `t${index}`);
    expect(agentStagesFrom([{ ...billing, tools }]).agents[0]!.tools).toHaveLength(64);
  });

  it("uses only the first 12 agents and says so", () => {
    const list = Array.from({ length: 14 }, (_, index) => ({ ...billing, id: `agent${index}` }));
    const { agents, problems } = agentStagesFrom(list);
    expect(agents).toHaveLength(12);
    expect(agents[11]!.id).toBe("agent11");
    expect(problems).toEqual(["only the first 12 agents are used"]);
  });

  it("yields no agents and a problem when only main is defined", () => {
    const result = agentStagesFrom([{ id: "main", instructions: "Hi" }]);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual(["agents needs at least one agent besides main"]);
  });

  it("gives no problem for an empty list", () => {
    expect(agentStagesFrom([])).toEqual({ agents: [], problems: [] });
  });
});

describe("agentRoster", () => {
  const stage = (id: string): AgentStage => ({ id, description: `${id} d`, instructions: `${id} i` });

  it("is empty for no agents", () => {
    expect(agentRoster([])).toEqual([]);
  });

  it("puts main first", () => {
    const roster = agentRoster([stage("billing"), stage(MAIN_AGENT), stage("sales")]);
    expect(roster.map((agent) => agent.id)).toEqual(["main", "billing", "sales"]);
    expect(roster[0]).toEqual(stage("main"));
  });

  it("synthesises main when absent", () => {
    const roster = agentRoster([stage("billing")]);
    expect(roster.map((agent) => agent.id)).toEqual(["main", "billing"]);
    expect(roster[0]).toMatchObject({ id: "main", instructions: "" });
    expect(roster[0]!.description).not.toBe("");
  });
});
