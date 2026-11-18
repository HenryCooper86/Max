# Contributing

Thank you for helping. This page covers setup, the checks your change must pass, and how we write commits.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, see
[SECURITY.md](SECURITY.md) and do not open a public issue.

## Set up

You need Node 22.13 or newer.

```bash
git clone <your fork>
cd <repository>
npm ci
cp .env.example .env
npm run dev
```

`npm run dev` starts the relay (`tsx watch server/index.ts`, port 8787) and the web app (Vite). With
`VOICE_PROVIDER=mock`, the default, nothing needs a key.

Other useful commands:

| Command              | What it does                                     |
| -------------------- | ------------------------------------------------ |
| `npm run dev:server` | Only the relay, restarting on change.            |
| `npm test`           | The unit and integration tests (`vitest run`).   |
| `npm run test:watch` | Tests in watch mode.                             |
| `npm run build`      | Type check, build the web app and build the SDK. |
| `npm run build:sdk`  | Only the browser SDK, into `dist/sdk/`.          |
| `npm run format`     | Format everything with Prettier.                 |

## Before you open a pull request

Run the same gate CI runs:

```bash
npm run check
```

It runs these steps in order and stops at the first failure:

| Step                | What it checks                                                          |
| ------------------- | ----------------------------------------------------------------------- |
| `check:protocol`    | The generated protocol files match `protocol/agent-events.schema.json`. |
| `format:check`      | Prettier formatting.                                                    |
| `lint`              | ESLint.                                                                 |
| `check:dead-code`   | `knip` finds unused files, exports and dependencies.                    |
| `check:rdk`         | Type check of the embedded board agent in `rdk/agent`.                  |
| `check:sdk`         | Type check of the browser SDK in `sdk/`.                                |
| `test`              | The vitest suite.                                                       |
| `test:fault-matrix` | A scripted set of failure scenarios for the relay.                      |
| `build`             | `tsc`, the web app build and the SDK build.                             |

Some jobs in CI need other toolchains (Python for `rdk/vision`, Android and iOS builds). You only need them if you change
those areas. `npm run test:rdk-vision` runs the Python tests.

## Tests

Tests live in `tests/`, one file per area, named `<area>.test.ts` (or `.test.tsx` for React). They use vitest. Shared
fixtures are in `tests/fixtures/`. Look at the tests for the code you change and follow their style:

- Relay logic is tested without a network: engines against a fake upstream socket (`tests/live-engines.test.ts`),
  tools through the broker (`tests/tools-broker.test.ts`).
- Add a test with every bug fix and every new behaviour. A test that fails before your change and passes after it is
  the best evidence.
- Do not call real model APIs from tests.

## Changing the protocol

The wire protocol is defined once, in `protocol/agent-events.schema.json`. The generated constants for TypeScript,
Kotlin and Swift come from it.

1. Edit `protocol/agent-events.schema.json`.
2. Update the types in `shared/agent.ts` and the validation in `parseClientEvent` (`server/session-controller.ts`).
3. Run `npm run generate:protocol`. It rewrites `shared/generated/agent-protocol.ts`,
   `android/.../GeneratedAgentProtocol.kt` and `ios/.../GeneratedAgentProtocol.swift`. Commit the results.
4. Update [docs/protocol.md](docs/protocol.md).
5. Keep changes backwards compatible: add optional fields, and make old clients and old relays keep working.

`npm run check:protocol` fails if step 3 was skipped.

## Adding things

**A voice backend.** Implement `VoiceEngine` (`server/providers/live/engine.ts`), register it in
`server/providers/catalog.ts` and `server/providers/factory.ts`, document its variables in `.env.example`, and add tests.
The steps are in [docs/backends.md](docs/backends.md#add-a-backend).

**A device preset.** Presets describe the device the assistant lives in (its wording, wake word, visualiser). Add one to
`server/device-presets.ts`, a mark at `brand/devices/<id>.svg` (and `src/assets/device-marks/<id>.svg`), and a test.
Look at the `app` preset, the general-purpose one, as the smallest example.

**A tool.** A tool is not part of the relay's code. Declare it in `assistant.config.json` (a webhook) or in a module named
by `toolsModule` (`defineTool`), as in [examples/web-embed](examples/web-embed/). Changes to how tools run belong in
`server/tools/`; see [docs/tools.md](docs/tools.md).

**An example.** Put it in `examples/<name>/` with a README that gives commands you have run, and add it to
[examples/README.md](examples/README.md).

## Commit messages

Write the subject line as an instruction in plain English, in the imperative, describing what the change does for
someone using the project. Do not use conventional-commit prefixes (`feat:`, `fix:`). Keep it short and without a trailing
full stop. Look at the history for the tone:

```text
Let a device declare what its audio hardware already does
Add a reference device client
Stop the speech detector taking steady noise for speech
Serve the owner's logo as the favicon
```

Add a body when the reason is not obvious. Do not add tool or AI attribution lines to commits or pull requests.

## Pull requests

- Keep each pull request to one idea. Small is easier to review.
- Describe what changed and why, and how you tested it. The template asks for this.
- Update the docs when behaviour changes.
- Make sure `npm run check` passes.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
