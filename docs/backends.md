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
| `max-speech`     | pipeline | Max Speech listens and speaks; any local chat model answers.   | `MAX_SPEECH_URL` or `MAX_SPEECH=on`    |

Friendly aliases also work: `demo`, `xai`, `chatgpt`, `google`, `whisper`, `cascade`, `ollama`, `offline`. An unknown
value falls back to `mock`, and the relay says so at startup.

"Live" backends move audio over one realtime socket and answer as soon as the user stops speaking. "Pipeline" backends
chain three steps, so the relay transcribes the whole sentence before the model starts. Live backends usually reply
sooner. Pipeline backends let you mix vendors and run each step on your own hardware.

## Capabilities

The `capabilities` object in `session.started` tells the client what the backend can do.

| Backend                           | Tools | Typed input (`text.input`) | Pictures (`image.input`)        | Synthesized audio | Notes                                                                            |
| --------------------------------- | ----- | -------------------------- | ------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `mock` (app assistant)            | yes   | yes                        | no                              | no                | Speech is left to the client (`useBrowserSpeech`). Type a tool's name to run it. |
| `mock` (helmet default)           | no    | no (see below)             | no                              | no                | The scripted riding demo.                                                        |
| `doubao`                          | no    | no                         | no                              | yes               | No function calling and no typed turns.                                          |
| `openai`                          | yes   | yes                        | yes (see [Pictures](#pictures)) | yes               |                                                                                  |
| `gemini`                          | yes   | yes                        | yes                             | yes               |                                                                                  |
| `pipeline`, `local`, `max-speech` | yes   | yes                        | only when you turn it on        | yes               | Needs a chat model that can see pictures.                                        |
| `grok`, `local-realtime`          | yes   | yes                        | no                              | yes               |                                                                                  |

The "app assistant" row applies when the assistant's device is `app` (a general software assistant, see
`assistant.config.json`). Without an assistant config the relay is the original "Max" helmet assistant and uses the
helmet demo.

The helmet demo is a scripted ride: it takes no typed turns or tools and reports `textInput: false` and
`tools: false`. Use the app preset for anything that is not the helmet.

## Pictures

A user can show the assistant a picture during a conversation (`image.input`, see the [protocol](protocol.md#imageinput)
and the web SDK's `sendImage`). The conversation's own model sees it; this is separate from the helmet's camera, which
goes to a vision service. `session.started.capabilities.imageInput` says whether it will work. It is true only where the
picture reaches a model that can see it:

| Backend                                    | `imageInput`                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai`                                   | True unless `OPENAI_REALTIME_MODEL` contains "preview". OpenAI documents image input for `gpt-realtime` and `gpt-realtime-2`, and not for the preview models. |
| `gemini`                                   | True. Sent as a video frame, which Gemini Live takes at most once a second.                                                                                   |
| `pipeline`                                 | True when `PIPELINE_LLM_IMAGES=on`.                                                                                                                           |
| `local`                                    | True when `LOCAL_LLM_IMAGES=on`.                                                                                                                              |
| `max-speech`                               | True when `LOCAL_LLM_IMAGES=on`: its chat model is the one `local` uses (`LOCAL_LLM_*`).                                                                      |
| `grok`, `local-realtime`, `doubao`, `mock` | False. The relay sends no pictures to them.                                                                                                                   |

The chat-model backends talk to an OpenAI-compatible chat endpoint, and the relay cannot tell whether the model behind
it can see pictures, so you say so with the setting above. Leave it off for a text-only model. If you turn it on for a
model that cannot see, its server refuses the request that carries the picture (Ollama answers HTTP 400 for
`qwen3:8b`); the relay reports that error, drops the pictures from the conversation so the next turns work, and the
user can go on.

How these backends handle pictures: a picture sent with words is a user message with the text and the picture. A
picture sent without words waits and goes with the user's next turn. Only the two most recent pictures are sent again
with each request; older ones become the text "[a picture the user showed earlier]".

Pictures go to the model's vendor (or to your own model server) and the relay does not write picture bytes to conversation records, logs, traces, resume state or memory. The OpenAI and Gemini
paths were built to the vendors' documentation and have not been run against their servers. The `local` backend was run
against Ollama with `gemma3:4b`.

### Live video

A user can also show the assistant their camera or their screen while they talk (`video.frame`, see the
[protocol](protocol.md#videoframe-and-videostop); `startVideo` in the [web SDK](../sdk/README.md#live-video), buttons
in the widget). It works wherever pictures do, with the same settings: `session.started.capabilities.videoInput` is
true exactly where `imageInput` is. The client sends about a frame a second, and the relay keeps the newest only.

| Backend                           | What the model sees                                                                                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini`                          | Every frame as it arrives, at most one a second: Gemini Live takes video itself.                                                                                                                                        |
| `openai`                          | The newest frame, put into the conversation when the user begins to speak or sends a typed turn. The conversation keeps the last two frames; older ones are taken out, because each is paid for again with every reply. |
| `pipeline`, `local`, `max-speech` | The newest frame, attached to the user's turn when it is answered. Like pictures, only the two most recent are sent again with later requests.                                                                          |

So this is a model that looks when it is spoken to, a frame a turn (Gemini: a frame a second), not one that watches a
film: it does not see motion between two frames, and it does not speak up about what it sees unless the user says
something. Frames are not kept or recorded by the relay. The `local` backend was run with live video against Ollama
with `gemma3:4b`, from a script and from the widget in Chrome with a camera; the OpenAI and Gemini paths were built to
the vendors' documentation and have not been run against their servers.

## The relay's own turn detector

OpenAI Realtime, Gemini Live and Grok each decide by themselves when the user has finished speaking, mostly from how
long the silence is. A silence is a poor judge: someone reading out a phone number, or looking for a word, pauses in
the middle and is answered too soon. With `TURN_DETECTOR=max-speech` the relay decides instead, with the voice
detector and the learned turn detector (Smart Turn) of a [Max Speech](speech-server-deployment.md) server you run. It
judges from the sound of the last words whether the speaker is done or only pausing.

```dotenv
TURN_DETECTOR=max-speech
# The Max Speech server. MAX_SPEECH_URL is used when this is not set, and http://localhost:8790 when neither is.
TURN_DETECTOR_URL=http://localhost:8790
```

| Setting                   | Default              | What it does                                                                                                                         |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `TURN_DETECTOR`           | `off`                | `max-speech`: the relay takes the turns on `openai`, `gemini` and `grok`. `off`: each backend's own detection.                       |
| `TURN_DETECTOR_URL`       | `MAX_SPEECH_URL`     | The Max Speech server to use for it.                                                                                                 |
| `TURN_DETECTOR_API_KEY`   | `MAX_SPEECH_API_KEY` | Its key, when it has one. `MAX_SPEECH_API_KEY` is used only when `TURN_DETECTOR_URL` is not set: that key goes to that server alone. |
| `TURN_DETECTOR_EAGERNESS` | `normal`             | `low`, `normal` or `high`. A pause ends the turn whatever the detector thinks after 2, 1.5 or 0.8 seconds of silence.                |

How it works: the microphone audio goes to Max Speech as well. When it hears speech begin, the relay opens the turn on
the backend and sends the audio from 600 ms before that moment on; when it judges the turn over, the relay closes it
and the backend answers. Between turns the backend is sent no audio at all. The backend's own detection is switched
off for the connection (`audio.input.turn_detection: null` on OpenAI, `turn_detection.type: null` on Grok,
`automaticActivityDetection.disabled` on Gemini), so the settings for it in the sections below do not apply. Speech
that begins while the assistant talks interrupts it, as before, and so does speech that begins in the moment after a
reply was asked for and before it began. A sound too short to be speech (under 200 ms), with no speech right after
it, is not answered. Speech that Max Speech's own transcriber made nothing of (a short "yes", a language it does not
know) is still a turn: the backend hears it and answers. Something typed, and a line the relay has the assistant
say, is sent to Gemini as a turn of its own, since Gemini with its detection off answers nothing else.

What to know before turning it on:

- It needs a Max Speech server: an Apple silicon Mac or a machine with a GPU. Each conversation takes one of its live
  sessions (4 at a time on a Mac and 8 with a GPU by default, `SPEECH_MAX_SESSIONS`). The user's audio goes to that
  server as well as to the backend; nothing is stored there.
- The detector is a helper, not a requirement. When it cannot be reached as a conversation starts (not running, full,
  still loading), that conversation uses the backend's own detection, and the log says so. When it goes away in the
  middle of a conversation, the relay connects to the backend again and carries on with the backend's own; what the
  user was saying at that moment is lost. A detector that stops answering without closing (the machine went to
  sleep) is found out by a ping every 5 seconds and given up after 15 seconds of silence, which is how long the
  assistant can be deaf. A turn the detector never ends is ended by the relay after 36 seconds.
- A conversation holds its place on the Max Speech server only while its connection to the backend is up: when the
  backend drops it (Gemini ends a session every ten minutes or so) the place is given back at once and taken again
  by the connection that follows.
- On [Max Cloud](cloud.md) the detector is the operator's: every project's conversations use it, their audio goes to
  that Max Speech server, and they share its live sessions.
- An older Max Speech server does not say why a turn ended. With one, a turn in which it made out no words is taken
  for a noise and not answered, so update it with the relay.
- It applies to `openai`, `gemini` and `grok`. `max-speech` already works this way; `pipeline` and `local` take turns
  by silence, `doubao` and `local-realtime` by their own detection.

Run on a Mac with Max Speech and the real detector, with stand-ins for the three vendors: a phone number spoken with
a one-second pause in the middle was one turn, the end of a turn was reported about 0.4 seconds after the last word, and both fallbacks above happened as described. What is sent to OpenAI, Google and xAI follows their
documentation for manual turns and was not run against their servers.

## Backend reference

### mock

No account, no key, no cost. Use it to build and test your integration.

- With an `app` assistant it is the app demo: it detects speech, shows the status changes, answers typed messages and
  really runs your tools. Type `get_order_status {"orderId":"A-1042"}` (a tool name, optionally followed by JSON
  arguments) and it calls the tool the way a live model would. It cannot recognise speech, and says so.
- Replies are text with `useBrowserSpeech: true`, so the browser speaks them.
- A client that reconnects with `session.start.resume` carries the conversation on: the demo does not greet again,
  and keeps what is said for the next reconnect. See
  [Resuming](conversations.md#carrying-a-conversation-across-a-dropped-connection).

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

A conversation that is [resumed](conversations.md#carrying-a-conversation-across-a-dropped-connection) gives Doubao
the turns so far as its dialog context, as complete question-and-answer pairs, and a note in its system role to carry
on without greeting again. This is for a software assistant (`device: app`): a wearable has its own session memory.

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
| `OPENAI_REALTIME_URL`     | `wss://api.openai.com/v1/realtime` |

How the model decides that the user has finished speaking, and what it does about background noise:

| Setting                  | Default      | What it does                                                                                                                        |
| ------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_TURN_DETECTION`  | `server_vad` | `server_vad` ends a turn after a silence. `semantic_vad` also listens to the words, and waits when the user is plainly mid-thought. |
| `OPENAI_TURN_EAGERNESS`  | OpenAI's     | With `semantic_vad`: `low` gives the user time, `high` answers as soon as it can, `medium`, `auto`.                                 |
| `OPENAI_VAD_THRESHOLD`   | OpenAI's     | With `server_vad`: 0 to 1. Higher needs louder speech, which helps in a noisy room.                                                 |
| `OPENAI_VAD_SILENCE_MS`  | OpenAI's     | With `server_vad`: the silence that ends a turn, 100 to 5000 ms. Shorter answers sooner and interrupts more.                        |
| `OPENAI_VAD_PREFIX_MS`   | OpenAI's     | With `server_vad`: audio kept from before speech was detected, 0 to 2000 ms.                                                        |
| `OPENAI_NOISE_REDUCTION` | OpenAI's     | `near_field` for a headset or a phone at the ear, `far_field` for a laptop or a room, `off` for none.                               |

A value the relay cannot use is reported in the log at startup and left out. These settings were checked against
OpenAI's documentation and the relay's tests cover what is sent; they were not run against OpenAI's servers.

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

Gemini detects the user's speech itself. To tune it:

| Setting                    | Default  | What it does                                                                            |
| -------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `GEMINI_START_SENSITIVITY` | Gemini's | `high` or `low`: how readily a sound counts as the start of speech.                     |
| `GEMINI_END_SENSITIVITY`   | Gemini's | `high` or `low`: how readily a pause ends the turn. `low` suits slow, careful speakers. |
| `GEMINI_VAD_SILENCE_MS`    | Gemini's | The silence that ends a turn, 50 to 5000 ms.                                            |
| `GEMINI_VAD_PREFIX_MS`     | Gemini's | The speech needed before a turn starts, 0 to 2000 ms.                                   |

As with OpenAI, these were checked against Google's documentation and the relay's tests, not against Google's servers.

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

`PIPELINE_LLM_IMAGES=on` lets users show the assistant pictures; set it only when the chat model can see them. Off by
default. See [Pictures](#pictures).

`PIPELINE_API_KEY` and `PIPELINE_BASE_URL` apply to every step unless a step overrides them. With neither set, the relay
uses `OPENAI_API_KEY` and `https://api.openai.com/v1`. The text-to-speech step must return raw PCM16
(`response_format=pcm`); set `PIPELINE_TTS_SAMPLE_RATE` if it is not 24000.

A key is not required for endpoints on `localhost`, `127.0.0.1` or a `.local` name.

The chat step runs tool calls in up to four rounds per turn. A typed message replaces the transcribed turn.

Every request to the chat model and to the text-to-speech server has two deadlines. A reply is ended with an error,
not left open for ever, when the first byte of an answer does not arrive in time or when the bytes stop coming. The
wearer sees a `status` event with state `degraded` that says which it was.

| Setting                                                  | Default | What it does                                                             |
| -------------------------------------------------------- | ------- | ------------------------------------------------------------------------ |
| `PIPELINE_FIRST_BYTE_MS`                                 | `30000` | Time from a request to the first byte of its answer.                     |
| `PIPELINE_STALL_MS`                                      | `15000` | Longest silence between two bytes of an answer.                          |
| `PIPELINE_LLM_FIRST_BYTE_MS`, `PIPELINE_TTS_STALL_MS`, … |         | The same for one step: `LLM` is the chat model, `TTS` the speech server. |

`0` turns a deadline off. A model that thinks before it writes needs a longer time to first byte.

### local

The pipeline on open-weight models you host: Whisper-class speech-to-text, an Ollama chat model and Kokoro speech.
Nothing leaves your network. Setup, default servers and a ready-made compose file (Max Speech and Ollama) are in
[local-models.md](local-models.md).

```dotenv
VOICE_PROVIDER=local
LOCAL_VOICE=on
```

| Step           | Variables                                 | Default                                                    |
| -------------- | ----------------------------------------- | ---------------------------------------------------------- |
| Speech-to-text | `LOCAL_STT_BASE_URL`, `LOCAL_STT_MODEL`   | `http://localhost:8000/v1`, `Systran/faster-whisper-small` |
| Chat model     | `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`   | `http://localhost:11434/v1`, `qwen3:8b`                    |
| Text-to-speech | `LOCAL_TTS_BASE_URL`, `LOCAL_TTS_MODEL`   | `http://localhost:8880/v1`, `kokoro`                       |
| Voices         | `LOCAL_TTS_VOICE`, `LOCAL_TTS_VOICE_MALE` | `af_heart`, `am_michael`                                   |

Tool calling needs a chat model that supports it. Small local models are less reliable at choosing tools and filling
arguments than hosted ones.

The chat model and the speech server have the [same deadlines](#pipeline) as `pipeline`'s, read from `LOCAL_*`:
`LOCAL_FIRST_BYTE_MS` defaults to `60000`, because a local model may first have to be loaded into memory, and
`LOCAL_STALL_MS` to `15000`. The `max-speech` backend uses the chat model's.

To let users show the assistant pictures, set `LOCAL_LLM_IMAGES=on` and use a multimodal chat model such as
`gemma3:4b`. See [Pictures](#pictures).

### local-realtime

A self-hosted server that implements the OpenAI Realtime WebSocket protocol.

```dotenv
VOICE_PROVIDER=local-realtime
LOCAL_REALTIME_URL=ws://localhost:8000/v1/realtime
LOCAL_REALTIME_MODEL=qwen3:8b
```

Optional: `LOCAL_REALTIME_TRANSCRIBE_MODEL` (default `Systran/faster-whisper-small`), `LOCAL_REALTIME_VOICE` (`af_heart`),
`LOCAL_REALTIME_VOICE_MALE` (`am_michael`), `LOCAL_REALTIME_API_KEY`.

### max-speech

[Max Speech](../speech-server/README.md), our own speech server, listens and speaks over one WebSocket; the relay
runs the chat model and tools exactly as for `local`.

```dotenv
VOICE_PROVIDER=max-speech
MAX_SPEECH_URL=ws://localhost:8790/v1/speech/session
LOCAL_LLM_MODEL=qwen3:8b
```

Optional: `MAX_SPEECH_API_KEY` (when the server sets `SPEECH_API_KEY`; required for a Docker server) and
`MAX_SPEECH_VOICE`, the default voice (a Kokoro preset or a custom voice id). The assistant's own `voice.id` in its
config, which the Studio's Voices section sets, takes precedence. That section also clones and designs voices and
edits pronunciations, through the relay; it needs `MAX_SPEECH=on` or `MAX_SPEECH_URL`. Unlike `local`, the user's
words arrive while they are still talking, and a learned turn detector decides when they have finished instead of a
fixed silence. See [local models](local-models.md) and
[deploying Max Speech](speech-server-deployment.md).

## Trade-offs

Numbers depend on your region, network and models, so measure with your own audio. Qualitatively:

- Live speech-to-speech backends (`openai`, `grok`, `gemini`, `doubao`, `local-realtime`) answer fastest and handle
  interruptions most naturally.
- `pipeline` and `local` add the time to transcribe a whole sentence, then to start the model, then to start speech.
  The relay speaks the reply sentence by sentence while the model is still writing, which hides much of the wait.
- `pipeline` is the most flexible: pick the cheapest or best model for each step, or mix vendors.
- `max-speech` sits between the two: it streams the user's words and ends turns with a learned turn detector, so it
  answers sooner than `local`, while the chat model still starts only after the turn ends.
- `local`, `local-realtime` and `max-speech` cost nothing per minute and keep audio on your hardware, in return for hardware, setup
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
     sendImage?(image: { data: string; mimeType: string }, text?: string): void; // a picture, with or without words
     sendVideoFrame?(image: { data: string; mimeType: string } | undefined): void; // the newest frame of live video; undefined when it stops
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
   - Implement `sendImage` only if the upstream and its model can see pictures. With `text` it is a typed turn with the
     picture attached; without, the picture joins the conversation and the reply waits for the next turn. Also give the
     catalog entry an `imageInput()` check, so `capabilities.imageInput` is true only where it works.
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
