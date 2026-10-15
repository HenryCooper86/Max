import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadCanonicalWarningAssets, verifyAndroidWarningCase, type AndroidWarningCaseEvidence } from "./warning-proof";

export function verifyAndroidWarningReport(reportPath: string, assetDirectory = "public/audio/adas") {
  const bytes = readFileSync(reportPath),
    report = JSON.parse(bytes.toString()) as { sessions?: AndroidWarningCaseEvidence[]; harnessFailure?: string };
  if (report.harnessFailure || !Array.isArray(report.sessions) || !report.sessions.length)
    throw new Error("Missing successful raw Android instrumentation sessions");
  const assets = loadCanonicalWarningAssets(assetDirectory);
  const sessions = report.sessions.map((session) => verifyAndroidWarningCase(session, assets));
  return {
    kind: "independent-android-warning-hardware-proof-replay",
    reportSha256: createHash("sha256").update(bytes).digest("hex"),
    canonicalManifestSha256: createHash("sha256")
      .update(readFileSync(assetDirectory + "/manifest.json"))
      .digest("hex"),
    sessions
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reportPath = process.argv[2];
  if (!reportPath)
    throw new Error(
      "Usage: tsx scripts/synthetic-qa/android/verify-warning-report.ts <android-report.json> [canonical-assets-directory]"
    );
  console.log(JSON.stringify(verifyAndroidWarningReport(reportPath, process.argv[3]), null, 2));
}
