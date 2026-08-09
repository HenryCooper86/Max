# Task 7 — Durable RDK device identity

## RED

`npx vitest run tests/rdk-device-identity.test.ts tests/rdk-relay-client.test.ts`
failed before production work: the identity module was absent and
`buildSessionStart` omitted `deviceId`.

## GREEN

- `npx vitest run tests/rdk-device-identity.test.ts tests/rdk-relay-client.test.ts tests/rdk-relay.test.ts` — 46 passed.
- `npm test` — 95 files and 1048 tests passed.
- Scoped Prettier, ESLint, and `git diff --check` passed.
- `npm run build` and `npm run lint` passed.

## Commit

`feat(rdk): register a durable helmet identity`

## Concerns

- `npx tsc -p rdk/agent/tsconfig.json` still reports the ledgered baseline
  `WritableStream.destroyed` errors in `rdk/agent/src/audio/reference.ts:48`
  and `:69`; this task leaves Task 12's scope untouched.
- `npm run check` stops at the pre-existing formatting artifact
  `server/companion-store.ts`; no unrelated formatting was changed.
- Review added a per-file exclusive initializer lock plus file and directory
  `fsync` calls, so concurrent first starts and a power loss cannot silently
  publish a replacement identity.
