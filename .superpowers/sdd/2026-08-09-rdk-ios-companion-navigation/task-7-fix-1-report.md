# Task 7 fix round 1

## RED

`npx vitest run tests/rdk-device-identity.test.ts` reproduced unsafe final
symlink, insecure final mode, and symlinked parent acceptance before the
protocol rewrite. The new spawned-process tests also exercise overlapping
initialization and SIGKILL before/after publish.

## GREEN

- Focused identity/relay tests: 3 files, 52 tests passed.
- `npm test`: 95 files, 1054 tests passed.
- `npm run build` and `npm run lint` passed.
- Scoped Prettier, ESLint, and `git diff --check` passed.

## Commit

`fix(rdk): recover device identity initialization safely`

## Concerns

- The RDK-specific TypeScript check retains only the ledgered
  `WritableStream.destroyed` errors in `rdk/agent/src/audio/reference.ts:48`
  and `:69`.
- `npm run check` still stops at the pre-existing formatting artifact in
  `server/companion-store.ts`; no unrelated formatting was changed.
