# Max Speech, Milestone 4: the Studio "Voices" section

> **For agentic workers:** implement only the task you are given and touch only the files it owns. Write tests
> first. Do not commit; the lead commits. Write original code. Follow the repo's comment style (why, not what) and
> its bilingual UI convention (`say("中文", "English")` / `localized`).

**Goal:** from Max's admin Studio, an admin can do all of the following without touching the speech server directly:

- see the voices;
- clone one, by recording in the browser or uploading a file, with consent;
- design one from a text description;
- preview, rename and delete voices;
- choose the assistant's voice;
- edit pronunciations;
- see the model attributions.

The relay holds the speech server's address and key; the browser never sees them.

**Spec:** see the "Max-side changes" item 3 and "Consent and safety" sections of
`docs/superpowers/specs/2026-11-20-max-speech-server-design.md`. Per-project voices for Max Cloud are still out of
scope.

## Contracts

### Assistant config

- `voice.id` (string, at most 64 characters) is stored next to the existing `voice.equalizer` in
  `assistant.config.json`.
- `AssistantProfile.voiceId` carries it, and `AssistantSummary` exposes it.
- `EngineConfig.voiceId?: string` carries it to the engine.
- The `max-speech` engine sends `voice: config.voiceId ?? MAX_SPEECH_VOICE` in `session.update`.
- Other engines ignore it.
- Saving the Studio draft writes it, through the same validation path as every other key.

### Relay routes (admin only, `requireAdmin`)

Every route answers 503 `{ok:false, code:"speech_unavailable", error}` when `MAX_SPEECH_URL` is unset or the server
cannot be reached.

The HTTP base is derived from `MAX_SPEECH_URL`: ws becomes http, wss becomes https, and the path is dropped. The relay
sends `MAX_SPEECH_API_KEY` as a bearer token.

Speech-server errors `{error:{code,message}}` come back as `{ok:false, code, error: message}`, keeping the status.

| Route                                             | Body → result                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/admin/studio/voices`                   | → `{ok:true, available:true, cloning, design, voices:[…speech /v1/voices entries…], attributions:[…/.well-known attributions…]}`. When the server is not configured or unreachable, it returns 200 `{ok:true, available:false, reason}` instead of 503, so the section can explain how to set it up.       |
| `POST /auth/admin/studio/voices`                  | JSON `{name, gender, languages:[…], transcript?, consent:true, consentStatement, consentSpeaker, audio:"<base64>", audioType:"audio/wav"}`, limit 12 MB → the speech server's voice (201). The relay builds the multipart request and sets `created_by` to the admin's username; the client cannot set it. |
| `PATCH /auth/admin/studio/voices/:id`             | JSON `{name?, languages?, gender?, transcript?}` → voice                                                                                                                                                                                                                                                   |
| `DELETE /auth/admin/studio/voices/:id`            | → 204                                                                                                                                                                                                                                                                                                      |
| `GET /auth/admin/studio/voices/:id/reference`     | → `audio/wav`, streamed through                                                                                                                                                                                                                                                                            |
| `POST /auth/admin/studio/voices/:id/preview`      | JSON `{text?}` → `audio/wav`                                                                                                                                                                                                                                                                               |
| `POST /auth/admin/studio/voices/design`           | JSON `{description, text?, language?, count?}` → `{ok:true, candidates:[{id, text, description}]}`                                                                                                                                                                                                         |
| `GET /auth/admin/studio/voices/design/:cid/audio` | → `audio/wav`                                                                                                                                                                                                                                                                                              |
| `POST /auth/admin/studio/voices/design/:cid/save` | JSON `{name, gender?, languages?}` → voice (201), with `created_by` set to the admin                                                                                                                                                                                                                       |
| `GET` / `PUT /auth/admin/studio/lexicon`          | `{entries:{…}}`                                                                                                                                                                                                                                                                                            |

Before the relay puts `:id` or `:cid` into the upstream URL, it must check them against `^v_[0-9a-f]{10}$` and
`^c_[0-9a-f]{12}$`; anything else gets a 404. Request size limits apply before the body is parsed.

### Speech-server design routes (Task C; the model is chosen after research)

| Route                               | Behaviour                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/voices/design`            | JSON `{description (≤300 chars), text? (≤300), language?, count? (1–3, default 3), created_by?}` → `{candidates:[{id:"c_<12 hex>", text, description, language, expires_at}]}`. Candidates are kept in memory for 15 minutes, with at most 30 per server. If there is no design engine, 409 `design_unavailable`.          |
| `GET /v1/voices/design/{cid}/audio` | → `audio/wav`, or 404 when unknown or expired                                                                                                                                                                                                                                                                              |
| `POST /v1/voices/design/{cid}/save` | JSON `{name, gender?, languages?, created_by?}` → 201 custom voice. The candidate audio becomes the reference and its text the transcript. The voice gets `origin:"designed"` and `design:{description}` instead of a consent record, because no real person's voice is involved. Recorded voices get `origin:"recorded"`. |

Discovery has `features.voice_design`.

### Studio UI

There is a new section, "Voices" (声音库), in `AssistantStudio`, between "Sound" and "Voice backend", built as the
component `src/components/studio/VoicesPanel.tsx` with its API client in `src/lib/voices-api.ts`.

- **Not available:** explain the setup (start Max Speech, set `MAX_SPEECH_URL`, or pick the `max-speech` backend),
  using `reason`.
- **Assistant voice:** a picker of preset and custom voices, with a Play button that runs a preview. Choosing one
  sets `draft.voiceId`; the Studio's normal Save writes it, and "Default" clears it.
- **Custom voices:** a list showing name, languages, origin (recorded or designed), creation time and creator, and
  the consent speaker and statement in a disclosure. Each has buttons to play the original, preview, rename and
  delete (with a confirm step inside the page, not `window.confirm`).
- **Clone a voice** (shown only when `cloning`):
  - Record from the microphone with Web Audio, capture PCM and encode WAV in the browser. Show a timer and a level
    meter, and allow 5–30 s. A file upload is the alternative.
  - Fields: name, gender, language, and an optional transcript ("leave blank to transcribe it").
  - Consent: a checkbox, the speaker's name, and a statement with a suggested template filled in.
  - Submit stays disabled until the consent checkbox is ticked, the statement is at least 20 characters, the speaker
    is filled in and the audio is 5–30 s long.
- **Design a voice** (shown only when `design`): a description, optional sample text, and a Generate button that
  makes 3 candidates, each with a player and a "Save as voice" action (name, gender).
- **Pronunciation:** an editable table of word → spoken as, with add, remove and save.
- **About the voices:** the attributions list.
- **States:** loading, errors (the code mapped to readable text), and empty states.
- **Accessibility:** labelled controls, keyboard operable, live-region status messages.

---

### Task A: relay side

**Owns:**

- `server/index.ts` (route registration only)
- new `server/studio-voices.ts` (the proxy logic)
- `server/assistant.ts` (`voice.id`)
- `server/studio.ts` (only if needed for `voice.id` validation)
- `shared/agent.ts` (`AssistantSummary.voiceId`, if that type lives there)
- `server/providers/live/engine.ts` (`EngineConfig.voiceId`)
- `server/providers/live/session.ts` (pass `voiceId`)
- `server/providers/live/max-speech.ts`
- tests: new `tests/studio-voices.test.ts`, plus extensions to the assistant, studio and max-speech tests

If `npm run check:protocol` requires a regenerated generated file, include it.

### Task B: Studio UI

**Owns:**

- new `src/lib/voices-api.ts`
- new `src/lib/wav-recorder.ts` (Web Audio capture and WAV encoding, unit-testable)
- new `src/components/studio/VoicesPanel.tsx`
- `src/components/admin/AssistantStudio.tsx` (mount the section)
- `src/lib/assistant-config.ts` (`draft.voiceId` round-trip)
- the Studio CSS file the section needs
- tests: new `tests/voices-panel.test.tsx` and `tests/wav-recorder.test.ts`, plus `tests/assistant-studio.test.tsx`
  for the mount and the `voiceId` save

Mock `voices-api` in component tests.

### Task C: speech-server voice design

Written once the research on the model is in.
