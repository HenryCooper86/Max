# MOSS-TTS-Nano for Max's local voice

[MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano) is OpenMOSS's 0.1B-parameter, Apache-2.0 text-to-speech
model: about 20 languages (Chinese, English, Japanese, Korean, Spanish, French, German, Arabic and more), built-in
voices, voice cloning from a short clip, and fast enough on an ordinary CPU through ONNX Runtime.

Its own demo server has no OpenAI-style endpoint, so `server.py` here adds one. Max's `local` pipeline then uses it like
any other speech server.

## Run it

```bash
# 1. MOSS-TTS-Nano itself (Python 3.10 or newer; uv shown, pip works too)
git clone https://github.com/OpenMOSS/MOSS-TTS-Nano.git
cd MOSS-TTS-Nano
uv venv --python 3.12 .venv && source .venv/bin/activate
uv pip install -r requirements.txt && uv pip install --no-deps -e .

# 2. The speech API (downloads the ONNX model on first run)
python /path/to/Max/examples/moss-tts-nano/server.py
# MOSS-TTS-Nano speech API on http://127.0.0.1:8890/v1
```

Then in Max's `.env`:

```bash
VOICE_PROVIDER=local
LOCAL_TTS_BASE_URL=http://localhost:8890/v1
LOCAL_TTS_MODEL=moss-tts-nano
LOCAL_TTS_VOICE=Junhao        # a built-in voice, or one of yours (below)
LOCAL_TTS_VOICE_MALE=Junhao
LOCAL_TTS_FORMAT=wav
```

`curl localhost:8890/v1/audio/voices` lists the voices. English ones include Ava, Bella, Adam and Nathan; Chinese ones
include Junhao, Zhiming, Xiaoyu and Lingyu.

On a MacBook's CPU a sentence takes about half a second to a second, roughly five times faster than it plays.

**If the install fails on `pynini`** (common on macOS: it needs the OpenFst C++ library), install everything else:

```bash
grep -v WeTextProcessing requirements.txt > requirements-lite.txt && uv pip install -r requirements-lite.txt
```

WeTextProcessing only improves how numbers and dates are read aloud in Chinese and English. The server notices it is
missing and uses the model's own normalizer.

## Your own voice

Put a few seconds of clean speech per voice in a folder, one WAV file each, and start the server with it:

```bash
python /path/to/Max/examples/moss-tts-nano/server.py --voices-dir ~/max-voices   # ~/max-voices/ava.wav → "ava"
```

Then `LOCAL_TTS_VOICE=ava`. Only clone voices you have permission to use.

## Options

| Option                 | Default             | Meaning                                                      |
| ---------------------- | ------------------- | ------------------------------------------------------------ |
| `--host`, `--port`     | `127.0.0.1`, `8890` | Where it listens. Keep it on localhost or a private network. |
| `--repo`               | `.`                 | The MOSS-TTS-Nano checkout, if you run from elsewhere.       |
| `--voices-dir`         | none                | Folder of WAV clips to clone.                                |
| `--default-voice`      | first built-in      | Used for voice names it does not know.                       |
| `--cpu-threads`        | `4`                 | ONNX Runtime threads.                                        |
| `--execution-provider` | `cpu`               | `cuda` with `onnxruntime-gpu` installed.                     |
| `--model-dir`          | auto                | A pre-downloaded ONNX model folder.                          |

The API: `POST /v1/audio/speech` with `{ "input", "voice", "response_format": "wav" | "pcm" }` returns a WAV at the
model's own 48 kHz stereo (Max down-mixes and resamples it), or raw 24 kHz mono PCM16. It renders a whole sentence
before answering; Max asks for one sentence at a time, so speech starts after the first sentence is ready.
