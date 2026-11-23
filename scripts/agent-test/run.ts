import { checkConversation, checkTurn, type AssertionResult, type TurnRecord } from "./assertions";
import { openSession, type AgentTestClient, type ClientOptions } from "./client";
import { NO_MODEL_MESSAGE, judge, simulateUserTurn, type ModelSettings, type TranscriptLine } from "./model";
import type { Scenario, ScriptedScenario, SimulatedScenario } from "./scenario";

/**
 * Plays scenarios against a relay and turns what happened into a result that
 * the report prints and writes. Each run gets its own session, so runs cannot
 * leak state into each other and can safely run side by side.
 */

export type RunOptions = {
  relayUrl: string;
  token?: string;
  tokenUrl?: string;
  settleMs?: number;
  turnTimeoutMs?: number;
  /** For the judge and the simulated user. Without it, scenarios that need one fail and the rest still run. */
  judgeModel?: ModelSettings;
  userModel?: ModelSettings;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

export type TurnResult = TurnRecord & {
  assertions: AssertionResult[];
  judge?: { criterion: string; pass: boolean; reason: string };
};

export type RunResult = {
  scenario: string;
  file: string;
  kind: "scripted" | "simulated";
  /** 1-based repeat number. */
  run: number;
  pass: boolean;
  durationMs: number;
  greeting?: string;
  turns: TurnResult[];
  /** Whole-conversation checks (simulated scenarios). */
  assertions: AssertionResult[];
  /** The verdict on a simulated scenario's `success` criteria. */
  success?: { criterion: string; pass: boolean; reason: string };
  /** Why the run could not be carried out (connection, validation of the environment). */
  error?: string;
};

function transcriptLines(turns: readonly TurnRecord[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const turn of turns) {
    lines.push({ role: "user", text: turn.user });
    for (const activity of turn.activity) {
      if (activity.state === "started") continue;
      const call = turn.calls.find((c) => c.callId === activity.callId);
      const args = call ? ` with arguments ${JSON.stringify(call.arguments)}` : "";
      lines.push({
        role: "tool",
        text: `${activity.name} (${activity.where} tool)${args} ${activity.state}${activity.error ? `: ${activity.error}` : ""}`
      });
    }
    if (turn.reply) lines.push({ role: "agent", text: turn.reply });
  }
  return lines;
}

function clientOptions(scenario: Scenario, options: RunOptions): ClientOptions {
  return {
    relayUrl: options.relayUrl,
    ...(options.token ? { token: options.token } : {}),
    ...(options.tokenUrl ? { tokenUrl: options.tokenUrl } : {}),
    clientTools: scenario.clientTools,
    ...(scenario.context ? { context: scenario.context } : {}),
    ...(scenario.language ? { language: scenario.language } : {}),
    ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.log ? { log: options.log } : {})
  };
}

function failed(name: string, message: string): AssertionResult {
  return { name, pass: false, expected: "a passing check", actual: message, message: `${name}: ${message}` };
}

async function runJudge(
  criterion: string,
  turns: readonly TurnRecord[],
  options: RunOptions
): Promise<{ criterion: string; pass: boolean; reason: string }> {
  if (!options.judgeModel) return { criterion, pass: false, reason: `the judge ${NO_MODEL_MESSAGE}` };
  try {
    const verdict = await judge(options.judgeModel, criterion, transcriptLines(turns), {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
    return { criterion, ...verdict };
  } catch (error) {
    return { criterion, pass: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function judgeAssertion(
  criterion: string,
  turns: readonly TurnRecord[],
  options: RunOptions
): Promise<{ verdict: { criterion: string; pass: boolean; reason: string }; assertion: AssertionResult }> {
  const verdict = await runJudge(criterion, turns, options);
  return {
    verdict,
    assertion: {
      name: "judge",
      pass: verdict.pass,
      expected: criterion,
      actual: verdict.reason,
      message: verdict.pass ? "judge ok" : `judge: ${verdict.reason}`
    }
  };
}

async function runScripted(
  scenario: ScriptedScenario,
  options: RunOptions,
  client: AgentTestClient
): Promise<TurnResult[]> {
  const clientToolNames = new Set(scenario.clientTools.map((tool) => tool.name));
  const results: TurnResult[] = [];
  for (const step of scenario.turns) {
    // A turn that expects the relay to end the conversation waits for the end, not only the reply.
    const awaitEnd = step.expect.sessionEnded === true || typeof step.expect.sessionEnded === "string";
    const record = await client.sendTurn(step.user, { awaitEnd });
    const assertions = record.failure
      ? [failed("turn", record.failure)]
      : checkTurn(step.expect, record, clientToolNames);
    const result: TurnResult = { ...record, assertions };
    if (!record.failure && step.expect.judge) {
      // The judge sees the whole conversation so far, so a criterion can refer back to earlier turns.
      const { verdict, assertion } = await judgeAssertion(step.expect.judge, [...results, record], options);
      result.judge = verdict;
      assertions.push(assertion);
    }
    results.push(result);
    if (record.failure) break; // the session is in an unknown state: later turns would only add noise
  }
  return results;
}

async function runSimulated(
  scenario: SimulatedScenario,
  options: RunOptions,
  client: AgentTestClient
): Promise<{ turns: TurnResult[]; error?: string }> {
  const { persona, goal, maxTurns, firstMessage } = scenario.simulate;
  const turns: TurnResult[] = [];
  const history: { speaker: "user" | "agent"; text: string }[] = [];
  const nextUser = async (): Promise<{ done: boolean; text: string }> => {
    if (!options.userModel) throw new Error(`the simulated user ${NO_MODEL_MESSAGE}`);
    return simulateUserTurn(options.userModel, { persona, goal }, history, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
  };
  try {
    let next = firstMessage ? { done: false, text: firstMessage } : await nextUser();
    while (!next.done && turns.length < maxTurns) {
      const text = next.text.slice(0, 2000);
      const record = await client.sendTurn(text);
      turns.push({ ...record, assertions: record.failure ? [failed("turn", record.failure)] : [] });
      if (record.failure) break;
      history.push({ speaker: "user", text }, { speaker: "agent", text: record.reply });
      if (turns.length >= maxTurns) break;
      next = await nextUser();
    }
  } catch (error) {
    return { turns, error: error instanceof Error ? error.message : String(error) };
  }
  return { turns };
}

/** Runs one scenario once, in its own session. Never throws. */
export async function runScenario(scenario: Scenario, options: RunOptions, run = 1): Promise<RunResult> {
  const startedAt = Date.now();
  const base = { scenario: scenario.name, file: scenario.file, kind: scenario.kind, run } as const;
  const finish = (
    partial: Omit<RunResult, "scenario" | "file" | "kind" | "run" | "durationMs" | "pass">
  ): RunResult => {
    const turnFailed = partial.turns.some((turn) => !turn.assertions.every((a) => a.pass));
    const pass =
      !partial.error &&
      !turnFailed &&
      partial.assertions.every((a) => a.pass) &&
      (partial.success?.pass ?? true) &&
      partial.turns.length > 0;
    return { ...base, ...partial, pass, durationMs: Date.now() - startedAt };
  };
  if (scenario.kind === "simulated" && !options.userModel) {
    return finish({ turns: [], assertions: [], error: `the simulated user ${NO_MODEL_MESSAGE}` });
  }
  let client: AgentTestClient;
  try {
    client = await openSession(clientOptions(scenario, options));
  } catch (error) {
    return finish({ turns: [], assertions: [], error: error instanceof Error ? error.message : String(error) });
  }
  try {
    const greeting = client.greeting;
    if (scenario.kind === "scripted") {
      const turns = await runScripted(scenario, options, client);
      return finish({ turns, assertions: [], ...(greeting ? { greeting } : {}) });
    }
    const { turns, error } = await runSimulated(scenario, options, client);
    const assertions = checkConversation(scenario.expect, turns);
    const success = turns.length ? await runJudge(scenario.success, turns, options) : undefined;
    return finish({
      turns,
      assertions,
      ...(success ? { success } : {}),
      ...(error ? { error } : {}),
      ...(greeting ? { greeting } : {})
    });
  } finally {
    await client.close();
  }
}

/** Runs every scenario `repeat` times with at most `concurrency` sessions at once; `onResult` fires as each finishes. */
export async function runAll(
  scenarios: readonly Scenario[],
  options: RunOptions,
  settings: { repeat: number; concurrency: number; onResult?: (result: RunResult) => void }
): Promise<RunResult[]> {
  const jobs = scenarios.flatMap((scenario) =>
    Array.from({ length: settings.repeat }, (_, index) => ({ scenario, run: index + 1 }))
  );
  const results: RunResult[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index]!;
      const result = await runScenario(job.scenario, options, job.run);
      results[index] = result;
      settings.onResult?.(result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(settings.concurrency, jobs.length)) }, worker));
  return results;
}
