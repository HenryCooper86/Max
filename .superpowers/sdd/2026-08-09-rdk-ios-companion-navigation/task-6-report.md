# Task 6 report

Status: complete

Files:

- `server/navigation-prompts.ts`
- `server/routing.ts`
- `server/providers/types.ts`
- `server/providers/doubao.ts`
- `server/providers/mock.ts`
- `server/session-controller.ts`
- `server/device-actions.ts`
- `server/speech.ts`
- `tests/navigation-prompts.test.ts`
- `tests/nav-handler.test.ts`
- `tests/doubao-nav-speech.test.ts`
- `tests/speech.test.ts`
- `tests/device-actions.test.ts`

RED:

- `npx vitest run tests/navigation-prompts.test.ts tests/nav-handler.test.ts tests/doubao-nav-speech.test.ts tests/device-actions.test.ts`
- Expected result: 4 files failed; 10 tests failed and 99 passed. Failures demonstrated the missing prompt module/provider method, active-route accessor and cached-reroute identity update, embedded reroute speech, per-command deadlines/next-expiry lookup, timer rescheduling, and location-unavailable line.
- `npx vitest run tests/speech.test.ts`
- Expected result: 2 tests failed and 23 passed, demonstrating concurrent generated synthesis and the missing pre-synthesis expiry check.
- Final adversarial RED: an unknown lifecycle kind reached the object prototype and attempted one non-text speech; the explicit lifecycle-enum guard now rejects it.

GREEN:

- Prescribed focused command: `npx vitest run tests/navigation-prompts.test.ts tests/nav-handler.test.ts tests/doubao-nav-speech.test.ts tests/speech.test.ts tests/device-actions.test.ts` — 5 files and 145 tests passed.
- Full suite: `npm test` — 94 files and 1,017 tests passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- `npm run test:fault-matrix` — 24/24 cases passed.
- Scoped Prettier check for all task source/test files and `git diff --check` — passed.
- `npm run check:protocol` — passed as the first stage of `npm run check`.

Commit:

- `feat(nav-relay): validate and synthesize RDK guidance prompts` (this task commit)

Concerns:

- Repository-wide `npm run check` stops at the already-ledgered untouched Prettier finding in `server/companion-store.ts`.
- Running the remaining gates independently shows the already-ledgered dead-code findings only: `server/companion-socket.contract.ts` and exported type `CompanionPeer`. The prior `NavPromptEvent` finding is now consumed by this task.
