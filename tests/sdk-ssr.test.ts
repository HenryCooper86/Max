// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Inside the repo so the externalised `react` import resolves from node_modules, and out of git's way.
const out = path.join(root, "node_modules/.cache/sdk-ssr-test");

/** Runs `source` in a fresh Node process: no DOM, no vitest globals. */
function node(source: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", cwd: out });
}

beforeAll(async () => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const mode of ["production", "iife"]) {
    await build({
      root,
      configFile: path.join(root, "vite.sdk.config.ts"),
      mode,
      logLevel: "silent",
      build: { outDir: out, emptyOutDir: false }
    });
  }
}, 120_000);

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("server rendering", () => {
  it("has no DOM in the child process", () => {
    expect(node("console.log(typeof HTMLElement + typeof document + typeof customElements)")).toBe(
      "undefinedundefinedundefined\n"
    );
  });

  for (const entry of ["voice-agent.js", "react.js", "widget.js"]) {
    it(`imports ${entry} in plain Node without throwing`, () => {
      const url = pathToFileURL(path.join(out, entry)).href;
      expect(node(`const m = await import(${JSON.stringify(url)}); console.log(Object.keys(m).sort().join())`)).toMatch(
        /\w/
      );
    });
  }

  it("exports the element class and a no-op define from the widget entry", () => {
    const url = pathToFileURL(path.join(out, "widget.js")).href;
    const result = node(
      `const m = await import(${JSON.stringify(url)}); m.defineVoiceAgentElement(); console.log(typeof m.VoiceAgentElement)`
    );
    expect(result).toBe("function\n");
  });

  it("runs the script-tag build in plain Node without throwing", () => {
    const file = path.join(out, "voice-agent.iife.js");
    const result = node(
      `import { readFileSync } from "node:fs"; new Function(readFileSync(${JSON.stringify(file)}, "utf8"))(); console.log("ok")`
    );
    expect(result).toBe("ok\n");
  });
});
