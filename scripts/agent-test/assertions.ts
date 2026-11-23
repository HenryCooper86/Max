import type { ConversationExpect, TurnExpect } from "./scenario";

/** One tool call as the test client saw it. */
export type ToolActivityRecord = {
  callId: string;
  name: string;
  where: "server" | "client";
  state: "started" | "succeeded" | "failed";
  durationMs?: number;
  error?: string;
};

/** A `tool.call` the test client answered. */
export type ClientCallRecord = {
  callId: string;
  name: string;
  arguments: unknown;
  /** What was sent back: a declared tool's result or error, or the refusal for an undeclared one. */
  answer: { output?: unknown; error?: string };
};

/** Everything seen between sending one typed turn and the agent finishing its reply. */
export type TurnRecord = {
  user: string;
  /** The agent's final transcripts joined in order (a line before a tool call, one after). */
  reply: string;
  replies: string[];
  activity: ToolActivityRecord[];
  calls: ClientCallRecord[];
  telemetry: Record<string, unknown>[];
  errors: string[];
  /** Time from sending the turn to the last final reply, when there was one. */
  latencyMs?: number;
  /** Why the relay ended the conversation during this turn, when it did. */
  sessionEnded?: string;
  /** Set when the turn did not complete (timeout, connection lost). */
  failure?: string;
};

export type AssertionResult = {
  /** Which check: `toolCalled`, `replyContains`, ... */
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  message: string;
};

function result(name: string, pass: boolean, expected: string, actual: string): AssertionResult {
  return {
    name,
    pass,
    expected,
    actual,
    message: pass ? `${name} ok` : `${name}: expected ${expected}, got ${actual}`
  };
}

const quote = (items: readonly string[]) => items.map((item) => `"${item}"`).join(", ");

/** Names of tools that ran, from both the activity feed and the calls we answered. */
function toolsCalled(turns: readonly TurnRecord[]): string[] {
  const names = new Set<string>();
  for (const turn of turns) {
    for (const activity of turn.activity) if (activity.state === "started") names.add(activity.name);
    for (const call of turn.calls) names.add(call.name);
  }
  return [...names];
}

/** True when every key in `expected` is present in `actual` with an equal value; objects compare as subsets, all else deeply equal. */
export function subsetMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") return expected === actual;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => subsetMatch(item, actual[index]))
    );
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => subsetMatch(value, (actual as Record<string, unknown>)[key]));
}

function checkToolLists(
  expect: { toolCalled?: string[]; toolNotCalled?: string[] },
  called: readonly string[],
  scope: string
): AssertionResult[] {
  const out: AssertionResult[] = [];
  const actual = called.length ? quote(called) : "no tools called";
  if (expect.toolCalled) {
    const missing = expect.toolCalled.filter((name) => !called.includes(name));
    out.push(result("toolCalled", !missing.length, `${quote(expect.toolCalled)} called${scope}`, actual));
  }
  if (expect.toolNotCalled) {
    const unwanted = expect.toolNotCalled.filter((name) => called.includes(name));
    out.push(
      result(
        "toolNotCalled",
        !unwanted.length,
        `${quote(expect.toolNotCalled)} not called${scope}`,
        unwanted.length ? `${quote(unwanted)} was called` : actual
      )
    );
  }
  return out;
}

/**
 * Checks everything in a turn's `expect` except `judge`, which needs a model and
 * is run by the runner. `clientToolNames` is the set the scenario declared: the
 * relay never sends server-tool arguments to a client, so `toolArgs` can only
 * be checked for those, and saying so beats a confusing "arguments not found".
 */
export function checkTurn(
  expect: TurnExpect,
  turn: TurnRecord,
  clientToolNames: ReadonlySet<string>
): AssertionResult[] {
  const out = checkToolLists(expect, toolsCalled([turn]), " this turn");
  if (expect.toolArgs) {
    for (const [tool, wanted] of Object.entries(expect.toolArgs)) {
      const label = `toolArgs ${tool}`;
      if (!clientToolNames.has(tool)) {
        out.push(
          result(
            label,
            false,
            `arguments ${JSON.stringify(wanted)}`,
            `"${tool}" is not a declared client tool, and the relay does not send server-tool arguments to clients, so they cannot be checked (declare it under clientTools, or drop toolArgs)`
          )
        );
        continue;
      }
      const calls = turn.calls.filter((call) => call.name === tool);
      const pass = calls.some((call) => subsetMatch(wanted, call.arguments));
      out.push(
        result(
          label,
          pass,
          `arguments including ${JSON.stringify(wanted)}`,
          calls.length ? calls.map((call) => JSON.stringify(call.arguments)).join(" | ") : `"${tool}" was not called`
        )
      );
    }
  }
  if (expect.sessionEnded !== undefined) {
    const wanted = expect.sessionEnded;
    const pass =
      wanted === true
        ? turn.sessionEnded !== undefined
        : wanted === false
          ? turn.sessionEnded === undefined
          : turn.sessionEnded === wanted;
    out.push(
      result(
        "sessionEnded",
        pass,
        wanted === true
          ? "the relay ending the conversation"
          : wanted === false
            ? "the conversation still open"
            : `the relay ending the conversation with reason "${wanted}"`,
        turn.sessionEnded !== undefined ? `ended with reason "${turn.sessionEnded}"` : "the conversation is still open"
      )
    );
  }
  const reply = turn.reply.toLowerCase();
  if (expect.replyContains) {
    const missing = expect.replyContains.filter((text) => !reply.includes(text.toLowerCase()));
    out.push(
      result(
        "replyContains",
        !missing.length,
        `reply containing ${quote(expect.replyContains)}`,
        missing.length ? `missing ${quote(missing)} in "${turn.reply}"` : "all present"
      )
    );
  }
  if (expect.replyNotContains) {
    const found = expect.replyNotContains.filter((text) => reply.includes(text.toLowerCase()));
    out.push(
      result(
        "replyNotContains",
        !found.length,
        `reply not containing ${quote(expect.replyNotContains)}`,
        found.length ? `found ${quote(found)} in "${turn.reply}"` : "none present"
      )
    );
  }
  if (expect.replyMatches !== undefined) {
    out.push(
      result(
        "replyMatches",
        new RegExp(expect.replyMatches, "i").test(turn.reply),
        `reply matching /${expect.replyMatches}/i`,
        `"${turn.reply}"`
      )
    );
  }
  if (expect.withinMs !== undefined) {
    out.push(
      result(
        "withinMs",
        turn.latencyMs !== undefined && turn.latencyMs <= expect.withinMs,
        `a reply within ${expect.withinMs} ms`,
        turn.latencyMs === undefined ? "no reply" : `${turn.latencyMs} ms`
      )
    );
  }
  return out;
}

/** Whole-conversation checks for simulated scenarios. */
export function checkConversation(expect: ConversationExpect, turns: readonly TurnRecord[]): AssertionResult[] {
  const out = checkToolLists(expect, toolsCalled(turns), " in the conversation");
  if (expect.maxTurns !== undefined) {
    out.push(
      result("maxTurns", turns.length <= expect.maxTurns, `at most ${expect.maxTurns} turns`, `${turns.length} turns`)
    );
  }
  return out;
}
