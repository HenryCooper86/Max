# Final aggregate cleanup report

**Base:** `ae8e5111dd7072f90508ba071c72d64093997fe4`

## RED evidence

- `npm run check` exited `1` only at Prettier, which reported `server/companion-store.ts`.
- `npm run check:dead-code` reported exactly two unused files
  (`server/companion-socket.contract.ts` and
  `tests/fixtures/rdk-device-identity-child.ts`), the unlisted `mkfifo` binary,
  and the unused exported `CompanionPeer` type.

## Minimal cleanup

- Applied Prettier mechanically to `server/companion-store.ts`.
- Declared the compile-time socket contract and the spawned identity helper as
  explicit Knip entrypoints.
- Declared the test's direct `mkfifo` invocation as an intentionally used
  binary without disabling any other Knip finding.
- Made `CompanionPeer` module-private; it remains the internal parameter type
  of the unchanged public `CompanionRegistry.attachCompanion` method.

No product code path, protocol shape, public runtime API, persistence behavior,
iOS behavior, Android behavior, or deployment behavior changed.

## Fresh GREEN evidence

- `npm run check`: PASS — generated protocol, Prettier, ESLint, Knip, 102
  Vitest files / 1,302 tests, 24/24 fault cases, TypeScript, and Vite build.
- `npx tsc -p rdk/agent/tsconfig.json`: PASS.
- Full MaxHelmet `iPhone 17` simulator suite: PASS — 397/397; Xcode emitted
  only the known post-success `simctl` diagnostics-collection warning.
- Android `testDebugUnitTest lintDebug assembleDebug`: PASS — 53 tasks using
  Android Studio's installed JBR; the native-access warning remains non-fatal.
  The first invocation without `JAVA_HOME` failed before Gradle because the
  shell had no discoverable Java runtime; the exact gate then passed with the
  installed JBR selected.
- `git diff --check`: PASS.

Scope inspection confirms the only repository changes are the Knip
declarations, the private type visibility, the mechanical formatting, and this
report.
