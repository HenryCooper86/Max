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
it is not production TLS acceptance. Inspect permissions without reading binding contents:

```bash
ssh -i /path/to/key ubuntu@relay.example.com \
  'stat -c "%a %U:%G %n" /path/to/binding-parent /path/to/companion-bindings.json && pm2 describe horizon'
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

| Evidence                                            | Value   | Result  |
| --------------------------------------------------- | ------- | ------- |
| Board/source reviewed SHA                           | PENDING | PENDING |
| `MAX_DEVICE_ID_FILE` path (value not recorded)      | PENDING | PENDING |
| Identity parent/file owner and modes `0700`/`0600`  | PENDING | PENDING |
| Identity unchanged across service restart           | PENDING | PENDING |
| `max-agent` active timestamp / MainPID              | PENDING | PENDING |
| Sanitized `[relay] session ready` journal timestamp | PENDING | PENDING |
| HUD reports paired/ready before ride                | PENDING | PENDING |
| Previous RDK SHA and rollback readiness             | PENDING | PENDING |

Use the reviewed sync/install/restart commands in [`../rdk/README.md`](../rdk/README.md). Compare
the private device identity across restart in shell variables and record only `stable` or
`changed`; never print its value. Do not run an unfiltered `journalctl` into this evidence file.

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
