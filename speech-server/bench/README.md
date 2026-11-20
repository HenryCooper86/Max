# Latency benchmark

Works against any OpenAI-compatible speech server (Max Speech, Kokoro-FastAPI, ...).

    uv run python -m bench.latency --base-url http://localhost:8790/v1 --runs 5 --json bench/out/run.json

Options: `--api-key`, `--voice`, `--tts-model`, `--stt-model`, `--fixtures DIR` (WAVs, optional matching `.txt`
reference), `--format wav` for servers that only return WAV (time to first byte then equals total).

TTS reports time to first byte, total time, audio seconds and real-time factor. STT reports latency, plus word
error rate (en) or character error rate (zh) when the reference text is known. Tables show p50 and p95.
