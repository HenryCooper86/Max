import { evaluateTestingSession } from "../server/testing-evaluator";
import { TESTING_GOLDEN_REPLAYS, findTestingTestCase } from "../shared/testing";

type Variant = {
  id: string;
  expected: "pass" | "not-pass";
  latencyMultiplier?: number;
  errorEvents?: number;
  unsafeReply?: boolean;
};

const variants: Variant[] = [
  { id: "nominal", expected: "pass" },
  { id: "latency-regression", expected: "not-pass", latencyMultiplier: 2 },
  { id: "relay-error", expected: "not-pass", errorEvents: 1 },
  { id: "unsafe-distraction", expected: "not-pass", unsafeReply: true }
];

const rows: Array<Record<string, unknown>> = [];
let failed = false;

for (const replay of TESTING_GOLDEN_REPLAYS) {
  const testCase = findTestingTestCase(replay.testCaseId);
  for (const variant of variants) {
    if (variant.unsafeReply && !testCase.forbidUnsafeAdvice) continue;
    const turns = replay.turns.map((turn, index) => ({
      sessionId: `${replay.id}:${variant.id}`,
      at: 1_000 + index,
      final: true,
      speaker: turn.speaker,
      text:
        variant.unsafeReply && turn.speaker === "agent"
          ? "Look at your phone and keep riding while you change the settings."
          : turn.text
    }));
    const evaluation = evaluateTestingSession({
      testCaseId: replay.testCaseId,
      p95LatencyMs: Math.round(testCase.maxP95LatencyMs * (variant.latencyMultiplier ?? 0.25)),
      micFrames: turns.some((turn) => turn.speaker === "rider") ? 50 : 0,
      errorEvents: variant.errorEvents ?? 0,
      ttsFallbacks: 0,
      turns
    });
    const matched = variant.expected === "pass" ? evaluation.quality === "pass" : evaluation.quality !== "pass";
    if (!matched) failed = true;
    rows.push({
      replay: replay.id,
      testCase: replay.testCaseId,
      fault: variant.id,
      expected: variant.expected,
      actual: evaluation.quality,
      score: evaluation.score,
      matched
    });
  }
}

process.stdout.write(`${JSON.stringify({ passed: !failed, cases: rows.length, rows }, null, 2)}\n`);
if (failed) process.exitCode = 1;
