import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adas.catalog import CATALOG
from tools.render_alerts import RATE, render, wav_bytes


def test_wav_header_declares_mono_24k_pcm16():
    # alert-player.ts rejects anything else, because playback.write consumes
    # 24 kHz and a 16 kHz clip would play half again too slow.
    data = wav_bytes(b"\x00\x00" * 480)
    assert data[:4] == b"RIFF" and data[8:12] == b"WAVE"
    assert struct.unpack("<H", data[22:24])[0] == 1  # channels
    assert struct.unpack("<I", data[24:28])[0] == RATE
    assert struct.unpack("<H", data[34:36])[0] == 16  # bits


def test_the_declared_data_length_matches_the_payload():
    # A wrong length here plays silence or garbage past the end of the clip.
    pcm = b"\x01\x00" * 300
    data = wav_bytes(pcm)
    assert struct.unpack("<I", data[40:44])[0] == len(pcm)
    assert len(data) == 44 + len(pcm)


def test_renders_one_clip_per_catalog_entry(tmp_path):
    def synth(text: str) -> bytes:
        return b"\x01\x00" * 240

    paths = render(synth, tmp_path)
    assert len(paths) == len(CATALOG)
    assert {p.stem for p in paths} == set(CATALOG)
    assert all(p.exists() and p.stat().st_size > 44 for p in paths)


def test_it_speaks_the_catalog_message_verbatim(tmp_path):
    # The rider learns one fixed sound. Paraphrasing between renders defeats
    # the entire reason for pre-rendering rather than synthesising live.
    spoken: list[str] = []

    def synth(text: str) -> bytes:
        spoken.append(text)
        return b"\x00\x00" * 240

    render(synth, tmp_path)
    for entry in CATALOG.values():
        assert entry["message"] in spoken


def test_filenames_match_the_threat_ids_the_player_looks_up(tmp_path):
    # alert-player.ts opens `${threat}.wav`; a mismatch is silent failure.
    paths = render(lambda _: b"\x00\x00" * 240, tmp_path)
    assert (tmp_path / "forward_collision.wav") in paths
