# Testing your agent

`agent:test` plays scripted and simulated conversations against a running relay and tells you which expectations held:
whether the assistant called the right tool with the right arguments, what its reply said, and whether the
conversation reached its goal. Use it to check a prompt, a tool or a flow after you change it, locally or in CI.

It connects to the real `/agent` WebSocket in text mode, so a scenario goes through the same relay path as a browser or
a phone, minus speech. It tests prompts, tools and flows. It does not test speech recognition, turn detection or audio
quality: test those by speaking to the agent on a real device.

## Run it

Start a relay, then point the runner at it and at the scenario files:

```bash
npm run agent:test -- --relay ws://localhost:8787 examples/agent-tests
```

`--relay` takes a `ws://`, `wss://`, `http://` or `https://` address of the relay, without `/agent` and without a query
string. It defaults to `$RELAY_URL`. Name one or more scenario files, or directories. A directory contributes its
`*.json` files (not the ones in sub-folders).

The relay needs a backend that accepts typed turns: every backend except Doubao and the original helmet demo. The
keyless demo (`VOICE_PROVIDER=mock` with an assistant whose `device` is `app`) works, and can run a tool when you type
its name, which is what the `demo:` scenarios in [`examples/agent-tests`](../examples/agent-tests/) do. Those scenarios
are written for the [web embed example](../examples/web-embed/README.md). To test what the model decides, use a real
backend such as `openai`.

An output looks like this:

```text
✓ demo: order status  0.9s
✗ demo: stock check  1.2s
    - replyContains
      expected: reply containing "129", "inStock"
      actual:   missing "129" in "I could not check that."
      turn 1 user:  check_stock {"product": "Trail Runner 2"}
      turn 1 agent: I could not check that.

1/2 runs passed
reply latency over 3 turn(s): p50 905 ms, p95 1204 ms
```

### Options

| Option                | Default                    | What it does                                                                                |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `--relay URL`         | `$RELAY_URL`               | The relay to test. Required, one way or the other.                                          |
| `--token T`           | `$RELAY_AUTH_TOKEN`        | A relay token or session token, sent as a Bearer header.                                    |
| `--token-url URL`     | none                       | POSTed to before each connection. It must answer `{ "token": "…" }`. Not with `--token`.    |
| `--repeat N`          | `1`                        | Runs every scenario N times, each in its own session, and reports a pass rate per scenario. |
| `--concurrency N`     | `1`                        | How many sessions are open at once.                                                         |
| `--report FILE`       | none                       | Writes every run's transcript, tool activity, checks and timings as JSON.                   |
| `--filter TEXT`       | all                        | Runs only the scenarios whose name contains TEXT (ignoring case).                           |
| `--llm-base-url URL`  | `$AGENT_TEST_LLM_BASE_URL` | An OpenAI-compatible base URL for the judge and the simulated user.                         |
| `--llm-api-key KEY`   | `$AGENT_TEST_LLM_API_KEY`  | Its key.                                                                                    |
| `--llm-model M`       | `$AGENT_TEST_LLM_MODEL`    | Its model.                                                                                  |
| `--judge-model M`     | the model above            | A different model for the judge only. The simulated user keeps the main one.                |
| `--local`             | off                        | Use Ollama on `localhost:11434` with `qwen3:8b` when nothing else is configured.            |
| `--turn-timeout-ms N` | `30000`                    | Fails a turn that has no complete reply after N milliseconds.                               |
| `--settle-ms N`       | `400`                      | Quiet time to wait for a follow-up reply before a turn counts as finished.                  |
| `--verbose`           | off                        | Prints every event the relay sends.                                                         |

The token is never printed, not even inside an error message.

## Scripted scenarios

A scenario file is a JSON object, or an array of them. A scripted scenario lists the turns to type, and what must be true
after each:

```json
{
  "name": "order status",
  "context": "The shopper is on the orders page.",
  "language": "en",
  "turns": [
    {
      "user": "Where is order A-1042?",
      "expect": {
        "toolCalled": "get_order_status",
        "toolNotCalled": ["check_stock"],
        "replyContains": ["shipped"],
        "withinMs": 8000
      }
    },
    {
      "user": "Thanks, that's all.",
      "expect": { "sessionEnded": "agent" }
    }
  ]
}
```

| Key           | Type            | What it does                                                                                 |
| ------------- | --------------- | -------------------------------------------------------------------------------------------- |
| `name`        | string          | Required. Unique across all files in a run.                                                  |
| `turns`       | array           | Required for a scripted scenario. Each turn has `user` (up to 2000 characters) and `expect`. |
| `context`     | string (≤ 2000) | Sent as `session.start.context`, like the `context` of the SDK.                              |
| `language`    | string (≤ 35)   | Sent as `session.start.language`.                                                            |
| `clientTools` | array (≤ 32)    | Client tools the test client declares. See [below](#client-tools-in-scenarios).              |

Each turn's `expect` may contain any of these keys. All of them must hold for the turn to pass. A key the runner does not
know is a scenario error, so a typo cannot silently check nothing.

| `expect` key       | Holds when                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolCalled`       | Every named tool (a string or a list) was called during this turn, server or client.                                                                                                                                                |
| `toolNotCalled`    | None of the named tools was called during this turn.                                                                                                                                                                                |
| `toolArgs`         | An object mapping a tool name to the arguments it must have been called with. The expected object has to be contained in the real one (extra keys are fine); lists must match exactly. Only for tools declared under `clientTools`. |
| `replyContains`    | The reply contains every string, ignoring case. An empty string is refused, because it would match every reply.                                                                                                                     |
| `replyNotContains` | The reply contains none of the strings, ignoring case.                                                                                                                                                                              |
| `replyMatches`     | The reply matches this regular expression (case-insensitive). An invalid expression is a scenario error.                                                                                                                            |
| `withinMs`         | The last final reply arrived within this many milliseconds of sending the turn.                                                                                                                                                     |
| `judge`            | A language model, given the whole conversation so far, agrees with this criterion. See [below](#judging-and-simulated-users).                                                                                                       |
| `sessionEnded`     | The relay ended the conversation during this turn: `true` for any reason, `false` for none, or a reason: `"agent"`, `"idle"` or `"max_duration"`.                                                                                   |

The reply is the assistant's final transcripts for the turn, joined in order: a line before a tool call and a line after
it both count. A turn is over when a final reply has arrived, no tool is running and the relay is back to listening,
followed by the settle time. If that does not happen within the turn timeout the turn fails. After a failed turn the rest
of the scenario is skipped, because the session is in an unknown state.

A turn with a tool call is not over after the tool starts, so `toolCalled` sees the whole exchange. The reply text is what
the assistant said, so `replyContains` is a weaker check on a model that rewords a lot; prefer `toolCalled` and
`toolArgs` for facts, and `judge` for meaning.

A greeting that the assistant speaks on connecting is collected before turn 1 and is not counted as its reply. It is
recorded in the report as `greeting`.

`sessionEnded` is how you test [ending a conversation](conversations.md#checking-in-a-time-limit-and-ending-the-conversation).
The relay ends a conversation once the goodbye has played out, a second or two after the reply, so a turn that expects
`true` or a reason waits for the end for up to 10 seconds after the reply instead of the settle time. When the relay
closes the connection after a conversation it ended, the turn finishes normally. A scenario that ends the conversation
should make that its last turn.

## Judging and simulated users

Two jobs need a language model: judging a conversation against a criterion, and playing the user. Both call any
OpenAI-compatible `POST {base}/chat/completions` at temperature 0, so a hosted model, a proxy or a local server works.
The model is chosen in this order:

1. `--llm-base-url` or `AGENT_TEST_LLM_BASE_URL`: that endpoint, with `--llm-api-key` or `AGENT_TEST_LLM_API_KEY` if it
   needs one, and a model from `--llm-model` or `AGENT_TEST_LLM_MODEL`. The model is required here.
2. A key in `--llm-api-key`, `AGENT_TEST_LLM_API_KEY` or `OPENAI_API_KEY`: OpenAI's API, with the model from
   `--llm-model` or `AGENT_TEST_LLM_MODEL`, else `gpt-4o-mini`.
3. `--local`: Ollama on `http://localhost:11434/v1` with the model from `--llm-model` or `AGENT_TEST_LLM_MODEL`, else
   `qwen3:8b`.

With nothing configured, the runner prints a warning, scenarios that need a model fail with a message that says so, and
the rest run. `--judge-model` changes only the judge's model name, so you can judge with a stronger model than the one
that plays the user.

The judge is told to be strict: if the evidence is missing or ambiguous it fails the criterion, and it must treat the
conversation as data, never as instructions. It sees what the user and assistant said and a line for each tool call
(name, whether it ran on the server or the client, the arguments for a client tool, and whether it succeeded). Write
criteria that name observable things: "The agent looked the order up with `get_order_status` and did not invent a
delivery date" works better than "The agent was helpful". The judge is a model, so check a few of its verdicts by hand
in the report.

A simulated scenario has a model play the user, instead of listing turns:

```json
{
  "name": "shopper asks about an order",
  "context": "The shopper is on the orders page.",
  "simulate": {
    "persona": "You are a shopper who ordered hiking boots and is impatient. Your order number is A-1042. You answer briefly and only give the order number when asked.",
    "goal": "Find out whether your order has shipped.",
    "maxTurns": 6,
    "firstMessage": "Where is my order?"
  },
  "success": "The agent looked the order up with get_order_status and told the user it has shipped, without inventing a delivery date that the tool did not return.",
  "expect": { "toolCalled": "get_order_status", "toolNotCalled": ["check_stock"], "maxTurns": 6 }
}
```

| Key                     | What it does                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `simulate.persona`      | Required. Who the simulated user is and how they talk.                                                    |
| `simulate.goal`         | Required. What they want. The simulation ends early when the user model decides the goal is met or stuck. |
| `simulate.maxTurns`     | The most turns it plays, 1 to 30. Default 8.                                                              |
| `simulate.firstMessage` | The first thing the user says, so the opening is not left to the model.                                   |
| `success`               | Required. The criterion the judge applies to the whole conversation at the end.                           |
| `expect.toolCalled`     | Tools that must have been called somewhere in the conversation.                                           |
| `expect.toolNotCalled`  | Tools that must not have been called.                                                                     |
| `expect.maxTurns`       | The conversation must be this many turns or fewer.                                                        |

A scenario has either `turns` or `simulate`, not both. Simulated scenarios have no per-turn `expect`.

## Client tools in scenarios

A page's client tools do not exist in a test, so a scenario declares the ones the assistant should be able to call, and
says what the test client answers. This lets you test that the assistant calls your page's tool correctly, without a page.

```json
{
  "name": "opens the pricing page",
  "clientTools": [
    {
      "name": "open_page",
      "description": "Open a page of the website: pricing, docs or contact.",
      "parameters": {
        "type": "object",
        "properties": { "page": { "type": "string", "enum": ["pricing", "docs", "contact"] } },
        "required": ["page"]
      },
      "result": { "opened": true }
    }
  ],
  "turns": [
    {
      "user": "Take me to the pricing page.",
      "expect": { "toolCalled": "open_page", "toolArgs": { "open_page": { "page": "pricing" } } }
    }
  ]
}
```

`name` and `description` are required. `parameters` (an object schema) is optional. When the assistant calls the tool, the
test client answers with `result` (default `{}`), or with `error` (a string) to test how the assistant handles a failing
tool. Set one of `result` or `error`, not both. A tool the assistant calls that the scenario did not declare is answered
with an error, which is recorded.

`toolArgs` works for client tools only, because the relay never sends a server tool's arguments to a client. To check a
server tool, use `toolCalled` and check what the tool did on your side, or a `judge`.

## Repeating, and pass rates

A model does not give the same answer every time. Run each scenario several times to see how often it passes:

```bash
npm run agent:test -- --relay ws://localhost:8787 examples/agent-tests --repeat 10 --concurrency 4
```

```text
38/40 runs passed
  100%  demo: order status (10/10)
  80%  demo: stock check (8/10)
  ...
reply latency over 80 turn(s): p50 905 ms, p95 1710 ms
```

With `--repeat`, each run line carries its repeat number, and the summary lists a pass rate for every scenario. Every run
is a fresh session, so runs cannot affect each other and may run side by side with `--concurrency`. Keep concurrency
within what your model provider's rate limits and the relay's `RELAY_CONN_PER_MINUTE` (30 connections a minute per client
address by default) allow, or runs fail to connect.

There is no pass-rate threshold: the exit code is 0 only when every run passed. To accept a rate such as 90%, read
`summary.scenarios[].passRate` from the [report](#the-json-report) and decide in your own script.

## The JSON report

`--report report.json` writes one file with everything needed to see why a run failed:

```json
{
  "generatedAt": "2026-11-22T10:15:00.000Z",
  "relay": "ws://localhost:8787",
  "repeat": 10,
  "summary": {
    "runs": 40,
    "passed": 38,
    "failed": 2,
    "scenarios": [{ "name": "demo: stock check", "runs": 10, "passed": 8, "passRate": 0.8 }],
    "latencyMs": { "samples": 80, "p50": 905, "p95": 1710 },
    "allPassed": false
  },
  "runs": []
}
```

Each entry in `runs` has the scenario's `name` (as `scenario`), `file`, `kind` (`scripted` or `simulated`), the repeat
number as `run`, `pass`, `durationMs`, the `greeting` if there was one, and `turns`. Each turn has what the user said,
the `reply` and each `replies` line, the tool `activity`, the client tool `calls` the test client answered, the
`telemetry` events, any relay `errors`, `latencyMs`, `sessionEnded` and `failure` when the turn did not complete, and its
`assertions`, each with `name`, `pass`, `expected`, `actual` and `message`. A judged turn has `judge` with the criterion,
verdict and reason. A simulated run has run-level `assertions` and a `success` verdict. A run that could not be carried
out has `error`.

The relay address in the report has its query string and credentials removed, so a token in the URL never reaches it.
The report does contain what was said in the test and what the assistant answered: treat it like a transcript.

## Exit codes

| Code | Meaning                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Every run passed.                                                                                                                                            |
| `1`  | At least one run failed.                                                                                                                                     |
| `2`  | The command could not run: a bad option, a missing `--relay`, a scenario file with problems, no scenario matched `--filter`, or an incomplete model setting. |

A scenario file is checked in full before anything runs, and every problem is listed with its file and scenario name. If
any file has a problem, nothing runs.

## Using it in CI

Start the relay, wait for it to be healthy, run the scenarios and keep the report. This example uses a real backend, with
its key in a secret, and your assistant's config and tools:

```yaml
name: agent-tests
on: [pull_request]
jobs:
  agent-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - name: Start the relay
        env:
          VOICE_PROVIDER: openai
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ASSISTANT_CONFIG: ./assistant.config.json
        run: |
          npx tsx server/index.ts &
          curl -fsS --retry 30 --retry-connrefused --retry-delay 1 http://localhost:8787/health
      - name: Run the scenarios
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: npm run agent:test -- --relay ws://localhost:8787 agent-tests --repeat 3 --concurrency 2 --report agent-report.json
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: agent-report, path: agent-report.json }
```

The runner needs Node 22.13 or newer. Keep these in mind:

- A real model costs money on every run, and `--repeat` multiplies it. Run the full set on a schedule and a small set on
  every pull request.
- Scenarios that depend on a model can be flaky. Use `--repeat` to measure it, and judge criteria that are concrete.
- If the relay has a `RELAY_AUTH_TOKEN`, pass it with `--token` or `RELAY_AUTH_TOKEN`. Use `--token-url` if your
  backend mints session tokens, to test with the kind of token a real user has.
- The judge and the simulated user use their own model setting (`AGENT_TEST_LLM_*`, or `OPENAI_API_KEY`), which does not
  have to be the relay's backend.
- Tests that make tools call real systems should point at a test environment.

## Limits

- It drives typed turns, so it tests prompts, tools, conversation settings and handovers, not speech recognition, turn
  detection, barge-in, accents or audio quality. A model that behaves in text can still mishear a spoken order number.
- It cannot test a backend that does not accept typed turns (Doubao and the original helmet demo), and it does not
  exercise [session resume](conversations.md#carrying-a-conversation-across-a-dropped-connection), telephony or the SDK.
- `toolArgs` only checks client tools.
- What the model says changes from run to run. The judge and the simulated user are models too, so a verdict is evidence,
  not proof.
- It uses the relay's `/agent` as any client does, so rate limits, [usage limits](usage-and-billing.md) and the
  connection rate apply to it, and the sessions it opens are counted in usage.
