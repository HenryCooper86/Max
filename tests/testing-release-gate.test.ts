import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("release gate command", () => {
  const candidate = "abcdef0123456789abcdef0123456789abcdef01";
  let server: http.Server;
  let url = "";

  beforeAll(async () => {
    // A QA relay whose release gate passed for, and whose administrator approved, `candidate`.
    server = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/testing/summary") {
        response.end(
          JSON.stringify({
            ok: true,
            testing: { releaseGate: { build: candidate, status: "pass" }, regression: noBaselineRegression }
          })
        );
      } else {
        response.end(
          JSON.stringify({ ok: true, operations: { approvedBaselineBuild: candidate, activePolicy: { version: 1 } } })
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /** Runs the command with only the given CI variables, as a CI job or an operator would. */
  function gate(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; stderr: string }>();
    const child = spawn(path.resolve("node_modules/.bin/tsx"), [path.resolve("scripts/testing-release-gate.ts")], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TESTING_GATE_URL: url, ...env }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stderr }));
    return promise;
  }

  it("refuses to decide without a candidate build", async () => {
    const result = await gate({});
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("No candidate build");
  });

  it("takes the candidate from GitHub Actions and holds it to the approved build", async () => {
    expect((await gate({ GITHUB_SHA: candidate })).code).toBe(0);
    expect((await gate({ GITHUB_SHA: "1234567890abcdef1234567890abcdef12345678" })).code).toBe(1);
  });
});
