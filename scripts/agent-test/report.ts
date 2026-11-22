import type { AssertionResult } from "./assertions";
import type { RunResult, TurnResult } from "./run";

/** Nearest-rank percentile of a list of numbers (`p` in 0-100). Undefined for an empty list. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

type ScenarioSummary = { name: string; runs: number; passed: number; passRate: number };

export type Summary = {
  runs: number;
  passed: number;
  failed: number;
  scenarios: ScenarioSummary[];
  /** Reply latency across every completed turn of every run. */
  latencyMs: { samples: number; p50?: number; p95?: number };
  allPassed: boolean;
};

export function summarize(results: readonly RunResult[]): Summary {
  const byName = new Map<string, ScenarioSummary>();
  for (const result of results) {
    const entry = byName.get(result.scenario) ?? { name: result.scenario, runs: 0, passed: 0, passRate: 0 };
    entry.runs += 1;
    if (result.pass) entry.passed += 1;
    entry.passRate = entry.passed / entry.runs;
    byName.set(result.scenario, entry);
  }
  const latencies = results.flatMap((result) =>
    result.turns.flatMap((turn) => (turn.latencyMs === undefined ? [] : [turn.latencyMs]))
  );
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const passed = results.filter((result) => result.pass).length;
  return {
    runs: results.length,
    passed,
    failed: results.length - passed,
    scenarios: [...byName.values()],
    latencyMs: {
      samples: latencies.length,
      ...(p50 !== undefined ? { p50 } : {}),
      ...(p95 !== undefined ? { p95 } : {})
    },
    allPassed: results.length > 0 && passed === results.length
  };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function formatRunLine(result: RunResult, repeated = false): string {
  return `${result.pass ? "✓" : "✗"} ${result.scenario}${repeated ? ` #${result.run}` : ""}  ${seconds(result.durationMs)}`;
}

function excerpt(turn: TurnResult, index: number): string[] {
  const lines = [
    `      turn ${index + 1} user:  ${clip(turn.user)}`,
    `      turn ${index + 1} agent: ${clip(turn.reply || "(no reply)")}`
  ];
  for (const activity of turn.activity) {
    if (activity.state !== "started") {
      lines.push(
        `      tool ${activity.name} (${activity.where}) ${activity.state}${activity.error ? `: ${activity.error}` : ""}`
      );
    }
  }
  return lines;
}

function failedAssertion(assertion: AssertionResult): string[] {
  return [
    `    - ${assertion.name}`,
    `      expected: ${clip(assertion.expected)}`,
    `      actual:   ${clip(assertion.actual)}`
  ];
}

/** The detail printed under a failed run: each failed assertion with expected vs actual and the transcript around it. */
export function formatFailure(result: RunResult): string[] {
  const lines: string[] = [];
  if (result.error) lines.push(`    error: ${result.error}`);
  if (!result.turns.length && !result.error) lines.push("    no turns were run");
  result.turns.forEach((turn, index) => {
    const bad = turn.assertions.filter((a) => !a.pass);
    if (!bad.length) return;
    for (const assertion of bad) lines.push(...failedAssertion(assertion));
    lines.push(...excerpt(turn, index));
  });
  for (const assertion of result.assertions.filter((a) => !a.pass)) lines.push(...failedAssertion(assertion));
  if (result.success && !result.success.pass) {
    lines.push(
      "    - success criteria",
      `      expected: ${clip(result.success.criterion)}`,
      `      judge:    ${clip(result.success.reason)}`
    );
    const last = result.turns.length - 1;
    if (last >= 0) lines.push(...excerpt(result.turns[last]!, last));
  }
  return lines;
}

export function formatSummary(summary: Summary, repeated: boolean): string[] {
  const lines = [`${summary.passed}/${summary.runs} runs passed`];
  if (repeated) {
    for (const scenario of summary.scenarios) {
      lines.push(`  ${Math.round(scenario.passRate * 100)}%  ${scenario.name} (${scenario.passed}/${scenario.runs})`);
    }
  }
  const { p50, p95, samples } = summary.latencyMs;
  if (samples && p50 !== undefined && p95 !== undefined) {
    lines.push(`reply latency over ${samples} turn(s): p50 ${p50} ms, p95 ${p95} ms`);
  }
  return lines;
}

/** Removes the query string and credentials from a URL so a token in `?token=` never reaches a report. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "(unparseable)";
  }
}

export function buildReport(results: readonly RunResult[], meta: { relay: string; repeat: number }) {
  return {
    generatedAt: new Date().toISOString(),
    relay: redactUrl(meta.relay),
    repeat: meta.repeat,
    summary: summarize(results),
    runs: results
  };
}
