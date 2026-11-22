import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];
const scripts = [
  "rdk/deploy.sh",
  "rdk/provision.sh",
  "rdk/lib/common.sh",
  "rdk/remote/stage.sh",
  "rdk/remote/build.sh",
  "rdk/remote/activate.sh"
];

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

function remoteHeredoc(block: string): string {
  const opening = "<<'REMOTE'\n";
  const start = block.indexOf(opening);
  const end = block.lastIndexOf("\nREMOTE\n");

  expect(start, "remote heredoc must exist").toBeGreaterThanOrEqual(0);
  expect(end, "remote heredoc must close").toBeGreaterThan(start);

  return block.slice(start + opening.length, end);
}

function writePreflightTraceHook(directory: string, includeReads = false): string {
  const traceHook = join(directory, "mutation-trace.cjs");
  const operations = ["mkdirSync", "chmodSync", "openSync", "fsyncSync", "renameSync", "unlinkSync", "rmSync"];
  if (includeReads) operations.unshift("lstatSync", "realpathSync");
  writeFileSync(
    traceHook,
    [
      'const fs = require("node:fs");',
      `for (const name of ${JSON.stringify(operations)}) {`,
      "  const operation = fs[name];",
      "  fs[name] = (...args) => {",
      "    process._rawDebug(`PREFLIGHT_FS:${name}`);",
      "    return operation(...args);",
      "  };",
      "}",
      ""
    ].join("\n")
  );
  return traceHook;
}

function readPreflightTrace(stderr: string): string[] {
  return stderr.split("\n").filter((line) => line.startsWith("PREFLIGHT_FS:"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("reviewed RDK release operations", () => {
  it("ships an exact reviewed-tree rollout with artifact and invocation safety as scripts", () => {
    const deploy = readRepositoryFile("rdk/deploy.sh");
    const stage = readRepositoryFile("rdk/remote/stage.sh");
    const build = readRepositoryFile("rdk/remote/build.sh");
    const activate = readRepositoryFile("rdk/remote/activate.sh");
    const everything = [deploy, stage, build, activate, readRepositoryFile("rdk/provision.sh")];

    for (const script of everything) {
      expect(script).toMatch(/^set -euo pipefail$/m);
      expect(script).not.toMatch(/(^|\n)\s*rsync\b/);
      expect(script).not.toContain("--delete");
    }

    // Exactly the reviewed commit, from a clean tree, as a Git archive.
    expect(deploy).toContain('git -C "$REPO" archive "$REVIEWED_SHA"');
    expect(deploy).toContain('REMOTE_STAGE="$RELEASE_ROOT.stage-$REVIEWED_SHA"');
    expect(deploy).toContain('"$REVIEWED_SHA" = "$(git -C "$REPO" rev-parse origin/main)"');
    expect(deploy).toContain("status --porcelain --untracked-files=no");

    // Armed board artifacts are preserved and proven before activation.
    expect(build).toContain("$ROOT/rdk/aec/max-aec");
    expect(build).toContain("$ROOT/rdk/audio/alerts");
    expect(build).toContain('test -x "$STAGED_AEC"');
    expect(build).toContain('diff -qr "$CURRENT_ALERTS" "$STAGED_ALERTS"');
    expect(build).toContain('cd "$STAGE"');
    expect(build).toContain("npm ci --no-audit --no-fund");
    expect(build).toContain("npm run build");

    // One controlled restart per proof, scoped to the new invocation.
    expect(activate.match(/systemctl restart max-agent/g) ?? []).toHaveLength(1);
    expect(activate).toContain("systemctl show -p InvocationID --value");
    expect(activate).toContain('test "$agent_id" != "$old_agent"');
    expect(activate).toContain("for _ in $(seq 1 60)");
    expect(activate).toContain('journalctl _SYSTEMD_INVOCATION_ID="$agent_id"');
    expect(activate).not.toContain('--since "2 minutes ago"');

    expect(activate).toContain("root:root:755");
    expect(activate).toContain("root:root:700");
    expect(activate).toContain("root:root:600");

    // Every path that is moved or deleted is rebuilt from the SHA, never trusted.
    expect(activate).toContain('[ "$STAGE" = "$ROOT.stage-$SHA" ]');
    expect(activate).toContain('[ "$FAILED" = "$ROOT.failed-$SHA-$stamp" ]');
    expect(stage).toContain('[ "$STAGE" = "$ROOT.stage-$SHA" ]');
    for (const script of [deploy, build, activate]) expect(script).not.toMatch(/\brm -rf\b/);
    expect(stage.match(/\brm -rf\b.*/g)).toEqual(['rm -rf -- "$STAGE"']);
  });

  it("states the transport encryption boundary truthfully", () => {
    // The reference helmet guide moved out of the root README.
    const rootReadme = readRepositoryFile("docs/max-helmet.md");

    expect(rootReadme).not.toContain("Current location necessarily appears in the encrypted protocol frame");
    expect(rootReadme).toContain("production `wss://` with trusted TLS");
    expect(rootReadme).toContain("Debug `ws://` LAN transport is not encrypted");
  });

  it("uses invocation-scoped evidence in the acceptance template", () => {
    const acceptance = readRepositoryFile("docs/rdk-ios-companion-acceptance.md");

    expect(acceptance).toContain("systemctl show -p InvocationID --value max-agent");
    expect(acceptance).toContain('journalctl _SYSTEMD_INVOCATION_ID="$invocation_id"');
    expect(acceptance).not.toContain('--since "2 minutes ago"');
    expect(acceptance).not.toContain("systemctl restart max-agent");
    expect(acceptance).toContain("root:root:600");
    expect(acceptance).toContain("binding-file permission/schema evidence remains **PENDING**");
    expect(acceptance).toContain("## First Pair and persisted binding — complete before ride");
  });

  it("accepts an absent pre-pair file, durably probes its parent, and validates the post-pair snapshot", () => {
    const acceptance = readRepositoryFile("docs/rdk-ios-companion-acceptance.md");
    const blocks = bashBlocks(acceptance);
    const prePairBlock = blocks.find((block) => block.includes(".companion-write-probe"));
    expect(prePairBlock, "pre-pair storage preflight must exist").toBeDefined();
    const prePairScript = remoteHeredoc(prePairBlock!);

    const sandboxFixture = mkdtempSync(join(tmpdir(), "max-binding-acceptance-test-"));
    temporaryDirectories.push(sandboxFixture);
    const sandbox = realpathSync(sandboxFixture);
    const relayHome = join(sandbox, "relay-home");
    const parent = join(relayHome, ".max-relay");
    const bindingFile = join(parent, "companion-bindings.json");
    const fixtureBin = join(sandbox, "bin");
    const statFixture = join(fixtureBin, "stat");
    const traceHook = join(sandbox, "trace.cjs");
    const traceFile = join(sandbox, "preflight.trace");
    mkdirSync(relayHome, { mode: 0o755 });
    chmodSync(relayHome, 0o755);
    mkdirSync(fixtureBin);
    // Preserve the Linux stat dialect used by the reviewed pre-fix command so
    // this macOS-hosted regression fails on the absent-file lifecycle itself.
    writeFileSync(
      statFixture,
      [
        "#!/bin/sh",
        'test "$1" = -c',
        "test \"$2\" = '%U:%G:%a'",
        "exec /usr/bin/stat -f '%Su:%Sg:%Lp' \"$3\"",
        ""
      ].join("\n")
    );
    chmodSync(statFixture, 0o755);
    writeFileSync(
      traceHook,
      [
        'const fs = require("node:fs");',
        "const trace = process.env.PREFLIGHT_TRACE;",
        "const fsyncSync = fs.fsyncSync;",
        "const renameSync = fs.renameSync;",
        "fs.fsyncSync = (fd) => {",
        '  fs.appendFileSync(trace, `fsync:${fs.fstatSync(fd).isDirectory() ? "dir" : "file"}\\n`);',
        "  return fsyncSync(fd);",
        "};",
        "fs.renameSync = (from, to) => {",
        '  fs.appendFileSync(trace, "rename\\n");',
        "  return renameSync(from, to);",
        "};",
        ""
      ].join("\n")
    );
    const environment = {
      ...process.env,
      NODE_OPTIONS: `--require=${traceHook}`,
      PATH: `${fixtureBin}:${process.env.PATH}`,
      PREFLIGHT_TRACE: traceFile,
      HOME: relayHome
    };

    const prePair = spawnSync("bash", ["-s", "--", parent, bindingFile], {
      input: prePairScript,
      encoding: "utf8",
      env: environment
    });

    expect(prePair.status, prePair.stderr).toBe(0);
    expect(prePair.stdout).toContain("binding file: absent before first Pair (expected); file evidence: PENDING");
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    expect(existsSync(bindingFile)).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
    expect(readFileSync(traceFile, "utf8").split("\n").filter(Boolean)).toEqual([
      "fsync:file",
      "rename",
      "fsync:dir",
      "fsync:dir"
    ]);

    const validSnapshot = {
      version: 1,
      bindings: [{ accountId: "account-fixture", deviceId: "rdk-fixture", createdAt: 100, updatedAt: 100 }]
    };
    writeFileSync(bindingFile, `${JSON.stringify(validSnapshot)}\n`, { mode: 0o644 });
    chmodSync(bindingFile, 0o644);
    const wrongMode = spawnSync("bash", ["-s", "--", parent, bindingFile], {
      input: prePairScript,
      encoding: "utf8",
      env: environment
    });
    expect(wrongMode.status).not.toBe(0);

    const postPairBlock = blocks.find((block) => block.includes("persisted relationships"));
    expect(postPairBlock, "post-first-pair snapshot check must exist").toBeDefined();
    const postPairScript = remoteHeredoc(postPairBlock!);
    const postPairWrongMode = spawnSync("bash", ["-s", "--", parent, bindingFile], {
      input: postPairScript,
      encoding: "utf8",
      env: environment
    });
    expect(postPairWrongMode.status).not.toBe(0);

    writeFileSync(bindingFile, "", { mode: 0o600 });
    chmodSync(bindingFile, 0o600);
    const invalidSnapshot = spawnSync("bash", ["-s", "--", parent, bindingFile], {
      input: postPairScript,
      encoding: "utf8",
      env: environment
    });
    expect(invalidSnapshot.status).not.toBe(0);

    writeFileSync(bindingFile, `${JSON.stringify({ version: 1, bindings: [] })}\n`, { mode: 0o600 });
    chmodSync(bindingFile, 0o600);
    const noPersistedRelationship = spawnSync("bash", ["-s", "--", parent, bindingFile], {
      input: postPairScript,
      encoding: "utf8",
      env: environment
    });
    expect(noPersistedRelationship.status).not.toBe(0);

    writeFileSync(bindingFile, `${JSON.stringify(validSnapshot)}\n`, { mode: 0o600 });
    chmodSync(bindingFile, 0o600);
    const postPair = spawnSync("bash", ["-s", "--", parent, bindingFile], {
      input: postPairScript,
      encoding: "utf8",
      env: environment
    });
    expect(postPair.status, postPair.stderr).toBe(0);
    expect(postPair.stdout).toContain("binding snapshot: valid; persisted relationships: 1");
    expect(postPair.stdout).not.toContain("account-fixture");
    expect(postPair.stdout).not.toContain("rdk-fixture");
  });

  it("rejects a symlinked pre-pair parent without mutating its target", () => {
    const acceptance = readRepositoryFile("docs/rdk-ios-companion-acceptance.md");
    const prePairBlock = bashBlocks(acceptance).find((block) => block.includes(".companion-write-probe"));
    expect(prePairBlock, "pre-pair storage preflight must exist").toBeDefined();
    const prePairScript = remoteHeredoc(prePairBlock!);

    const sandboxFixture = mkdtempSync(join(tmpdir(), "max-binding-symlink-test-"));
    temporaryDirectories.push(sandboxFixture);
    const sandbox = realpathSync(sandboxFixture);
    const relayHome = join(sandbox, "relay-home");
    const unrelatedTarget = join(sandbox, "unrelated-target");
    const unrelatedFile = join(unrelatedTarget, "keep.txt");
    const configuredParent = join(relayHome, ".max-relay");
    const bindingFile = join(configuredParent, "companion-bindings.json");
    mkdirSync(relayHome, { mode: 0o755 });
    mkdirSync(unrelatedTarget, { mode: 0o755 });
    chmodSync(unrelatedTarget, 0o755);
    writeFileSync(unrelatedFile, "unrelated content must remain unchanged\n");
    symlinkSync(unrelatedTarget, configuredParent);

    const beforeMode = statSync(unrelatedTarget).mode & 0o777;
    const beforeEntries = readdirSync(unrelatedTarget);
    const beforeContent = readFileSync(unrelatedFile, "utf8");
    const result = spawnSync("bash", ["-s", "--", configuredParent, bindingFile], {
      input: prePairScript,
      encoding: "utf8",
      env: { ...process.env, HOME: relayHome }
    });

    expect(result.status).not.toBe(0);
    expect(statSync(unrelatedTarget).mode & 0o777).toBe(beforeMode);
    expect(readdirSync(unrelatedTarget)).toEqual(beforeEntries);
    expect(readFileSync(unrelatedFile, "utf8")).toBe(beforeContent);
    expect(existsSync(bindingFile)).toBe(false);
  });

  it("does not create an absent pre-pair parent outside the verified relay home", () => {
    const acceptance = readRepositoryFile("docs/rdk-ios-companion-acceptance.md");
    const prePairBlock = bashBlocks(acceptance).find((block) => block.includes(".companion-write-probe"));
    expect(prePairBlock, "pre-pair storage preflight must exist").toBeDefined();
    const prePairScript = remoteHeredoc(prePairBlock!);

    const sandboxFixture = mkdtempSync(join(tmpdir(), "max-binding-untrusted-parent-test-"));
    temporaryDirectories.push(sandboxFixture);
    const sandbox = realpathSync(sandboxFixture);
    const relayHome = join(sandbox, "relay-home");
    const unrelatedRoot = join(sandbox, "unrelated-root");
    const configuredParent = join(unrelatedRoot, "private");
    const bindingFile = join(configuredParent, "companion-bindings.json");
    mkdirSync(relayHome, { mode: 0o755 });
    mkdirSync(unrelatedRoot, { mode: 0o755 });

    const result = spawnSync("bash", ["-s", "--", configuredParent, bindingFile], {
      input: prePairScript,
      encoding: "utf8",
      env: { ...process.env, HOME: relayHome }
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(configuredParent)).toBe(false);
    expect(readdirSync(unrelatedRoot)).toEqual([]);
  });

  it("rejects a dangling final-file symlink instead of recording absence", () => {
    const acceptance = readRepositoryFile("docs/rdk-ios-companion-acceptance.md");
    const prePairBlock = bashBlocks(acceptance).find((block) => block.includes(".companion-write-probe"));
    expect(prePairBlock, "pre-pair storage preflight must exist").toBeDefined();
    const prePairScript = remoteHeredoc(prePairBlock!);

    const sandboxFixture = mkdtempSync(join(tmpdir(), "max-binding-dangling-file-test-"));
    temporaryDirectories.push(sandboxFixture);
    const sandbox = realpathSync(sandboxFixture);
    const relayHome = join(sandbox, "relay-home");
    const configuredParent = join(relayHome, ".max-relay");
    const bindingFile = join(configuredParent, "companion-bindings.json");
    mkdirSync(relayHome, { mode: 0o755 });
    mkdirSync(configuredParent, { mode: 0o700 });
    chmodSync(configuredParent, 0o700);
    symlinkSync("missing-snapshot.json", bindingFile);

    const result = spawnSync("bash", ["-s", "--", configuredParent, bindingFile], {
      input: prePairScript,
      encoding: "utf8",
      env: { ...process.env, HOME: relayHome }
    });

    expect(result.status).not.toBe(0);
    expect(lstatSync(bindingFile).isSymbolicLink()).toBe(true);
    expect(readdirSync(configuredParent)).toEqual(["companion-bindings.json"]);
  });

  it("rejects every raw non-canonical pre-pair path before mutation", () => {
    const acceptance = readRepositoryFile("docs/rdk-ios-companion-acceptance.md");
    const prePairBlock = bashBlocks(acceptance).find((block) => block.includes(".companion-write-probe"));
    expect(prePairBlock, "pre-pair storage preflight must exist").toBeDefined();
    const prePairScript = remoteHeredoc(prePairBlock!);

    const sandboxFixture = mkdtempSync(join(tmpdir(), "max-binding-noncanonical-test-"));
    temporaryDirectories.push(sandboxFixture);
    const sandbox = realpathSync(sandboxFixture);
    const relayHome = join(sandbox, "relay-home");
    const configuredParent = join(relayHome, ".max-relay");
    const bindingFile = join(configuredParent, "companion-bindings.json");
    const sentinelFile = join(configuredParent, "keep.txt");
    const traceHook = writePreflightTraceHook(sandbox, true);
    mkdirSync(relayHome, { mode: 0o755 });
    chmodSync(relayHome, 0o755);
    mkdirSync(configuredParent, { mode: 0o700 });
    chmodSync(configuredParent, 0o700);
    writeFileSync(sentinelFile, "private sentinel must remain unchanged\n");
    const beforeParentMode = statSync(configuredParent).mode & 0o777;
    const beforeEntries = readdirSync(configuredParent);
    const beforeContent = readFileSync(sentinelFile, "utf8");
    const rawCases = [
      {
        label: "relative parent",
        parent: relative(repositoryRoot, configuredParent),
        file: bindingFile
      },
      {
        label: "dot-segment parent",
        parent: `${relayHome}/./.max-relay`,
        file: bindingFile
      },
      {
        label: "dot-dot-segment parent",
        parent: `${relayHome}/unused/../.max-relay`,
        file: bindingFile
      },
      {
        label: "repeated-separator parent",
        parent: `${relayHome}//.max-relay`,
        file: bindingFile
      },
      {
        label: "relative file",
        parent: configuredParent,
        file: relative(repositoryRoot, bindingFile)
      },
      {
        label: "dot-segment file",
        parent: configuredParent,
        file: `${configuredParent}/./companion-bindings.json`
      },
      {
        label: "dot-dot-segment file",
        parent: configuredParent,
        file: `${configuredParent}/unused/../companion-bindings.json`
      },
      {
        label: "repeated-separator file",
        parent: configuredParent,
        file: `${configuredParent}//companion-bindings.json`
      }
    ];

    for (const fixture of rawCases) {
      const result = spawnSync("bash", ["-s", "--", fixture.parent, fixture.file], {
        input: prePairScript,
        encoding: "utf8",
        cwd: repositoryRoot,
        env: { ...process.env, HOME: relayHome, NODE_OPTIONS: `--require=${traceHook}` }
      });
      const filesystemTrace = readPreflightTrace(result.stderr);

      expect.soft(result.status, `${fixture.label}: ${result.stderr}`).not.toBe(0);
      expect.soft(filesystemTrace, fixture.label).toEqual([]);
      expect.soft(statSync(configuredParent).mode & 0o777, fixture.label).toBe(beforeParentMode);
      expect.soft(readdirSync(configuredParent), fixture.label).toEqual(beforeEntries);
      expect.soft(readFileSync(sentinelFile, "utf8"), fixture.label).toBe(beforeContent);
      expect.soft(existsSync(bindingFile), fixture.label).toBe(false);
    }
  });

  it("rejects an existing private parent below an unsafe relay home without mutation", () => {
    const acceptance = readRepositoryFile("docs/rdk-ios-companion-acceptance.md");
    const prePairBlock = bashBlocks(acceptance).find((block) => block.includes(".companion-write-probe"));
    expect(prePairBlock, "pre-pair storage preflight must exist").toBeDefined();
    const prePairScript = remoteHeredoc(prePairBlock!);

    const sandboxFixture = mkdtempSync(join(tmpdir(), "max-binding-unsafe-ancestor-test-"));
    temporaryDirectories.push(sandboxFixture);
    const sandbox = realpathSync(sandboxFixture);
    const relayHome = join(sandbox, "relay-home");
    const configuredParent = join(relayHome, ".max-relay");
    const bindingFile = join(configuredParent, "companion-bindings.json");
    const sentinelFile = join(configuredParent, "keep.txt");
    const traceHook = writePreflightTraceHook(sandbox);
    mkdirSync(relayHome, { mode: 0o777 });
    chmodSync(relayHome, 0o777);
    mkdirSync(configuredParent, { mode: 0o700 });
    chmodSync(configuredParent, 0o700);
    writeFileSync(sentinelFile, "unsafe-ancestor sentinel must remain unchanged\n");
    const beforeHomeMode = statSync(relayHome).mode & 0o7777;
    const beforeParentMode = statSync(configuredParent).mode & 0o777;
    const beforeEntries = readdirSync(configuredParent);
    const beforeContent = readFileSync(sentinelFile, "utf8");
    const result = spawnSync("bash", ["-s", "--", configuredParent, bindingFile], {
      input: prePairScript,
      encoding: "utf8",
      env: { ...process.env, HOME: relayHome, NODE_OPTIONS: `--require=${traceHook}` }
    });
    const mutationTrace = readPreflightTrace(result.stderr);

    expect(result.status).not.toBe(0);
    expect(mutationTrace).toEqual([]);
    expect(statSync(relayHome).mode & 0o7777).toBe(beforeHomeMode);
    expect(statSync(configuredParent).mode & 0o777).toBe(beforeParentMode);
    expect(readdirSync(configuredParent)).toEqual(beforeEntries);
    expect(readFileSync(sentinelFile, "utf8")).toBe(beforeContent);
    expect(existsSync(bindingFile)).toBe(false);
  });

  it("keeps the rollout scripts and every shell block in the docs syntactically executable", () => {
    const rdkReadme = readRepositoryFile("rdk/README.md");
    const operations = sectionBetween(rdkReadme, "## Deploying", "Two footguns worth knowing");
    const acceptance = readRepositoryFile("docs/rdk-ios-companion-acceptance.md");
    const blocks = [...bashBlocks(operations), ...bashBlocks(acceptance)];

    expect(blocks.length).toBeGreaterThanOrEqual(7);
    for (const block of blocks) {
      execFileSync("bash", ["-n"], { input: block });
    }
    for (const script of scripts) {
      execFileSync("bash", ["-n", join(repositoryRoot, script)]);
    }
  });

  it("passes shellcheck when it is installed", (context) => {
    const probe = spawnSync("shellcheck", ["--version"]);
    if (probe.status !== 0) context.skip();
    const result = spawnSync(
      "shellcheck",
      ["-x", "-P", "SCRIPTDIR", ...scripts.map((script) => join(repositoryRoot, script))],
      {
        encoding: "utf8"
      }
    );
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A checkout whose HEAD equals origin/main, plus an ssh stand-in that records
 *  every call. A dry run must never invoke it. */
function reviewedCheckout() {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "max-rdk-deploy-test-")));
  temporaryDirectories.push(sandbox);
  const origin = join(sandbox, "origin.git");
  const checkout = join(sandbox, "checkout");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", checkout]);
  git(checkout, "config", "user.name", "Release Test");
  git(checkout, "config", "user.email", "release-test@example.test");
  git(checkout, "remote", "add", "origin", origin);
  writeFileSync(join(checkout, "tracked.txt"), "reviewed\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "reviewed");
  git(checkout, "push", "--quiet", "origin", "main");
  const sha = git(checkout, "rev-parse", "HEAD");

  const sshLog = join(sandbox, "ssh.log");
  const fakeSsh = join(sandbox, "fake-ssh");
  writeFileSync(fakeSsh, `#!/bin/sh\necho "$@" >> '${sshLog}'\nexit 1\n`);
  chmodSync(fakeSsh, 0o755);
  return { sandbox, checkout, sha, sshLog, fakeSsh };
}

function runScript(script: string, args: string[], env: Record<string, string>, input?: string) {
  return spawnSync("bash", [join(repositoryRoot, script), ...args], {
    encoding: "utf8",
    input: input ?? "",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }
  });
}

/** An ssh stand-in that behaves like a board whose activation has already run:
 *  the activate step ends with FAKE_ACTIVATE_RC (255 = connection dropped), the
 *  status file holds FAKE_STATUS, and the first FAKE_DOWN status queries fail
 *  as an unreachable host does. */
function boardSimulatingSsh(fixture: ReturnType<typeof reviewedCheckout>) {
  const counter = join(fixture.sandbox, "status-queries");
  const ssh = join(fixture.sandbox, "board-ssh");
  writeFileSync(
    ssh,
    [
      "#!/bin/bash",
      'all="$*"',
      'echo "$all" >> "${FAKE_LOG:-/dev/null}"',
      "case $all in",
      '  *"bash -s"*) script=$(cat); if grep -q set_status <<<"$script"; then exit "${FAKE_ACTIVATE_RC:-0}"; fi; exit 0 ;;',
      '  *"tar -xf"*) cat >/dev/null; exit 0 ;;',
      '  *"rm -f"*) exit 0 ;;',
      '  *".status"*) n=$(cat "$FAKE_COUNTER" 2>/dev/null || echo 0); echo $((n+1)) > "$FAKE_COUNTER"; [ "$n" -lt "${FAKE_DOWN:-0}" ] && exit 255; echo "$FAKE_STATUS"; if [ "$n" -ge "${FAKE_LIVE_FROM:-99999}" ]; then echo running; else echo idle; fi; echo "${FAKE_ACTIVE:-unknown}"; exit 0 ;;',
      '  *".rdk-release-sha"*) exit 0 ;;',
      '  *".log"*) echo "BOARD-LOG-LINE"; exit 0 ;;',
      "esac",
      "exit 1"
    ].join("\n")
  );
  chmodSync(ssh, 0o755);
  return { ssh, counter };
}

describe("rdk/deploy.sh reports what the board says, not what the connection did", () => {
  const run = (statusLine: string, extra: Record<string, string> = {}) => {
    const fixture = reviewedCheckout();
    const board = boardSimulatingSsh(fixture);
    const result = runScript("rdk/deploy.sh", ["--host", "board"], {
      RDK_DEPLOY_REPO: fixture.checkout,
      RDK_SSH: board.ssh,
      RDK_RECONNECT_SLEEP: "0",
      RDK_RECONNECT_TRIES: "4",
      FAKE_COUNTER: board.counter,
      FAKE_STATUS: statusLine.replace("SHA", fixture.sha),
      ...extra
    });
    return { result, fixture };
  };

  it("reports success and prints the board log", () => {
    const { result } = run("activated SHA");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("BOARD-LOG-LINE");
    expect(result.stderr).toContain("deployed");
  });

  it("reports a dropped connection as the board's own outcome after reconnecting", () => {
    const { result } = run("rolled-back SHA", { FAKE_ACTIVATE_RC: "255", FAKE_DOWN: "2" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("connection to the board ended with status 255; board says: rolled-back");
    expect(result.stderr).toContain("the previous release is running again");
  });

  it("exits 3 with a warning for a good release whose relay is unreachable", () => {
    const { result } = run("activated-relay-unreachable SHA");
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("could not reach the relay");
  });

  it("exits 2 when the rollback itself failed", () => {
    const { result } = run("rollback-failed SHA", { FAKE_ACTIVATE_RC: "255" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ROLLBACK FAILED");
  });

  it("reports a stale started status (killed script) as interrupted, with the active release, without polling", () => {
    const { result, fixture } = run("started SHA", {
      FAKE_ACTIVATE_RC: "255",
      FAKE_ACTIVE: "b".repeat(40)
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`interrupted; the board is on release ${"b".repeat(40)}`);
    expect(fixture.sha).toHaveLength(40);
  });

  it("refuses to start, or delete anything, while an activation is running on the board", () => {
    const fixture = reviewedCheckout();
    const board = boardSimulatingSsh(fixture);
    const log = join(fixture.sandbox, "ssh-calls");
    const result = runScript("rdk/deploy.sh", ["--host", "board"], {
      RDK_DEPLOY_REPO: fixture.checkout,
      RDK_SSH: board.ssh,
      FAKE_COUNTER: board.counter,
      FAKE_LOG: log,
      FAKE_STATUS: `started ${fixture.sha}`,
      FAKE_LIVE_FROM: "0"
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("an activation is still running");
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("rm -f");
    expect(calls).not.toContain("bash -s");
    expect(calls).not.toContain("tar -xf");
  });

  it.each([
    ["no status file, exit 0 and the new release active", "none", "0", "sha", 0, "deployed"],
    ["no status file, exit 3 and the new release active", "none", "3", "sha", 3, "could not reach the relay"],
    ["no status file and exit 1", "none", "1", "c".repeat(40), 1, "previous release is running again"]
  ])("falls back to the exit status when the status cannot be read: %s", (_l, status, rc, active, code, text) => {
    const fixture = reviewedCheckout();
    const board = boardSimulatingSsh(fixture);
    const result = runScript("rdk/deploy.sh", ["--host", "board"], {
      RDK_DEPLOY_REPO: fixture.checkout,
      RDK_SSH: board.ssh,
      FAKE_COUNTER: board.counter,
      FAKE_STATUS: status,
      FAKE_ACTIVATE_RC: rc,
      FAKE_ACTIVE: active === "sha" ? fixture.sha : active
    });
    expect(result.status, result.stderr).toBe(code);
    expect(result.stderr).toContain(text);
  });

  it("derives the polling window from the settle time actually passed", () => {
    const queriesFor = (settle: string) => {
      const fixture = reviewedCheckout();
      const board = boardSimulatingSsh(fixture);
      const shims = join(fixture.sandbox, "shims");
      mkdirSync(shims);
      writeFileSync(join(shims, "sleep"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(shims, "sleep"), 0o755);
      runScript("rdk/deploy.sh", ["--host", "board", "--vision-settle", settle], {
        PATH: `${shims}:${process.env.PATH}`,
        RDK_DEPLOY_REPO: fixture.checkout,
        RDK_SSH: board.ssh,
        RDK_RECONNECT_SLEEP: "1000",
        FAKE_COUNTER: board.counter,
        FAKE_STATUS: `started ${fixture.sha}`,
        FAKE_LIVE_FROM: "1",
        FAKE_ACTIVATE_RC: "255"
      });
      return Number(readFileSync(board.counter, "utf8"));
    };
    // 1 pre-check + ceil((2 * (80 + settle) + 120) / 1000) polls.
    expect(queriesFor("45")).toBe(1 + 1);
    expect(queriesFor("999")).toBe(1 + 3);
  });

  it("says the outcome is unknown when the board never comes back", () => {
    const { result } = run("activated SHA", { FAKE_ACTIVATE_RC: "255", FAKE_DOWN: "99" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outcome is unknown");
  });
});

describe("rdk/deploy.sh --dry-run", () => {
  it("prints every remote step and runs none of them", () => {
    const fixture = reviewedCheckout();
    const result = runScript("rdk/deploy.sh", ["--host", "root@board.example.com", "--dry-run"], {
      RDK_DEPLOY_REPO: fixture.checkout,
      RDK_SSH: fixture.fakeSsh
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(fixture.sshLog), "a dry run must not call ssh").toBe(false);
    const output = result.stdout;
    expect(output).toContain(`ssh root@board.example.com bash -s -- /opt/max.stage-${fixture.sha} ${fixture.sha}`);
    expect(output).toContain(
      `git -C ${fixture.checkout} archive ${fixture.sha} | ssh root@board.example.com tar -xf - -C /opt/max.stage-${fixture.sha}`
    );
    expect(output).toMatch(
      new RegExp(
        `bash -s -- /opt/max\\.stage-${fixture.sha} /opt/max\\.previous-${fixture.sha}-\\d{14} /opt/max\\.failed-${fixture.sha}-\\d{14} /var/lib/max/device-id ${fixture.sha} 1 45`
      )
    );
    for (const script of ["stage.sh", "build.sh", "activate.sh"]) {
      expect(output).toContain(`--- begin ${script} ---`);
      expect(output).toContain(`--- end ${script} ---`);
    }
    // The rollback path is part of what a reviewer sees.
    expect(output).toContain("rolling back to the previous release");
  });

  it("can skip the hardening drop-ins and says so to the board", () => {
    const fixture = reviewedCheckout();
    const result = runScript(
      "rdk/deploy.sh",
      ["--host", "board", "--dry-run", "--no-hardening", "--device-id-file", "/data/max/device-id"],
      { RDK_DEPLOY_REPO: fixture.checkout, RDK_SSH: fixture.fakeSsh }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/\/data\/max\/device-id [0-9a-f]{40} 0 45/);
  });

  it("refuses a HEAD that is not origin/main", () => {
    const fixture = reviewedCheckout();
    writeFileSync(join(fixture.checkout, "tracked.txt"), "second\n");
    git(fixture.checkout, "commit", "--quiet", "-am", "unreviewed");
    const result = runScript("rdk/deploy.sh", ["--host", "board", "--dry-run"], {
      RDK_DEPLOY_REPO: fixture.checkout,
      RDK_SSH: fixture.fakeSsh
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not origin/main");
    expect(result.stdout).not.toContain("bash -s");
  });

  it("refuses uncommitted changes to tracked files", () => {
    const fixture = reviewedCheckout();
    writeFileSync(join(fixture.checkout, "tracked.txt"), "edited\n");
    const result = runScript("rdk/deploy.sh", ["--host", "board", "--dry-run"], {
      RDK_DEPLOY_REPO: fixture.checkout,
      RDK_SSH: fixture.fakeSsh
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("uncommitted");
  });

  it.each([
    ["an ssh option as a host", ["--host", "-oProxyCommand=touch/tmp/x"]],
    ["shell metacharacters in the host", ["--host", "root@board;reboot"]],
    ["a relative device id path", ["--host", "board", "--device-id-file", "var/lib/max/device-id"]],
    ["a dot-dot device id path", ["--host", "board", "--device-id-file", "/var/lib/max/../../etc/passwd"]],
    ["a device id path with a space", ["--host", "board", "--device-id-file", "/var/lib/my max/id"]],
    ["a quote in the device id path", ["--host", "board", "--device-id-file", "/var/lib/max/id'x"]],
    ["a non-numeric settle time", ["--host", "board", "--vision-settle", "1;reboot"]]
  ])("rejects %s before anything is sent", (_label, args) => {
    const fixture = reviewedCheckout();
    const result = runScript("rdk/deploy.sh", [...args, "--dry-run"], {
      RDK_DEPLOY_REPO: fixture.checkout,
      RDK_SSH: fixture.fakeSsh
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(fixture.sshLog)).toBe(false);
  });
});

describe("rdk/provision.sh", () => {
  const SECRET = "tok-SECRET-value.123";
  const baseEnv = (fixture: ReturnType<typeof reviewedCheckout>) => ({
    RDK_SSH: fixture.fakeSsh,
    MAX_RELAY_URL: "wss://relay.example.com/agent",
    MAX_RELAY_TOKEN: SECRET,
    MAX_VISION_TOKEN: `${SECRET}-vision`
  });

  it("creates agent.env at 0600 without ever printing a secret", () => {
    const fixture = reviewedCheckout();
    const result = runScript("rdk/provision.sh", ["--host", "root@board", "--dry-run"], baseEnv(fixture));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(result.stdout).toContain("MAX_RELAY_TOKEN=<redacted>");
    expect(result.stdout).toContain("MAX_VISION_TOKEN=<redacted>");
    expect(result.stdout).toContain("MAX_REQUIRE_TLS=on");
    // Created under umask 077 and chmod 0600 before it is moved into place.
    expect(result.stdout).toMatch(
      /umask 077 .*cat >\/etc\/max\/agent\.env\.new .*chmod 0600 \/etc\/max\/agent\.env\.new .*mv -f/
    );
    expect(result.stdout).toContain("install -d -o root -g root -m 0700 /var/lib/max /var/lib/max/gallery");
    expect(result.stdout).toContain("/etc/systemd/system.conf.d");
    expect(result.stdout).toContain("hardening.conf");
    expect(existsSync(fixture.sshLog)).toBe(false);
  });

  it("never puts a secret in the token position of a URL or on a command line", () => {
    const fixture = reviewedCheckout();
    const withQuery = runScript("rdk/provision.sh", ["--host", "board", "--dry-run"], {
      ...baseEnv(fixture),
      MAX_RELAY_URL: `wss://relay.example.com/agent?token=${SECRET}`
    });
    expect(withQuery.status).not.toBe(0);
    expect(withQuery.stdout + withQuery.stderr).not.toContain(SECRET);
  });

  it.each([
    ["a newline", "abc\nMAX_RELAY_URL=ws://evil"],
    ["a space", "abc def"],
    ["a quote", "abc'def"],
    ["a dollar sign", "abc$HOME"],
    ["a hash", "abc#def"]
  ])("rejects a token containing %s so it cannot break out of its line", (_label, token) => {
    const fixture = reviewedCheckout();
    const result = runScript("rdk/provision.sh", ["--host", "board", "--dry-run"], {
      ...baseEnv(fixture),
      MAX_VISION_TOKEN: token
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("MAX_VISION_TOKEN=");
  });

  it("refuses plain ws:// to a remote host unless cleartext is explicitly accepted", () => {
    const fixture = reviewedCheckout();
    const env = { ...baseEnv(fixture), MAX_RELAY_URL: "ws://192.168.1.20:8787/agent" };
    const refused = runScript("rdk/provision.sh", ["--host", "board", "--dry-run"], env);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("unencrypted");

    const accepted = runScript("rdk/provision.sh", ["--host", "board", "--dry-run", "--allow-cleartext"], env);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("MAX_REQUIRE_TLS=off");
  });

  it("keeps strict TLS for a loopback ws:// relay", () => {
    const fixture = reviewedCheckout();
    const result = runScript("rdk/provision.sh", ["--host", "board", "--dry-run"], {
      ...baseEnv(fixture),
      MAX_RELAY_URL: "ws://127.0.0.1:8787/agent"
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("MAX_REQUIRE_TLS=on");
  });

  it("requires a relay URL when none is given and no terminal is attached", () => {
    const fixture = reviewedCheckout();
    const result = runScript("rdk/provision.sh", ["--host", "board", "--dry-run"], {
      RDK_SSH: fixture.fakeSsh
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MAX_RELAY_URL is required");
  });
});

/**
 * Runs the real board-side activate.sh against a sandboxed fake board: a root
 * directory, a unit directory, and stand-ins for the GNU/systemd tools that do
 * not exist on the machine running the tests. What is under test is the swap,
 * the proof and the rollback ordering, not systemd.
 */
type RelayBehaviour = "up" | "retrying" | "silent" | "crashing";

function fakeBoard(options: {
  newReleaseBroken: boolean;
  oldReleaseBroken?: boolean;
  hardenedOld?: boolean;
  newRelay?: RelayBehaviour;
  oldRelay?: RelayBehaviour;
}) {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "max-rdk-activate-test-")));
  temporaryDirectories.push(sandbox);
  const root = join(sandbox, "opt", "max");
  const etc = join(sandbox, "etc");
  const bin = join(sandbox, "bin");
  const state = join(sandbox, "state");
  const sha = "a".repeat(40);
  const stamp = "20260101000000";
  const stage = `${root}.stage-${sha}`;
  const previous = `${root}.previous-${sha}-${stamp}`;
  const failed = `${root}.failed-${sha}-${stamp}`;
  const deviceIdFile = join(sandbox, "var", "lib", "max", "device-id");

  const relayLines: Record<RelayBehaviour, string | null> = {
    up: null,
    retrying:
      "[relay] socket error: getaddrinfo ENOTFOUND\n[relay] closed code=1006\n[relay] reconnecting in 1000 ms\n",
    silent: "starting\n",
    crashing: "[relay] reconnecting in 1000 ms\n[agent] uncaught exception: boom\n"
  };
  function release(directory: string, name: string, broken: boolean, hardening: boolean, relay: RelayBehaviour = "up") {
    mkdirSync(join(directory, "rdk", "aec"), { recursive: true });
    mkdirSync(join(directory, "rdk", "audio", "alerts"), { recursive: true });
    mkdirSync(join(directory, "rdk", "systemd", "max-agent.service.d"), { recursive: true });
    mkdirSync(join(directory, "rdk", "systemd", "max-vision.service.d"), { recursive: true });
    writeFileSync(join(directory, "rdk", "aec", "max-aec"), "#!/bin/sh\n");
    chmodSync(join(directory, "rdk", "aec", "max-aec"), 0o755);
    writeFileSync(join(directory, "rdk", "audio", "alerts", "a.wav"), "clip");
    writeFileSync(join(directory, "rdk", "systemd", "max-agent.service"), `[Service] # ${name}\n`);
    writeFileSync(join(directory, "rdk", "systemd", "max-vision.service"), `[Service] # ${name}\n`);
    if (hardening) {
      writeFileSync(join(directory, "rdk", "systemd", "max-agent.service.d", "hardening.conf"), `# ${name}\n`);
      writeFileSync(join(directory, "rdk", "systemd", "max-vision.service.d", "hardening.conf"), `# ${name}\n`);
    }
    writeFileSync(join(directory, "RELEASE"), `${name}\n`);
    if (broken) writeFileSync(join(directory, "BROKEN"), "");
    const lines = relayLines[relay];
    if (lines !== null) writeFileSync(join(directory, "RELAY_DOWN"), lines);
    chmodSync(directory, 0o755);
  }
  release(root, "old", options.oldReleaseBroken ?? false, options.hardenedOld ?? false, options.oldRelay);
  release(stage, "new", options.newReleaseBroken, true, options.newRelay);
  writeFileSync(join(stage, ".rdk-release-sha"), `${sha}\n`);

  mkdirSync(join(etc, "max"), { recursive: true });
  mkdirSync(join(etc, "systemd", "system"), { recursive: true });
  writeFileSync(join(etc, "max", "agent.env"), "MAX_RELAY_URL=wss://x/agent\n", { mode: 0o600 });
  chmodSync(join(etc, "max", "agent.env"), 0o600);
  mkdirSync(join(sandbox, "var", "lib", "max"), { recursive: true, mode: 0o700 });
  chmodSync(join(sandbox, "var", "lib", "max"), 0o700);
  writeFileSync(deviceIdFile, "rdk-fixture\n", { mode: 0o600 });
  chmodSync(deviceIdFile, 0o600);
  mkdirSync(bin);
  mkdirSync(state);

  const shim = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // GNU stat -c '%U:%G:%a' -> the sandbox is not owned by root, so report root.
  shim("stat", 'echo "root:root:$(/usr/bin/stat -f %Lp "$3")"');
  // shasum is perl: stderr is silenced so a dead channel cannot be what fails it.
  shim("sha256sum", 'exec shasum -a 256 "$@" 2>/dev/null');
  // BSD find has no -readable.
  shim(
    "find",
    'args=(); for a in "$@"; do [ "$a" = -readable ] || args+=("$a"); done; exec /usr/bin/find "${args[@]}"'
  );
  shim("sleep", "exit 0");
  // Mode, owner and group flags are irrelevant to a sandbox owned by the tester.
  shim(
    "install",
    [
      "dir=0; args=()",
      'while [ "$#" -gt 0 ]; do case $1 in -d) dir=1;; -o|-g|-m) shift;; *) args+=("$1");; esac; shift; done',
      'if [ "$dir" = 1 ]; then exec mkdir -p "${args[@]}"; fi',
      'n=${#args[@]}; dest=${args[$((n-1))]}; unset "args[$((n-1))]"',
      'for f in "${args[@]}"; do if [ -d "$dest" ]; then cp "$f" "$dest/"; else cp "$f" "$dest"; fi; done'
    ].join("\n")
  );
  const counter = (service: string) => join(state, `${service}.invocation`);
  shim(
    "systemctl",
    [
      `STATE='${state}'; ROOT='${root}'`,
      "case $1 in",
      '  show) if [ "$2" = -p ] && [ "$3" = InvocationID ]; then cat "$STATE/$5.invocation" 2>/dev/null || true; else echo "$@"; fi ;;',
      '  restart) shift; for s in "$@"; do echo "$s" >> "$STATE/restarts"; n=$(cat "$STATE/$s.invocation" 2>/dev/null || echo 0); echo $((n+1)) > "$STATE/$s.invocation"; done ;;',
      '  is-active) [ -e "$ROOT/BROKEN" ] && [ "$3" = max-vision ] && exit 3; exit 0 ;;',
      '  daemon-reload) echo reload >> "$STATE/reloads" ;;',
      "esac"
    ].join("\n")
  );
  shim(
    "journalctl",
    [
      `if [ -e '${root}/RELAY_DOWN' ]; then cat '${root}/RELAY_DOWN'; exit 0; fi`,
      `if [ -e '${root}/BROKEN' ]; then echo 'relay unreachable'; else echo '[relay] session ready'; fi`
    ].join("\n")
  );
  // `systemctl show -p InvocationID --value X`: the unit is the fifth argument.
  void counter;

  const activateArgs = [
    join(repositoryRoot, "rdk/remote/activate.sh"),
    stage,
    previous,
    failed,
    deviceIdFile,
    sha,
    "1",
    "1"
  ];
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: sandbox,
    RDK_REMOTE_ROOT: root,
    RDK_REMOTE_ETC: etc
  };
  // closedChannel reproduces a dropped ssh session: stdout and stderr go into a
  // pipe whose reader has already exited, so every write to either fails with
  // EPIPE (the script ignores SIGPIPE, exactly as it does over ssh).
  const run = (runOptions: { closedChannel?: boolean; env?: Record<string, string> } = {}) => {
    const runEnv = { ...env, ...runOptions.env };
    return runOptions.closedChannel
      ? spawnSync(
          "bash",
          [
            "-c",
            '( /bin/sleep 0.3; exec bash "$@" ) 2>&1 | true; exit "${PIPESTATUS[0]}"',
            "activate-under-closed-channel",
            ...activateArgs
          ],
          { encoding: "utf8", env: runEnv }
        )
      : spawnSync("bash", activateArgs, { encoding: "utf8", env: runEnv });
  };
  const logFile = `${root}.activate-${sha}.log`;
  const statusFile = `${root}.activate-${sha}.status`;
  const read = (path: string) => readFileSync(path, "utf8");
  const unit = (name: string) => join(etc, "systemd", "system", name);
  const restarts = () =>
    existsSync(join(state, "restarts")) ? read(join(state, "restarts")).split("\n").filter(Boolean) : [];
  const log = () => read(logFile);
  const status = () => read(statusFile).trim();
  return {
    root,
    stage,
    previous,
    failed,
    deviceIdFile,
    run,
    read,
    unit,
    restarts,
    etc,
    parent: join(sandbox, "opt"),
    log,
    status,
    logFile,
    statusFile,
    sha
  };
}

describe("rdk/remote/activate.sh on a fake board", () => {
  it("swaps in the new release, installs its units and drop-ins, restarts once and keeps the previous release", () => {
    const board = fakeBoard({ newReleaseBroken: false });
    const result = board.run();

    expect(result.status, result.stderr + result.stdout + board.log()).toBe(0);
    expect(board.read(join(board.root, "RELEASE"))).toBe("new\n");
    expect(board.read(join(board.previous, "RELEASE"))).toBe("old\n");
    expect(existsSync(board.stage)).toBe(false);
    expect(board.read(board.unit("max-agent.service"))).toContain("# new");
    expect(existsSync(join(board.unit("max-agent.service.d"), "hardening.conf"))).toBe(true);
    expect(existsSync(join(board.unit("max-vision.service.d"), "hardening.conf"))).toBe(true);
    expect(board.restarts()).toEqual(["max-vision", "max-agent"]);
    expect(board.log()).toContain("device identity: stable");
    expect(board.status()).toBe(`activated ${board.sha}`);
    expect(result.stdout + result.stderr).toBe("");
    expect(statSync(board.logFile).mode & 0o777).toBe(0o600);
    expect(board.read(board.deviceIdFile)).toBe("rdk-fixture\n");
  });

  it("rolls back automatically when the new release never reports a ready session", () => {
    const board = fakeBoard({ newReleaseBroken: true });
    const result = board.run();

    expect(result.status).toBe(1);
    expect(board.log()).toContain("activation failed");
    expect(board.log()).toContain("rolled back");
    expect(board.status()).toBe(`rolled-back ${board.sha}`);
    expect(board.read(join(board.root, "RELEASE"))).toBe("old\n");
    expect(board.read(join(board.failed, "RELEASE"))).toBe("new\n");
    expect(existsSync(board.previous)).toBe(false);
    // The previous release's units are back and its (absent) drop-ins are gone,
    // so the installed units always describe the release that is running.
    expect(board.read(board.unit("max-agent.service"))).toContain("# old");
    expect(existsSync(join(board.unit("max-agent.service.d"), "hardening.conf"))).toBe(false);
    // One restart pair for the attempt, one for the rollback.
    expect(board.restarts()).toEqual(["max-vision", "max-agent", "max-vision", "max-agent"]);
    expect(board.read(board.deviceIdFile)).toBe("rdk-fixture\n");
  });

  it("restores a previous release's own drop-ins on rollback", () => {
    const board = fakeBoard({ newReleaseBroken: true, hardenedOld: true });
    const result = board.run();
    expect(result.status).toBe(1);
    expect(board.read(join(board.unit("max-agent.service.d"), "hardening.conf"))).toBe("# old\n");
  });

  it("says so, and exits differently, when the rollback itself cannot be proven", () => {
    const board = fakeBoard({ newReleaseBroken: true, oldReleaseBroken: true });
    const result = board.run();

    expect(result.status).toBe(2);
    expect(board.log()).toContain("ROLLBACK FAILED");
    expect(board.status()).toBe(`rollback-failed ${board.sha}`);
  });

  it("rolls back completely even when the ssh channel is already dead", () => {
    const board = fakeBoard({ newReleaseBroken: true });
    const result = board.run({ closedChannel: true });

    expect(result.status).toBe(1);
    expect(board.read(join(board.root, "RELEASE"))).toBe("old\n");
    expect(board.read(join(board.failed, "RELEASE"))).toBe("new\n");
    expect(existsSync(board.previous)).toBe(false);
    expect(board.read(board.unit("max-agent.service"))).toContain("# old");
    expect(board.restarts()).toEqual(["max-vision", "max-agent", "max-vision", "max-agent"]);
    expect(board.status()).toBe(`rolled-back ${board.sha}`);
    expect(board.log()).toContain("rolling back to the previous release");
  });

  it("completes a successful activation when the ssh channel is already dead", () => {
    const board = fakeBoard({ newReleaseBroken: false });
    const result = board.run({ closedChannel: true });

    expect(result.status).toBe(0);
    expect(board.read(join(board.root, "RELEASE"))).toBe("new\n");
    expect(board.read(join(board.previous, "RELEASE"))).toBe("old\n");
    expect(board.status()).toBe(`activated ${board.sha}`);
    expect(board.log()).toContain("device identity: stable");
  });

  it("never follows a symbolic link planted at the log or status path", () => {
    const board = fakeBoard({ newReleaseBroken: false });
    const victim = join(board.parent, "victim.txt");
    writeFileSync(victim, "precious\n");
    symlinkSync(victim, board.logFile);
    symlinkSync(victim, board.statusFile);
    symlinkSync(victim, `${board.statusFile}.tmp`);

    const result = board.run();

    expect(result.status).toBe(0);
    expect(board.read(victim)).toBe("precious\n");
    expect(lstatSync(board.logFile).isSymbolicLink()).toBe(false);
    expect(lstatSync(board.statusFile).isSymbolicLink()).toBe(false);
    expect(board.status()).toBe(`activated ${board.sha}`);
  });

  it("refuses when the directory holding its files is writable by others", () => {
    const board = fakeBoard({ newReleaseBroken: false });
    chmodSync(board.parent, 0o777);
    const result = board.run();

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("writable by group or others");
    expect(board.read(join(board.root, "RELEASE"))).toBe("old\n");
    expect(existsSync(board.logFile)).toBe(false);
  });

  it.each([
    ["a dead channel with no log redirect", true, "inherit"],
    ...(existsSync("/dev/full") ? [["a full disk (/dev/full)", false, "/dev/full"] as const] : [])
  ])("still rolls back and records the outcome when every write fails: %s", (_label, closedChannel, sink) => {
    const board = fakeBoard({ newReleaseBroken: true });
    const result = board.run({ closedChannel, env: { RDK_REMOTE_OUTPUT_SINK: sink } });

    expect(result.status, board.status()).toBe(1);
    expect(board.read(join(board.root, "RELEASE"))).toBe("old\n");
    expect(board.read(join(board.failed, "RELEASE"))).toBe("new\n");
    expect(board.restarts()).toEqual(["max-vision", "max-agent", "max-vision", "max-agent"]);
    expect(board.status()).toBe(`rolled-back ${board.sha}`);
  });

  it("refuses while another activation holds the lock and leaves its files alone", () => {
    const board = fakeBoard({ newReleaseBroken: false });
    const lock = `${board.root}.activate.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    writeFileSync(
      join(lock, "boot"),
      existsSync("/proc/sys/kernel/random/boot_id") ? readFileSync("/proc/sys/kernel/random/boot_id") : ""
    );
    writeFileSync(board.statusFile, `started ${board.sha}\n`);
    writeFileSync(board.logFile, "running log\n");

    const result = board.run();

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("another activation is running");
    expect(board.read(board.logFile)).toBe("running log\n");
    expect(board.status()).toBe(`started ${board.sha}`);
    expect(board.read(join(board.root, "RELEASE"))).toBe("old\n");
    expect(existsSync(lock)).toBe(true);
  });

  it("reclaims a stale lock left by a killed activation and releases its own lock", () => {
    const board = fakeBoard({ newReleaseBroken: false });
    const lock = `${board.root}.activate.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "999999\n");
    writeFileSync(join(lock, "boot"), "");
    writeFileSync(board.statusFile, `started ${board.sha}\n`);

    const result = board.run();

    expect(result.status, result.stderr).toBe(0);
    expect(board.status()).toBe(`activated ${board.sha}`);
    expect(existsSync(lock)).toBe(false);
  });

  it("keeps the five most recent log/status pairs after a success, never the current one", () => {
    const board = fakeBoard({ newReleaseBroken: false });
    const olds = Array.from({ length: 7 }, (_, i) =>
      String(i + 1)
        .repeat(40)
        .slice(0, 40)
    );
    olds.forEach((old, i) => {
      for (const ext of ["log", "status"]) {
        const file = `${board.root}.activate-${old}.${ext}`;
        writeFileSync(file, "old\n");
        const when = new Date(Date.now() - (10 - i) * 3_600_000);
        utimesSync(file, when, when);
      }
    });

    const result = board.run();
    expect(result.status).toBe(0);

    const remaining = readdirSync(board.parent).filter((name) => name.endsWith(".status"));
    expect(remaining).toHaveLength(5);
    expect(existsSync(board.statusFile)).toBe(true);
    expect(existsSync(board.logFile)).toBe(true);
    // The four newest old pairs survive, the three oldest are gone, logs with them.
    for (const gone of olds.slice(0, 3)) {
      expect(existsSync(`${board.root}.activate-${gone}.status`)).toBe(false);
      expect(existsSync(`${board.root}.activate-${gone}.log`)).toBe(false);
    }
    for (const kept of olds.slice(3)) {
      expect(existsSync(`${board.root}.activate-${kept}.status`)).toBe(true);
      expect(existsSync(`${board.root}.activate-${kept}.log`)).toBe(true);
    }
  });

  it("prunes nothing after a rollback", () => {
    const board = fakeBoard({ newReleaseBroken: true });
    const old = "9".repeat(40);
    for (let i = 0; i < 6; i++) {
      const name = `${board.root}.activate-${String(i).repeat(40)}.status`;
      writeFileSync(name, "old\n");
      const when = new Date(Date.now() - (10 - i) * 3_600_000);
      utimesSync(name, when, when);
    }
    writeFileSync(`${board.root}.activate-${old}.status`, "old\n");
    expect(board.run().status).toBe(1);
    expect(readdirSync(board.parent).filter((n) => n.endsWith(".status"))).toHaveLength(8);
  });

  it("keeps a good release whose agent is running and retrying an unreachable relay (exit 3)", () => {
    const board = fakeBoard({ newReleaseBroken: false, newRelay: "retrying" });
    const result = board.run();

    expect(result.status).toBe(3);
    expect(board.read(join(board.root, "RELEASE"))).toBe("new\n");
    expect(existsSync(board.failed)).toBe(false);
    expect(board.status()).toBe(`activated-relay-unreachable ${board.sha}`);
    expect(board.log()).toContain("could not reach the relay");
    expect(board.restarts()).toEqual(["max-vision", "max-agent"]);
  });

  it.each([
    ["an agent that says nothing about the relay", "silent"],
    ["an agent that crashed while retrying", "crashing"]
  ] as const)("still rolls back %s", (_label, newRelay) => {
    const board = fakeBoard({ newReleaseBroken: false, newRelay });
    const result = board.run();

    expect(result.status).toBe(1);
    expect(board.read(join(board.root, "RELEASE"))).toBe("old\n");
    expect(board.status()).toBe(`rolled-back ${board.sha}`);
  });

  it("treats relay readiness during a rollback as a warning, not a failed rollback", () => {
    const board = fakeBoard({ newReleaseBroken: true, oldRelay: "silent" });
    const result = board.run();

    expect(result.status).toBe(1);
    expect(board.read(join(board.root, "RELEASE"))).toBe("old\n");
    expect(board.status()).toBe(`rolled-back ${board.sha}`);
    expect(board.log()).toContain("warning: the agent is running but has not reached the relay");
    expect(board.log()).not.toContain("ROLLBACK FAILED");
  });

  it.each([
    ["a stage that does not match the SHA", (b: ReturnType<typeof fakeBoard>) => [`${b.root}.stage-${"b".repeat(40)}`]],
    ["a previous path outside the release family", () => ["/", "/etc"]]
  ])("refuses %s without moving anything", (_label, mutate) => {
    const board = fakeBoard({ newReleaseBroken: false });
    const [stage = board.stage, previous = board.previous] = mutate(board);
    const result = spawnSync(
      "bash",
      [
        join(repositoryRoot, "rdk/remote/activate.sh"),
        stage,
        previous,
        board.failed,
        board.deviceIdFile,
        "a".repeat(40),
        "1",
        "1"
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", RDK_REMOTE_ROOT: board.root, RDK_REMOTE_ETC: board.etc }
      }
    );
    expect(result.status).toBe(64);
    expect(board.read(join(board.root, "RELEASE"))).toBe("old\n");
    expect(existsSync(board.stage)).toBe(true);
  });
});
