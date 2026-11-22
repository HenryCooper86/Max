import fs from "node:fs";
import path from "node:path";

/**
 * Scenario files for `agent-test`. A scenario is plain JSON so it can be
 * written by someone who has never opened this repo, which is why validation is
 * strict and talkative: every problem is reported with the file and scenario
 * name before anything runs, because a typo in `replyContain` that silently
 * checks nothing is worse than a refusal to start.
 */

export type ClientToolSpec = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  /** What the test client answers when the agent calls the tool. */
  result?: unknown;
  /** Answer with this error instead of a result. */
  error?: string;
};

export type TurnExpect = {
  toolCalled?: string[];
  toolNotCalled?: string[];
  toolArgs?: Record<string, Record<string, unknown>>;
  replyContains?: string[];
  replyNotContains?: string[];
  replyMatches?: string;
  withinMs?: number;
  judge?: string;
  /** The relay ended the conversation during this turn: `true` for any reason,
   *  or the reason itself (`agent`, `idle`, `max_duration`, `transfer`). */
  sessionEnded?: boolean | string;
};

export type ConversationExpect = {
  toolCalled?: string[];
  toolNotCalled?: string[];
  maxTurns?: number;
};

type ScenarioBase = {
  name: string;
  /** The file it came from, for reports. */
  file: string;
  language?: string;
  context?: string;
  clientTools: ClientToolSpec[];
};

export type ScriptedScenario = ScenarioBase & {
  kind: "scripted";
  turns: { user: string; expect: TurnExpect }[];
};

export type SimulatedScenario = ScenarioBase & {
  kind: "simulated";
  simulate: { persona: string; goal: string; maxTurns: number; firstMessage?: string };
  success: string;
  expect: ConversationExpect;
};

export type Scenario = ScriptedScenario | SimulatedScenario;

const DEFAULT_MAX_TURNS = 8;
const MAX_TURNS_LIMIT = 30;

const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
/** The relay's own limits (docs/protocol.md): a scenario the relay would reject is a scenario error. */
const MAX_CLIENT_TOOLS = 32;
const MAX_CONTEXT = 2000;
const MAX_TEXT = 2000;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects problems under a path prefix so each message says where it is. */
class Problems {
  readonly list: string[] = [];
  constructor(private readonly prefix: string) {}
  add(where: string, message: string): void {
    this.list.push(`${this.prefix}${where ? ` ${where}` : ""}: ${message}`);
  }
}

function checkKeys(value: Obj, allowed: readonly string[], where: string, problems: Problems): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.add(where, `unknown field "${key}" (allowed: ${allowed.join(", ")})`);
  }
}

function stringList(value: unknown, where: string, problems: Problems, nonEmptyItems = true): string[] | undefined {
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) {
    problems.add(where, "must be a string or an array of strings");
    return undefined;
  }
  if (nonEmptyItems && items.some((item: string) => !item.trim())) {
    problems.add(where, "must not contain empty strings");
    return undefined;
  }
  return items as string[];
}

function optionalString(value: Obj, key: string, where: string, problems: Problems, max?: number): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || !field.trim()) {
    problems.add(`${where}${key}`, "must be a non-empty string");
    return undefined;
  }
  if (max && field.length > max) {
    problems.add(`${where}${key}`, `must be at most ${max} characters`);
    return undefined;
  }
  return field;
}

function positiveInt(value: unknown, where: string, problems: Problems, max?: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
    problems.add(where, `must be a whole number from 1${max ? ` to ${max}` : ""}`);
    return undefined;
  }
  return value;
}

const TURN_EXPECT_KEYS = [
  "toolCalled",
  "toolNotCalled",
  "toolArgs",
  "replyContains",
  "replyNotContains",
  "replyMatches",
  "withinMs",
  "judge",
  "sessionEnded"
] as const;

function parseTurnExpect(raw: unknown, where: string, problems: Problems): TurnExpect {
  const expect: TurnExpect = {};
  if (raw === undefined) return expect;
  if (!isObject(raw)) {
    problems.add(where, "must be an object");
    return expect;
  }
  checkKeys(raw, TURN_EXPECT_KEYS, where, problems);
  for (const key of ["toolCalled", "toolNotCalled", "replyContains", "replyNotContains"] as const) {
    if (raw[key] === undefined) continue;
    // An empty replyContains entry would match every reply, so empty strings are refused.
    const list = stringList(raw[key], `${where}.${key}`, problems);
    if (list) expect[key] = list;
  }
  if (raw.toolArgs !== undefined) {
    if (!isObject(raw.toolArgs) || Object.values(raw.toolArgs).some((args) => !isObject(args))) {
      problems.add(`${where}.toolArgs`, "must map a tool name to an object of expected arguments");
    } else {
      expect.toolArgs = raw.toolArgs as Record<string, Record<string, unknown>>;
    }
  }
  if (raw.replyMatches !== undefined) {
    if (typeof raw.replyMatches !== "string" || !raw.replyMatches) {
      problems.add(`${where}.replyMatches`, "must be a regular expression string");
    } else {
      try {
        new RegExp(raw.replyMatches, "i");
        expect.replyMatches = raw.replyMatches;
      } catch (error) {
        problems.add(
          `${where}.replyMatches`,
          `is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`
        );
      }
    }
  }
  if (raw.withinMs !== undefined) {
    const ms = positiveInt(raw.withinMs, `${where}.withinMs`, problems);
    if (ms !== undefined) expect.withinMs = ms;
  }
  const judge = optionalString(raw, "judge", `${where}.`, problems);
  if (judge) expect.judge = judge;
  if (raw.sessionEnded !== undefined) {
    if (typeof raw.sessionEnded === "boolean" || (typeof raw.sessionEnded === "string" && raw.sessionEnded)) {
      expect.sessionEnded = raw.sessionEnded;
    } else problems.add(`${where}.sessionEnded`, "must be true, false or the reason the session ended with");
  }
  return expect;
}

function parseConversationExpect(raw: unknown, where: string, problems: Problems): ConversationExpect {
  const expect: ConversationExpect = {};
  if (raw === undefined) return expect;
  if (!isObject(raw)) {
    problems.add(where, "must be an object");
    return expect;
  }
  checkKeys(raw, ["toolCalled", "toolNotCalled", "maxTurns"], where, problems);
  for (const key of ["toolCalled", "toolNotCalled"] as const) {
    if (raw[key] === undefined) continue;
    const list = stringList(raw[key], `${where}.${key}`, problems);
    if (list) expect[key] = list;
  }
  if (raw.maxTurns !== undefined) {
    const turns = positiveInt(raw.maxTurns, `${where}.maxTurns`, problems, MAX_TURNS_LIMIT);
    if (turns !== undefined) expect.maxTurns = turns;
  }
  return expect;
}

function parseClientTools(raw: unknown, problems: Problems): ClientToolSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.add("clientTools", "must be an array");
    return [];
  }
  if (raw.length > MAX_CLIENT_TOOLS) problems.add("clientTools", `at most ${MAX_CLIENT_TOOLS} tools are allowed`);
  const tools: ClientToolSpec[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const where = `clientTools[${index}]`;
    if (!isObject(entry)) {
      problems.add(where, "must be an object");
      return;
    }
    checkKeys(entry, ["name", "description", "parameters", "result", "error"], where, problems);
    const name = entry.name;
    if (typeof name !== "string" || !TOOL_NAME.test(name)) {
      problems.add(`${where}.name`, "must match ^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$");
      return;
    }
    if (seen.has(name)) problems.add(`${where}.name`, `"${name}" is declared twice`);
    seen.add(name);
    const description = optionalString(entry, "description", `${where}.`, problems, 1024);
    if (description === undefined && entry.description === undefined) {
      problems.add(`${where}.description`, "is required (the model reads it to decide when to call the tool)");
    }
    const tool: ClientToolSpec = { name, description: description ?? "" };
    if (entry.parameters !== undefined) {
      if (!isObject(entry.parameters) || (entry.parameters.type !== undefined && entry.parameters.type !== "object")) {
        problems.add(`${where}.parameters`, 'must be a JSON Schema object with type "object"');
      } else {
        tool.parameters = entry.parameters;
      }
    }
    if (entry.result !== undefined && entry.error !== undefined) {
      problems.add(where, 'set "result" or "error", not both');
    }
    if (entry.result !== undefined) tool.result = entry.result;
    if (entry.error !== undefined) {
      if (typeof entry.error !== "string" || !entry.error.trim()) problems.add(`${where}.error`, "must be a string");
      else tool.error = entry.error;
    }
    tools.push(tool);
  });
  return tools;
}

function parseTurns(raw: unknown, problems: Problems): ScriptedScenario["turns"] {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.add("turns", "must be a non-empty array");
    return [];
  }
  const turns: ScriptedScenario["turns"] = [];
  raw.forEach((entry, index) => {
    const where = `turns[${index}]`;
    if (!isObject(entry)) {
      problems.add(where, "must be an object");
      return;
    }
    checkKeys(entry, ["user", "expect"], where, problems);
    const user = entry.user;
    if (typeof user !== "string" || !user.trim() || user.length > MAX_TEXT) {
      problems.add(`${where}.user`, `must be a non-empty string of at most ${MAX_TEXT} characters`);
    }
    const expect = parseTurnExpect(entry.expect, `${where}.expect`, problems);
    if (typeof user === "string") turns.push({ user, expect });
  });
  return turns;
}

function parseSimulate(raw: unknown, problems: Problems): SimulatedScenario["simulate"] | undefined {
  if (!isObject(raw)) {
    problems.add("simulate", "must be an object");
    return undefined;
  }
  checkKeys(raw, ["persona", "goal", "maxTurns", "firstMessage"], "simulate", problems);
  const persona = optionalString(raw, "persona", "simulate.", problems);
  const goal = optionalString(raw, "goal", "simulate.", problems);
  if (persona === undefined && raw.persona === undefined) problems.add("simulate.persona", "is required");
  if (goal === undefined && raw.goal === undefined) problems.add("simulate.goal", "is required");
  let maxTurns = DEFAULT_MAX_TURNS;
  if (raw.maxTurns !== undefined) {
    maxTurns = positiveInt(raw.maxTurns, "simulate.maxTurns", problems, MAX_TURNS_LIMIT) ?? DEFAULT_MAX_TURNS;
  }
  const firstMessage = optionalString(raw, "firstMessage", "simulate.", problems, MAX_TEXT);
  if (!persona || !goal) return undefined;
  return { persona, goal, maxTurns, ...(firstMessage ? { firstMessage } : {}) };
}

const COMMON_KEYS = ["name", "language", "context", "clientTools"];

/** Validates one parsed scenario object. Returns the scenario, or the problems found. */
function validateScenario(raw: unknown, file: string, position: number): { scenario?: Scenario; problems: string[] } {
  const label = isObject(raw) && typeof raw.name === "string" && raw.name.trim() ? raw.name : `#${position + 1}`;
  const problems = new Problems(`${file}: scenario "${label}":`);
  if (!isObject(raw)) {
    problems.add("", "must be a JSON object");
    return { problems: problems.list };
  }
  const name = optionalString(raw, "name", "", problems);
  if (name === undefined && raw.name === undefined) problems.add("name", "is required");
  const simulated = raw.simulate !== undefined;
  if (simulated && raw.turns !== undefined) problems.add("", 'has both "turns" and "simulate": pick one kind');
  if (!simulated && raw.turns === undefined) problems.add("", 'needs "turns" (scripted) or "simulate" (simulated)');
  checkKeys(
    raw,
    simulated ? [...COMMON_KEYS, "simulate", "success", "expect"] : [...COMMON_KEYS, "turns"],
    "",
    problems
  );
  const language = optionalString(raw, "language", "", problems, 35);
  const context = optionalString(raw, "context", "", problems, MAX_CONTEXT);
  const clientTools = parseClientTools(raw.clientTools, problems);
  const base = {
    name: name ?? label,
    file,
    clientTools,
    ...(language ? { language } : {}),
    ...(context ? { context } : {})
  };
  let scenario: Scenario | undefined;
  if (simulated) {
    const simulate = parseSimulate(raw.simulate, problems);
    const success = optionalString(raw, "success", "", problems);
    if (success === undefined && raw.success === undefined) {
      problems.add("success", "is required: the judge needs criteria to decide whether the goal was met");
    }
    const expect = parseConversationExpect(raw.expect, "expect", problems);
    if (simulate && success) scenario = { ...base, kind: "simulated", simulate, success, expect };
  } else if (raw.turns !== undefined) {
    const turns = parseTurns(raw.turns, problems);
    if (turns.length) scenario = { ...base, kind: "scripted", turns };
  }
  return problems.list.length ? { problems: problems.list } : { scenario, problems: [] };
}

/** Validates the contents of one scenario file (an object or an array of objects). */
export function parseScenarioFile(text: string, file: string): { scenarios: Scenario[]; problems: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { scenarios: [], problems: [`${file}: not valid JSON (${error instanceof Error ? error.message : error})`] };
  }
  const items = Array.isArray(data) ? data : [data];
  if (items.length === 0) return { scenarios: [], problems: [`${file}: contains no scenarios`] };
  const scenarios: Scenario[] = [];
  const problems: string[] = [];
  items.forEach((item, index) => {
    const result = validateScenario(item, file, index);
    problems.push(...result.problems);
    if (result.scenario) scenarios.push(result.scenario);
  });
  return { scenarios, problems };
}

/** Expands files and directories (`*.json`, not recursive) into a sorted list of files. */
function scenarioFiles(inputs: readonly string[]): { files: string[]; problems: string[] } {
  const files: string[] = [];
  const problems: string[] = [];
  for (const input of inputs) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(input);
    } catch {
      problems.push(`${input}: no such file or directory`);
      continue;
    }
    if (stat.isDirectory()) {
      const found = fs
        .readdirSync(input)
        .filter((entry) => entry.endsWith(".json"))
        .sort()
        .map((entry) => path.join(input, entry));
      if (!found.length) problems.push(`${input}: no *.json scenario files in this directory`);
      files.push(...found);
    } else {
      files.push(input);
    }
  }
  return { files, problems };
}

/** Loads every scenario under the given paths. Any problem anywhere means nothing should run. */
export function loadScenarios(inputs: readonly string[]): { scenarios: Scenario[]; problems: string[] } {
  const expanded = scenarioFiles(inputs);
  const problems = [...expanded.problems];
  const scenarios: Scenario[] = [];
  for (const file of expanded.files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      problems.push(`${file}: cannot be read (${error instanceof Error ? error.message : error})`);
      continue;
    }
    const parsed = parseScenarioFile(text, file);
    scenarios.push(...parsed.scenarios);
    problems.push(...parsed.problems);
  }
  // Report lines and pass rates are keyed by name, so two scenarios may not share one.
  const first = new Map<string, string>();
  for (const scenario of scenarios) {
    const earlier = first.get(scenario.name);
    if (earlier) problems.push(`${scenario.file}: scenario "${scenario.name}" has the same name as one in ${earlier}`);
    else first.set(scenario.name, scenario.file);
  }
  return { scenarios, problems };
}
