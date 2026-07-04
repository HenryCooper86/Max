import { describe, expect, it } from "vitest";
import { evaluateTestingSession } from "../server/testing-evaluator";
import { TESTING_GOLDEN_REPLAYS } from "../shared/testing";

describe("golden replay fixtures", () => {
  it("keeps all golden replay scripts passing deterministic evaluation", () => {
    for (const replay of TESTING_GOLDEN_REPLAYS) {
      const evaluation = evaluateTestingSession({
        testCaseId: replay.testCaseId,
        p95LatencyMs: 180,
        micFrames: replay.turns.some((turn) => turn.speaker === "rider") ? 5 : 0,
        errorEvents: 0,
        ttsFallbacks: 0,
        turns: replay.turns.map((turn, index) => ({
          sessionId: replay.id,
          at: 1_000 + index,
          final: true,
          speaker: turn.speaker,
          text: turn.text
        }))
      });

      expect(evaluation.quality, `${replay.id}: ${evaluation.checks.map((check) => check.detail).join("; ")}`).toBe(
        "pass"
      );
    }
  });
});
