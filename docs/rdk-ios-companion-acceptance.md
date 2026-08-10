# RDK + iOS companion navigation acceptance record

This is an evidence template, not a success declaration. Keep every field **PENDING** until the
named command or physical observation has been performed against the same reviewed release. Do
not paste session/operator tokens, pairing codes, raw coordinates, course, speed, location
accuracy, the RDK device ID, or unfiltered logs into this file.

## Release identities

| Evidence                                | Value   | Result  |
| --------------------------------------- | ------- | ------- |
| Reviewed full Git SHA                   | PENDING | PENDING |
| `origin/main` full Git SHA              | PENDING | PENDING |
| Local clean `main` equals `origin/main` | PENDING | PENDING |
| Rollout operator/date (UTC)             | PENDING | PENDING |
| Previous known-good relay/iOS/RDK SHAs  | PENDING | PENDING |

Local identity commands:

```bash
git status --short --branch
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

## Relay and binding store — deploy first

| Evidence                                                         | Value   | Result  |
| ---------------------------------------------------------------- | ------- | ------- |
| Lightsail host/app identity (no credentials)                     | PENDING | PENDING |
| `/health` build stamp and UTC observation                        | PENDING | PENDING |
| `/ready` build stamp, empty issues, UTC observation              | PENDING | PENDING |
| PM2 service `horizon` online after deploy                        | PENDING | PENDING |
| `COMPANION_BINDINGS_FILE` configured path                        | PENDING | PENDING |
| Binding parent owner/mode `0700`                                 | PENDING | PENDING |
| Pre-pair final-file state: absent expected / present             | PENDING | PENDING |
| Disposable sibling write + file fsync + rename + directory fsync | PENDING | PENDING |
| Probe cleanup left no invalid snapshot                           | PENDING | PENDING |

Run the guarded deployment only from reviewed clean `main`:

```bash
LIGHTSAIL_KEY=/path/to/key ./deploy-lightsail.command
curl --fail --silent --show-error https://relay.example.com/health
curl --fail --silent --show-error https://relay.example.com/ready
ssh -i /path/to/key ubuntu@relay.example.com 'pm2 describe horizon'
```

For the controlled self-signed test relay only, `curl --insecure` may be recorded as test evidence;
it is not production TLS acceptance. Run the permission/write probe as the configured relay account,
not root. On a new deployment, an absent final binding file before the first Pair is expected: the
store creates it only on its first successful mutation. This pre-pair command creates/private-modes
the parent, rejects an existing wrong-owner/mode file, and proves a sibling file can be written,
fsynced, atomically renamed, and durably removed. It never creates or changes `BINDING_FILE`, so
binding-file permission/schema evidence remains **PENDING**:

```bash
BINDING_PARENT=/home/ubuntu/.horizon-helmet-testing
BINDING_FILE="$BINDING_PARENT/companion-bindings.json"
ssh -i /path/to/key ubuntu@relay.example.com bash -s -- \
  "$BINDING_PARENT" "$BINDING_FILE" <<'REMOTE'
set -euo pipefail
BINDING_PARENT=$1
BINDING_FILE=$2
node - "$BINDING_PARENT" "$BINDING_FILE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const parent = process.argv[2];
const bindingFile = process.argv[3];
const expectedUid = process.getuid();
const expectedGid = process.getgid();

if (path.resolve(path.dirname(bindingFile)) !== path.resolve(parent)) {
  throw new Error("binding file must be directly inside the configured parent");
}
fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
fs.chmodSync(parent, 0o700);
const parentStat = fs.lstatSync(parent);
if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
  throw new Error("binding parent must be a real directory");
}
if (parentStat.uid !== expectedUid || parentStat.gid !== expectedGid || (parentStat.mode & 0o777) !== 0o700) {
  throw new Error("binding parent must belong to the relay account at mode 0700");
}

if (fs.existsSync(bindingFile)) {
  const fileStat = fs.lstatSync(bindingFile);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error("existing binding path must be a regular file");
  }
  if (fileStat.uid !== expectedUid || fileStat.gid !== expectedGid || (fileStat.mode & 0o777) !== 0o600) {
    throw new Error("existing binding file must belong to the relay account at mode 0600");
  }
  console.log("binding file: present before Pair; post-pair evidence: PENDING");
} else {
  console.log("binding file: absent before first Pair (expected); file evidence: PENDING");
}

const probe = path.join(parent, `.companion-write-probe.${process.pid}`);
const moved = `${probe}.moved`;
let fd;
let directoryFd;
try {
  fd = fs.openSync(probe, "wx", 0o600);
  fs.writeFileSync(fd, "pre-pair durable-storage probe\n");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = undefined;
  fs.renameSync(probe, moved);
  directoryFd = fs.openSync(parent, "r");
  fs.fsyncSync(directoryFd);
  fs.closeSync(directoryFd);
  directoryFd = undefined;
  fs.unlinkSync(moved);
  directoryFd = fs.openSync(parent, "r");
  fs.fsyncSync(directoryFd);
  fs.closeSync(directoryFd);
  directoryFd = undefined;
} finally {
  if (fd !== undefined) fs.closeSync(fd);
  if (directoryFd !== undefined) fs.closeSync(directoryFd);
  fs.rmSync(probe, { force: true });
  fs.rmSync(moved, { force: true });
}
if (fs.existsSync(probe) || fs.existsSync(moved)) {
  throw new Error("binding storage probe cleanup failed");
}
console.log("binding parent: private; durable sibling rename: passed");
NODE
REMOTE
```

If `/ready` is not `200` with the reviewed build stamp and an empty `issues` array, do not install
clients. Record the error and roll back the relay before continuing. Do not mark binding-file mode,
schema, relationship, or backup evidence complete until after the first successful Pair persists the
real snapshot.

## Signed iOS build — install second

| Evidence                                        | Value   | Result  |
| ----------------------------------------------- | ------- | ------- |
| Full reviewed source SHA / 12-char app stamp    | PENDING | PENDING |
| Configuration, marketing version, build number  | PENDING | PENDING |
| Xcode version and signing identity/team         | PENDING | PENDING |
| Physical iPhone model / identifier              | PENDING | PENDING |
| iOS version                                     | PENDING | PENDING |
| Account sign-in succeeded                       | PENDING | PENDING |
| Precise When-In-Use permission granted          | PENDING | PENDING |
| Locked-screen location indicator visible        | PENDING | PENDING |
| Force-quit stops forwarding                     | PENDING | PENDING |
| Relaunch/login does not auto-resume Helmet Ride | PENDING | PENDING |

The account session token owns `/companion`; the manual operator token is only an `/agent`
credential. Record whether each action—Pair, Start Helmet Ride, Stop Helmet Ride, Unpair, and
Logout—produced the expected state, without recording the token or pairing code. Confirm there is
no map/raw-coordinate UI and no stored fix history.

## RDK release — deploy third

| Evidence                                                      | Value   | Result  |
| ------------------------------------------------------------- | ------- | ------- |
| Board/source reviewed SHA and `.rdk-release-sha`              | PENDING | PENDING |
| Exact reviewed Git archive staged; checkout-only files absent | PENDING | PENDING |
| `/opt/max` owner/mode `root:root:0755`                        | PENDING | PENDING |
| AEC executable preserved, executable, and byte-identical      | PENDING | PENDING |
| Armed `.wav` alert set preserved and readable                 | PENDING | PENDING |
| Dependencies installed and build passed inside staged tree    | PENDING | PENDING |
| `MAX_DEVICE_ID_FILE` path (value not recorded)                | PENDING | PENDING |
| Identity parent/file owner and modes `root:root:0700`/`0600`  | PENDING | PENDING |
| Identity unchanged across the one controlled service restart  | PENDING | PENDING |
| New/current `max-agent` Invocation ID                         | PENDING | PENDING |
| `max-agent` active timestamp / MainPID                        | PENDING | PENDING |
| Same-invocation `[relay] session ready` within 60 seconds     | PENDING | PENDING |
| HUD reports paired/ready before ride                          | PENDING | PENDING |
| Previous RDK SHA and rollback readiness                       | PENDING | PENDING |

Use the reviewed archive/stage/build/activation commands in
[`../rdk/README.md`](../rdk/README.md); do not sync a live checkout to `/opt/max`. Keep the
`InvocationID=` value emitted by that rollout as `ROLLOUT_INVOCATION_ID`. Do **not** restart again
for evidence collection and do not accept a marker from an earlier invocation. This read-only
follow-up rechecks the current Invocation ID, exact release stamp, owners/modes, preserved board
artifacts, and only the journal belonging to the rollout invocation. Record only `stable`/`changed`
for the private identity digest; never print its value or run an unfiltered `journalctl` into this
evidence file:

```bash
RDK_HOST=root@board.example.com
REVIEWED_SHA=0000000000000000000000000000000000000000
RDK_DEVICE_ID_FILE=/var/lib/max/device-id
ROLLOUT_INVOCATION_ID=00000000000000000000000000000000
ssh "$RDK_HOST" bash -s -- \
  "$REVIEWED_SHA" "$RDK_DEVICE_ID_FILE" "$ROLLOUT_INVOCATION_ID" <<'REMOTE'
set -euo pipefail
REVIEWED_SHA=$1
DEVICE_ID=$2
invocation_id=$3
test "$(cat /opt/max/.rdk-release-sha)" = "$REVIEWED_SHA"
test "$(stat -c '%U:%G:%a' /opt/max)" = root:root:755
test "$(stat -c '%U:%G:%a' "$(dirname "$DEVICE_ID")")" = root:root:700
test "$(stat -c '%U:%G:%a' "$DEVICE_ID")" = root:root:600
test -x /opt/max/rdk/aec/max-aec
find /opt/max/rdk/audio/alerts -maxdepth 1 -type f -name '*.wav' -readable -print -quit | grep -q .
test "$(systemctl show -p InvocationID --value max-agent)" = "$invocation_id"
systemctl is-active --quiet max-agent
journalctl _SYSTEMD_INVOCATION_ID="$invocation_id" --no-pager -o cat | \
  grep -F '[relay] session ready' >/dev/null
systemctl show max-agent -p InvocationID -p ActiveEnterTimestamp -p MainPID --no-pager
REMOTE
```

## First Pair and persisted binding — complete before ride

The first successful Pair happens only after relay, signed iOS, and RDK rollout. Keep identity values
private: record only whether the signed-in account paired to the intended RDK and whether the HUD
reported ready. Then complete the final-file evidence the pre-pair probe deliberately left PENDING:

| Evidence                                                               | Value   | Result  |
| ---------------------------------------------------------------------- | ------- | ------- |
| Signed-in account paired to intended RDK; identities not recorded      | PENDING | PENDING |
| RDK HUD reported paired/ready before Helmet Ride                       | PENDING | PENDING |
| Binding file now exists as a regular non-symlink file                  | PENDING | PENDING |
| Binding parent/file relay owner and modes `0700`/`0600`                | PENDING | PENDING |
| Snapshot parses as version 1 with only valid relationship metadata     | PENDING | PENDING |
| At least one persisted account ↔ RDK relationship; identities withheld | PENDING | PENDING |
| `/ready` remains `200` with empty issues after persistence             | PENDING | PENDING |
| Owner-only snapshot backup path and restore test/reference             | PENDING | PENDING |

Run this as the relay account after Pair. It reads the protected snapshot only to validate the
schema and relationship invariants; output is count-only and never prints account IDs, device IDs,
timestamps, pairing codes, or fixes. An absent, empty-byte, malformed, wrong-owner/mode, duplicate,
or empty-relationship snapshot fails:

```bash
BINDING_PARENT=/home/ubuntu/.horizon-helmet-testing
BINDING_FILE="$BINDING_PARENT/companion-bindings.json"
ssh -i /path/to/key ubuntu@relay.example.com bash -s -- \
  "$BINDING_PARENT" "$BINDING_FILE" <<'REMOTE'
set -euo pipefail
BINDING_PARENT=$1
BINDING_FILE=$2
node - "$BINDING_PARENT" "$BINDING_FILE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const parent = process.argv[2];
const bindingFile = process.argv[3];
const expectedUid = process.getuid();
const expectedGid = process.getgid();

if (path.resolve(path.dirname(bindingFile)) !== path.resolve(parent)) {
  throw new Error("binding file must be directly inside the configured parent");
}
const parentStat = fs.lstatSync(parent);
const fileStat = fs.lstatSync(bindingFile);
if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
  throw new Error("binding parent must be a real directory");
}
if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
  throw new Error("binding snapshot must be a regular file");
}
if (parentStat.uid !== expectedUid || parentStat.gid !== expectedGid || (parentStat.mode & 0o777) !== 0o700) {
  throw new Error("binding parent must belong to the relay account at mode 0700");
}
if (fileStat.uid !== expectedUid || fileStat.gid !== expectedGid || (fileStat.mode & 0o777) !== 0o600) {
  throw new Error("binding snapshot must belong to the relay account at mode 0600");
}

const snapshot = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.bindings) || snapshot.bindings.length < 1) {
  throw new Error("binding snapshot must contain at least one version-1 relationship");
}
const snapshotKeys = Object.keys(snapshot).sort();
if (snapshotKeys.length !== 2 || snapshotKeys[0] !== "bindings" || snapshotKeys[1] !== "version") {
  throw new Error("binding snapshot contains an unexpected top-level field");
}
const accounts = new Set();
const devices = new Set();
const allowedKeys = ["accountId", "createdAt", "deviceId", "updatedAt"];
for (const binding of snapshot.bindings) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error("binding snapshot contains a non-object relationship");
  }
  const keys = Object.keys(binding).sort();
  if (keys.length !== allowedKeys.length || keys.some((key, index) => key !== allowedKeys[index])) {
    throw new Error("binding snapshot contains an unexpected field");
  }
  if (typeof binding.accountId !== "string" || binding.accountId.trim() === "" ||
      typeof binding.deviceId !== "string" || binding.deviceId.trim() === "" ||
      typeof binding.createdAt !== "number" || !Number.isFinite(binding.createdAt) || binding.createdAt < 0 ||
      typeof binding.updatedAt !== "number" || !Number.isFinite(binding.updatedAt) ||
      binding.updatedAt < binding.createdAt) {
    throw new Error("binding snapshot contains an invalid relationship");
  }
  if (accounts.has(binding.accountId) || devices.has(binding.deviceId)) {
    throw new Error("binding snapshot contains a duplicate account or device");
  }
  accounts.add(binding.accountId);
  devices.add(binding.deviceId);
}
console.log(`binding snapshot: valid; persisted relationships: ${snapshot.bindings.length}`);
NODE
REMOTE
curl --fail --silent --show-error https://relay.example.com/ready
```

## Physical ride acceptance

| Step                                                                                           | Observation | Result  |
| ---------------------------------------------------------------------------------------------- | ----------- | ------- |
| Start Helmet Ride, lock phone for at least 10 continuous minutes, confirm forwarding/indicator | PENDING     | PENDING |
| Request a real Amap destination; verify RDK HUD and speech far → near → now                    | PENDING     | PENDING |
| Force an off-route condition; verify one reroute and replacement route                         | PENDING     | PENDING |
| Remove/restore network; verify truthful pause then fresh-fix resume                            | PENDING     | PENDING |
| Disable/restore precise location; verify truthful pause then precise-fix resume                | PENDING     | PENDING |
| Trigger an armed test ADAS alert during a nav prompt; verify priority/preemption               | PENDING     | PENDING |
| Verify arrival once, then stop navigation                                                      | PENDING     | PENDING |
| Start a second route without unlocking; verify route and guidance                              | PENDING     | PENDING |
| Stop Helmet Ride; verify location forwarding and indicator stop                                | PENDING     | PENDING |
| Unpair and logout; verify no background forwarding/reconnect                                   | PENDING     | PENDING |

Record the route/destination only at the level needed to repeat the test; do not record raw fixes.
ADAS audio must already be explicitly armed under its own safety gate—do not enable it merely to
complete this checklist.

## Privacy inspection

| Surface inspected                             | Time range / method | Result  |
| --------------------------------------------- | ------------------- | ------- |
| Relay structured logs                         | PENDING             | PENDING |
| Aggregate companion/testing metrics           | PENDING             | PENDING |
| Relay user-memory/provider-visible inputs     | PENDING             | PENDING |
| Binding snapshot metadata and permissions     | PENDING             | PENDING |
| RDK `max-agent` journal and HUD-visible state | PENDING             | PENDING |
| iOS diagnostics/UI/persistence                | PENDING             | PENDING |

Use bounded searches that report matching line numbers only after replacing any discovered private
value locally; do not paste a raw match into this document. Repository/static checks:

```bash
rg -n "lat|lon|course|speed" server/companion-store.ts
rg -n "companion.location|phone.location" server
rg -n "pairingCode|horizontalAccuracyMeters|phone.location" rdk/agent/src/hud rdk/agent/src/main.ts
npx vitest run tests/rdk-companion-navigation-e2e.test.ts
```

Expected privacy boundary: current location exists only in the phone → relay → bound RDK protocol
frames while the ride is active. Logs, metrics, memory, binding persistence, acceptance evidence,
and post-pair rendered UI must not expose raw fixes or the pairing code. The binding snapshot may
contain only account/device relationship metadata and timestamps.

## Final decision and rollback

| Decision                                      | Value   |
| --------------------------------------------- | ------- |
| Acceptance owner                              | PENDING |
| Final PASS / FAIL / BLOCKED                   | PENDING |
| Open concerns and links                       | PENDING |
| Rollback performed or explicitly not required | PENDING |

Any failed stage blocks later stages. Relay rollback comes first, followed by the previously signed
iOS build and then the previous `/opt/max` checkout/unit files. Stop Helmet Ride before client or
RDK rollback, preserve `/var/lib/max/device-id`, repeat health/readiness/service/privacy checks,
and keep all physical results PENDING until rerun on the restored identities.
