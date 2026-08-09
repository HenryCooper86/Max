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

| Evidence                                            | Value   | Result  |
| --------------------------------------------------- | ------- | ------- |
| Lightsail host/app identity (no credentials)        | PENDING | PENDING |
| `/health` build stamp and UTC observation           | PENDING | PENDING |
| `/ready` build stamp, empty issues, UTC observation | PENDING | PENDING |
| PM2 service `horizon` online after deploy           | PENDING | PENDING |
| `COMPANION_BINDINGS_FILE` configured path           | PENDING | PENDING |
| Binding parent owner/mode `0700`                    | PENDING | PENDING |
| Binding file owner/mode `0600`                      | PENDING | PENDING |
| Atomic write/rename probe as relay owner            | PENDING | PENDING |
| Owner-only backup path and restore test/reference   | PENDING | PENDING |

Run the guarded deployment only from reviewed clean `main`:

```bash
LIGHTSAIL_KEY=/path/to/key ./deploy-lightsail.command
curl --fail --silent --show-error https://relay.example.com/health
curl --fail --silent --show-error https://relay.example.com/ready
```

For the controlled self-signed test relay only, `curl --insecure` may be recorded as test evidence;
it is not production TLS acceptance. Run the permission/write probe as the configured relay account,
not root. It proves the configured binding parent owner/group/mode, binding file owner/group/mode,
and atomic rename capability without reading binding contents:

```bash
BINDING_PARENT=/home/ubuntu/.horizon-helmet-testing
BINDING_FILE="$BINDING_PARENT/companion-bindings.json"
ssh -i /path/to/key ubuntu@relay.example.com bash -s -- \
  "$BINDING_PARENT" "$BINDING_FILE" <<'REMOTE'
set -euo pipefail
BINDING_PARENT=$1
BINDING_FILE=$2
expected_owner=$(id -un)
expected_group=$(id -gn)
test "$(dirname "$BINDING_FILE")" = "$BINDING_PARENT"
test "$(stat -c '%U:%G:%a' "$BINDING_PARENT")" = "$expected_owner:$expected_group:700"
test "$(stat -c '%U:%G:%a' "$BINDING_FILE")" = "$expected_owner:$expected_group:600"
probe="$BINDING_PARENT/.companion-write-probe.$$"
moved="$probe.moved"
trap 'rm -f "$probe" "$moved"' EXIT
umask 077
: > "$probe"
mv "$probe" "$moved"
rm -f "$moved"
trap - EXIT
pm2 describe horizon
REMOTE
```

If `/ready` is not `200` with the reviewed build stamp and an empty `issues` array, do not install
clients. Record the error and roll back the relay before continuing.

## Signed iOS build — install second

| Evidence                                        | Value   | Result  |
| ----------------------------------------------- | ------- | ------- |
| Full reviewed source SHA / 12-char app stamp    | PENDING | PENDING |
| Configuration, marketing version, build number  | PENDING | PENDING |
| Xcode version and signing identity/team         | PENDING | PENDING |
| Physical iPhone model / identifier              | PENDING | PENDING |
| iOS version                                     | PENDING | PENDING |
| Account sign-in succeeded                       | PENDING | PENDING |
| Pair once; RDK HUD ready before ride            | PENDING | PENDING |
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

## Physical ride acceptance

| Step                                                                                           | Observation | Result  |
| ---------------------------------------------------------------------------------------------- | ----------- | ------- |
| Install signed build on physical iPhone, sign in, Pair once, verify RDK HUD ready before ride  | PENDING     | PENDING |
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
