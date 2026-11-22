# Examples

| Example                                     | What it shows                                                                                      | Language   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------- |
| [`web-embed/`](web-embed/README.md)         | A web page with a voice assistant, session tokens from your backend, and server and client tools.  | JavaScript |
| [`device-client/`](device-client/README.md) | A client for a Raspberry Pi or Linux board: microphone, speaker, interruption and reconnect.       | Python     |
| [`moss-tts-nano/`](moss-tts-nano/README.md) | A local text-to-speech server (MOSS-TTS-Nano) with an OpenAI-style endpoint for the `local` voice. | Python     |

Start with `web-embed` if you are adding a voice agent to a website or app. Start with `device-client` if you are
building hardware, or want a readable client for the [protocol](../docs/protocol.md) in a language other than
JavaScript. Use `moss-tts-nano` if you run Max's [local models](../docs/local-models.md) and want a multilingual voice.
