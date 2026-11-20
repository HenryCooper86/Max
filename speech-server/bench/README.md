# Latency benchmark

Works against any OpenAI-compatible speech server (Max Speech, Kokoro-FastAPI, ...).

    uv run python -m bench.latency --base-url http://localhost:8790/v1 --runs 5 --json bench/out/run.json

Options: `--api-key`, `--voice`, `--tts-model`, `--stt-model`, `--fixtures DIR` (WAVs, optional matching `.txt`
reference), `--format wav` for servers that only return WAV (time to first byte then equals total).

TTS reports time to first byte, total time, audio seconds and real-time factor. STT reports latency, plus word
error rate (en) or character error rate (zh) when the reference text is known. Tables show p50 and p95.

## Session benchmark

    uv run python -m bench.session --url ws://localhost:8790/v1/speech/session --runs 3 --json bench/out/session.json

Measures the live session of a Max Speech server. Each phrase is synthesized with `/v1/audio/speech`, resampled to
16 kHz and streamed at real-time pace in 20 ms frames with 0.4 s of leading and 1.5 s of trailing silence (`--lead`,
`--trail`). Reported: end of speech to `transcript.final`, first partial after speech start, WER (en) or CER (zh),
the server's `ms.turn` and `ms.stt`, and, for `speak`, time to the first audio frame and to `audio.done`. The "M1
equivalent" row is 700 ms (the relay's fixed silence wait) plus the latency of `POST /v1/audio/transcriptions`.
If the server ends a turn at a pause inside a phrase, the texts of all turns are joined and the last one is timed.
