# Final navigation-speech flake report

## Scope

- Base: `main` at `20ba022`.
- Failure: `tests/doubao-nav-speech.test.ts` — `routes one prompt through the session-owned route and mock provider as one transcript line` timed out at line 475 after about one second during `npm run check`.
- Constraint: diagnose the data flow before editing; do not hide the failure with a longer timeout or retries.

## Phase 1 evidence

The test constructs a real `AgentSessionController` with the mock **voice** provider, but the controller independently constructs its route provider from `config.amapApiKey`. The local `.env` now has a non-empty `AMAP_API_KEY`, so the test selected the real Amap HTTP provider. `nav.request` is intentionally dispatched fire-and-forget, and the test's observable-event wait expired while the two sequential network calls were still running.

- Configured-key focused reproduction: 5/5 measured fresh-process runs failed at the same line; each test spent about 1.02 seconds in the wait.
- Full-load reproduction before the fix: 1 failure, 2,227 passes; the only failure was the same navigation-speech case.
- Boundary timing using the same origin/query without printing the key:
  - configured Amap `resolveDestination`: 2,539 ms;
  - configured Amap `planRoute`: 1,736 ms;
  - in-memory mock resolve + plan: 0 ms at millisecond resolution.
- Control experiment with `AMAP_API_KEY` masked: 5/5 fresh-process runs passed, with the focused test completing in 5–6 ms.
- Nearby `createNavHandler` tests explicitly inject `createMockRouteProvider()`, and this file already has a `routeProviderOverride` seam for its deterministic reroute test.

## Root cause

The wiring test did not own its route dependency. Deploying a legitimate runtime Amap key changed a unit/integration test from an in-memory route into a live network integration. The fixed one-second polling ceiling was only the symptom; increasing it would remain network-dependent and could still fail anywhere within the provider's two three-second request bounds.

## Fix

The test now assigns `createMockRouteProvider()` through the existing `routeProviderOverride` seam before constructing the session controller.

- No production code changed.
- No timeout increased.
- No retry added.
- The real `AgentSessionController` routing and prompt wiring, real mock route provider, and real mock voice provider remain exercised. A missing `nav.route`, missing active-route ownership, rejected `nav.prompt`, or missing transcript send still fails the observable behavior assertion.

## RED / GREEN / verification

RED was the existing test against the configured environment:

```text
FAIL tests/doubao-nav-speech.test.ts ... routes one prompt ... 1025ms
AssertionError: expected false to be true
```

GREEN and stress evidence after the dependency-isolation change:

- Exact focused case: 1/1 passed in 4 ms on the first GREEN run (2 ms in the full-file run).
- Fresh-process focused stress: 30/30 passed with the configured `.env` still present.
- Full `tests/doubao-nav-speech.test.ts`: 14/14 discovered tests passed.
- `npx tsc -p rdk/agent/tsconfig.json`: exit 0.
- `git diff --check`: exit 0.
- `npm run check`: exit 0.
  - protocol generation check passed;
  - Prettier passed;
  - ESLint passed;
  - dead-code check passed;
  - Vitest: 192/192 files and 2,228/2,228 tests passed;
  - fault matrix: 24/24 cases matched;
  - TypeScript and Vite production build passed.
