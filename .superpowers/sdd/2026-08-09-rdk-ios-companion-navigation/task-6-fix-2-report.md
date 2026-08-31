# Task 6 fix round 2 report

Status: complete

Files:

- `server/navigation-prompts.ts`
- `tests/navigation-prompts.test.ts`

RED:

- Replaced the incorrect combined route-reset expectation and added the required route-change accounting cases before editing production code.
- `npx vitest run tests/navigation-prompts.test.ts` against `a7e65b7` — 2 tests failed and 14 passed. With `maxPerMinute: 1`, a distinct prompt on route 2 spoke immediately after route 1 had consumed the session budget; the exact-60-second retry case failed at the same premature acceptance assertion. The same-ID/new-route case passed with remaining capacity, preserving route-scoped dedupe behavior.

GREEN:

- Navigation prompt unit suite: `npx vitest run tests/navigation-prompts.test.ts` — 16/16 tests passed.
- Focused Task 6 suite: `npx vitest run tests/navigation-prompts.test.ts tests/nav-handler.test.ts tests/doubao-nav-speech.test.ts tests/speech.test.ts tests/device-actions.test.ts` — 5 files and 161 tests passed.
- Full suite: `npm test` — 94 files and 1,033 tests passed.
- `npm run build` — passed.
- `npm run lint` — passed.
- `npm run check:protocol` — passed.
- `npm run test:fault-matrix` — 24/24 cases passed.
- Scoped Prettier check for the changed source/test files and `git diff --check` — passed.

Commit:

- `fix(nav-relay): keep prompt rate limits session scoped` (this task commit)

Concerns:

- Repository-wide formatting and dead-code checks retain the already-ledgered unrelated findings in `server/companion-store.ts`, `server/companion-socket.contract.ts`, and exported type `CompanionPeer`; this fix does not modify those files.
- Physical-device audible preemption and cancellation of synthesis already in progress at close remain outside this narrowly scoped accounting fix.
