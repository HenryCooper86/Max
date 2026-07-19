import type { TestingRegressionSummary, TestingReleaseGate } from "../shared/testing";
import { testingBuildsMatch } from "../shared/testing";

type ReleaseDecisionInput = {
  releaseGate: Pick<TestingReleaseGate, "build" | "status">;
  regression: Pick<TestingRegressionSummary, "baselineSource" | "status">;
  approvedBaselineBuild?: string;
  expectedBuild?: string;
};

export type TestingReleaseDecision = {
  passed: boolean;
  buildMatches: boolean;
  approvalMatches: boolean;
  baselineRequired: boolean;
};

export function evaluateTestingReleaseDecision({
  releaseGate,
  regression,
  approvedBaselineBuild,
  expectedBuild
}: ReleaseDecisionInput): TestingReleaseDecision {
  const baselineRequired = regression.baselineSource !== "none";
  const buildMatches = !expectedBuild || testingBuildsMatch(releaseGate.build, expectedBuild);
  const approvalMatches = Boolean(
    approvedBaselineBuild && testingBuildsMatch(releaseGate.build, approvedBaselineBuild)
  );
  const passed =
    buildMatches &&
    approvalMatches &&
    releaseGate.status === "pass" &&
    (!baselineRequired || regression.status === "pass");

  return { passed, buildMatches, approvalMatches, baselineRequired };
}
