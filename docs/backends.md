# Voice backends

A backend is the service that listens, thinks and speaks. The relay hides the differences: your client, your tools and
your assistant configuration stay the same whichever one you pick.

Choose the default with `VOICE_PROVIDER` in `.env`. The relay knows eight backends:

| `VOICE_PROVIDER` | Kind     | What it is                                                     | Key needed                             |
| ---------------- | -------- | -------------------------------------------------------------- | -------------------------------------- |
| `mock`           | demo     | Scripted conversation. Nothing leaves your machine.            | none                                   |
| `doubao`         | live     | ByteDance Doubao realtime dialogue. Strongest in Chinese.      | `DOUBAO_API_KEY`                       |
| `openai`         | live     | OpenAI Realtime, speech to speech.                             | `OPENAI_API_KEY`                       |
| `grok`           | live     | xAI Grok Voice, over an OpenAI-compatible realtime protocol.   | `XAI_API_KEY`                          |
| `gemini`         | live     | Google Gemini Live.                                            | `GEMINI_API_KEY`                       |
| `pipeline`       | pipeline | Speech-to-text, then any chat model, then text-to-speech.      | `PIPELINE_API_KEY` or `OPENAI_API_KEY` |
| `local`          | pipeline | The same pipeline on open-weight models you run yourself.      | none (`LOCAL_VOICE=on`)                |
| `local-realtime` | live     | A self-hosted server that speaks the OpenAI Realtime protocol. | `LOCAL_REALTIME_URL`                   |

Friendly aliases also work: `demo`, `xai`, `chatgpt`, `google`, `whisper`, `cascade`, `ollama`, `offline`. An unknown
value falls back to `mock`, and the relay says so at startup.

"Live" backends move audio over one realtime socket and answer as soon as the user stops speaking. "Pipeline" backends
chain three steps, so the relay transcribes the whole sentence before the model starts. Live backends usually reply
sooner. Pipeline backends let you mix vendors and run each step on your own hardware.

## Capabilities

The `capabilities` object in `session.started` tells the client what the backend can do.

| Backend                                                           | Tools | Typed input (`text.input`) | Synthesized audio | Notes                                                                            |
| ----------------------------------------------------------------- | ----- | -------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `mock` (app assistant)                                            | yes   | yes                        | no                | Speech is left to the client (`useBrowserSpeech`). Type a tool's name to run it. |
| `mock` (helmet default)                                           | no    | no (see below)             | no                | The scripted riding demo.                                                        |
| `doubao`                                                          | no    | no                         | yes               | No function calling and no typed turns.                                          |
| `openai`, `grok`, `gemini`, `pipeline`, `local`, `local-realtime` | yes   | yes                        | yes               |                                                                                  |

The "app assistant" row applies when the assistant's device is `app` (a general software assistant, see
`assistant.config.json`). Without an assistant config the relay is the original "Max" helmet assistant and uses the
helmet demo.

The helmet demo is a scripted ride: it takes no typed turns or tools and reports `textInput: false` and
`tools: false`. Use the app preset for anything that is not the helmet.

## Backend reference

### mock

No account, no key, no cost. Use it to build and test your integration.

- With an `app` assistant it is the app demo: it detects speech, shows the status changes, answers typed messages and
  really runs your tools. Type `get_order_status {"orderId":"A-1042"}` (a tool name, optionally followed by JSON
  arguments) and it calls the tool the way a live model would. It cannot recognise speech, and says so.
- Replies are text with `useBrowserSpeech: true`, so the browser speaks them.

### doubao

```dotenv
VOICE_PROVIDER=doubao
DOUBAO_API_KEY=...
DOUBAO_RESOURCE_ID=volc.speech.dialog
DOUBAO_AGENT_WS_URL=wss://openspeech.bytedance.com/api/v3/realtime/dialogue
```

| Setting                                                | Default                          | Purpose                                                       |
| ------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------- |
| `DOUBAO_API_KEY`                                       | none                             | Speech console API key. The usual way to authenticate.        |
| `DOUBAO_APP_ID`, `DOUBAO_APP_KEY`, `DOUBAO_ACCESS_KEY` | none                             | Legacy credentials, used only when `DOUBAO_API_KEY` is empty. |
| `DOUBAO_VOICE`                                         | `zh_female_vv_jupiter_bigtts`    | Female voice.                                                 |
| `DOUBAO_VOICE_MALE`                                    | `zh_male_yunzhou_jupiter_bigtts` | Male voice.                                                   |
| `DOUBAO_REALTIME_MODEL`                                | `1.2.1.1`                        | Model version.                                                |
| `DOUBAO_VAD_END_MS`                                    | `900`                            | Silence that ends a turn.                                     |

Doubao has more tuning variables (speech rate, loudness, timeouts). They are listed in `.env.example`. Doubao cannot
call tools and does not accept typed input.

### openai

```dotenv
VOICE_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

| Setting                   | Default                            |
| ------------------------- | ---------------------------------- |
| `OPENAI_REALTIME_MODEL`   | `gpt-realtime`                     |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe`           |
| `OPENAI_VOICE`            | `marin` (female)                   |
| `OPENAI_VOICE_MALE`       | `cedar`                            |
| `OPENAI_TURN_DETECTION`   | `server_vad`                       |
| `OPENAI_REALTIME_URL`     | `wss://api.openai.com/v1/realtime` |

### grok

```dotenv
VOICE_PROVIDER=grok
XAI_API_KEY=...
```

| Setting            | Default                      |
| ------------------ | ---------------------------- |
| `XAI_VOICE_MODEL`  | `grok-voice-latest`          |
| `XAI_VOICE`        | `eve` (female)               |
| `XAI_VOICE_MALE`   | `rex`                        |
| `XAI_REALTIME_URL` | `wss://api.x.ai/v1/realtime` |

`GROK_API_KEY` is accepted in place of `XAI_API_KEY`.

### gemini

```dotenv
VOICE_PROVIDER=gemini
GEMINI_API_KEY=...
```

| Setting             | Default           |
| ------------------- | ----------------- |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` |
| `GEMINI_VOICE`      | `Aoede` (female)  |
| `GEMINI_VOICE_MALE` | `Puck`            |

`GOOGLE_API_KEY` is accepted in place of `GEMINI_API_KEY`.

### pipeline

Three steps, each an OpenAI-compatible HTTP endpoint. They may be different vendors.

```dotenv
VOICE_PROVIDER=pipeline
OPENAI_API_KEY=sk-...
```

| Step           | Variables                                                             | Default           |
| -------------- | --------------------------------------------------------------------- | ----------------- |
| Speech-to-text | `PIPELINE_STT_BASE_URL`, `PIPELINE_STT_API_KEY`, `PIPELINE_STT_MODEL` | `whisper-1`       |
| Chat model     | `PIPELINE_LLM_BASE_URL`, `PIPELINE_LLM_API_KEY`, `PIPELINE_LLM_MODEL` | `gpt-4o-mini`     |
| Text-to-speech | `PIPELINE_TTS_BASE_URL`, `PIPELINE_TTS_API_KEY`, `PIPELINE_TTS_MODEL` | `gpt-4o-mini-tts` |
| Voices         | `PIPELINE_TTS_VOICE`, `PIPELINE_TTS_VOICE_MALE`                       | `nova`, `onyx`    |

`PIPELINE_API_KEY` and `PIPELINE_BASE_URL` apply to every step unless a step overrides them. With neither set, the relay
uses `OPENAI_API_KEY` and `https://api.openai.com/v1`. The text-to-speech step must return raw PCM16
(`response_format=pcm`); set `PIPELINE_TTS_SAMPLE_RATE` if it is not 24000.

A key is not required for endpoints on `localhost`, `127.0.0.1` or a `.local` name.

The chat step runs tool calls in up to four rounds per turn. A typed message replaces the transcribed turn.

### local

The pipeline on open-weight models you host: Whisper-class speech-to-text, an Ollama chat model and Kokoro speech.
Nothing leaves your network. Setup, default servers and a ready-made compose file are in
[local-models.md](local-models.md).

```dotenv
VOICE_PROVIDER=local
LOCAL_VOICE=on
```

| Step           | Variables                                 | Default                                                    |
| -------------- | ----------------------------------------- | ---------------------------------------------------------- |
| Speech-to-text | `LOCAL_STT_BASE_URL`, `LOCAL_STT_MODEL`   | `http://localhost:8000/v1`, `Systran/faster-whisper-small` |
| Chat model     | `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`   | `http://localhost:11434/v1`, `qwen2.5:7b`                  |
| Text-to-speech | `LOCAL_TTS_BASE_URL`, `LOCAL_TTS_MODEL`   | `http://localhost:8880/v1`, `kokoro`                       |
| Voices         | `LOCAL_TTS_VOICE`, `LOCAL_TTS_VOICE_MALE` | `af_heart`, `am_michael`                                   |

Tool calling needs a chat model that supports it. Small local models are less reliable at choosing tools and filling
arguments than hosted ones.

### local-realtime

A self-hosted server that implements the OpenAI Realtime WebSocket protocol.

```dotenv
VOICE_PROVIDER=local-realtime
LOCAL_REALTIME_URL=ws://localhost:8000/v1/realtime
LOCAL_REALTIME_MODEL=qwen2.5:7b
```

Optional: `LOCAL_REALTIME_TRANSCRIBE_MODEL` (default `Systran/faster-whisper-small`), `LOCAL_REALTIME_VOICE` (`af_heart`),
`LOCAL_REALTIME_VOICE_MALE` (`am_michael`), `LOCAL_REALTIME_API_KEY`.

## Trade-offs

Numbers depend on your region, network and models, so measure with your own audio. Qualitatively:

- Live speech-to-speech backends (`openai`, `grok`, `gemini`, `doubao`, `local-realtime`) answer fastest and handle
  interruptions most naturally.
- `pipeline` and `local` add the time to transcribe a whole sentence, then to start the model, then to start speech.
  The relay speaks the reply sentence by sentence while the model is still writing, which hides much of the wait.
- `pipeline` is the most flexible: pick the cheapest or best model for each step, or mix vendors.
- `local` and `local-realtime` cost nothing per minute and keep audio on your hardware, in return for hardware, setup
  and a smaller choice of voices and languages.
- `mock` is instant and free, and is not an assistant.

## Switching per session

By default a client may pick a backend for its own session, with `voiceProvider` in `session.start`. The relay honours
the request only when switching is allowed and it holds that backend's credentials. Otherwise the session uses
`VOICE_PROVIDER`. A client can never make the relay try a backend that its owner did not set up.

`GET /health` lists the backends and whether each is configured:

```bash
curl -s http://localhost:8787/health | python3 -c "import json,sys; v=json.load(sys.stdin)['voice']; print(v['active'], v['switching']); [print(p['id'], p['configured']) for p in v['providers']]"
```

To pin every session to `VOICE_PROVIDER`, set `VOICE_PROVIDER_SWITCHING=off`. Do this when you do not want a client to
choose a more expensive backend than the one you picked.

## Add a backend

A live backend is a `VoiceEngine`: a thin adapter that moves audio and text between the relay and one upstream
service. Everything else a user experiences (the persona, the wake word, tools, memory, the transcript events, barge-in
bookkeeping) lives once in `server/providers/live/session.ts` and is shared.

1. **Write the engine.** Create `server/providers/live/<name>.ts` that exports a function returning a `VoiceEngine`
   (see `server/providers/live/engine.ts`, which documents each member):

   ```ts
   export type VoiceEngine = {
     readonly responseMode: "auto" | "manual-capable" | "manual-only";
     connect(config: EngineConfig, events: EngineEvents): Promise<void>;
     sendAudio(pcm: Buffer): void; // 16 kHz mono PCM16 from the user
     respond(): void; // answer the latest turn (no-op if the upstream answers by itself)
     cancel(): void; // stop the reply in progress
     say?(text: string): void;
     updateInstructions?(instructions: string): void;
     addContext?(text: string): void;
     sendToolResult?(callId: string, output: string): void; // the result of a tool call
     sendText?(text: string): void; // a typed turn
     close(): void;
   };
   ```

   - `connect` receives `EngineConfig` (`instructions`, `voiceGender`, `languages`, `keyterms`, `tools`) and
     `EngineEvents`, the callbacks you call as things happen: `onSpeechStarted`, `onRiderTranscript`,
     `onResponseStarted`, `onAgentText`, `onAgentAudio` (24 kHz mono PCM16), `onResponseDone`, `onError`, `onClosed`.
   - For tools, offer `config.tools` to the model, call `events.onToolCall({ callId, name, arguments })` when the model
     uses one, and implement `sendToolResult(callId, output)` to hand the result back and let the model continue. The
     relay runs the tool (relay-side or on the client) and always calls you back, even on failure or timeout.
   - Implement `sendText` if the upstream can take a typed turn.
   - Use the helpers in `engine.ts`: `resamplePcm16`, `wavFromPcm16`, `pcm16Rms`, `env`, and the constants
     `CLIENT_INPUT_RATE` (16000) and `CLIENT_OUTPUT_RATE` (24000).
   - `connect` should reject with a message fit for the person setting the kit up, such as "set MYVENDOR_API_KEY".

2. **Register it in the catalog.** In `server/providers/catalog.ts`, add the id to `VoiceProviderId` and an entry to
   `VOICE_PROVIDERS` with a label, a `kind`, a one-line description, its `capabilities` (`LIVE_CAPABILITIES` unless the
   upstream lacks tools or typed input), a `configured()` check and a `requires` hint. Add aliases if useful.

3. **Create it in the factory.** In `server/providers/factory.ts`, add a `case` to `createVoiceProvider` that wraps your
   engine with `createLiveProvider(client, liveBackend(id, (engineLog) => createMyEngine(engineLog)), log, telemetry)`.

4. **Document the variables.** Add them to `.env.example` (commented) and to the table above.

5. **Test it.** Look at `tests/live-engines.test.ts` and `tests/live-engines-tools.test.ts` for how engines are tested
   against a fake upstream socket, then run `npm run check`.
