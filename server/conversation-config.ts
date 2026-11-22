import {
  SESSION_VALUES,
  agentEntryFrom,
  collectFrom,
  entryValues,
  type AgentEntry,
  type CollectedValue
} from "./agent-entry";

/**
 * How a conversation is run, beyond what the assistant says: when the relay
 * checks that a silent user is still there, when it ends a conversation, and
 * which specialist agents the assistant can hand the conversation to.
 *
 * Both keys live in `assistant.config.json`:
 *
 * ```json
 * {
 *   "conversation": {
 *     "idleReminderSeconds": 12,
 *     "maxIdleReminders": 2,
 *     "maxDurationSeconds": 900,
 *     "endSession": true
 *   },
 *   "agents": [
 *     { "id": "billing", "description": "Invoices and refunds.", "instructions": "…", "tools": ["get_invoice"] }
 *   ]
 * }
 * ```
 */

export type ConversationSettings = {
  /** Seconds of silence after the assistant finished speaking before it checks in. Off when absent. */
  idleReminderSeconds?: number;
  /** What the check-in says, in order; the last one repeats. Defaults to a line in the session's language. */
  idleReminders: string[];
  /** Check-ins that may go unanswered before the relay ends the conversation. */
  maxIdleReminders: number;
  /** The longest a conversation may run. Off when absent. */
  maxDurationSeconds?: number;
  /** Spoken when the relay ends the conversation itself (silence or the time limit). */
  farewell?: string;
  /** Gives the model an `end_session` tool, so it can end a finished conversation. */
  endSession: boolean;
  /** Keeps what a user said between conversations, for users named by a session token. */
  rememberUsers: boolean;
  /** Fold what leaves a user's window of remembered turns into a summary a chat model writes. */
  memorySummary: boolean;
};

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  idleReminders: [],
  maxIdleReminders: 2,
  endSession: false,
  rememberUsers: false,
  memorySummary: false
};

/** One specialist the conversation can be handed to. */
export type AgentStage = {
  /** Letters, digits, `_` and `-`. `main` names the agent every conversation starts with. */
  id: string;
  /** When to hand over to this agent. The other agents read it. */
  description: string;
  /** This agent's instructions, added to the assistant's own. */
  instructions: string;
  /** Names of the tools this agent may use. Absent: every tool. */
  tools?: string[];
  /**
   * The agents this one may hand over to, each with when to. Absent: any
   * agent, on its description alone. Empty: none, the conversation stays here.
   */
  handoffs?: AgentHandoff[];
  /** What the assistant has to find out from the user before it hands the conversation to this agent. */
  collect?: CollectedValue[];
  /** What the relay does itself when the conversation is handed to this agent. */
  onEnter?: AgentEntry;
};

/** How the loader says that an agent's every handoff was dropped: a consequence of loading on regardless. */
export const NO_HANDOFF_LEFT = "none of its handoffs can be used";

type AgentHandoff = {
  /** The id of the agent to hand over to, as that agent writes it. */
  to: string;
  /** When to hand over, for the model to read. Absent: the target's description says when. */
  when?: string;
};

/** The id of the agent a conversation starts with. */
export const MAIN_AGENT = "main";

const AGENT_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const MAX_AGENTS = 12;
const MAX_AGENT_TOOLS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedSeconds(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function line(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

/** Parses the `conversation` key. Anything unusable falls back to its default,
 *  with a problem to show whoever is setting the relay up. */
export function conversationSettingsFrom(raw: unknown): { settings: ConversationSettings; problems: string[] } {
  if (raw === undefined || raw === null) return { settings: DEFAULT_CONVERSATION_SETTINGS, problems: [] };
  if (!isRecord(raw)) {
    return { settings: DEFAULT_CONVERSATION_SETTINGS, problems: ["conversation must be an object"] };
  }
  const problems: string[] = [];
  const numeric = (key: string, min: number, max: number): number | undefined => {
    if (raw[key] === undefined || raw[key] === null || raw[key] === false) return undefined;
    const value = boundedSeconds(raw[key], min, max);
    if (value === undefined) problems.push(`conversation.${key} must be a number of seconds`);
    return value;
  };
  const idleReminderSeconds = numeric("idleReminderSeconds", 5, 300);
  const maxDurationSeconds = numeric("maxDurationSeconds", 30, 14_400);
  let idleReminders: string[] = [];
  if (typeof raw.idleReminders === "string") idleReminders = [raw.idleReminders];
  else if (Array.isArray(raw.idleReminders)) idleReminders = raw.idleReminders as string[];
  else if (raw.idleReminders !== undefined) problems.push("conversation.idleReminders must be a list of lines");
  const reminders = idleReminders
    .map((item) => line(item, 200))
    .filter((item): item is string => item !== undefined)
    .slice(0, 5);
  let maxIdleReminders = DEFAULT_CONVERSATION_SETTINGS.maxIdleReminders;
  if (raw.maxIdleReminders !== undefined) {
    if (typeof raw.maxIdleReminders === "number" && Number.isInteger(raw.maxIdleReminders)) {
      maxIdleReminders = Math.min(10, Math.max(0, raw.maxIdleReminders));
    } else problems.push("conversation.maxIdleReminders must be a whole number");
  }
  const farewell = line(raw.farewell, 300);
  return {
    settings: {
      ...(idleReminderSeconds !== undefined ? { idleReminderSeconds } : {}),
      idleReminders: reminders,
      maxIdleReminders,
      ...(maxDurationSeconds !== undefined ? { maxDurationSeconds } : {}),
      ...(farewell ? { farewell } : {}),
      endSession: raw.endSession === true,
      rememberUsers: raw.rememberUsers === true,
      memorySummary: raw.memorySummary === true
    },
    problems
  };
}

/** Parses the `agents` key. A bad entry is skipped with a problem; the rest still load. */
export function agentStagesFrom(raw: unknown): { agents: AgentStage[]; problems: string[] } {
  if (raw === undefined || raw === null) return { agents: [], problems: [] };
  if (!Array.isArray(raw)) return { agents: [], problems: ["agents must be a list"] };
  const agents: AgentStage[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_AGENTS)) {
    if (!isRecord(entry)) {
      problems.push("every agent must be an object");
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!AGENT_ID.test(id)) {
      problems.push(`invalid agent id ${JSON.stringify(entry.id ?? "")}`);
      continue;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) {
      problems.push(`agent ${id} is defined twice; the first definition is used`);
      continue;
    }
    const instructions = line(entry.instructions, 8000);
    const description = line(entry.description, 400);
    // The starting agent needs no description: nothing hands over to it blind.
    if (!instructions && key !== MAIN_AGENT) {
      problems.push(`agent ${id} needs instructions`);
      continue;
    }
    if (!description && key !== MAIN_AGENT) {
      problems.push(`agent ${id} needs a description, so the other agents know when to hand over to it`);
      continue;
    }
    let tools: string[] | undefined;
    if (entry.tools !== undefined) {
      if (!Array.isArray(entry.tools) || entry.tools.some((name) => typeof name !== "string" || !name.trim())) {
        problems.push(`agent ${id}: tools must be a list of tool names`);
        continue;
      }
      tools = [...new Set((entry.tools as string[]).map((name) => name.trim()))].slice(0, MAX_AGENT_TOOLS);
    }
    let handoffs: AgentHandoff[] | undefined;
    if (entry.handoffs !== undefined && entry.handoffs !== null) {
      if (!Array.isArray(entry.handoffs)) {
        problems.push(`agent ${id}: handoffs must be a list`);
        continue;
      }
      handoffs = [];
      // No agent has more targets than there are agents; what is beyond that is a mistake, not a flow.
      if (entry.handoffs.length > MAX_AGENTS * 2) {
        problems.push(`agent ${id}: only its first ${MAX_AGENTS * 2} handoffs are read`);
      }
      for (const item of entry.handoffs.slice(0, MAX_AGENTS * 2)) {
        const to = (
          typeof item === "string" ? item.trim() : isRecord(item) && typeof item.to === "string" ? item.to.trim() : ""
        ).slice(0, 64);
        const when = isRecord(item) ? line(item.when, 300) : undefined;
        // Which agents there are is known only once every entry is read: the targets are checked below.
        if (to) handoffs.push({ to, ...(when ? { when } : {}) });
        else problems.push(`agent ${id}: every handoff needs the id of an agent, as "billing" or { "to": "billing" }`);
      }
    }
    // A mistake here costs the agent what it does on arriving, not the agent.
    const entered = agentEntryFrom(entry.onEnter);
    if (entered.problem) problems.push(`agent ${id}: ${entered.problem}`);
    // The relay calls the tool as this agent, which may use only the tools on its list.
    if (entered.entry?.call && tools && !tools.includes(entered.entry.call.tool)) {
      problems.push(`agent ${id}: onEnter calls ${entered.entry.call.tool}, which is not one of the agent's tools`);
      delete entered.entry;
    }
    // A mistake here costs the agent what it asks for first, not the agent.
    const asked = collectFrom(entry.collect);
    if (asked.problem) problems.push(`agent ${id}: ${asked.problem}`);
    // Nobody hands a conversation to the agent it starts with: there is no handover to ask at.
    if (asked.collect && key === MAIN_AGENT) {
      problems.push("agent main: collect is asked for at a handover, and a conversation starts with main");
      delete asked.collect;
    }
    seen.add(key);
    agents.push({
      id: key === MAIN_AGENT ? MAIN_AGENT : id,
      description: description ?? "The agent every conversation starts with; handles everything else.",
      instructions: instructions ?? "",
      ...(tools ? { tools } : {}),
      ...(handoffs ? { handoffs } : {}),
      ...(asked.collect ? { collect: asked.collect } : {}),
      ...(entered.entry ? { onEnter: entered.entry } : {})
    });
  }
  if (raw.length > MAX_AGENTS) problems.push(`only the first ${MAX_AGENTS} agents are used`);
  // A handoff leads to an agent there is, not to the agent itself, and to each agent once.
  const ids = new Map([
    [MAIN_AGENT, MAIN_AGENT],
    ...agents.map((agent) => [agent.id.toLowerCase(), agent.id] as const)
  ]);
  for (const agent of agents) {
    if (!agent.handoffs) continue;
    const kept: AgentHandoff[] = [];
    for (const handoff of agent.handoffs) {
      const target = ids.get(handoff.to.toLowerCase());
      if (!target) problems.push(`agent ${agent.id}: there is no agent ${handoff.to} to hand over to`);
      else if (target === agent.id) problems.push(`agent ${agent.id} cannot hand over to itself`);
      else if (kept.some((other) => other.to === target)) {
        problems.push(`agent ${agent.id} lists the handoff to ${target} twice; the first is used`);
      } else kept.push({ ...handoff, to: target });
    }
    // A list is a limit, and a wrong entry does not lift it: an agent whose every handoff was
    // dropped hands over to nobody, which is worth saying in so many words.
    if (kept.length === 0 && agent.handoffs.length > 0) {
      problems.push(`agent ${agent.id}: ${NO_HANDOFF_LEFT}, so it cannot hand the conversation over at all`);
    }
    agent.handoffs = kept;
  }
  // A branch leads to an agent there is, and not back to the agent it starts from.
  for (const agent of agents) {
    const next = agent.onEnter?.next;
    if (!next) continue;
    const wrong = next
      .map((branch) => {
        const target = ids.get(branch.to.toLowerCase());
        if (!target) return `there is no agent ${branch.to} for onEnter to move on to`;
        if (target === agent.id) return "onEnter cannot move on to the agent itself";
        branch.to = target;
        return undefined;
      })
      .find(Boolean);
    if (wrong) {
      problems.push(`agent ${agent.id}: ${wrong}`);
      delete agent.onEnter;
    }
  }
  // A value that is read is one that some step can have set: a name nobody sets is a slip of the pen.
  const set = new Set<string>(SESSION_VALUES);
  for (const agent of agents) {
    for (const value of agent.collect ?? []) set.add(value.name);
    if (agent.onEnter) for (const name of entryValues(agent.onEnter).sets) set.add(name);
  }
  for (const agent of agents) {
    if (!agent.onEnter) continue;
    const unknown = entryValues(agent.onEnter).reads.find((name) => !set.has(name));
    if (unknown) {
      problems.push(
        `agent ${agent.id}: onEnter reads {{${unknown}}}, which no agent collects or saves. The relay's own values are ${SESSION_VALUES.join(", ")}`
      );
      delete agent.onEnter;
    }
  }
  // One agent besides the starting one is the least a handover needs.
  if (agents.length > 0 && agents.every((agent) => agent.id === MAIN_AGENT)) {
    return { agents: [], problems: [...problems, "agents needs at least one agent besides main"] };
  }
  return { agents, problems };
}

/** Every agent a conversation can be in, with the starting agent first. */
export function agentRoster(agents: readonly AgentStage[]): AgentStage[] {
  if (agents.length === 0) return [];
  const main = agents.find((agent) => agent.id === MAIN_AGENT) ?? {
    id: MAIN_AGENT,
    description: "The agent every conversation starts with; handles everything else.",
    instructions: ""
  };
  return [main, ...agents.filter((agent) => agent.id !== MAIN_AGENT)];
}
