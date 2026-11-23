// The flow builder's own arithmetic: where steps sit, how the arrows run, and
// what a change to one step means for the others. No React in here.

type FlowHandoff = { to: string; when?: string };

/** A test of what the tool called on arriving answered. One of the tests, and a path for all but `failed`. */
type FlowCondition = {
  path?: string;
  /** The name of a value of the conversation the test reads, in place of the tool's answer. */
  value?: string;
  is?: string | number | boolean;
  in?: Array<string | number | boolean>;
  above?: number;
  below?: number;
  exists?: boolean;
  failed?: true;
};

export type FlowBranch = { to: string; if?: FlowCondition };

/** What the relay does itself when a conversation comes to a step. */
export type FlowEntry = {
  say?: string;
  call?: { tool: string; arguments?: Record<string, unknown> };
  /** Parts of the tool's answer kept as values: the name of each, and its path in the answer. */
  save?: Record<string, string>;
  next?: FlowBranch[];
};

/** Something the assistant has to get from the user before it hands a conversation to a step. */
export type FlowCollected = {
  name: string;
  description: string;
  type?: "text" | "number" | "boolean";
  required?: boolean;
};

/** A value's name: what the relay takes, and what `{{name}}` can name. */
const VALUE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** The values every conversation has without a step setting them. */
const SESSION_VALUES = ["user.id", "session.id", "channel"];
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)\s*\}\}/g;
/** Names a value cannot have: the relay's own, and the parameters of the handover. */
const TAKEN_NAMES = new Set(["channel", "agent", "values"]);
const BRACES = /\{\{[^{}]*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?\s*\}\}$/;

/** A `{{…}}` that names no value, which the relay refuses: it would be said aloud as it is written. */
function wrongBraces(value: unknown): string | undefined {
  if (typeof value === "string") return (value.match(BRACES) ?? []).find((one) => !WHOLE_PLACEHOLDER.test(one));
  if (Array.isArray(value)) return value.map(wrongBraces).find(Boolean);
  if (value && typeof value === "object") return Object.values(value).map(wrongBraces).find(Boolean);
  return undefined;
}

/** The tests a branch can make, as the builder offers them. `always` is a branch without a condition. */
export const BRANCH_TESTS = ["always", "is", "in", "above", "below", "exists", "missing", "failed"] as const;
export type BranchTest = (typeof BRANCH_TESTS)[number];

export function testOf(branch: FlowBranch): BranchTest {
  const condition = branch.if;
  if (!condition) return "always";
  if (condition.failed) return "failed";
  if (condition.exists !== undefined) return condition.exists ? "exists" : "missing";
  return (["is", "in", "above", "below"] as const).find((test) => condition[test] !== undefined) ?? "is";
}

/** What a branch compares with, as it is typed: one value, or several parted by commas. */
export function valueOf(branch: FlowBranch): string {
  const condition = branch.if;
  if (!condition) return "";
  if (condition.in) return condition.in.join(", ");
  const value = condition.is ?? condition.above ?? condition.below;
  return value === undefined ? "" : String(value);
}

/**
 * A number or true/false when the text is exactly one, else the text. "is" and
 * "is one of" compare as text, so what a number would write differently stays
 * text: "02134" is a postcode, "1.50" a price, and a long id is no number at all.
 */
function typed(text: string): string | number | boolean {
  const value = text.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return value !== "" && String(Number(value)) === value ? Number(value) : value;
}

/**
 * The branch a test, a path and a value make. A number that is none makes a condition the relay will refuse.
 * `ofValue`: the test reads the value of the conversation that `path` names, not the tool's answer.
 */
export function branchOf(to: string, test: BranchTest, path: string, value: string, ofValue = false): FlowBranch {
  if (test === "always") return { to };
  if (test === "failed") return { to, if: { failed: true } };
  const where = ofValue ? { value: path.trim() } : path.trim() ? { path: path.trim() } : {};
  if (test === "exists" || test === "missing") return { to, if: { ...where, exists: test === "exists" } };
  if (test === "in") {
    return {
      to,
      if: {
        ...where,
        in: value
          .split(",")
          .map((one) => one.trim())
          .filter(Boolean)
          .map(typed)
      }
    };
  }
  if (test === "is") return { to, if: { ...where, is: typed(value) } };
  return { to, if: { ...where, [test]: Number(value.trim() === "" ? Number.NaN : value) } };
}

/** A branch's condition in a few words, for the arrow it draws. */
function conditionText(branch: FlowBranch): string {
  const condition = branch.if;
  if (!condition) return "";
  if (condition.failed) return "call failed";
  const what = condition.value !== undefined ? `{{${condition.value}}}` : (condition.path ?? "answer");
  if (condition.exists !== undefined) return `${what} ${condition.exists ? "exists" : "missing"}`;
  if (condition.in) return `${what} in ${condition.in.join(", ")}`;
  if (condition.above !== undefined) return `${what} > ${condition.above}`;
  if (condition.below !== undefined) return `${what} < ${condition.below}`;
  return `${what} = ${String(condition.is)}`;
}

export type FlowStep = {
  id: string;
  description?: string;
  instructions?: string;
  /** Absent: every tool. */
  tools?: string[];
  /** Absent: any step. Empty: none. */
  handoffs?: FlowHandoff[];
  /** What the assistant has to get from the user before it hands a conversation to this step. */
  collect?: FlowCollected[];
  onEnter?: FlowEntry;
  /** The start only: what the relay does itself when a conversation starts, before the model has a turn. */
  onStart?: FlowEntry;
  at?: [number, number];
};

/** The two things a step can do by rule: on a conversation coming to it, and (the start) on one starting. */
const ENTRY_KEYS = ["onEnter", "onStart"] as const;
export type EntryKey = (typeof ENTRY_KEYS)[number];

/** The step every conversation starts in. */
export const START = "main";
export const MAX_STEPS = 12;
const STEP_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
export const NODE = { width: 220, height: 104 } as const;
// Wide enough between two columns for the condition written on an arrow.
const GAP = { x: 180, y: 46 } as const;
const MARGIN = 40;
const CANVAS = 4000;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A place on the canvas: on the grid, and never off it. */
export function snap(x: number, y: number): [number, number] {
  const within = (value: number) => Math.min(CANVAS, Math.max(0, Math.round(value / 10) * 10));
  return [within(x), within(y)];
}

/**
 * Lays every step out afresh: the start on the left, each step one column to
 * the right of the first step that leads to it. Steps no arrow leads to go in
 * the last column.
 */
export function tidy(steps: readonly FlowStep[]): FlowStep[] {
  const depth = new Map<string, number>();
  const queue: string[] = [];
  const start = steps.find((step) => same(step.id, START));
  if (start) {
    depth.set(start.id, 0);
    queue.push(start.id);
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const step = steps.find((candidate) => candidate.id === id);
    for (const handoff of step?.handoffs ?? []) {
      const target = steps.find((candidate) => same(candidate.id, handoff.to));
      if (!target || depth.has(target.id)) continue;
      depth.set(target.id, depth.get(id)! + 1);
      queue.push(target.id);
    }
  }
  const last = Math.max(0, ...depth.values()) + 1;
  const rows = new Map<number, number>();
  return steps.map((step) => {
    const column = depth.get(step.id) ?? last;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      ...step,
      at: [MARGIN + column * (NODE.width + GAP.x), MARGIN + row * (NODE.height + GAP.y)] as [number, number]
    };
  });
}

/** Gives a place to the steps that have none, and leaves the others where they were put. */
export function placed(steps: readonly FlowStep[]): FlowStep[] {
  if (steps.every((step) => step.at)) return [...steps];
  const laid = tidy(steps);
  const taken = (at: [number, number], among: readonly FlowStep[]) =>
    among.some(
      (other) => other.at && Math.abs(other.at[0] - at[0]) < NODE.width && Math.abs(other.at[1] - at[1]) < NODE.height
    );
  const result: FlowStep[] = [];
  for (const [index, step] of steps.entries()) {
    if (step.at) {
      result.push(step);
      continue;
    }
    let at = laid[index]!.at!;
    const others = [...result, ...steps.slice(index + 1).filter((other) => other.at)];
    while (taken(at, others)) at = [at[0], at[1] + NODE.height + GAP.y];
    result.push({ ...step, at });
  }
  return result;
}

/** How large the canvas has to be to hold every step, with room to drag one further. */
export function surfaceSize(steps: readonly FlowStep[]): [number, number] {
  const right = Math.max(0, ...steps.map((step) => (step.at?.[0] ?? 0) + NODE.width));
  const bottom = Math.max(0, ...steps.map((step) => (step.at?.[1] ?? 0) + NODE.height));
  return [right + 160, bottom + 120];
}

export type FlowArrow = {
  from: string;
  to: string;
  when?: string;
  /** True for a branch the relay takes itself on arriving, by what a tool answered. */
  byRule?: true;
  /** An SVG path from the edge of one step to the edge of the other. */
  path: string;
  /** Where the condition is written: the middle of the path. */
  middle: [number, number];
};

/** The curve between two places: out of one step's side and into the other's. */
export function curve(from: [number, number], to: [number, number]): { path: string; middle: [number, number] } {
  const forward = to[0] >= from[0];
  // A step to the left is reached from the left side, a little lower, so an arrow there and one back do not overlap.
  const start: [number, number] = forward
    ? [from[0] + NODE.width, from[1] + NODE.height / 2 - 10]
    : [from[0], from[1] + NODE.height / 2 + 14];
  const end: [number, number] = forward
    ? [to[0], to[1] + NODE.height / 2 - 10]
    : [to[0] + NODE.width, to[1] + NODE.height / 2 + 14];
  const reach = Math.max(50, Math.abs(end[0] - start[0]) / 2) * (forward ? 1 : -1);
  const c1: [number, number] = [start[0] + reach, start[1]];
  const c2: [number, number] = [end[0] - reach, end[1]];
  const middle: [number, number] = [
    Math.round((start[0] + 3 * c1[0] + 3 * c2[0] + end[0]) / 8),
    Math.round((start[1] + 3 * c1[1] + 3 * c2[1] + end[1]) / 8)
  ];
  return { path: `M ${start[0]} ${start[1]} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${end[0]} ${end[1]}`, middle };
}

/** The arrows drawn: one for each handoff written down. A step open to any step has none. */
export function arrowsOf(steps: readonly FlowStep[]): FlowArrow[] {
  const arrows: FlowArrow[] = [];
  for (const step of steps) {
    for (const handoff of step.handoffs ?? []) {
      const target = steps.find((candidate) => same(candidate.id, handoff.to));
      if (!target || !step.at || !target.at) continue;
      arrows.push({
        from: step.id,
        to: target.id,
        ...(handoff.when ? { when: handoff.when } : {}),
        ...curve(step.at, target.at)
      });
    }
    for (const branch of ENTRY_KEYS.flatMap((key) => step[key]?.next ?? [])) {
      const target = steps.find((candidate) => same(candidate.id, branch.to));
      if (!target || !step.at || !target.at) continue;
      // Drawn a little lower than a handoff between the same two steps, so that both can be seen.
      const lower = (at: [number, number]): [number, number] => [at[0], at[1] + 18];
      const text = conditionText(branch);
      arrows.push({
        from: step.id,
        to: target.id,
        byRule: true,
        ...(text ? { when: text } : {}),
        ...curve(lower(step.at), lower(target.at))
      });
    }
  }
  return arrows;
}

/** The step under a point of the canvas, if any: the one drawn last wins. */
export function stepAt(steps: readonly FlowStep[], x: number, y: number): FlowStep | undefined {
  return [...steps]
    .reverse()
    .find(
      (step) =>
        step.at && x >= step.at[0] && x <= step.at[0] + NODE.width && y >= step.at[1] && y <= step.at[1] + NODE.height
    );
}

/** A name nobody has yet: step2, step3 and so on. */
function newStepId(steps: readonly FlowStep[]): string {
  for (let number = steps.length + 1; ; number += 1) {
    const id = `step${number}`;
    if (!steps.some((step) => same(step.id, id))) return id;
  }
}

/** Adds a step to the right of the one it was added from, or of everything. */
export function addStep(steps: readonly FlowStep[], after?: string): FlowStep[] {
  const origin = steps.find((step) => step.id === after)?.at;
  const [right] = surfaceSize(steps);
  let at: [number, number] = origin
    ? [origin[0] + NODE.width + GAP.x, origin[1]]
    : [Math.max(MARGIN, right - 160 + GAP.x), MARGIN];
  while (
    steps.some(
      (step) => step.at && Math.abs(step.at[0] - at[0]) < NODE.width && Math.abs(step.at[1] - at[1]) < NODE.height
    )
  ) {
    at = [at[0], at[1] + NODE.height + GAP.y];
  }
  return [...steps, { id: newStepId(steps), description: "", instructions: "", at: snap(at[0], at[1]) }];
}

/**
 * Why a step cannot take a name, if it cannot: nothing written, not a name the
 * relay takes, the start's own name, or another step's (whatever the case of
 * the letters: the relay tells agents apart without it).
 */
export function nameProblem(
  steps: readonly FlowStep[],
  current: string,
  name: string
): "empty" | "invalid" | "start" | "twice" | undefined {
  if (!name) return "empty";
  if (!STEP_ID.test(name)) return "invalid";
  if (same(name, START)) return "start";
  if (steps.some((step) => step.id !== current && same(step.id, name))) return "twice";
  return undefined;
}

/** Renames a step, and with it every arrow that leads to it. */
export function renameStep(steps: readonly FlowStep[], from: string, to: string): FlowStep[] {
  return steps.map((step) => ({
    ...step,
    ...(step.id === from ? { id: to } : {}),
    ...(step.handoffs
      ? { handoffs: step.handoffs.map((handoff) => (handoff.to === from ? { ...handoff, to } : handoff)) }
      : {}),
    ...withBranches(step, (next) => next.map((branch) => (branch.to === from ? { ...branch, to } : branch)))
  }));
}

/** A step's two entries with their branches changed, where it has any. */
function withBranches(step: FlowStep, change: (next: FlowBranch[]) => FlowBranch[]): Partial<FlowStep> {
  const changed: Partial<FlowStep> = {};
  for (const key of ENTRY_KEYS) {
    const entry = step[key];
    if (entry?.next) changed[key] = { ...entry, next: change(entry.next) };
  }
  return changed;
}

/** Removes a step and the arrows that led to it. The start cannot be removed. */
export function removeStep(steps: readonly FlowStep[], id: string): FlowStep[] {
  if (same(id, START)) return [...steps];
  return steps
    .filter((step) => step.id !== id)
    .map((step) => ({
      ...step,
      ...(step.handoffs ? { handoffs: step.handoffs.filter((handoff) => handoff.to !== id) } : {}),
      ...withBranches(step, (next) => next.filter((branch) => branch.to !== id))
    }));
}

/**
 * Draws an arrow. A step that was open to any step is from then on open only
 * to the ones its arrows lead to: that is what drawing one means.
 */
export function connect(steps: readonly FlowStep[], from: string, to: string): FlowStep[] {
  if (from === to) return [...steps];
  return steps.map((step) => {
    if (step.id !== from) return step;
    const handoffs = step.handoffs ?? [];
    return handoffs.some((handoff) => handoff.to === to)
      ? { ...step, handoffs }
      : { ...step, handoffs: [...handoffs, { to }] };
  });
}

export type FlowProblem = {
  step: string;
  field: "id" | "description" | "instructions" | "handoffs" | "collect" | "onEnter" | "onStart" | "flow";
  kind: string;
  /** The thing the problem is with, where naming it helps: a value, a piece of text. */
  detail?: string;
};

/** What has to be put right before the flow can be saved, in the order of the steps. */
export function flowProblems(steps: readonly FlowStep[]): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const others = steps.filter((step) => !same(step.id, START));
  const start = steps.find((step) => same(step.id, START));
  if (others.length === 0 && start && (start.instructions?.trim() || start.tools || start.handoffs)) {
    problems.push({ step: START, field: "flow", kind: "alone" });
  }
  if (steps.length > MAX_STEPS) problems.push({ step: START, field: "flow", kind: "many" });
  for (const step of steps) {
    if (!STEP_ID.test(step.id)) problems.push({ step: step.id, field: "id", kind: "invalid" });
    else if (steps.some((other) => other !== step && same(other.id, step.id))) {
      problems.push({ step: step.id, field: "id", kind: "twice" });
    }
    if (!same(step.id, START)) {
      if (!step.description?.trim()) problems.push({ step: step.id, field: "description", kind: "missing" });
      if (!step.instructions?.trim()) problems.push({ step: step.id, field: "instructions", kind: "missing" });
    }
    if ((step.description?.trim().length ?? 0) > 400)
      problems.push({ step: step.id, field: "description", kind: "long" });
    if ((step.instructions?.trim().length ?? 0) > 8000)
      problems.push({ step: step.id, field: "instructions", kind: "long" });
    if (step.handoffs?.some((handoff) => (handoff.when?.trim().length ?? 0) > 300)) {
      problems.push({ step: step.id, field: "handoffs", kind: "long" });
    }
    const asked = collectProblem(step, steps);
    if (asked) problems.push({ step: step.id, field: "collect", kind: asked });
    for (const key of ENTRY_KEYS) {
      const unknown = unknownValue(step[key], steps);
      const kind = entryProblem(step, key) ?? (unknown ? "unknownValue" : undefined);
      if (kind) {
        problems.push({
          step: step.id,
          field: key,
          kind,
          ...(kind === "unknownValue" && unknown ? { detail: `{{${unknown}}}` } : {}),
          ...(kind === "placeholder" ? { detail: wrongBraces([step[key]?.say, step[key]?.call?.arguments]) } : {})
        });
      }
    }
  }
  return problems;
}

/** What is wrong with what a step does by rule, as the relay would say it, if anything is. */
function entryProblem(step: FlowStep, key: EntryKey): string | undefined {
  const entry = step[key];
  if (!entry) return undefined;
  if (key === "onStart" && !same(step.id, START)) return "notStart";
  if ((entry.say?.trim().length ?? 0) > 500) return "say";
  if (wrongBraces([entry.say, entry.call?.arguments])) return "placeholder";
  const tool = entry.call?.tool.trim();
  if (entry.call && !tool) return "tool";
  if (tool && step.tools && !step.tools.includes(tool)) return "notOffered";
  const next = entry.next ?? [];
  // A branch that reads the tool's answer needs a tool to answer. One that reads a value does not.
  if (next.some((branch) => branch.if && branch.if.value === undefined) && !tool) return "noCall";
  if (next.some((branch) => branch.if?.value !== undefined && !nameable(branch.if.value))) return "valueName";
  const save = Object.entries(entry.save ?? {});
  if (save.length > 0 && !tool) return "saveNoCall";
  if (save.length > 8) return "saves";
  if (save.some(([name, path]) => !VALUE_NAME.test(name.trim()) || TAKEN_NAMES.has(name.trim()) || !path.trim())) {
    return "save";
  }
  if (next.slice(0, -1).some((branch) => !branch.if)) return "alwaysFirst";
  if (next.length > 8) return "branches";
  for (const branch of next) {
    const condition = branch.if;
    if (!condition || condition.failed || condition.exists !== undefined) continue;
    if (condition.in ? condition.in.length === 0 : condition.is === "") return "value";
    if ((condition.in?.length ?? 0) > 16) return "choices";
    for (const test of ["above", "below"] as const) {
      if (condition[test] !== undefined && !Number.isFinite(condition[test])) return "number";
    }
  }
  return undefined;
}

const nameable = (name: string): boolean => VALUE_NAME.test(name) || SESSION_VALUES.includes(name);

/** What is wrong with what a step asks for first, if anything is. */
function collectProblem(step: FlowStep, steps: readonly FlowStep[]): string | undefined {
  const collect = step.collect ?? [];
  if (collect.length === 0) return undefined;
  if (same(step.id, START)) return "start";
  if (collect.length > 8) return "many";
  if (collect.some((value) => !VALUE_NAME.test(value.name.trim()) || TAKEN_NAMES.has(value.name.trim()))) {
    return "name";
  }
  if (new Set(collect.map((value) => value.name.trim())).size < collect.length) return "twice";
  if (collect.some((value) => !value.description.trim() || value.description.trim().length > 200)) return "description";
  // One name is one value: asked of the user or kept from a tool, and of one type wherever it is asked for.
  const kept = new Set(
    steps.flatMap((other) =>
      ENTRY_KEYS.flatMap((key) => Object.keys(other[key]?.save ?? {}).map((name) => name.trim()))
    )
  );
  if (collect.some((value) => kept.has(value.name.trim()))) return "kept";
  const types = new Map<string, string>();
  for (const other of steps) {
    for (const value of other.collect ?? []) {
      const name = value.name.trim();
      const type = types.get(name) ?? value.type ?? "text";
      types.set(name, type);
      if (other === step && type !== (value.type ?? "text")) return "types";
    }
    if (other === step) break;
  }
  return undefined;
}

function namesInside(value: unknown, into: Set<string>): void {
  if (typeof value === "string") for (const match of value.matchAll(PLACEHOLDER)) into.add(match[1]!);
  else if (Array.isArray(value)) for (const one of value) namesInside(one, into);
  else if (value && typeof value === "object") for (const one of Object.values(value)) namesInside(one, into);
}

/** The first value a step reads that no step collects or saves: the relay would refuse the step for it. */
function unknownValue(entry: FlowEntry | undefined, steps: readonly FlowStep[]): string | undefined {
  if (!entry) return undefined;
  const set = new Set(SESSION_VALUES);
  for (const other of steps) {
    for (const value of other.collect ?? []) set.add(value.name.trim());
    for (const key of ENTRY_KEYS) for (const name of Object.keys(other[key]?.save ?? {})) set.add(name.trim());
  }
  const reads = new Set<string>();
  namesInside(entry.say, reads);
  namesInside(entry.call?.arguments, reads);
  for (const branch of entry.next ?? []) if (branch.if?.value) reads.add(branch.if.value);
  return [...reads].find((name) => !set.has(name));
}

/** A step's `onEnter` as the relay takes it: nothing of it when nothing is written in it. */
function entryToSave(entry: FlowEntry | undefined): FlowEntry | undefined {
  if (!entry) return undefined;
  const say = entry.say?.replace(/\s+/g, " ").trim();
  const tool = entry.call?.tool.trim();
  const save = Object.entries(entry.save ?? {}).map(([name, path]) => [name.trim(), path.trim()] as const);
  const saved: FlowEntry = {
    ...(say ? { say } : {}),
    ...(tool ? { call: { tool, arguments: entry.call?.arguments ?? {} } } : {}),
    ...(save.length > 0 ? { save: Object.fromEntries(save) } : {}),
    ...(entry.next?.length ? { next: entry.next } : {})
  };
  return Object.keys(saved).length > 0 ? saved : undefined;
}

export type FlowWarning = { step: string; kind: "ends" | "unreachable" };

/**
 * What can be saved but is probably not meant: a start that leads nowhere
 * although there are other steps, and steps no arrow leads to from the start.
 */
export function flowWarnings(steps: readonly FlowStep[]): FlowWarning[] {
  const start = steps.find((step) => same(step.id, START));
  if (!start || steps.length < 2) return [];
  if (start.handoffs?.length === 0) return [{ step: start.id, kind: "ends" }];
  const reached = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const step = queue.pop()!;
    if (reached.has(step.id)) continue;
    reached.add(step.id);
    // Without arrows of its own a step is open to every other.
    const byRule = ENTRY_KEYS.flatMap((key) => step[key]?.next ?? []);
    const next = step.handoffs
      ? steps.filter((other) => [...step.handoffs!, ...byRule].some((arrow) => same(arrow.to, other.id)))
      : steps;
    queue.push(...next.filter((other) => !reached.has(other.id)));
  }
  return steps.filter((step) => !reached.has(step.id)).map((step) => ({ step: step.id, kind: "unreachable" as const }));
}

/** The steps as the relay takes them: trimmed, and without what is empty. */
export function flowToSave(steps: readonly FlowStep[]): FlowStep[] {
  return steps.map((step) => ({
    id: step.id.trim(),
    ...(step.description?.trim() ? { description: step.description.trim() } : {}),
    ...(step.instructions?.trim() ? { instructions: step.instructions.trim() } : {}),
    ...(step.tools ? { tools: step.tools } : {}),
    ...(step.handoffs
      ? {
          handoffs: step.handoffs.map((handoff) => ({
            to: handoff.to,
            ...(handoff.when?.trim() ? { when: handoff.when.trim() } : {})
          }))
        }
      : {}),
    ...(step.collect?.length
      ? {
          collect: step.collect.map((value) => ({
            name: value.name.trim(),
            description: value.description.replace(/\s+/g, " ").trim(),
            type: value.type ?? "text",
            required: value.required !== false
          }))
        }
      : {}),
    ...(entryToSave(step.onEnter) ? { onEnter: entryToSave(step.onEnter) } : {}),
    ...(entryToSave(step.onStart) ? { onStart: entryToSave(step.onStart) } : {}),
    ...(step.at ? { at: step.at } : {})
  }));
}
