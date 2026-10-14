# Synthetic browser QA

This local harness loads the production `useHelmetAgent`, `useMicCapture` and
`useAudioPlayback` hooks. Its isolated Vite plugin replaces the capture acquisition
boundary with a generated MediaStream, disables location acquisition, and routes
the native browser WebSocket through a standard authenticated Vite proxy. Real
AudioWorklet framing, server VAD, relay events, PCM queueing and teardown remain in
use. It does not establish microphone, physical device, road, or carrier coverage.

Run from the repository root after freezing the candidate commit:

```sh
QA_CONNECTION_FILE=/tmp/max-synthetic-qa/connection.json \
QA_FIXTURE_MANIFEST=/tmp/max-synthetic-qa/manifest.json \
QA_WEB_CONTEXT_FILE=/tmp/max-synthetic-qa/web-context.json \
QA_EVIDENCE_DIR=/tmp/max-synthetic-qa/web-evidence \
npx vite --config scripts/synthetic-qa/browser/vite.config.mts
```

Open `http://127.0.0.1:5189/` in Chrome and use the visible run buttons. Every
required fixture passes its declared SHA-256, sample format and exact length before
any session opens. The token is read only by the loopback proxy; keep connection
files, generated PCM and evidence outside the repository with private permissions.
The harness has no production route or entry point.

Connection JSON: `{ "url": "wss://host/agent", "token": "private", "build": "server commit" }`.
Optional context JSON:

```json
{
  "testingRunId": "run-id",
  "testerId": "fixed-assignment-tester",
  "assignments": { "baseline-live-session": "assignment-id" },
  "networkCohorts": {
    "standard": "synthetic-standard",
    "wind": "synthetic field wind 12db",
    "degraded": "synthetic-degraded-outage"
  }
}
```

The context must use assignment ids for each selected case. `serverBuild` records
the connection's declared upstream build independently from `compiledClientCommit`,
which is resolved from actual local Git HEAD at server start. Restart after changing
the candidate or upstream. `QA_PORT`, `QA_PRIVATE_DIR` and `QA_FIXTURE_DIR` can route
an independent baseline harness without changing browser source.

The network case finishes a valid exchange before a 4.5-second forced socket close
and refused reconnect attempts, then emits a second fixture after production
reconnection. The ADAS scenario observes live relay hazard events. The visible
playback counters and saved evidence record actual buffer source starts, endings,
stops, speech synthesis calls, fixture hashes, relay events and final teardown.
Results preserve repeats and failures in separate files with explicit pass/fail and individual assertions. Unaddressed background audio must produce no agent transcript, PCM or speech. An ADAS alert must arrive while real PCM sources are pending and stop every pending source immediately in the production handler. Every received PCM sample must reach playback, normal responses must finish naturally, and disconnect must close capture and playback resources.

Verification:

```sh
npx vitest run tests/synthetic-browser-fixtures.test.ts tests/synthetic-browser-assertions.test.ts
npx tsc -p scripts/synthetic-qa/browser/tsconfig.json
npx vite build --config scripts/synthetic-qa/browser/vite.config.mts --outDir /tmp/max-synthetic-qa/browser-build
```
