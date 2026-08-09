# Task 6 fix round 1 report

Status: complete

Files:

- `server/navigation-prompts.ts`
- `server/speech.ts`
- `server/providers/doubao.ts`
- `server/providers/mock.ts`
- `server/session-controller.ts`
- `server/device-actions.ts`
- `tests/navigation-prompts.test.ts`
- `tests/doubao-nav-speech.test.ts`
- `tests/device-actions.test.ts`

RED:

- Prompt accounting: `npx vitest run tests/navigation-prompts.test.ts` — 3 new tests failed and 11 passed. The failures showed that a rate-rejected ID could not be retried at exactly 60 seconds, route changes did not reset accounting, and retained prompt IDs were not bounded. The same test file also covers invalid, stale, and duplicate events consuming no accepted budget or IDs.
- Speech ordering: `npx vitest run tests/doubao-nav-speech.test.ts -t "rechecks a newer ordinary reply|serializes multiple re-waiting prompts"` — 2 new tests failed and 11 were skipped. Both prompts began after the first generated utterance was released even though a newer ordinary reply was open; the second test also exercised multiple prompts and expiry at the re-wait start boundary.
- Terminal safety: `npx vitest run tests/doubao-nav-speech.test.ts -t "drops a prompt released|drops a fresh reroute completion"` — 2 new tests failed and 11 were skipped. A prompt synthesized after close, and a fresh reroute completion emitted two events after close.
- Device deadline: the boundary-focused `tests/device-actions.test.ts` run produced 4 new failures and 1 pass (85 skipped): exactly-at and just-after results were accepted, mixed 8-second/12-second deadlines reconciled incorrectly, and expired peek/attachment stayed authorized. The provider-level exactly-at-deadline test separately failed because it emitted no timeout transcript.

GREEN:

- Focused Task 6 suite: `npx vitest run tests/navigation-prompts.test.ts tests/nav-handler.test.ts tests/doubao-nav-speech.test.ts tests/speech.test.ts tests/device-actions.test.ts` — 5 files and 159 tests passed.
- Full suite: `npm test` — 94 files and 1,031 tests passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- `npm run check:protocol` — passed.
- `npm run test:fault-matrix` — 24/24 cases passed.
- Scoped Prettier check for all changed source/test files — passed.
- `git diff --check` — passed.

Commit:

- `fix(nav-relay): enforce prompt lifecycle boundaries` (this task commit)

Concerns:

- Repository-wide formatting and dead-code checks retain the already-ledgered unrelated findings in `server/companion-store.ts`, `server/companion-socket.contract.ts`, and exported type `CompanionPeer`; this fix did not modify those files.
- The interrupt path still has the prior review's end-to-end hardware caveat: tests prove Doubao truncation/control behavior, but do not prove audible RDK playback preemption for PCM already buffered on a physical device.
