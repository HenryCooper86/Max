import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

function readRepositoryFile(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

function sectionBetween(document: string, startHeading: string, endHeading: string): string {
  const start = document.indexOf(startHeading);
  const end = document.indexOf(endHeading, start + startHeading.length);

  expect(start, `${startHeading} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${endHeading} must follow ${startHeading}`).toBeGreaterThan(start);

  return document.slice(start, end);
}

function bashBlocks(document: string): string[] {
  return Array.from(document.matchAll(/```bash\n([\s\S]*?)```/g), (match) => match[1]);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("reviewed RDK release operations", () => {
  it("documents an exact reviewed-tree rollout with artifact and invocation safety", () => {
    const rdkReadme = readRepositoryFile("rdk/README.md");
    const rollout = sectionBetween(rdkReadme, "### Reviewed RDK rollout", "### Reviewed RDK rollback");

    expect(rollout).not.toContain("rsync -azc --delete");
    expect(rollout).not.toContain('./ "$RDK_HOST":/opt/max/');
    for (const block of bashBlocks(rollout)) {
      expect(block).not.toMatch(/(^|\n)\s*rsync\b/);
      expect(block).not.toContain("--delete");
    }
    expect(rollout).toContain('git archive "$REVIEWED_SHA"');
    expect(rollout).toContain('REMOTE_STAGE="/opt/max.stage-$REVIEWED_SHA"');
    expect(rollout).toContain("/opt/max/rdk/aec/max-aec");
    expect(rollout).toContain("/opt/max/rdk/audio/alerts");
    expect(rollout).toContain('test -x "$REMOTE_STAGE/rdk/aec/max-aec"');
    expect(rollout).toContain('diff -qr "$CURRENT_ALERTS" "$STAGED_ALERTS"');
    expect(rollout).toContain('cd "$REMOTE_STAGE"');
    expect(rollout).toContain("npm ci --no-audit --no-fund");
    expect(rollout).toContain("npm run build");

    expect(rollout.match(/systemctl restart max-agent/g) ?? []).toHaveLength(1);
    expect(rollout).toContain("systemctl show -p InvocationID --value max-agent");
    expect(rollout).toContain('test "$invocation_id" != "$old_invocation"');
    expect(rollout).toContain("for _ in $(seq 1 60)");
    expect(rollout).toContain('journalctl _SYSTEMD_INVOCATION_ID="$invocation_id"');
    expect(rollout).not.toContain('--since "2 minutes ago"');

    expect(rollout).toContain("root:root:755");
    expect(rollout).toContain("root:root:700");
    expect(rollout).toContain("root:root:600");
  });

  it("states the transport encryption boundary truthfully", () => {
    const rootReadme = readRepositoryFile("README.md");
    const report = readRepositoryFile(".superpowers/sdd/2026-08-09-rdk-ios-companion-navigation/task-16-report.md");

    expect(rootReadme).not.toContain("Current location necessarily appears in the encrypted protocol frame");
    expect(rootReadme).toContain("production `wss://` with trusted TLS");
    expect(rootReadme).toContain("Debug `ws://` LAN transport is not encrypted");
    expect(report).toContain("FAIL — 3 failed, 1 passed");
    expect(report).toContain("No physical-device, audio-hardware, Amap, or Lightsail acceptance is claimed.");
  });

  it("uses invocation-scoped evidence in the acceptance template", () => {
    const acceptance = readRepositoryFile("docs/rdk-ios-companion-acceptance.md");

    expect(acceptance).toContain("systemctl show -p InvocationID --value max-agent");
    expect(acceptance).toContain('journalctl _SYSTEMD_INVOCATION_ID="$invocation_id"');
    expect(acceptance).not.toContain('--since "2 minutes ago"');
    expect(acceptance).not.toContain("systemctl restart max-agent");
    expect(acceptance).toContain("root:root:600");
    expect(acceptance).toContain("binding parent owner");
  });

  it("keeps the rollout and acceptance shell blocks syntactically executable", () => {
    const rdkReadme = readRepositoryFile("rdk/README.md");
    const operations = sectionBetween(rdkReadme, "### Reviewed RDK rollout", "Two footguns worth knowing");
    const acceptance = readRepositoryFile("docs/rdk-ios-companion-acceptance.md");
    const blocks = [...bashBlocks(operations), ...bashBlocks(acceptance)];

    expect(blocks.length).toBeGreaterThanOrEqual(7);
    for (const block of blocks) {
      execFileSync("bash", ["-n"], { input: block });
    }
  });

  it("dry-runs an archive release without importing checkout-only files or losing board artifacts", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "max-rdk-release-test-"));
    temporaryDirectories.push(sandbox);

    const checkout = join(sandbox, "checkout");
    const archive = join(sandbox, "reviewed.tar");
    const stage = join(sandbox, "stage");
    const current = join(sandbox, "current");
    mkdirSync(join(checkout, "rdk"), { recursive: true });
    writeFileSync(join(checkout, ".gitignore"), "ignored/\n");
    writeFileSync(join(checkout, "rdk", "tracked.ts"), "export const tracked = true;\n");

    execFileSync("git", ["init", "--quiet"], { cwd: checkout });
    execFileSync("git", ["config", "user.name", "Release Test"], {
      cwd: checkout
    });
    execFileSync("git", ["config", "user.email", "release-test@example.test"], {
      cwd: checkout
    });
    execFileSync("git", ["add", "."], { cwd: checkout });
    execFileSync("git", ["commit", "--quiet", "-m", "reviewed"], {
      cwd: checkout
    });
    const reviewedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: checkout,
      encoding: "utf8"
    }).trim();

    mkdirSync(join(checkout, "ignored"));
    writeFileSync(join(checkout, "ignored", "local-secret"), "not reviewed\n");
    writeFileSync(join(checkout, "untracked-debug.ts"), "not reviewed\n");
    mkdirSync(stage);
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, reviewedSha], { cwd: checkout });
    execFileSync("tar", ["-xf", archive, "-C", stage]);

    expect(existsSync(join(stage, "rdk", "tracked.ts"))).toBe(true);
    expect(existsSync(join(stage, "ignored", "local-secret"))).toBe(false);
    expect(existsSync(join(stage, "untracked-debug.ts"))).toBe(false);

    const currentAec = join(current, "rdk", "aec", "max-aec");
    const currentAlerts = join(current, "rdk", "audio", "alerts");
    mkdirSync(currentAlerts, { recursive: true });
    mkdirSync(join(current, "rdk", "aec"), { recursive: true });
    writeFileSync(currentAec, "#!/bin/sh\nexit 0\n");
    chmodSync(currentAec, 0o755);
    writeFileSync(join(currentAlerts, "forward-collision.wav"), "armed clip\n");

    const stagedAec = join(stage, "rdk", "aec", "max-aec");
    const stagedAlerts = join(stage, "rdk", "audio", "alerts");
    mkdirSync(join(stage, "rdk", "aec"), { recursive: true });
    mkdirSync(stagedAlerts, { recursive: true });
    copyFileSync(currentAec, stagedAec);
    chmodSync(stagedAec, 0o755);
    cpSync(currentAlerts, stagedAlerts, { recursive: true });

    expect(readFileSync(stagedAec, "utf8")).toBe(readFileSync(currentAec, "utf8"));
    expect(readFileSync(join(stagedAlerts, "forward-collision.wav"), "utf8")).toBe("armed clip\n");
    expect(statSync(stagedAec).mode & 0o111).not.toBe(0);
  });
});
