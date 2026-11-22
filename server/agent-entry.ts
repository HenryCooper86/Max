/**
 * What the relay itself does when a conversation is handed to an agent, with
 * no model deciding any of it: say a fixed sentence, call a tool with fixed
 * arguments, and move on to another agent by what the tool answered. This is
 * the `onEnter` key of an agent in the assistant config.
 */

export type Plain = string | number | boolean;

/** Something the assistant has to find out from the user before it hands the conversation to an agent. */
export type CollectedValue = {
  /** The name it is kept under, and written as `{{name}}` where it is used. */
  name: string;
  /** What it is, for the model that asks for it. */
  description: string;
  type: "text" | "number" | "boolean";
  /** False: handed over without it when the user did not say. */
  required: boolean;
};

/** Reads a value of the conversation by its name. Nothing when there is none. */
export type ValueLookup = (name: string) => Plain | undefined;

/** A test of what the tool answered, or of a value of the conversation. Exactly one of the tests is given. */
type EntryCondition = {
  /** Where in the tool's JSON answer to look: keys and list positions joined by dots. Absent: the whole answer. */
  path?: string;
  /** The name of a value of the conversation to test, in place of the tool's answer. */
  value?: string;
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
  /** Parts of the tool's answer to keep as values of the conversation: the name of each, and its path in the answer. */
  save?: Record<string, string>;
  /** Where the conversation goes next without the model choosing: the first branch that applies. */
  next?: EntryBranch[];
};

const MAX_SAY = 500;
const MAX_ARGUMENTS = 2000;
const MAX_BRANCHES = 8;
const MAX_CHOICES = 16;
const MAX_PATH = 120;
const MAX_COLLECTED = 8;
const MAX_SAVED = 8;
const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const VALUE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** `{{name}}` in a sentence or an argument. The relay's own values have a dot in their name. */
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)\s*\}\}/g;
/** Values every conversation has, which no step can set. */
export const SESSION_VALUES = ["user.id", "session.id", "channel"] as const;
/** Names a value cannot have: the relay's own, and the parameters of the handover a value travels in. */
const TAKEN_NAMES = new Set(["channel", "agent", "values"]);
/** `{{…}}` of any kind, to find the ones that are no placeholder: a slip of the pen would be said aloud. */
const BRACES = /\{\{[^{}]*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?\s*\}\}$/;

/**
 * A value as it is kept: one line of at most 200 characters, without the
 * characters that are not seen but change how text reads (control characters,
 * marks that turn the direction of writing, spaces of no width). A value comes
 * from what a model heard or from a tool's answer, and goes into what is said
 * and into what a model reads.
 */
function cleanValue(text: string): string {
  return [
    ...text
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  ]
    .slice(0, 200)
    .join("")
    .trim();
}

function wrongBraces(value: unknown): string | undefined {
  if (typeof value === "string") return (value.match(BRACES) ?? []).find((one) => !WHOLE_PLACEHOLDER.test(one));
  if (Array.isArray(value)) return value.map(wrongBraces).find(Boolean);
  if (value && typeof value === "object") return Object.values(value).map(wrongBraces).find(Boolean);
  return undefined;
}

const notAPlaceholder = (found: string): string =>
  `${found.slice(0, 60)} is not a value: write {{name}}, with a name of lower-case letters, digits and _`;
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
  const unknown = Object.keys(raw).find(
    (key) => key !== "path" && key !== "value" && !(TESTS as readonly string[]).includes(key)
  );
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
  if (raw.value !== undefined) {
    if (condition.path)
      return "a condition reads the tool's answer (path) or a value of the conversation (value), not both";
    const name = typeof raw.value === "string" ? raw.value.trim() : "";
    if (!VALUE_NAME.test(name) && !(SESSION_VALUES as readonly string[]).includes(name)) {
      return 'the value of a condition must be the name of a value, such as "order_number"';
    }
    condition.value = name;
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
    if (condition.path || condition.value) return 'a condition with "failed" takes no path and no value';
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
  const unknown = Object.keys(raw).find((key) => !["say", "call", "save", "next"].includes(key));
  if (unknown) return { problem: `onEnter has no "${unknown.slice(0, 40)}"` };
  const entry: AgentEntry = {};
  if (raw.say !== undefined && raw.say !== null && raw.say !== "") {
    if (typeof raw.say !== "string") return { problem: "onEnter: say must be text" };
    const say = raw.say.replace(/\s+/g, " ").trim();
    if (say.length > MAX_SAY) return { problem: `onEnter: say can be at most ${MAX_SAY} characters` };
    const wrong = wrongBraces(say);
    if (wrong) return { problem: `onEnter: say: ${notAPlaceholder(wrong)}` };
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
    const wrong = wrongBraces(args);
    if (wrong) return { problem: `onEnter: the arguments of a call: ${notAPlaceholder(wrong)}` };
    entry.call = { tool: call.tool.trim(), arguments: args };
  }
  if (raw.save !== undefined && raw.save !== null) {
    if (!isRecord(raw.save) || Object.keys(raw.save).length > MAX_SAVED) {
      return {
        problem: `onEnter: save must be an object of at most ${MAX_SAVED} names, each with a path into the tool's answer`
      };
    }
    if (!entry.call) return { problem: "onEnter: save keeps parts of a tool's answer, so it needs a call" };
    const save: Record<string, string> = {};
    for (const [name, path] of Object.entries(raw.save)) {
      if (!VALUE_NAME.test(name)) {
        return {
          problem: `onEnter: save: a value's name is lower-case letters, digits and _, starting with a letter; "${name.slice(0, 40)}" is not`
        };
      }
      if (TAKEN_NAMES.has(name)) return { problem: `onEnter: save: a value cannot be called ${name}` };
      if (typeof path !== "string" || !path.trim() || path.trim().length > MAX_PATH) {
        return { problem: `onEnter: save: ${name} needs a path into the tool's answer, such as "order.status"` };
      }
      save[name] = path.trim();
    }
    if (Object.keys(save).length > 0) entry.save = save;
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
      if (!entry.call && !condition.value) {
        return {
          problem:
            "onEnter: a branch with a condition needs a call whose answer it reads, or the name of a value to read"
        };
      }
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

function applies(condition: EntryCondition, answer: unknown, values?: ValueLookup): boolean {
  const value = condition.value ? values?.(condition.value) : valueAt(answer, condition.path);
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
  result?: { ok: boolean; output: string },
  values?: ValueLookup
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
  return next.find((branch) => !branch.if || (!branch.if.failed && applies(branch.if, answer, values)))?.to;
}

/**
 * Reads an agent's `collect`: what the assistant has to find out before it
 * hands the conversation to the agent. Anything wrong gives a problem and no
 * list: a handover that asks for half of what the agent needs is worse than
 * one that asks for nothing.
 */
export function collectFrom(raw: unknown): { collect?: CollectedValue[]; problem?: string } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw) || raw.length > MAX_COLLECTED) {
    return { problem: `collect must be a list of at most ${MAX_COLLECTED} values` };
  }
  const collect: CollectedValue[] = [];
  for (const item of raw) {
    if (!isRecord(item))
      return { problem: 'collect: every value is an object such as { "name": "order_number", "description": "…" }' };
    const unknown = Object.keys(item).find((key) => !["name", "description", "type", "required"].includes(key));
    if (unknown) return { problem: `collect: a value has no "${unknown.slice(0, 40)}"` };
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!VALUE_NAME.test(name)) {
      return { problem: "collect: a value's name is lower-case letters, digits and _, starting with a letter" };
    }
    if (TAKEN_NAMES.has(name)) return { problem: `collect: a value cannot be called ${name}` };
    if (collect.some((one) => one.name === name)) return { problem: `collect: ${name} is there twice` };
    const description = typeof item.description === "string" ? item.description.replace(/\s+/g, " ").trim() : "";
    if (!description || description.length > 200) {
      return { problem: `collect: ${name} needs a description of at most 200 characters, which the assistant asks by` };
    }
    const type = item.type ?? "text";
    if (type !== "text" && type !== "number" && type !== "boolean") {
      return { problem: `collect: the type of ${name} is text, number or boolean` };
    }
    if (item.required !== undefined && typeof item.required !== "boolean") {
      return { problem: `collect: required of ${name} is true or false` };
    }
    collect.push({ name, description, type, required: item.required !== false });
  }
  return collect.length > 0 ? { collect } : {};
}

/** What the model gave for a value, as the type the value has. Nothing when it is no such thing. */
export function collected(value: unknown, type: CollectedValue["type"]): Plain | undefined {
  if (type === "number") {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    // An amount or a count. What a number would write differently is no number here: "00123" is
    // an identifier, and so is a row of digits too long for a number to hold. Those are text.
    const digits = typeof value === "string" ? value.trim() : "";
    return /^[+-]?(0|[1-9]\d{0,14})(\.\d{1,10})?$/.test(digits) ? Number(digits) : undefined;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const word = typeof value === "string" ? value.trim().toLowerCase() : "";
    return word === "true" || word === "yes" ? true : word === "false" || word === "no" ? false : undefined;
  }
  const text =
    typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  return cleanValue(text) || undefined;
}

/** The names written as `{{name}}` in a text. */
function namesIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

function namesInside(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(...namesIn(value));
  else if (Array.isArray(value)) for (const one of value) namesInside(one, into);
  else if (isRecord(value)) for (const one of Object.values(value)) namesInside(one, into);
}

/** Every value an `onEnter` reads, and every value it sets. */
export function entryValues(entry: AgentEntry): { reads: string[]; sets: string[] } {
  const reads: string[] = [];
  if (entry.say) reads.push(...namesIn(entry.say));
  if (entry.call) namesInside(entry.call.arguments, reads);
  for (const branch of entry.next ?? []) if (branch.if?.value) reads.push(branch.if.value);
  return { reads: [...new Set(reads)], sets: Object.keys(entry.save ?? {}) };
}

/** A text with its `{{name}}` filled in, and the names there was no value for. */
export function filled(text: string, values: ValueLookup): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(PLACEHOLDER, (_all, name: string) => {
    const value = values(name);
    if (value === undefined) {
      missing.push(name);
      return "";
    }
    return String(value);
  });
  return { text: out, missing };
}

/**
 * A call's arguments with their `{{name}}` filled in. An argument that is
 * nothing but one `{{name}}` takes the value as it is, a number as a number.
 */
export function filledArguments(
  args: Record<string, unknown>,
  values: ValueLookup
): { arguments: Record<string, unknown>; missing: string[] } {
  const missing: string[] = [];
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") {
      const whole = /^\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)\s*\}\}$/.exec(value.trim());
      if (whole) {
        const found = values(whole[1]!);
        if (found === undefined) missing.push(whole[1]!);
        return found ?? "";
      }
      const text = filled(value, values);
      missing.push(...text.missing);
      return text.text;
    }
    if (Array.isArray(value)) return value.map(fill);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fill(one)]));
    return value;
  };
  return { arguments: fill(args) as Record<string, unknown>, missing: [...new Set(missing)] };
}

/** The parts of a tool's answer an entry keeps, by the names it keeps them under. Only plain values are kept. */
export function savedFrom(save: Record<string, string> | undefined, output: string): Record<string, Plain> {
  if (!save) return {};
  let answer: unknown;
  try {
    answer = JSON.parse(output) as unknown;
  } catch {
    return {};
  }
  const kept: Record<string, Plain> = {};
  for (const [name, path] of Object.entries(save)) {
    const value = valueAt(answer, path);
    if (typeof value === "string") {
      const clean = cleanValue(value);
      if (clean) kept[name] = clean;
    } else if (isPlain(value)) kept[name] = value;
  }
  return kept;
}
