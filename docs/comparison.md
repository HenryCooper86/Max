# How Max compares

This page lists what voice-agent platforms are expected to do, says for each whether Max does it, and names what Max
does not do yet. It was last checked in November 2026 against the public documentation of hosted agent platforms
(Vapi, Retell AI, ElevenLabs Agents, Bland), open-source frameworks (LiveKit Agents, Pipecat) and the vendors' own
realtime APIs (OpenAI Realtime, Gemini Live, Grok Voice). These products change every month. Check their documentation
before you rely on a comparison, and tell us when this page is out of date.

Max is a different kind of product from most of that list. It is a relay you run yourself, under the MIT license, that
puts one protocol in front of eight voice backends. A hosted platform is a service you rent that also resells the phone
numbers, models and voices. If you want nothing to run, a hosted platform or [Max Cloud](cloud.md) fits better. If you
want to own the stack, keep your own model keys, run on your own hardware or put an agent on a device, read on.

## What agent platforms do, and where Max stands

"Yes" means the feature is in this repository and covered by its tests. "Partly" is explained in the note. "No" means
it is not built; see [not built yet](#not-built-yet).

### The conversation

| Capability                                            | Max    | Notes                                                                                                                       |
| ----------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| Speech-to-speech models                               | Yes    | OpenAI Realtime, Gemini Live, Grok Voice, Doubao. See [voice backends](backends.md).                                        |
| Cascaded speech-to-text → chat model → text-to-speech | Yes    | Any OpenAI-compatible endpoints, hosted or local.                                                                           |
| Barge-in                                              | Yes    | On every live backend, including phone calls.                                                                               |
| Turn detection                                        | Yes    | Tunable per backend. Learned end-of-turn detection with OpenAI (`semantic_vad`) and Max Speech; the vendor's own elsewhere. |
| Noise suppression                                     | Yes    | In the relay for any backend and for phone calls (RNNoise), the browser's own on the web, and OpenAI's setting.             |
| Typed input and live captions                         | Yes    |                                                                                                                             |
| Greeting, check-ins on silence, time limit            | Yes    | [Running a conversation](conversations.md).                                                                                 |
| The agent ends the conversation itself                | Yes    | The `end_session` tool; always on for phone calls.                                                                          |
| Several agents with handoff                           | Yes    | Per-agent instructions and tools. No visual flow builder.                                                                   |
| Conversation survives a dropped connection            | Yes    | For 10 minutes, in the relay's memory.                                                                                      |
| Memory across conversations                           | Yes    | Recent turns and facts the user asked to keep, per user, with a route to forget a user. No summarising of long histories.   |
| Images or video in the conversation                   | Partly | Camera frames for the helmet assistant. Not yet a general image input for app assistants.                                   |
| Wake word                                             | Yes    | Uncommon on agent platforms; it comes from Max's device origins.                                                            |

### Tools and knowledge

| Capability                             | Max | Notes                                                                                                                                                 |
| -------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side functions                  | Yes | Code tools and HMAC-signed webhook tools. See [tools](tools.md).                                                                                      |
| Client-side functions                  | Yes | The page or app runs the tool: scroll, fill a form, add to cart.                                                                                      |
| Remote MCP servers                     | Yes | Streamable HTTP. Not stdio servers.                                                                                                                   |
| Knowledge base                         | Yes | Search over your files, built in: keyword (BM25), or hybrid with any embeddings endpoint. Up to 100,000 passages, with the embeddings cached on disk. |
| Tools that keep running while it talks | Yes | Mark a webhook or code tool `background`: the agent carries on and reports the result when it comes.                                                  |

### Phone calls

| Capability                                  | Max | Notes                                                            |
| ------------------------------------------- | --- | ---------------------------------------------------------------- |
| Inbound and outbound calls                  | Yes | Through Twilio. See [phone calls](telephony.md).                 |
| Transfer to a person, keypad input, hang up | Yes | Cold transfer to numbers you list. No warm (announced) transfer. |
| Answering-machine detection                 | Yes | Twilio's; a voicemail message can be left.                       |
| Direct SIP trunks, other carriers           | No  |                                                                  |
| Buying numbers, batch campaigns, recordings | No  | Numbers and recording stay in your Twilio account.               |

### Operating it

| Capability                             | Max    | Notes                                                                                        |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| Summary, outcome and extracted fields  | Yes    | After each conversation, to a webhook or a log file.                                         |
| Personal-data redaction                | Partly | Pattern-based: emails, phone numbers, card numbers, SSNs, IP addresses. Text only.           |
| Automated tests with simulated users   | Yes    | Scripted and model-played users, an LLM judge, pass rates. See [testing](testing-agents.md). |
| Traces                                 | Yes    | OpenTelemetry (OTLP/HTTP), a span per session, turn and tool call.                           |
| Metrics, latency per turn              | Yes    | Prometheus `/metrics` and per-turn telemetry events.                                         |
| Usage metering and limits              | Yes    | Per user and month. See [usage and billing](usage-and-billing.md).                           |
| Agent versions and A/B tests           | No     | The config is a file; version it in git.                                                     |
| Compliance attestations (SOC 2, HIPAA) | No     | Self-hosting puts compliance in your hands; we hold no attestations.                         |

### Reaching users

| Capability                     | Max | Notes                                                                       |
| ------------------------------ | --- | --------------------------------------------------------------------------- |
| Web widget and JavaScript SDK  | Yes | One script tag, a React hook, or the `VoiceAgent` class.                    |
| Native iOS and Android clients | Yes | Source included.                                                            |
| Devices and embedded Linux     | Yes | A Python reference client, an embedded client, a documented audio contract. |
| WebRTC transport               | Yes | For the web SDK, with fallback to the WebSocket. See [WebRTC](webrtc.md).   |
| Avatars                        | No  |                                                                             |

## What Max does that hosted platforms usually do not

- **You run it.** The whole stack is in this repository under the MIT license. Model keys, transcripts and audio stay
  on your servers, and nothing is billed per minute unless you choose Max Cloud.
- **One protocol in front of every model.** Clients speak one [documented protocol](protocol.md). Changing from OpenAI
  to Gemini to a local model is one environment variable, and a client can pick a backend per session.
- **It runs with no cloud at all.** [Max Speech](local-models.md) with a local chat model gives live transcripts,
  learned turn-taking and tool calls on your own hardware. Tools, knowledge search, MCP, handoff, ending a
  conversation and post-conversation analysis were all tested end to end with an 8-billion-parameter chat model
  running on a laptop.
- **It is built for devices as well as browsers.** Wake word, an audio contract for hardware, and clients for iOS,
  Android and embedded Linux.
- **Tools in the page.** The agent can act in the user's own browser tab, which a server-side platform cannot reach.
- **Small models are handled, not assumed away.** When a small model says "let me check" and then calls nothing, the
  cascaded backends notice and ask it again, so the user is not left waiting.

## Not built yet

In rough order of how much they would matter to most users:

1. **A learned turn detector of the relay's own in front of every hosted backend.** OpenAI and Max Speech have one;
   Gemini and Grok use the vendor's voice activity detection, which the relay can tune but not replace. Noise
   suppression is steady-noise removal: it does not separate the user from other people talking nearby.
2. **Direct SIP and carriers other than Twilio.**
3. **A vector database for very large knowledge bases.** The built-in knowledge base holds its index in memory and
   compares a question with every passage: measured at 100,000 passages, not beyond. For a larger collection, call
   your own search from a tool or an MCP server.
4. **A general image input for app assistants.** Background tools exist for webhook and code tools, not yet for
   client tools or MCP servers.
5. **Guardrails beyond redaction**, such as moderation of what the agent says.
6. **A visual flow builder, agent versions and A/B tests.**
7. **Warm transfers, batch outbound campaigns and call recording.**
8. **WebRTC in the native iOS and Android clients.** The web SDK has it; the native clients use the WebSocket.
9. **Avatars.**

Conversation analysis, the conversation webhook, traces and phone calls currently apply to the relay's own assistant.
Max Cloud projects have their own conversation history in the console and do not have these yet.
