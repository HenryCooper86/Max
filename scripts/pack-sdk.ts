/**
 * Assembles the publishable SDK package from `npm run build:sdk`'s output and
 * packs it: `dist/sdk-package/` is exactly what `npm publish` would upload,
 * and `dist/max-voice-agent-<version>.tgz` installs anywhere with
 * `npm install <path-to-tgz>`. Publishing stays a deliberate, manual step:
 *
 *   npm run pack:sdk && cd dist/sdk-package && npm publish
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
const tarball = output.trim().split("\n").at(-1);
console.log(`Packed dist/${tarball}`);
console.log("Install it in another project with: npm install <path to that file>");
