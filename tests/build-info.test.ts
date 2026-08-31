import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildInfo } from "../server/build-info";

describe("build identity", () => {
  it("reads the application version from package metadata outside npm lifecycle scripts", () => {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };

    expect(buildInfo.appVersion).toBe(packageJson.version);
    expect(buildInfo.gitCommit).not.toBe("");
  });
});
