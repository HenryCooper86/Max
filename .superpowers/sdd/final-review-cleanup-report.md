# Final review cleanup report

Date: 2026-07-23

## Scope

Addressed the two remaining whole-branch review items only. No native, protocol,
or audio files changed.

## Changes

- Localized the safe operator-facing testing API error responses in `server/index.ts`.
  Technical tokens such as `gate`, `username`, `scope`, `testerKey`, and `sessionId`
  remain intact. Authoritative response data, including structured blocker values,
  was not translated.
- Added an integration assertion for the localized invalid `scope` response.
- Made `EvidenceWorkspace` clear evidence selection, pending/bound note state, and
  review draft state when the authenticated user ID or role changes. Ordinary
  navigation and filters are otherwise preserved.
- Added a reviewer-to-tester regression: it confirms that newly allowed evidence is
  auto-selected and the prior reviewer’s unsaved note/review drafts do not remain.

## TDD evidence

- The new reviewer-to-tester test initially failed because no active session was
  selected after the simulated scope change.
- The new integration assertion initially failed against the previous English
  `scope` error response.
- After the minimal fixes, focused tests passed: 2 files, 29 tests.

## Verification

```text
npm test -- tests/admin-evidence-workspace.test.tsx tests/server-integration.test.ts  pass (2 files, 29 tests)
npm run format:check                                                               pass
npm run lint                                                                       pass
npm run check:protocol                                                             pass
npm run check:dead-code                                                            pass
npm run test:fault-matrix                                                          pass (24 cases)
npm run build                                                                      pass
npm test                                                                           pass (37 files, 375 tests)
git diff --check                                                                   pass
```
