/**
 * Assembles the publishable SDK package from `npm run build:sdk`'s output and
 * packs it: `dist/sdk-package/` is exactly what `npm publish` would upload,
 * and `dist/max-voice-agent-<version>.tgz` installs anywhere with
 * `npm install <path-to-tgz>`.
 *
 * Then it proves the tarball works as a dependency: installs it into an empty
 * project, imports each entry point by its package name (so the `exports` map
 * and the shared chunks are what is tested, not files that happen to sit side
 * by side) and type-checks a consumer of all three. A file left out of the
 * package, a broken export path or a missing `.d.ts` fails here, before anyone
 * publishes. Publishing stays a deliberate, manual step (see sdk/README.md).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = path.join(root, "dist/sdk");
const stage = path.join(root, "dist/sdk-package");
const required = ["voice-agent.js", "react.js", "widget.js", "voice-agent.iife.js", "types/index.d.ts"];

for (const file of required) {
  if (!fs.existsSync(path.join(built, file))) {
    console.error(`Missing dist/sdk/${file}. Run npm run build:sdk first.`);
    process.exit(1);
  }
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(built, stage, { recursive: true });
// For pages whose Content-Security-Policy refuses blob: scripts (the `workletUrl` option).
fs.copyFileSync(path.join(root, "public/pcm-worklet.js"), path.join(stage, "pcm-worklet.js"));
fs.copyFileSync(path.join(root, "sdk/package.json"), path.join(stage, "package.json"));
fs.copyFileSync(path.join(root, "sdk/README.md"), path.join(stage, "README.md"));
fs.copyFileSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));

const output = execFileSync("npm", ["pack", "--pack-destination", path.join(root, "dist")], {
  cwd: stage,
  encoding: "utf8"
});
const tarball = output.trim().split("\n").at(-1) ?? "";
console.log(`Packed dist/${tarball}`);

/** The version of a package installed in this checkout, so the consumer gets the same one. */
function installedVersion(name: string): string {
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8"));
  if (manifest && typeof manifest === "object" && "version" in manifest && typeof manifest.version === "string") {
    return manifest.version;
  }
  throw new Error(`node_modules/${name} has no version; run npm ci first.`);
}

const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "max-voice-agent-consumer-"));
try {
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" })
  );
  execFileSync(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      path.join(root, "dist", tarball),
      `react@${installedVersion("react")}`,
      `@types/react@${installedVersion("@types/react")}`
    ],
    { cwd: consumer, stdio: ["ignore", "ignore", "inherit"] }
  );

  // Every entry by its package specifier, in a separate plain Node process (no DOM), as a bundler or SSR loads it.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        'import { VoiceAgent } from "max-voice-agent";',
        'import { useVoiceAgent } from "max-voice-agent/react";',
        'import { defineVoiceAgentElement } from "max-voice-agent/widget";',
        "for (const [name, value] of Object.entries({ VoiceAgent, useVoiceAgent, defineVoiceAgentElement })) {",
        '  if (typeof value !== "function") throw new Error(`${name} is not exported`);',
        "}"
      ].join("\n")
    ],
    { cwd: consumer, stdio: "inherit" }
  );

  // And its types, resolved through `exports` as a TypeScript consumer resolves them.
  fs.writeFileSync(
    path.join(consumer, "consumer.ts"),
    [
      'import { VoiceAgent } from "max-voice-agent";',
      'import { useVoiceAgent } from "max-voice-agent/react";',
      'import { defineVoiceAgentElement } from "max-voice-agent/widget";',
      'export const agent: VoiceAgent = new VoiceAgent({ url: "https://relay.example.com" });',
      "export const hook: typeof useVoiceAgent = useVoiceAgent;",
      "defineVoiceAgentElement();"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        strict: true,
        noEmit: true,
        types: []
      },
      files: ["consumer.ts"]
    })
  );
  execFileSync(path.join(root, "node_modules/.bin/tsc"), ["-p", consumer], { stdio: "inherit" });
  console.log("Installed it into an empty project: every entry imports and type-checks.");
} finally {
  fs.rmSync(consumer, { recursive: true, force: true });
}
console.log("Install it in another project with: npm install <path to that file>");
