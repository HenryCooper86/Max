import type { AgentEntry, CollectedValue } from "./agent-entry";
import { agentStagesFrom, MAIN_AGENT, NO_HANDOFF_LEFT } from "./conversation-config";

/**
 * The assistant's agents as a flow: steps a conversation moves through, and
 * the arrows between them. This is the `agents` key of the assistant config,
 * as the Studio's flow builder reads and writes it. A step is an agent; an
 * arrow is one of its `handoffs`.
 */

export type FlowStep = {
  id: string;
  /** When to come to this step, for the steps that lead here without a condition of their own. */
  description?: string;
  instructions?: string;
  /** The tools this step may use. Absent: every tool. */
  tools?: string[];
  /** The steps this one leads to. Absent: any step. Empty: none. */
  handoffs?: Array<{ to: string; when?: string }>;
  /** What the assistant has to find out from the user before it hands the conversation to this step. */
  collect?: CollectedValue[];
  /** What the relay does itself when a conversation comes to this step: a sentence, a tool call, where to next. */
  onEnter?: AgentEntry;
  /** The starting step only: what the relay does itself when a conversation starts. */
  onStart?: AgentEntry;
  /** Where the step sits on the canvas. The relay itself does not read it. */
  at?: [number, number];
};

const MAX_STEPS = 12;
const LIMITS = { instructions: 8000, description: 400, when: 300 } as const;
const CANVAS = 4000;
const STEP_KEYS: ReadonlySet<string> = new Set([
  "id",
  "description",
  "instructions",
  "tools",
  "handoffs",
  "collect",
  "onEnter",
  "onStart",
  "at"
]);
const DEFAULT_MAIN_DESCRIPTION = "The agent every conversation starts with; handles everything else.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function placeFrom(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [x, y] = value as unknown[];
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const within = (n: number) => Math.round(Math.min(CANVAS, Math.max(0, n)));
  return [within(x), within(y)];
}

/** The steps a stored `agents` key describes, the starting step first. Entries the relay would skip are left out. */
export function flowFrom(raw: unknown): { steps: FlowStep[]; problems: string[] } {
  const { agents, problems } = agentStagesFrom(raw);
  const places = new Map<string, [number, number]>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const place = isRecord(entry) ? placeFrom(entry.at) : undefined;
      if (place && isRecord(entry) && typeof entry.id === "string") places.set(entry.id.trim().toLowerCase(), place);
    }
  }
  const steps: FlowStep[] = agents.map((agent) => {
    const place = places.get(agent.id.toLowerCase());
    return {
      id: agent.id,
      ...(agent.id === MAIN_AGENT && agent.description === DEFAULT_MAIN_DESCRIPTION
        ? {}
        : { description: agent.description }),
      ...(agent.instructions ? { instructions: agent.instructions } : {}),
      ...(agent.tools ? { tools: agent.tools } : {}),
      ...(agent.handoffs ? { handoffs: agent.handoffs } : {}),
      ...(agent.collect ? { collect: agent.collect } : {}),
      ...(agent.onEnter ? { onEnter: agent.onEnter } : {}),
      ...(agent.onStart ? { onStart: agent.onStart } : {}),
      ...(place ? { at: place } : {})
    };
  });
  const main = steps.find((step) => step.id === MAIN_AGENT) ?? { id: MAIN_AGENT };
  return { steps: [main, ...steps.filter((step) => step.id !== MAIN_AGENT)], problems };
}

/**
 * Checks a flow someone drew before it is saved. Unlike the config loader,
 * which skips what it cannot use and carries on, this accepts a flow only when
 * every part of it is right: what is saved is then what was drawn. Returns the
 * `agents` key to store, which is nothing for a flow with no step but the start.
 */
export function checkFlow(raw: unknown): { agents: FlowStep[] | undefined } | { problems: string[] } {
  if (!Array.isArray(raw)) return { problems: ["The flow must be a list of steps."] };
  if (raw.length > MAX_STEPS) return { problems: [`A flow has at most ${MAX_STEPS} steps.`] };
  const problems: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim().slice(0, 64) : "a step";
    // The loader ignores a key it does not know. Here that would save less than was sent.
    for (const key of Object.keys(entry)) {
      if (!STEP_KEYS.has(key)) problems.push(`${id}: a step has no "${key.slice(0, 40)}"`);
    }
    // The loader shortens a text that is too long. Here that would save something other than what was written.
    for (const key of ["instructions", "description"] as const) {
      if (typeof entry[key] === "string" && entry[key].trim().length > LIMITS[key]) {
        problems.push(`${id}: ${key} can be at most ${LIMITS[key]} characters`);
      }
    }
    if (Array.isArray(entry.tools) && entry.tools.length > 64) problems.push(`${id}: at most 64 tools`);
    if (Array.isArray(entry.handoffs)) {
      if (entry.handoffs.length > MAX_STEPS) problems.push(`${id}: at most ${MAX_STEPS} handoffs`);
      for (const handoff of entry.handoffs.slice(0, MAX_STEPS)) {
        if (!isRecord(handoff)) continue;
        if (handoff.when !== undefined && handoff.when !== null && typeof handoff.when !== "string") {
          problems.push(`${id}: the condition of a handoff must be text`);
        } else if (typeof handoff.when === "string" && handoff.when.trim().length > LIMITS.when) {
          problems.push(`${id}: the condition of a handoff can be at most ${LIMITS.when} characters`);
        }
        const extra = Object.keys(handoff).find((key) => key !== "to" && key !== "when");
        if (extra) problems.push(`${id}: a handoff has no "${extra.slice(0, 40)}"`);
      }
    }
    if (entry.at !== undefined && entry.at !== null && !placeFrom(entry.at)) {
      problems.push(`${id}: its place on the canvas must be two numbers`);
    }
  }
  const only = raw.filter(
    (entry) =>
      isRecord(entry) &&
      String(entry.id ?? "")
        .trim()
        .toLowerCase() !== MAIN_AGENT
  );
  if (raw.length > 0 && only.length === 0) {
    const main = raw.find(isRecord);
    const written =
      main &&
      ["instructions", "tools", "handoffs", "collect", "onEnter", "onStart"].some(
        (key) => main[key] !== undefined && main[key] !== null && main[key] !== ""
      );
    // The start alone, with nothing written in it, is no flow: the assistant then works as one agent.
    if (!written) return problems.length > 0 ? { problems } : { agents: undefined };
  }
  if (raw.length === 0) return { agents: undefined };
  const read = flowFrom(raw);
  problems.push(
    ...read.problems
      // What the loader would do with the rest does not matter here: a flow with a problem is not saved.
      .filter((problem) => !problem.includes(NO_HANDOFF_LEFT))
      .map((problem) => `${problem[0]!.toUpperCase()}${problem.slice(1)}.`)
  );
  if (problems.length > 0) return { problems };
  // The starting step is stored only when something is written in it.
  const [main, ...rest] = read.steps;
  return { agents: main && Object.keys(main).length > 1 ? [main, ...rest] : rest };
}
