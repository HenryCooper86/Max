import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from recorder.metadata import FrameMeta, MetadataWriter, read_metadata


def test_append_writes_one_json_object_per_line(tmp_path):
    path = tmp_path / "seg.jsonl"
    with MetadataWriter(path) as w:
        w.append(FrameMeta(frame_index=0, mono_ns=1_000, wall_ms=1700, camera="front"))
        w.append(FrameMeta(frame_index=1, mono_ns=101_000, wall_ms=1800, camera="front"))
    lines = path.read_text(encoding="utf-8").strip().split("\n")
    assert len(lines) == 2
    assert json.loads(lines[0])["frame_index"] == 0
    assert json.loads(lines[1])["mono_ns"] == 101_000


def test_round_trips_through_read_metadata(tmp_path):
    path = tmp_path / "seg.jsonl"
    original = [FrameMeta(frame_index=i, mono_ns=i * 100_000, wall_ms=1700 + i, camera="rear") for i in range(5)]
    with MetadataWriter(path) as w:
        for meta in original:
            w.append(meta)
    assert read_metadata(path) == original


def test_flushes_each_record_so_power_loss_keeps_what_was_written(tmp_path):
    # Recording must survive power loss: a buffered writer would lose the ride.
    path = tmp_path / "seg.jsonl"
    w = MetadataWriter(path)
    w.append(FrameMeta(frame_index=0, mono_ns=0, wall_ms=1700, camera="front"))
    assert path.read_text(encoding="utf-8").count("\n") == 1
    w.close()


def test_read_metadata_skips_a_torn_final_line(tmp_path):
    # Exactly what an abrupt power cut leaves behind.
    path = tmp_path / "seg.jsonl"
    path.write_text('{"frame_index":0,"mono_ns":0,"wall_ms":1,"camera":"front"}\n{"frame_ind', encoding="utf-8")
    metas = read_metadata(path)
    assert len(metas) == 1
    assert metas[0].frame_index == 0


def test_read_metadata_on_missing_file_is_empty(tmp_path):
    assert read_metadata(tmp_path / "nope.jsonl") == []
