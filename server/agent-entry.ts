/**
 * What the relay itself does when a conversation is handed to an agent, with
 * no model deciding any of it: say a fixed sentence, call a tool with fixed
 * arguments, and move on to another agent by what the tool answered. This is
 * the `onEnter` key of an agent in the assistant config.
 */

type Plain = string | number | boolean;

/** A test of what the tool answered. Exactly one of the tests is given. */
type EntryCondition = {
  /** Where in the tool's JSON answer to look: keys and list positions joined by dots. Absent: the whole answer. */
  path?: string;
  is?: Plain;
  in?: Plain[];
  above?: number;
  below?: number;
  exists?: boolean;
  /** True: the call did not succeed, or its result was withheld. */
  failed?: true;
};

export type EntryBranch = {
  /** The id of the agent to move on to. */
  to: string;
  /** Absent: taken when no branch before it was. */
  if?: EntryCondition;
};

export type AgentEntry = {
  /** Said in these words when the conversation arrives. */
  say?: string;
  /** A tool the relay calls itself on arriving, and the arguments it calls it with. */
  call?: { tool: string; arguments: Record<string, unknown> };
  /** Where the conversation goes next without the model choosing: the first branch that applies. */
  next?: EntryBranch[];
};

const MAX_SAY = 500;
const MAX_ARGUMENTS = 2000;
const MAX_BRANCHES = 8;
const MAX_CHOICES = 16;
const MAX_PATH = 120;
const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const TESTS = ["is", "in", "above", "below", "exists", "failed"] as const;
/** The conversation's own tools: ending it and handing it over are not a step's to call. */
const NOT_FOR_A_STEP = new Set(["end_session", "transfer_to_agent"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const isPlain = (value: unknown): value is Plain =>
  (typeof value === "string" && value.length <= 200) ||
  (typeof value === "number" && Number.isFinite(value)) ||
  typeof value === "boolean";

function conditionFrom(raw: unknown): EntryCondition | string {
  if (!isRecord(raw)) return 'the "if" of a branch must be an object such as { "path": "status", "is": "shipped" }';
  const unknown = Object.keys(raw).find((key) => key !== "path" && !(TESTS as readonly string[]).includes(key));
  if (unknown) return `a condition has no "${unknown.slice(0, 40)}"`;
  const given = TESTS.filter((test) => raw[test] !== undefined);
  if (given.length !== 1) return `a condition needs exactly one of ${TESTS.join(", ")}`;
  const condition: EntryCondition = {};
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || !raw.path.trim() || raw.path.trim().length > MAX_PATH) {
      return `the path of a condition must be text of at most ${MAX_PATH} characters, such as "order.status"`;
    }
    condition.path = raw.path.trim();
  }
  const test = given[0]!;
  if (test === "is") {
    if (!isPlain(raw.is)) return 'the "is" of a condition must be a text, a number or true/false';
    condition.is = raw.is;
  } else if (test === "in") {
    if (!Array.isArray(raw.in) || raw.in.length === 0 || raw.in.length > MAX_CHOICES || !raw.in.every(isPlain)) {
      return `the "in" of a condition must be a list of 1 to ${MAX_CHOICES} texts or numbers`;
    }
    condition.in = raw.in as Plain[];
  } else if (test === "above" || test === "below") {
    const value = raw[test];
    if (typeof value !== "number" || !Number.isFinite(value)) return `the "${test}" of a condition must be a number`;
    condition[test] = value;
  } else if (test === "exists") {
    if (typeof raw.exists !== "boolean") return 'the "exists" of a condition must be true or false';
    condition.exists = raw.exists;
  } else {
    if (raw.failed !== true) return 'the "failed" of a condition can only be true';
    if (condition.path) return 'a condition with "failed" takes no path';
    condition.failed = true;
  }
  return condition;
}

/**
 * Reads an agent's `onEnter`. Anything wrong in it gives a problem and no
 * entry at all: half of what was meant to happen by rule is worse than none.
 * Whether the agents a branch names exist is for the caller, which knows them.
 */
export function agentEntryFrom(raw: unknown): { entry?: AgentEntry; problem?: string } {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return { problem: "onEnter must be an object" };
  const unknown = Object.keys(raw).find((key) => key !== "say" && key !== "call" && key !== "next");
  if (unknown) return { problem: `onEnter has no "${unknown.slice(0, 40)}"` };
  const entry: AgentEntry = {};
  if (raw.say !== undefined && raw.say !== null && raw.say !== "") {
    if (typeof raw.say !== "string") return { problem: "onEnter: say must be text" };
    const say = raw.say.replace(/\s+/g, " ").trim();
    if (say.length > MAX_SAY) return { problem: `onEnter: say can be at most ${MAX_SAY} characters` };
    if (say) entry.say = say;
  }
  if (raw.call !== undefined && raw.call !== null) {
    const call = raw.call;
    if (!isRecord(call) || typeof call.tool !== "string" || !TOOL_NAME.test(call.tool.trim())) {
      return { problem: 'onEnter: call must name a tool, as { "tool": "find_order" }' };
    }
    const extra = Object.keys(call).find((key) => key !== "tool" && key !== "arguments");
    if (extra) return { problem: `onEnter: a call has no "${extra.slice(0, 40)}"` };
    if (NOT_FOR_A_STEP.has(call.tool.trim())) {
      return {
        problem: `onEnter cannot call ${call.tool.trim()}: to move on to another agent use next, and a conversation is ended by the assistant or the user`
      };
    }
    if (call.arguments !== undefined && call.arguments !== null && !isRecord(call.arguments)) {
      return { problem: "onEnter: the arguments of a call must be an object" };
    }
    const args = isRecord(call.arguments) ? call.arguments : {};
    if (JSON.stringify(args).length > MAX_ARGUMENTS) {
      return { problem: `onEnter: the arguments of a call can be at most ${MAX_ARGUMENTS} characters of JSON` };
    }
    entry.call = { tool: call.tool.trim(), arguments: args };
  }
  if (raw.next !== undefined && raw.next !== null) {
    if (!Array.isArray(raw.next) || raw.next.length > MAX_BRANCHES) {
      return { problem: `onEnter: next must be a list of at most ${MAX_BRANCHES} branches` };
    }
    const next: EntryBranch[] = [];
    for (const [index, item] of raw.next.entries()) {
      const to =
        typeof item === "string" ? item.trim() : isRecord(item) && typeof item.to === "string" ? item.to.trim() : "";
      if (!to || to.length > 64) {
        return { problem: 'onEnter: every branch needs the id of an agent, as "billing" or { "to": "billing" }' };
      }
      if (isRecord(item)) {
        const extra = Object.keys(item).find((key) => key !== "to" && key !== "if");
        if (extra) return { problem: `onEnter: a branch has no "${extra.slice(0, 40)}"` };
      }
      if (!isRecord(item) || item.if === undefined || item.if === null) {
        // Nothing after a branch without a condition could ever be taken.
        if (index < raw.next.length - 1) {
          return { problem: "onEnter: a branch without a condition is always taken, so it must be the last one" };
        }
        next.push({ to });
        continue;
      }
      const condition = conditionFrom(item.if);
      if (typeof condition === "string") return { problem: `onEnter: ${condition}` };
      // A condition reads what the tool answered: without a call there is nothing to read.
      if (!entry.call) return { problem: "onEnter: a branch with a condition needs a call whose answer it reads" };
      next.push({ to, if: condition });
    }
    if (next.length > 0) entry.next = next;
  }
  return Object.keys(entry).length > 0 ? { entry } : {};
}

/** The part of a tool's answer a path names. The whole answer for no path; nothing when the path leads nowhere. */
function valueAt(answer: unknown, path: string | undefined): unknown {
  if (!path) return answer;
  let value = answer;
  for (const key of path.split(".")) {
    if (Array.isArray(value)) {
      value = /^\d+$/.test(key) ? value[Number(key)] : undefined;
    } else if (isRecord(value) && Object.hasOwn(value, key)) {
      value = value[key];
    } else {
      return undefined;
    }
  }
  return value;
}

const text = (value: Plain): string => String(value).trim().toLowerCase();

function applies(condition: EntryCondition, answer: unknown): boolean {
  const value = valueAt(answer, condition.path);
  if (condition.exists !== undefined)
    return (value !== undefined && value !== null && value !== "") === condition.exists;
  if (condition.is !== undefined) return isPlain(value) && text(value) === text(condition.is);
  if (condition.in) return isPlain(value) && condition.in.some((choice) => text(choice) === text(value));
  // A number, or one written out in digits as text: "40" is above 30. Nothing else is above or below anything.
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[+-]?\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number)) return false;
  if (condition.above !== undefined) return number > condition.above;
  if (condition.below !== undefined) return number < condition.below;
  return false;
}

/**
 * The agent the conversation moves on to, by the first branch that applies.
 * `result` is what the entry's call gave: nothing when there was no call. A
 * call that failed takes only a branch that asks for that; one that succeeded
 * never takes it.
 */
export function branchTaken(
  next: readonly EntryBranch[] | undefined,
  result?: { ok: boolean; output: string }
): string | undefined {
  if (!next) return undefined;
  if (result && !result.ok) return next.find((branch) => branch.if?.failed)?.to;
  let answer: unknown = result?.output;
  if (result) {
    try {
      answer = JSON.parse(result.output) as unknown;
    } catch {
      // Not JSON: the answer is its text, which a condition without a path can still read.
    }
  }
  return next.find((branch) => !branch.if || (!branch.if.failed && applies(branch.if, answer)))?.to;
}
