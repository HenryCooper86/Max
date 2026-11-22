"""Custom voices on disk: `<root>/<id>/reference.wav` plus `voice.json`, with the consent record kept alongside."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import secrets
import shutil
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType

import numpy as np
import soundfile as sf

from max_speech.audio import OUTPUT_RATE, AudioDecodeError, decode_audio, resample
from max_speech.engines.base import ReferenceVoice, UnknownVoiceError

log = logging.getLogger(__name__)

ID_RE = re.compile(r"^v_[0-9a-f]{10}$")
TRASH_PREFIX = ".trash-"
GENDERS = ("female", "male", "neutral")

MAX_NAME = 64
MAX_TRANSCRIPT = 1000
MAX_STATEMENT = 1000
MAX_SPEAKER = 128
MAX_CREATED_BY = 128
MIN_STATEMENT = 20
MAX_LANGUAGES = 8
MAX_DESCRIPTION = 300
ORIGINS = ("recorded", "designed")

MIN_SECONDS = 5.0
MAX_SECONDS = 30.0
SILENCE_FLOOR_DBFS = -50.0  # frames below this are trimmed from both ends
MIN_RMS_DBFS = -45.0
CLIP_LEVEL = 0.999
MAX_CLIPPED_FRACTION = 0.01
PEAK_DBFS = -1.0
_FRAME_S = 0.02
_PAD_S = 0.05


def is_custom_id(voice_id: str) -> bool:
    return isinstance(voice_id, str) and ID_RE.fullmatch(voice_id) is not None


class VoiceError(ValueError):
    """A request the store refuses. `code` is stable and goes to the client."""

    def __init__(self, code: str, message: str, param: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.param = param


@dataclass(frozen=True)
class ProcessedReference:
    """A validated reference: trimmed, 24 kHz mono, peak-normalised."""

    audio: np.ndarray
    rate: int
    duration_s: float


@dataclass(frozen=True)
class CustomVoice:
    id: str
    name: str
    languages: tuple[str, ...]
    gender: str
    transcript: str
    transcript_source: str
    duration_s: float
    created_at: str
    created_by: str
    consent: Mapping = field(default_factory=dict)  # read-only: a copy wrapped in MappingProxyType
    engine_hint: str | None = None
    origin: str = (
        "recorded"  # "recorded" (a real person, with consent) or "designed" (from a text description)
    )
    design: Mapping = field(default_factory=dict)  # designed voices only: {description, seed, model, text}

    def __post_init__(self) -> None:
        # The record is frozen, so its consent must not be editable through the dict either.
        object.__setattr__(self, "consent", MappingProxyType(dict(self.consent)))
        object.__setattr__(self, "design", MappingProxyType(dict(self.design)))

    def to_dict(self) -> dict:
        out = {
            "id": self.id,
            "name": self.name,
            "languages": list(self.languages),
            "gender": self.gender,
            "transcript": self.transcript,
            "transcript_source": self.transcript_source,
            "duration_s": self.duration_s,
            "created_at": self.created_at,
            "created_by": self.created_by,
            "engine_hint": self.engine_hint,
            "origin": self.origin,
        }
        if self.origin == "designed":
            out["design"] = dict(self.design)
        else:
            out["consent"] = dict(self.consent)
        return out

    @classmethod
    def from_dict(cls, d: dict) -> CustomVoice:
        origin = d.get("origin", "recorded")  # voices made before design existed were all recorded
        if origin not in ORIGINS:
            raise ValueError(f"unknown origin {origin!r}")
        if origin == "recorded" and not d.get("consent"):
            raise ValueError("a recorded voice has no consent record")
        if origin == "designed" and not (d.get("design") or {}).get("description"):
            raise ValueError("a designed voice has no description")
        return cls(
            id=d["id"],
            name=d["name"],
            languages=tuple(d["languages"]),
            gender=d["gender"],
            transcript=d["transcript"],
            transcript_source=d.get("transcript_source", "given"),
            duration_s=float(d["duration_s"]),
            created_at=d["created_at"],
            created_by=d.get("created_by", ""),
            consent=dict(d.get("consent") or {}) if origin == "recorded" else {},
            engine_hint=d.get("engine_hint"),
            origin=origin,
            design=dict(d.get("design") or {}) if origin == "designed" else {},
        )


# ---- field validation --------------------------------------------------------------------------------------------


def _text(value: object, field_name: str, max_len: int, code: str = "invalid_field") -> str:
    if not isinstance(value, str):
        raise VoiceError(code, f"{field_name} must be text", field_name)
    text = " ".join(value.split())  # one line, single spaces
    if any(ord(c) < 32 or ord(c) == 127 for c in text):
        raise VoiceError(code, f"{field_name} must not contain control characters", field_name)
    if len(text) > max_len:
        raise VoiceError(code, f"{field_name} must be at most {max_len} characters", field_name)
    return text


def _name(value: object) -> str:
    name = _text(value, "name", MAX_NAME)
    if not name:
        raise VoiceError("invalid_field", "name is required", "name")
    return name


def _transcript(value: object) -> str:
    return _text(value, "transcript", MAX_TRANSCRIPT)


def _gender(value: object) -> str:
    if not isinstance(value, str) or value.strip().lower() not in GENDERS:
        raise VoiceError("invalid_field", f"gender must be one of {', '.join(GENDERS)}", "gender")
    return value.strip().lower()


_LANG_RE = re.compile(r"^[a-z]{2,3}$")


def _languages(value: object) -> tuple[str, ...]:
    items = value.split(",") if isinstance(value, str) else value
    if not isinstance(items, (list, tuple)):
        raise VoiceError("invalid_field", "languages must be a comma-separated list", "languages")
    out: list[str] = []
    for item in items:
        if not isinstance(item, str):
            raise VoiceError("invalid_field", "languages must be a comma-separated list", "languages")
        tag = item.strip().lower().split("-")[0].split("_")[0]
        if not tag:
            continue
        if not _LANG_RE.match(tag):
            raise VoiceError(
                "invalid_field", f"'{item}' is not a language code such as 'en' or 'zh'", "languages"
            )
        if tag not in out:
            out.append(tag)
    if len(out) > MAX_LANGUAGES:
        raise VoiceError("invalid_field", f"at most {MAX_LANGUAGES} languages are allowed", "languages")
    return tuple(out)


def _guess_language(transcript: str) -> str:
    return "zh" if any("一" <= c <= "鿿" for c in transcript) else "en"


def check_consent(consent: object, statement: object, speaker: object) -> tuple[str, str]:
    """Returns the cleaned (statement, speaker), or raises `consent_required`."""

    def refuse(why: str) -> VoiceError:
        return VoiceError(
            "consent_required",
            f"cloning a voice needs consent from the speaker: {why}",
            "consent",
        )

    if consent is not True:
        raise refuse("send consent=true")
    if not isinstance(statement, str) or not isinstance(speaker, str):
        raise refuse("send consent_statement and consent_speaker")
    cleaned = " ".join(statement.split())
    if len(cleaned) < MIN_STATEMENT:
        raise refuse(f"consent_statement must be at least {MIN_STATEMENT} characters")
    if len(cleaned) > MAX_STATEMENT:
        raise refuse(f"consent_statement must be at most {MAX_STATEMENT} characters")
    who = " ".join(speaker.split())
    if not who:
        raise refuse("consent_speaker is required")
    if len(who) > MAX_SPEAKER:
        raise refuse(f"consent_speaker must be at most {MAX_SPEAKER} characters")
    if any(ord(c) < 32 or ord(c) == 127 for c in cleaned + who):
        raise refuse("consent fields must not contain control characters")
    return cleaned, who


# ---- reference audio ---------------------------------------------------------------------------------------------


def _rms_dbfs(x: np.ndarray) -> float:
    if len(x) == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    return 20.0 * np.log10(rms) if rms > 0 else -120.0


def _trim(x: np.ndarray, rate: int) -> np.ndarray:
    frame = max(1, int(rate * _FRAME_S))
    n = len(x) // frame
    if n == 0:
        return x
    levels = np.sqrt(np.mean(np.square(x[: n * frame].reshape(n, frame), dtype=np.float64), axis=1))
    loud = np.flatnonzero(levels > 10 ** (SILENCE_FLOOR_DBFS / 20))
    if len(loud) == 0:
        return x[:0]
    pad = int(rate * _PAD_S)
    start = max(0, int(loud[0]) * frame - pad)
    end = min(len(x), (int(loud[-1]) + 1) * frame + pad)
    return x[start:end]


def process_reference(data: bytes) -> ProcessedReference:
    """Decode and check an uploaded recording; see the milestone 3 design for the thresholds."""
    try:
        info = sf.info(io.BytesIO(data))
        raw_s = info.frames / info.samplerate if info.samplerate else 0.0
    except Exception as exc:
        raise VoiceError(
            "invalid_audio", "could not read the audio file; send WAV, FLAC or OGG", "audio"
        ) from exc
    # Judge the length before decoding, so a small compressed file cannot expand into a huge array.
    if raw_s > MAX_SECONDS:
        raise VoiceError(
            "reference_too_long", f"the recording must be at most {MAX_SECONDS:.0f} seconds", "audio"
        )
    if raw_s < MIN_SECONDS:
        raise VoiceError(
            "reference_too_short", f"the recording must be at least {MIN_SECONDS:.0f} seconds", "audio"
        )
    try:
        samples, rate = decode_audio(data)
    except AudioDecodeError as exc:
        raise VoiceError("invalid_audio", str(exc), "audio") from exc
    if not np.all(np.isfinite(samples)):
        raise VoiceError("invalid_audio", "the audio contains invalid samples", "audio")
    if len(samples) and float(np.mean(np.abs(samples) >= CLIP_LEVEL)) > MAX_CLIPPED_FRACTION:
        raise VoiceError(
            "reference_clipped", "the recording is heavily clipped; record at a lower level", "audio"
        )
    trimmed = _trim(samples, rate)
    if _rms_dbfs(trimmed) < MIN_RMS_DBFS:
        raise VoiceError("reference_silent", "the recording is silent or far too quiet", "audio")
    if len(trimmed) / rate < MIN_SECONDS:
        raise VoiceError(
            "reference_too_short",
            f"less than {MIN_SECONDS:.0f} seconds of speech remain after trimming silence",
            "audio",
        )
    out = resample(trimmed, rate, OUTPUT_RATE).astype(np.float32)
    peak = float(np.max(np.abs(out)))
    if peak > 0:
        out = (out * (10 ** (PEAK_DBFS / 20) / peak)).astype(np.float32)
    return ProcessedReference(out, OUTPUT_RATE, round(len(out) / OUTPUT_RATE, 3))


MIN_DESIGN_SECONDS = 3.0  # shorter references clone poorly


def reference_from_samples(samples: np.ndarray, rate: int) -> ProcessedReference:
    """A reference from audio the server generated itself: trimmed and peak-normalised like an upload, but with
    no minimum length beyond `MIN_DESIGN_SECONDS` (a designed sample is one short sentence)."""
    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    if not np.all(np.isfinite(x)):
        raise VoiceError("invalid_audio", "the audio contains invalid samples", "audio")
    x = _trim(x, rate)
    if len(x) / rate < MIN_DESIGN_SECONDS or _rms_dbfs(x) < MIN_RMS_DBFS:
        raise VoiceError("reference_too_short", "the sample is too short or too quiet to save", "audio")
    out = resample(x, rate, OUTPUT_RATE).astype(np.float32)
    peak = float(np.max(np.abs(out)))
    if peak > 0:
        out = (out * (10 ** (PEAK_DBFS / 20) / peak)).astype(np.float32)
    return ProcessedReference(out, OUTPUT_RATE, round(len(out) / OUTPUT_RATE, 3))


# ---- files -------------------------------------------------------------------------------------------------------


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _wav_bytes(audio: np.ndarray, rate: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# What the server knows about a caller; anything else in the mapping is dropped, so a route cannot leak a secret here.
_PROVENANCE_KEYS = ("client", "auth", "key_id")


def _provenance(raw: Mapping | None) -> dict[str, str]:
    return {k: str(raw[k])[:128] for k in _PROVENANCE_KEYS if raw and raw.get(k)}


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class VoiceStore:
    """Index of custom voices, loaded once at startup. Nothing touches disk until the first voice is created."""

    def __init__(self, root: Path, audit_log: Path | None = None) -> None:
        self.root = Path(root)
        self._audit_path = Path(audit_log) if audit_log is not None else None
        self._audit_lock = threading.Lock()
        self._lock = threading.Lock()
        self._voices: dict[str, CustomVoice] = {}
        # the record each cached reference was built from: a cache entry is valid only while that very object is current
        self._cache: dict[str, tuple[CustomVoice, ReferenceVoice]] = {}
        self._load()

    def _load(self) -> None:
        if not self.root.is_dir():
            return
        for entry in sorted(self.root.iterdir()):
            if entry.is_symlink() or not entry.is_dir():
                continue
            if entry.name.startswith(TRASH_PREFIX):  # a delete that was interrupted after its rename
                self._remove(entry)
                continue
            if not ID_RE.fullmatch(entry.name):
                continue
            if not (entry / "voice.json").exists():
                # create() writes voice.json last, so this is a crashed create holding an orphaned recording
                log.warning("removing incomplete voice directory %s (no voice.json)", entry)
                self._remove(entry)
                continue
            try:
                voice = CustomVoice.from_dict(json.loads((entry / "voice.json").read_text(encoding="utf-8")))
                if voice.id != entry.name or not (entry / "reference.wav").is_file():
                    raise ValueError("voice.json does not match its directory")
            except (OSError, ValueError, KeyError, TypeError):
                log.warning("skipping unreadable voice directory %s", entry, exc_info=True)
                continue
            self._voices[voice.id] = voice

    @staticmethod
    def _remove(directory: Path) -> None:
        try:
            shutil.rmtree(directory)
        except OSError:
            log.warning("could not remove %s", directory, exc_info=True)

    # ---- reading ----

    def _check_id(self, voice_id: str) -> None:
        # Every id from a URL passes here before it is used in a path.
        if not is_custom_id(voice_id):
            raise UnknownVoiceError(f"voice '{str(voice_id)[:40]}' not found")

    def list(self) -> list[CustomVoice]:
        with self._lock:
            return sorted(self._voices.values(), key=lambda v: (v.created_at, v.id))

    def info(self, voice_id: str) -> CustomVoice:
        self._check_id(voice_id)
        with self._lock:
            voice = self._voices.get(voice_id)
        if voice is None:
            raise UnknownVoiceError(f"voice '{voice_id}' not found")
        return voice

    def __contains__(self, voice_id: object) -> bool:
        return isinstance(voice_id, str) and is_custom_id(voice_id) and voice_id in self._voices

    def reference_path(self, voice_id: str) -> Path:
        self.info(voice_id)
        return self.root / voice_id / "reference.wav"

    def get(self, voice_id: str) -> ReferenceVoice:
        info = self.info(voice_id)
        with self._lock:
            cached = self._cache.get(voice_id)
            if cached is not None and cached[0] is info:
                return cached[1]
        try:
            audio, rate = sf.read(self.root / voice_id / "reference.wav", dtype="float32")
        except (OSError, RuntimeError) as exc:
            raise UnknownVoiceError(f"voice '{voice_id}' has no readable reference audio") from exc
        ref = ReferenceVoice(
            id=voice_id,
            audio=np.asarray(audio, dtype=np.float32),
            rate=int(rate),
            transcript=info.transcript,
            language=info.languages[0] if info.languages else None,
        )
        with self._lock:
            if self._voices.get(voice_id) is info:  # not updated or deleted while the audio was read
                self._cache[voice_id] = (info, ref)
        return ref

    # ---- writing ----

    def create(
        self,
        *,
        audio: bytes | ProcessedReference,
        name: object,
        transcript: object = None,
        languages: object = None,
        gender: object = "neutral",
        consent: object = None,
        consent_statement: object = None,
        consent_speaker: object = None,
        created_by: object = None,
        transcript_source: str = "given",
        provenance: Mapping | None = None,
    ) -> CustomVoice:
        statement, speaker = check_consent(consent, consent_statement, consent_speaker)
        clean_name = _name(name)
        clean_gender = _gender(gender if gender not in (None, "") else "neutral")
        who = _text(created_by, "created_by", MAX_CREATED_BY) if created_by else ""
        text = _transcript(transcript) if transcript else ""
        if not text:
            raise VoiceError("transcript_required", "a transcript of the recording is required", "transcript")
        langs = _languages(languages) if languages not in (None, "", []) else ()
        if not langs:
            langs = (_guess_language(text),)
        ref = audio if isinstance(audio, ProcessedReference) else process_reference(audio)
        return self._persist(
            ref,
            name=clean_name,
            languages=langs,
            gender=clean_gender,
            transcript=text,
            transcript_source=transcript_source if transcript_source in ("given", "stt") else "given",
            created_by=who or "unknown",
            origin="recorded",
            consent_fields=lambda now, stored_sha: {
                "statement": statement,
                "speaker": speaker,
                "recorded_at": now,
                # Ties the statement to one recording: the file in the voice's folder, and the bytes as uploaded.
                "audio_sha256": stored_sha,
                **({"upload_sha256": _sha256(audio)} if isinstance(audio, bytes) else {}),
                **_provenance(provenance),
            },
            provenance=provenance,
        )

    def create_designed(
        self,
        *,
        audio: bytes | ProcessedReference,
        name: object,
        transcript: object,
        description: object,
        seed: object,
        model: object,
        languages: object = None,
        gender: object = "neutral",
        created_by: object = None,
        provenance: Mapping | None = None,
    ) -> CustomVoice:
        """Save a voice made from a text description: no real person is cloned, so there is no consent record.

        Only the design path calls this; `POST /v1/voices` always goes through `create` and its consent check.
        """
        clean_name = _name(name)
        clean_gender = _gender(gender if gender not in (None, "") else "neutral")
        who = _text(created_by, "created_by", MAX_CREATED_BY) if created_by else ""
        text = _transcript(transcript) if transcript else ""
        if not text:
            raise VoiceError("transcript_required", "a transcript of the sample is required", "transcript")
        desc = _text(description, "description", MAX_DESCRIPTION)
        if not desc:
            raise VoiceError("invalid_field", "a designed voice needs a description", "description")
        if not isinstance(seed, int) or isinstance(seed, bool):
            raise VoiceError("invalid_field", "seed must be an integer", "seed")
        langs = _languages(languages) if languages not in (None, "", []) else ()
        if not langs:
            langs = (_guess_language(text),)
        ref = audio if isinstance(audio, ProcessedReference) else process_reference(audio)
        return self._persist(
            ref,
            name=clean_name,
            languages=langs,
            gender=clean_gender,
            transcript=text,
            transcript_source="given",
            created_by=who or "unknown",
            origin="designed",
            design={"description": desc, "seed": seed, "model": _text(model, "model", 128), "text": text},
            provenance=provenance,
        )

    def _persist(
        self,
        ref: ProcessedReference,
        *,
        name: str,
        languages: tuple[str, ...],
        gender: str,
        transcript: str,
        transcript_source: str,
        created_by: str,
        origin: str,
        consent_fields=None,
        design: dict | None = None,
        provenance: Mapping | None = None,
    ) -> CustomVoice:
        now = _now()
        wav = _wav_bytes(ref.audio, ref.rate)
        with self._lock:
            voice_id = next(
                i for i in (f"v_{secrets.token_hex(5)}" for _ in range(100)) if i not in self._voices
            )
            voice = CustomVoice(
                id=voice_id,
                name=name,
                languages=languages,
                gender=gender,
                transcript=transcript,
                transcript_source=transcript_source,
                duration_s=ref.duration_s,
                created_at=now,
                created_by=created_by,
                consent=consent_fields(now, _sha256(wav)) if consent_fields else {},
                origin=origin,
                design=design or {},
            )
            directory = self.root / voice_id
            try:
                self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.chmod(self.root, 0o700)
                directory.mkdir(mode=0o700)
                _atomic_write(directory / "reference.wav", wav)
                _atomic_write(directory / "voice.json", self._json(voice))
            except BaseException:
                shutil.rmtree(directory, ignore_errors=True)
                raise
            self._voices[voice_id] = voice  # visible only once voice.json is safely on disk
        self._audit(
            "create",
            voice,
            provenance,
            audio_sha256=_sha256(wav),
            **({"speaker": voice.consent.get("speaker")} if origin == "recorded" else {}),
        )
        return voice

    @staticmethod
    def _json(voice: CustomVoice) -> bytes:
        return json.dumps(voice.to_dict(), ensure_ascii=False, indent=2).encode("utf-8")

    def update(
        self,
        voice_id: str,
        *,
        name: object = None,
        languages: object = None,
        gender: object = None,
        transcript: object = None,
    ) -> CustomVoice:
        self._check_id(voice_id)
        changes: dict = {}
        if name is not None:
            changes["name"] = _name(name)
        if languages is not None:
            langs = _languages(languages)
            if not langs:
                raise VoiceError("invalid_field", "languages must not be empty", "languages")
            changes["languages"] = langs
        if gender is not None:
            changes["gender"] = _gender(gender)
        if transcript is not None:
            text = _transcript(transcript)
            if not text:
                raise VoiceError("invalid_field", "transcript must not be empty", "transcript")
            changes["transcript"] = text
            changes["transcript_source"] = "given"
        with self._lock:
            current = self._voices.get(voice_id)
            if current is None:
                raise UnknownVoiceError(f"voice '{voice_id}' not found")
            data = {
                **current.to_dict(),
                **{k: (list(v) if k == "languages" else v) for k, v in changes.items()},
            }
            updated = CustomVoice.from_dict(data)
            _atomic_write(self.root / voice_id / "voice.json", self._json(updated))
            self._voices[voice_id] = updated
            self._cache.pop(voice_id, None)  # engines re-analyse the voice with the new transcript
        return updated

    def delete(self, voice_id: str, provenance: Mapping | None = None) -> None:
        self._check_id(voice_id)
        with self._lock:
            if voice_id not in self._voices:
                raise UnknownVoiceError(f"voice '{voice_id}' not found")
            gone = self._voices[voice_id]
            directory = self.root / voice_id
            trash = self.root / f"{TRASH_PREFIX}{voice_id}-{secrets.token_hex(4)}"
            try:
                os.replace(directory, trash)  # atomic: the voice is gone or fully there, never half-deleted
            except FileNotFoundError:
                trash = None
            except OSError:
                log.warning("could not delete voice %s", voice_id, exc_info=True)
                raise
            del self._voices[voice_id]
            self._cache.pop(voice_id, None)
            if trash is not None:
                self._remove(trash)  # a failure leaves a .trash- directory that the next start cleans up
        self._audit("delete", gone, provenance, audio_sha256=gone.consent.get("audio_sha256"))

    def _audit(self, event: str, voice: CustomVoice, provenance: Mapping | None, **extra) -> None:
        """Append one JSON line to the audit log (0600). A failure is logged, not raised: the voice change it
        describes has already happened and must not be reported as failed."""
        if self._audit_path is None:
            return
        record = {
            "time": _now(),
            "event": event,
            "voice_id": voice.id,
            "name": voice.name,
            "origin": voice.origin,
            **{k: v for k, v in extra.items() if v},
            **_provenance(provenance),
        }
        line = (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")
        try:
            with self._audit_lock:
                self._audit_path.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(self._audit_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
                try:
                    os.fchmod(fd, 0o600)  # an older or hand-made file may be looser
                    os.write(fd, line)
                finally:
                    os.close(fd)
        except OSError:
            log.exception("could not write the voice audit log %s (%s a voice)", self._audit_path, event)
