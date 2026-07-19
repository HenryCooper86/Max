import { describe, expect, it } from "vitest";
import { evaluateTestingReleaseDecision } from "../scripts/testing-release-decision";

const passingGate = { build: "abcdef012345", status: "pass" as const };
const noBaselineRegression = { baselineSource: "none" as const, status: "insufficient" as const };

describe("live testing release decision", () => {
  it("requires administrator approval for the exact candidate build", () => {
    expect(
      evaluateTestingReleaseDecision({
        releaseGate: passingGate,
        regression: noBaselineRegression,
        expectedBuild: "abcdef012345"
      })
    ).toMatchObject({ passed: false, buildMatches: true, approvalMatches: false });

    expect(
      evaluateTestingReleaseDecision({
        releaseGate: passingGate,
        regression: noBaselineRegression,
        approvedBaselineBuild: "123456789abc",
        expectedBuild: "abcdef012345"
      })
    ).toMatchObject({ passed: false, approvalMatches: false });

    expect(
      evaluateTestingReleaseDecision({
        releaseGate: passingGate,
        regression: noBaselineRegression,
        approvedBaselineBuild: "abcdef0123456789abcdef0123456789abcdef01",
        expectedBuild: "abcdef0123456789abcdef0123456789abcdef01"
      })
    ).toMatchObject({ passed: true, buildMatches: true, approvalMatches: true });
  });

  it("still blocks a mismatched CI build, failed gate, or failed regression", () => {
    const approvedBaselineBuild = "abcdef012345";
    expect(
      evaluateTestingReleaseDecision({
        releaseGate: passingGate,
        regression: noBaselineRegression,
        approvedBaselineBuild,
        expectedBuild: "123456789abc"
      }).passed
    ).toBe(false);
    expect(
      evaluateTestingReleaseDecision({
        releaseGate: { ...passingGate, status: "watch" },
        regression: noBaselineRegression,
        approvedBaselineBuild
      }).passed
    ).toBe(false);
    expect(
      evaluateTestingReleaseDecision({
        releaseGate: passingGate,
        regression: { baselineSource: "approved", status: "fail" },
        approvedBaselineBuild
      }).passed
    ).toBe(false);
  });
});
