# Task 16 implementation report

## Scope and identity

- Base: `ad2e201cba423648e4894f81fe74218d9c9df21a`
- Branch: `feature/rdk-ios-companion-navigation`
- Product/API changes: none
- External changes: none; no merge, push, Lightsail deploy, phone install, RDK sync, or service restart was performed
- Test-only local setup: created gitignored `android/local.properties` pointing at the already-installed `/Users/admin/Library/Android/sdk`

## Deterministic integration and privacy proof

`tests/rdk-companion-navigation-e2e.test.ts` builds one deterministic harness from the real:

- companion protocol parser, `CompanionBindingStore`, and `CompanionRegistry`;
- `/agent` event parser, `PhoneLocationSource`, `RdkNavigationController`, HUD reducer, and `MOCK_ROUTE`;
- aggregate metrics and user-memory snapshots;
- owner-private temporary binding file, deterministic clock, pairing code, IDs, timers, and authenticated account/device peer identities.

The first test derives the required semantic timeline from actual registry peer sends, location and navigation state callbacks, parsed navigation requests/prompts, and route delivery callbacks. It pins pairing, sharing, held start, matching start/reroute command IDs, route replacement, far/near/now order, stale pause, fresh resume, exactly-once arrival, terminal/repeated stop behavior, companion stop, and cleanup. It also challenges duplicate and stale fixes, old phone and helmet generations after replacement, repeated companion stop, and callbacks/timers after all real components close.

The second test captures every registry logger method/argument, before/after aggregate metrics, provider-visible prompt inputs, user-memory snapshot, durable binding snapshot/file, all temporary documents, acceptance evidence, and post-pair user-visible HUD projections. Unique raw pairing/location/course/speed/accuracy sentinels are absent from those surfaces and present in the protocol transport frames that require them. The persisted relationship contains only account ID, device ID, and timestamps; its parent/file modes are asserted as `0700`/`0600`.

## RED / characterization / GREEN

No production or documentation file had been edited before the first required run.

```text
npx vitest run tests/rdk-companion-navigation-e2e.test.ts
PASS — 1 file, 2 tests
```

This was honestly characterization-green against the already-implemented product. No artificial production failure was introduced. The missing evidence artifacts then produced the planned documentation RED:

```text
test -f docs/rdk-ios-companion-acceptance.md && \
  test -f .superpowers/sdd/2026-08-09-rdk-ios-companion-navigation/task-16-report.md
exit 1
```

After creating the acceptance template and this report, that existence gate exits `0`. The focused test was rerun after documentation changes and remained `2/2` green; final fresh verification is recorded below.

## Independent-review correction round 1

The cumulative review of `c696b50edcff1a8fc457735f7c578f9440451fff` found two Important
operational defects and one Minor wording defect in Task 16's documentation: root-level checkout
`rsync --delete` could upload ignored files and erase the board-only AEC executable/armed alerts;
the readiness grep could accept a marker from the previous systemd invocation; and the generic
privacy text overstated encryption for Debug LAN `ws://`.

Before changing the documentation, `tests/rdk-release-operations.test.ts` supplied the required
executable regression contract:

```text
npx vitest run tests/rdk-release-operations.test.ts
FAIL — 3 failed, 1 passed
```

The failures were the three reviewed documentation defects. The already-green test was a safe local
dry-run: it created a temporary Git repository, archived a reviewed commit, proved ignored/untracked
checkout sentinels were absent, then proved an executable AEC fixture and armed `.wav` alert survived
explicit preservation. No product or deployment file was changed to create the RED.

After correcting the rollout, acceptance template, and transport wording, the same contract passed;
an additional executable assertion now parses every new rollout/rollback and acceptance `bash`
fence through `bash -n`:

```text
npx vitest run tests/rdk-release-operations.test.ts
PASS — 1 file, 5 tests
```

## Independent-review correction round 2

The cumulative re-review of `b414940c8ee927f4eea77d50edbf47d1eb462b03` found that the revised
relay-first preflight still unconditionally required `COMPANION_BINDINGS_FILE`. Production treats
`ENOENT` as a ready in-memory store and does not persist the final file until the first successful
Pair, so a normal new deployment could not pass that command. It also meant the pre-pair evidence
text falsely claimed the nonexistent file's owner/mode had been proven.

Before changing documentation, the operations suite executed the documented remote preflight in a
real owner-private temporary directory with an absent final file:

```text
npx vitest run tests/rdk-release-operations.test.ts
FAIL — 1 failed, 5 passed
stat: .../companion-bindings.json: No such file or directory
```

The failure was the reviewed lifecycle defect, not a compiler/import error. The regression now
instruments the actual file/directory `fsync` and rename calls while retaining their real side
effects. It proves pre-pair absence succeeds without creating a final snapshot or leaving probe
files; an existing `0644` file fails both pre-pair and post-Pair; and post-Pair empty bytes or a
schema-valid but relationship-empty snapshot cannot complete acceptance. A valid owner-private
version-1 relationship snapshot passes with count-only output that omits account/device identities.

After splitting the acceptance lifecycle, the focused contract is green:

```text
npx vitest run tests/rdk-release-operations.test.ts
PASS — 1 file, 6 tests
```

## Broad gates

Initial Task 16 runs at `c696b50edcff1a8fc457735f7c578f9440451fff`:

| Command                                                                    | Result                                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/rdk-companion-navigation-e2e.test.ts`                | PASS — 2/2                                                                                          |
| `npm run check`                                                            | BLOCKED at known Prettier finding: `server/companion-store.ts`                                      |
| `npx tsc -p rdk/agent/tsconfig.json`                                       | PASS                                                                                                |
| `npm run check:protocol`                                                   | PASS                                                                                                |
| `npm test`                                                                 | PASS — 101 files, 1,291 tests                                                                       |
| `npm run lint`                                                             | PASS after fixing only the new test harness lint findings                                           |
| `npm run check:dead-code`                                                  | BLOCKED by ledgered artifacts listed below                                                          |
| `npm run test:fault-matrix`                                                | PASS — 24/24                                                                                        |
| `npm run build`                                                            | PASS                                                                                                |
| Full MaxHelmet simulator test command                                      | PASS — 397/397; Xcode emitted a post-success simulator diagnostic collection warning about `simctl` |
| Unsigned MaxHelmet simulator build                                         | PASS                                                                                                |
| Android `testDebugUnitTest lintDebug assembleDebug` with installed SDK/JBR | PASS — 53 Gradle tasks; non-fatal native-access/strip-symbol warnings                               |
| `git diff --check`                                                         | PASS                                                                                                |
| `bash -n deploy-lightsail.command`                                         | PASS                                                                                                |

Fresh review-correction runs:

| Command                                                                    | Result                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npx vitest run tests/rdk-release-operations.test.ts`                      | PASS — 5/5                                                                     |
| Both Task 16 Vitest files                                                  | PASS — 2 files, 7 tests                                                        |
| `npm test`                                                                 | PASS — 102 files, 1,296 tests                                                  |
| `npx tsc -p rdk/agent/tsconfig.json`                                       | PASS                                                                           |
| `npm run check:protocol`                                                   | PASS                                                                           |
| `npm run lint`                                                             | PASS                                                                           |
| `npm run test:fault-matrix`                                                | PASS — 24/24                                                                   |
| `npm run build`                                                            | PASS                                                                           |
| Affected-file Prettier checks, including the ignored report explicitly     | PASS                                                                           |
| Executable rollout/rollback/acceptance Bash-fence assertions               | PASS inside `rdk-release-operations.test.ts`                                   |
| `bash -n deploy-lightsail.command`                                         | PASS                                                                           |
| Full MaxHelmet simulator test command                                      | PASS — 397/397; known post-success `simctl` diagnostic-collection warning only |
| Unsigned MaxHelmet simulator build                                         | PASS                                                                           |
| Android `testDebugUnitTest lintDebug assembleDebug` with installed SDK/JBR | PASS — 53 Gradle tasks; the documented native-access warning remains non-fatal |
| `git diff --check`                                                         | PASS                                                                           |
| `npm run check`                                                            | BLOCKED at unchanged ledgered Prettier finding: `server/companion-store.ts`    |
| `npm run check:dead-code`                                                  | BLOCKED by the same four ledgered file/binary/export findings printed below    |

Fresh review-correction round 2 runs:

| Command                                                                    | Result                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npx vitest run tests/rdk-release-operations.test.ts`                      | PASS — 6/6                                                                     |
| Both Task 16 Vitest files                                                  | PASS — 2 files, 8 tests                                                        |
| `npm test`                                                                 | PASS — 102 files, 1,297 tests                                                  |
| `npx tsc -p rdk/agent/tsconfig.json`                                       | PASS                                                                           |
| `npm run check:protocol`                                                   | PASS                                                                           |
| `npm run lint`                                                             | PASS                                                                           |
| `npm run test:fault-matrix`                                                | PASS — 24/24                                                                   |
| `npm run build`                                                            | PASS                                                                           |
| Affected-file Prettier checks, including the ignored report explicitly     | PASS                                                                           |
| Executed absent-file/fsync/rename/post-persist acceptance contract         | PASS                                                                           |
| Executable rollout/rollback/acceptance Bash-fence assertions               | PASS inside `rdk-release-operations.test.ts`                                   |
| `bash -n deploy-lightsail.command`                                         | PASS                                                                           |
| Full MaxHelmet simulator test command                                      | PASS — 397/397; known post-success `simctl` diagnostic-collection warning only |
| Unsigned MaxHelmet simulator build                                         | PASS                                                                           |
| Android `testDebugUnitTest lintDebug assembleDebug` with installed SDK/JBR | PASS — 53 Gradle tasks; the documented native-access warning remains non-fatal |
| `git diff --check`                                                         | PASS                                                                           |
| `npm run check`                                                            | BLOCKED at unchanged ledgered Prettier finding: `server/companion-store.ts`    |
| `npm run check:dead-code`                                                  | BLOCKED by the same four ledgered file/binary/export findings printed below    |

The exact pre-ledgered dead-code output remains:

```text
Unused files (2)
server/companion-socket.contract.ts
tests/fixtures/rdk-device-identity-child.ts
Unlisted binaries (1)
mkfifo  tests/rdk-device-identity.test.ts
Unused exported types (1)
CompanionPeer  type  server/companion-registry.ts:7:13
```

Per the Task 16 brief, this commit does not format Task 2's store or delete/change those artifacts. The primary final-gate owner must resolve or explicitly disposition them before claiming the aggregate `npm run check` is green.

## Privacy/static audit

- `rg -n "lat|lon|course|speed" server/companion-store.ts` reports only false-positive `cloneBinding`/`cloneMaps` identifier substrings; the snapshot has no location/course/speed field.
- `rg -n "companion.location|phone.location" server` finds the registry's typed event handling/forwarding sites only.
- The follow-up combined payload/logger search found no companion logger containing location values or payload spreads.
- The deterministic privacy test proves raw sentinels remain out of logger arguments, aggregate metrics, memory/provider inputs, persisted bindings, temporary documents, acceptance evidence, and post-pair rendered evidence.
- Current transport frames remain the explicit exception: an active Helmet Ride must carry the current fix to the bound RDK.

## Documentation and operations audit

The root, RDK, and iOS READMEs and changelog now consistently document:

- pre-pair `COMPANION_BINDINGS_FILE` absence as normal, private parent ownership, durable disposable
  sibling probing, and final-file/schema evidence remaining PENDING until the first persisted Pair;
- post-first-Pair final-file owner/mode, nonempty relationship-schema validation, owner-only
  backup/recovery, and `/ready` failure after load/persist faults;
- account-owned `/companion` authentication versus the manual `/agent` operator token, aggregate-only companion metrics, and `/health` liveness versus `/ready` traffic readiness;
- per-board durable RDK ID preservation and private mode/stability verification without printing its value;
- Pair, Start/Stop Helmet Ride, Unpair, logout, precise When-In-Use permission, locked-screen indicator, force-quit termination, no auto-resume, no raw-coordinate/map UI, and no fix persistence;
- Debug self-signed relay use only and trusted hostname-matched TLS for production;
- relay → signed iOS → RDK rollout order, stage blocking, verification, and rollback.

`docs/rdk-ios-companion-acceptance.md` is intentionally a PENDING evidence template. It contains identity/build/service/permission fields, the complete physical checklist, privacy surfaces, safe commands, and rollback fields; it makes no deployed or physical success claim.

## Deployment-readiness audit

`deploy-lightsail.command` was inspected without execution. It:

- refuses a dirty worktree;
- requires the configured deploy branch (default `main`) unless an explicit staging override is set;
- compares local `HEAD` to `origin/<deploy branch>`;
- archives, builds, and stamps that exact commit;
- activates and restarts the expected PM2 service `horizon`;
- verifies `/health` and `/ready` against the expected short SHA and requires readiness `issues` to be empty;
- automatically restores the previous release after a post-activation failure.

Required deployment inputs are `LIGHTSAIL_KEY`, `LIGHTSAIL_HOST`, `LIGHTSAIL_APP_DIR`, `LIGHTSAIL_HEALTH_URL`, `LIGHTSAIL_READY_URL`, and optionally `LIGHTSAIL_DEPLOY_BRANCH`; no secret values were printed. The default key file exists locally, but credentials/connectivity were not exercised. The script currently uses `curl --insecure` for the documented controlled self-signed test box; production acceptance still requires trusted TLS.

The corrected RDK archive/stage/build/activation/rollback commands are recorded in `rdk/README.md`.
They require the reviewed SHA to equal `origin/main`, stream `git archive "$REVIEWED_SHA"` into a
new root-owned stage, and therefore cannot import ignored/unreviewed checkout files. Before
activation they explicitly preserve and compare `/opt/max/rdk/aec/max-aec` and the armed
`/opt/max/rdk/audio/alerts` clip set; dependencies and the build run from that exact stage. They
verify `/opt/max` and private device-identity ownership/modes, preserve `/var/lib/max/device-id` and
`/etc/max`, and use one controlled forward restart. Readiness is bounded to 60 seconds and accepts
`[relay] session ready` only from the new/current
`systemctl show -p InvocationID --value max-agent`; the acceptance follow-up performs no second
restart. Rollback restores the entire former release, including its native/audio artifacts, and
repeats the new-invocation proof.

The relay acceptance lifecycle now has two deliberately separate gates. Before Pair, the relay
account creates/private-modes only the configured parent and durably writes, file-fsyncs, renames,
directory-fsyncs, and removes a disposable sibling. Absence of the final path is recorded as
expected and its file evidence remains PENDING; no empty placeholder is created. After the first
successful Pair, a separate command requires a regular relay-owned `0600` file under the `0700`
parent, parses exact version-1 relationship metadata, requires at least one unique account/device
relationship, rechecks `/ready`, and prints only the relationship count. Root privacy wording still
distinguishes production `wss://` with trusted TLS, the TLS-protected self-signed Debug test
endpoint, and unencrypted Debug LAN `ws://`.

## External and physical checks still PENDING

- reviewed merge/push and exact `origin/main` identity;
- Lightsail deployment, binding-path permission/write probe, PM2 state, and matching `/health`/`/ready` stamps;
- signed build/install on a physical iPhone and actual device/iOS/build identities;
- physical Pair/ready and precise-permission checks;
- at least ten minutes locked during Helmet Ride;
- real Amap destination with HUD/speech far/near/now/reroute/arrival;
- network and precise-location loss/resume;
- armed ADAS alert priority/preemption during a navigation prompt;
- second route while locked, Stop Helmet Ride, Unpair/logout;
- live relay/RDK/iOS log, HUD, metrics, memory, binding, and persistence privacy inspection.

No physical-device, audio-hardware, Amap, or Lightsail acceptance is claimed.

## Exact Task 16 diff

Created:

- `tests/rdk-companion-navigation-e2e.test.ts`
- `tests/rdk-release-operations.test.ts`
- `docs/rdk-ios-companion-acceptance.md`
- `.superpowers/sdd/2026-08-09-rdk-ios-companion-navigation/task-16-report.md`

Modified:

- `README.md`
- `rdk/README.md`
- `ios/README.md`
- `CHANGELOG.md`

Ignored local-only setup:

- `android/local.properties`

No production source, protocol, configuration, deployment script, plist, Xcode project, Gradle project, or service unit was changed.
