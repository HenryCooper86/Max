"""Voice cloning on CPU with MOSS-TTS-Nano's ONNX export (onnxruntime, no torch).

How it works (the algorithm and graph contract follow MOSS-TTS-Nano, OpenMOSS, Apache-2.0; this code is our own):

1. Reference: the voice's audio is resampled to the codec's 48 kHz, duplicated to stereo and encoded by the audio
   tokenizer into `frames x 16` RVQ codes (12.5 frames per second). Cached in `reference.cache`, so a voice is
   encoded once. The transcript is not used: this model clones from codes alone.
2. Prompt: rows of 17 ints (text/slot token + 16 audio codes). A fixed chat-style template, the reference codes in
   "user audio slot" rows, the sentencepiece tokens of the text, then an assistant prefix that opens the audio.
3. Prefill: the global transformer (12 layers) runs the whole prompt once and returns the KV cache.
4. Decode loop: per frame, a small local graph samples the 16 codes (and whether to stop) from the last hidden state
   with fixed top-k/top-p/temperature/repetition penalty baked in; the 17-wide row of the new frame is fed back
   through the cached decode-step graph.
5. Codec: frames go through the streaming decoder graph (stateful attention caches) in small batches, so audio is
   emitted while generation is still running. Stereo 48 kHz output is averaged down to mono.

Long text is split into <= 75-token pieces (sentence, then clause, then word/char budget); each piece is its own
prompt, with a short silence between pieces.

Limitations: `speed` is ignored; the reference transcript is ignored; no text normalisation beyond whitespace (digits,
dates and symbols are left for the model, which reads them unevenly; upstream uses WeTextProcessing, which needs
pynini); the language is inferred from the text, `language` is accepted but unused.
"""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import numpy as np

from max_speech.audio import resample
from max_speech.engines.base import ReferenceVoice

CACHE_KEY = "moss_tts_nano_prompt_codes"
MAX_REFERENCE_S = 15.0  # a longer reference only slows prefill
MAX_TEXT_TOKENS = 75  # per generated piece, as upstream
MAX_NEW_FRAMES = 375  # 30 s per piece
FRAMES_PER_TOKEN = (
    8  # 12.5 frames/s: 0.64 s per text token, 2-3x what speech needs (measured on the real model)
)
FRAME_SLACK = 25  # two extra seconds, for the lead-in and trailing breath of short pieces
_SENTENCE_END = set(".!?。！？；;")
_CLAUSE_END = set(",，、；;：:")
_CLOSERS = set("\"'”’)]}）】》」』")
_MAX_U = 0.99999994  # largest float32 below 1.0, so the sampler's inverse CDF stays in range

LANGUAGES = (
    "zh",
    "en",
    "de",
    "es",
    "fr",
    "ja",
    "it",
    "hu",
    "ko",
    "ru",
    "fa",
    "ar",
    "pl",
    "pt",
    "cs",
    "da",
    "sv",
    "el",
    "tr",
)


# ---- Pure helpers (unit-tested without models) -----------------------------------------------------------------


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _split_after(text: str, marks: set[str]) -> list[str]:
    """Split after each mark (plus any closing quote/bracket that follows it)."""
    parts: list[str] = []
    start = 0
    i = 0
    while i < len(text):
        if text[i] in marks:
            j = i + 1
            while j < len(text) and text[j] in _CLOSERS:
                j += 1
            # "3.5" or "e.g.x" is not a boundary: a Latin mark needs whitespace or the end after it
            if text[i].isascii() and j < len(text) and not text[j].isspace():
                i = j
                continue
            parts.append(text[start:j])
            start = j
            i = j
        else:
            i += 1
    if start < len(text):
        parts.append(text[start:])
    return [p.strip() for p in parts if p.strip()]


def _hard_split(text: str, max_tokens: int, count: Callable[[str], int]) -> list[str]:
    """Last resort for a clause over budget: break at spaces, or anywhere for unspaced (CJK) text."""
    pieces: list[str] = []
    rest = text.strip()
    while rest:
        if count(rest) <= max_tokens:
            pieces.append(rest)
            break
        lo, hi, best = 1, len(rest), 1
        while lo <= hi:
            mid = (lo + hi) // 2
            if count(rest[:mid].strip()) <= max_tokens:
                best, lo = mid, mid + 1
            else:
                hi = mid - 1
        cut = best
        space = rest.rfind(" ", max(0, best - 25), best)
        if space > 0:
            cut = space + 1
        pieces.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    return [p for p in pieces if p]


def split_text(text: str, count: Callable[[str], int], max_tokens: int = MAX_TEXT_TOKENS) -> list[str]:
    """Pieces of at most `max_tokens` (by `count`), cut at sentence ends, then clause marks, then anywhere."""
    text = clean_text(text)
    if not text:
        return []
    atoms: list[str] = []
    for sentence in _split_after(text, _SENTENCE_END) or [text]:
        if count(sentence) <= max_tokens:
            atoms.append(sentence)
            continue
        for clause in _split_after(sentence, _CLAUSE_END) or [sentence]:
            atoms.extend([clause] if count(clause) <= max_tokens else _hard_split(clause, max_tokens, count))
    pieces: list[str] = []
    current = ""
    for atom in atoms:
        if not current:
            current = atom
            continue
        joined = current + ("" if _no_space(current, atom) else " ") + atom
        if count(joined) <= max_tokens:
            current = joined
        else:
            pieces.append(current)
            current = atom
    if current:
        pieces.append(current)
    return pieces


def _no_space(left: str, right: str) -> bool:
    return _is_cjk(left[-1]) or _is_cjk(right[0])


def _is_cjk(ch: str) -> bool:
    return "　" <= ch <= "鿿" or "＀" <= ch <= "￯"


def frame_cap(text_tokens: int) -> int:
    """Most frames to generate for a piece of `text_tokens` tokens.

    Without a cap, a piece the model cannot say (an emoji, a lone symbol) may never emit the stop signal and
    would run to MAX_NEW_FRAMES, 30 s of babble.
    """
    return min(MAX_NEW_FRAMES, FRAMES_PER_TOKEN * text_tokens + FRAME_SLACK)


def speakable(text: str) -> bool:
    return any(c.isalnum() for c in text)


def pause_seconds(piece: str) -> float:
    """Silence after a piece: longer after very short ones, as upstream (they sound clipped otherwise)."""
    return 0.40 if len(piece.split()) <= 4 else 0.24


def build_prompt_rows(
    prompt_codes: np.ndarray, text_ids: list[int], cfg: dict[str, Any], templates: dict[str, Any]
) -> np.ndarray:
    """The (rows, 17) int32 prompt: [text/slot token, 16 audio codes] per row, audio columns padded for text rows."""
    n_vq = int(cfg["n_vq"])
    pad = int(cfg["audio_pad_token_id"])
    start, end = int(cfg["audio_start_token_id"]), int(cfg["audio_end_token_id"])
    prefix = [*templates["user_prompt_prefix_token_ids"], start]
    suffix = [end, *templates["user_prompt_after_reference_token_ids"], *text_ids]
    suffix += [*templates["assistant_prompt_prefix_token_ids"], start]

    def text_rows(ids: list[int]) -> np.ndarray:
        rows = np.full((len(ids), n_vq + 1), pad, dtype=np.int32)
        rows[:, 0] = ids
        return rows

    codes = np.asarray(prompt_codes, dtype=np.int32).reshape(-1, n_vq)
    audio = np.full((len(codes), n_vq + 1), pad, dtype=np.int32)
    audio[:, 0] = int(cfg["audio_user_slot_token_id"])
    audio[:, 1:] = codes
    return np.concatenate([text_rows(prefix), audio, text_rows(suffix)])


def frame_row(frame: list[int] | np.ndarray, cfg: dict[str, Any]) -> np.ndarray:
    """The (1, 1, 17) decode-step input for a generated frame."""
    row = np.full((1, 1, int(cfg["n_vq"]) + 1), int(cfg["audio_pad_token_id"]), dtype=np.int32)
    row[0, 0, 0] = int(cfg["audio_assistant_slot_token_id"])
    row[0, 0, 1:] = frame
    return row


def repetition_mask(seen: list[set[int]], codebook: int) -> np.ndarray:
    mask = np.zeros((1, len(seen), codebook), dtype=np.int32)
    for channel, tokens in enumerate(seen):
        for token in tokens:
            if 0 <= token < codebook:
                mask[0, channel, token] = 1
    return mask


def random_uniforms(rng: np.random.Generator, n_vq: int) -> tuple[np.ndarray, np.ndarray]:
    u = np.minimum(rng.random(n_vq + 1), _MAX_U).astype(np.float32)
    return u[:1], u[1:].reshape(1, n_vq)


def decode_budget(lead_s: float | None) -> int:
    """Frames to decode at once, given how many seconds of audio are already ahead of playback.

    Small while the listener has nothing buffered (first chunk as early as possible), larger once there is slack.
    """
    if lead_s is None or lead_s < 0.20:
        return 1
    if lead_s < 0.55:
        return 2
    if lead_s < 1.10:
        return 4
    return 8


def to_mono(audio: np.ndarray, length: int) -> np.ndarray:
    """(1, channels, samples) codec output -> float32 mono."""
    return np.ascontiguousarray(audio[0, :, :length].mean(axis=0), dtype=np.float32)


def prepare_reference(audio: np.ndarray, rate: int, codec_rate: int, channels: int) -> np.ndarray:
    """Mono reference -> (1, channels, samples) float32 at the codec's rate, capped at MAX_REFERENCE_S."""
    mono = np.asarray(audio, dtype=np.float32).reshape(-1)
    mono = mono[: int(MAX_REFERENCE_S * rate)]
    mono = resample(mono, rate, codec_rate)
    return np.tile(mono[None, None, :], (1, channels, 1)).astype(np.float32, copy=False)


# ---- Engine ----------------------------------------------------------------------------------------------------


class _CodecStream:
    """The codec's streaming decoder: one set of attention caches, fed a few frames at a time."""

    def __init__(self, session: Any, meta: dict[str, Any]):
        self._session = session
        self._n_q = int(meta["codec_config"]["num_quantizers"])
        sd = meta["streaming_decode"]
        self._transformers = sd["transformer_offsets"]
        self._attention = sd["attention_caches"]
        self._names = [o.name for o in session.get_outputs()]
        self.state: dict[str, np.ndarray] = {}
        self.reset()

    def reset(self) -> None:
        state = {}
        for spec in self._transformers:
            state[spec["input_name"]] = np.zeros(spec["shape"], dtype=np.int32)
        for spec in self._attention:
            state[spec["offset_input_name"]] = np.zeros(spec["offset_shape"], dtype=np.int32)
            state[spec["cached_keys_input_name"]] = np.zeros(spec["cache_shape"], dtype=np.float32)
            state[spec["cached_values_input_name"]] = np.zeros(spec["cache_shape"], dtype=np.float32)
            state[spec["cached_positions_input_name"]] = np.full(spec["positions_shape"], -1, dtype=np.int32)
        self.state = state

    def decode(self, frames: list[list[int]]) -> np.ndarray:
        codes = np.asarray(frames, dtype=np.int32).reshape(1, len(frames), self._n_q)
        feeds = {
            "audio_codes": codes,
            "audio_code_lengths": np.asarray([len(frames)], dtype=np.int32),
            **self.state,
        }
        out = dict(zip(self._names, self._session.run(None, feeds), strict=True))
        for spec in self._transformers:
            self.state[spec["input_name"]] = out[spec["output_name"]]
        for spec in self._attention:
            for key in ("offset", "cached_keys", "cached_values", "cached_positions"):
                self.state[spec[f"{key}_input_name"]] = out[spec[f"{key}_output_name"]]
        return to_mono(out["audio"], int(out["audio_lengths"].reshape(-1)[0]))


class MossNanoCloning:
    id = "moss-tts-nano"
    languages = LANGUAGES

    def __init__(
        self, tts_dir: Path, codec_dir: Path, model_id: str = "moss-tts-nano-onnx", *, seed: int | None = None
    ):
        self.model_id = model_id
        self._tts_dir = Path(tts_dir)
        self._codec_dir = Path(codec_dir)
        manifest = json.loads((self._tts_dir / "browser_poc_manifest.json").read_text(encoding="utf-8"))
        self._cfg = manifest["tts_config"]
        self._templates = manifest["prompt_templates"]
        self._tts_meta = json.loads(
            (self._tts_dir / "tts_browser_onnx_meta.json").read_text(encoding="utf-8")
        )
        self._codec_meta = json.loads(
            (self._codec_dir / "codec_browser_onnx_meta.json").read_text(encoding="utf-8")
        )
        codec_cfg = self._codec_meta["codec_config"]
        self.sample_rate = int(codec_cfg["sample_rate"])
        self._codec_channels = int(codec_cfg["channels"])
        self._rng = np.random.default_rng(seed)
        self._threads = max(1, min(4, os.cpu_count() or 1))
        self._sessions: dict[str, Any] | None = None
        self._sp: Any = None
        self._stream: _CodecStream | None = None

    # -- loading --

    def _load(self) -> dict[str, Any]:
        if self._sessions is not None:
            return self._sessions
        import onnxruntime as ort
        import sentencepiece as spm

        def session(path: Path) -> Any:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = self._threads
            opts.inter_op_num_threads = 1
            return ort.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])

        files, codec_files = self._tts_meta["files"], self._codec_meta["files"]
        self._sessions = {
            "prefill": session(self._tts_dir / files["prefill"]),
            "decode": session(self._tts_dir / files["decode_step"]),
            "frame": session(self._tts_dir / files["local_fixed_sampled_frame"]),
            "encode": session(self._codec_dir / codec_files["encode"]),
            "codec_step": session(self._codec_dir / codec_files["decode_step"]),
        }
        self._sp = spm.SentencePieceProcessor(model_file=str(self._tts_dir / "tokenizer.model"))
        self._stream = _CodecStream(self._sessions["codec_step"], self._codec_meta)
        return self._sessions

    def count_tokens(self, text: str) -> int:
        self._load()
        return len(self._sp.encode(text, out_type=int))

    # -- reference --

    def encode_reference(self, reference: ReferenceVoice) -> np.ndarray:
        """(frames, 16) prompt codes for the reference, computed once and cached on the voice."""
        cached = reference.cache.get(CACHE_KEY)
        if cached is not None:
            return cached
        sessions = self._load()
        wave = prepare_reference(reference.audio, reference.rate, self.sample_rate, self._codec_channels)
        codes, lengths = sessions["encode"].run(
            None, {"waveform": wave, "input_lengths": np.asarray([wave.shape[-1]], dtype=np.int32)}
        )
        prompt = np.asarray(codes[0, : int(np.asarray(lengths).reshape(-1)[0])], dtype=np.int32)
        if len(prompt) == 0:
            raise ValueError("reference audio is too short to clone")
        reference.cache[CACHE_KEY] = prompt
        return prompt

    # -- generation --

    def _frames(self, rows: np.ndarray, max_frames: int = MAX_NEW_FRAMES) -> Iterator[list[int]]:
        """Autoregressive loop: yields one 16-code frame at a time until the model closes the audio (or the cap)."""
        sessions = self._load()
        n_vq = int(self._cfg["n_vq"])
        codebook = int(self._tts_meta["model_config"]["audio_codebook_sizes"][0])
        onnx = self._tts_meta["onnx"]
        prefill = sessions["prefill"].run(
            None,
            {"input_ids": rows[None], "attention_mask": np.ones((1, len(rows)), dtype=np.int32)},
        )
        hidden = prefill[0][:, -1, :].astype(np.float32, copy=False)
        past = dict(
            zip(
                (n.replace("present_", "past_") for n in onnx["prefill_output_names"][1:]),
                prefill[1:],
                strict=True,
            )
        )
        valid = len(rows)
        seen: list[set[int]] = [set() for _ in range(n_vq)]
        decode_out = [n.replace("present_", "past_") for n in onnx["decode_output_names"][1:]]
        for _ in range(max_frames):
            assistant_u, audio_u = random_uniforms(self._rng, n_vq)
            cont, frame = sessions["frame"].run(
                None,
                {
                    "global_hidden": hidden,
                    "repetition_seen_mask": repetition_mask(seen, codebook),
                    "assistant_random_u": assistant_u,
                    "audio_random_u": audio_u,
                },
            )
            if not bool(int(np.asarray(cont).reshape(-1)[0])):
                return
            codes = [int(c) for c in np.asarray(frame).reshape(-1)]
            for channel, code in enumerate(codes):
                seen[channel].add(code)
            yield codes
            out = sessions["decode"].run(
                None,
                {
                    "input_ids": frame_row(codes, self._cfg),
                    "past_valid_lengths": np.asarray([valid], dtype=np.int32),
                    **past,
                },
            )
            hidden = out[0][:, -1, :].astype(np.float32, copy=False)
            past = dict(zip(decode_out, out[1:], strict=True))
            valid += 1

    def _speak_piece(self, text: str, prompt: np.ndarray) -> Iterator[np.ndarray]:
        assert self._stream is not None
        ids = self._sp.encode(text, out_type=int)
        rows = build_prompt_rows(prompt, ids, self._cfg, self._templates)
        self._stream.reset()
        pending: list[list[int]] = []
        first_at: float | None = None
        emitted = 0
        for frame in self._frames(rows, frame_cap(len(ids))):
            pending.append(frame)
            lead = None if first_at is None else emitted / self.sample_rate - (time.perf_counter() - first_at)
            if len(pending) < decode_budget(lead):
                continue
            audio = self._stream.decode(pending)
            pending = []
            if len(audio):
                first_at = first_at or time.perf_counter()
                emitted += len(audio)
                yield audio
        if pending:
            audio = self._stream.decode(pending)
            if len(audio):
                yield audio
        self._stream.reset()

    def synthesize_cloned(
        self, text: str, reference: ReferenceVoice, *, speed: float = 1.0, language: str | None = None
    ) -> Iterator[np.ndarray]:
        pieces = [p for p in split_text(text, self.count_tokens) if speakable(p)]
        if not pieces:
            return
        prompt = self.encode_reference(reference)
        for i, piece in enumerate(pieces):
            yield from self._speak_piece(piece, prompt)
            if i < len(pieces) - 1:
                yield np.zeros(round(pause_seconds(piece) * self.sample_rate), dtype=np.float32)

    def warm_up(self) -> None:
        self._load()
        silence = ReferenceVoice(
            id="warm-up", audio=np.zeros(24000, dtype=np.float32), rate=24000, transcript=""
        )
        # Run every graph once so first-use costs (allocations, kernel selection) land here, not on a request.
        prompt = self.encode_reference(silence)
        rows = build_prompt_rows(prompt, self._sp.encode("Hi.", out_type=int), self._cfg, self._templates)
        for n, _ in enumerate(self._frames(rows)):
            if n >= 2:
                break
        assert self._stream is not None
        self._stream.reset()
        self._stream.decode([[0] * int(self._cfg["n_vq"])])
        self._stream.reset()
