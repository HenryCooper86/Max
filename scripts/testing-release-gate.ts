import fs from "node:fs";
import path from "node:path";
import type { TestingStats } from "../shared/agent";

const baseUrl = (process.env.TESTING_GATE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.TESTING_GATE_TOKEN?.trim() ?? "";
const outputPath = process.env.TESTING_GATE_REPORT?.trim();
const expectedBuild = (process.env.TESTING_GATE_EXPECTED_BUILD ?? process.env.CI_COMMIT_SHA)?.trim();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);

try {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const [response, operationsResponse] = await Promise.all([
    fetch(`${baseUrl}/testing/summary`, { headers, signal: controller.signal }),
    fetch(`${baseUrl}/testing/operations`, { headers, signal: controller.signal })
  ]);
  if (!response.ok) throw new Error(`Testing summary returned HTTP ${response.status}`);
  if (!operationsResponse.ok) throw new Error(`Testing operations returned HTTP ${operationsResponse.status}`);
  const payload = (await response.json()) as { ok?: boolean; testing?: TestingStats };
  const operationsPayload = (await operationsResponse.json()) as {
    ok?: boolean;
    operations?: TestingStats["operations"];
  };
  if (!payload.ok || !payload.testing) throw new Error("Testing summary payload is incomplete");
  if (!operationsPayload.ok || !operationsPayload.operations) {
    throw new Error("Testing operations payload is incomplete");
  }

  const { releaseGate, regression } = payload.testing;
  const operations = operationsPayload.operations;
  const baselineRequired = regression.baselineSource !== "none";
  const buildMatches =
    !expectedBuild ||
    releaseGate.build === expectedBuild ||
    (releaseGate.build.length >= 7 &&
      expectedBuild.length >= 7 &&
      (releaseGate.build.startsWith(expectedBuild) || expectedBuild.startsWith(releaseGate.build)));
  const passed = buildMatches && releaseGate.status === "pass" && (!baselineRequired || regression.status === "pass");
  const report = {
    generatedAt: new Date().toISOString(),
    passed,
    build: releaseGate.build,
    expectedBuild,
    buildMatches,
    policyVersion: operations?.activePolicy.version,
    approvedBaselineBuild: operations?.approvedBaselineBuild,
    releaseGate,
    regression
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  if (outputPath) {
    const target = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json, { mode: 0o600 });
  }
  if (!passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Release gate check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  clearTimeout(timeout);
}
