import os
import subprocess
import sys
from pathlib import Path

import pytest

VISION_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(VISION_ROOT))

import service


def test_import_does_not_construct_the_production_runtime(tmp_path):
    gallery_dir = tmp_path / "must-not-exist"
    env = {**os.environ, "MAX_GALLERY_DIR": str(gallery_dir)}
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            f"import sys; sys.path.insert(0, {str(VISION_ROOT)!r}); import service",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert not gallery_dir.exists()
    assert not hasattr(service, "gallery")
    assert not hasattr(service, "cameras")
    assert not hasattr(service, "events")


def test_config_defaults_match_the_production_service():
    assert service.VisionConfig.from_env({}) == service.VisionConfig(
        socket_path="/run/max/vision.sock",
        gallery_dir="/var/lib/max/gallery",
        min_free_mb=1024,
        preview_port=8081,
        corpus_dir="/var/lib/max/corpus",
        adas_shadow=False,
        share_frames=False,
        front_channel=0,
        rear_channel=2,
    )


def test_config_reads_overrides_and_keeps_feature_gates_exact():
    config = service.VisionConfig.from_env(
        {
            "MAX_VISION_SOCKET": "/tmp/max/vision.sock",
            "MAX_GALLERY_DIR": "/tmp/max/gallery",
            "MAX_GALLERY_MIN_FREE_MB": "17",
            "MAX_VISION_PREVIEW_PORT": "9081",
            "MAX_CORPUS_DIR": "/tmp/max/corpus",
            "MAX_ADAS_SHADOW": "1",
            "MAX_VISION_SHARE": "1",
            "RDK_CAMERA_FRONT": "4",
            "RDK_CAMERA_REAR": "6",
        }
    )
    assert config == service.VisionConfig(
        socket_path="/tmp/max/vision.sock",
        gallery_dir="/tmp/max/gallery",
        min_free_mb=17,
        preview_port=9081,
        corpus_dir="/tmp/max/corpus",
        adas_shadow=True,
        share_frames=True,
        front_channel=4,
        rear_channel=6,
    )

    rejected = service.VisionConfig.from_env(
        {"MAX_ADAS_SHADOW": "true", "MAX_VISION_SHARE": "yes"}
    )
    assert rejected.adas_shadow is False
    assert rejected.share_frames is False


@pytest.mark.parametrize(
    "name",
    [
        "MAX_GALLERY_MIN_FREE_MB",
        "MAX_VISION_PREVIEW_PORT",
        "RDK_CAMERA_FRONT",
        "RDK_CAMERA_REAR",
    ],
)
def test_invalid_numeric_config_fails_fast(name):
    with pytest.raises(ValueError):
        service.VisionConfig.from_env({name: "not-a-number"})


def test_runtime_uses_the_supplied_storage_and_camera_config(tmp_path):
    gallery_dir = tmp_path / "gallery"
    runtime = service.build_runtime(
        service.VisionConfig(
            gallery_dir=str(gallery_dir),
            min_free_mb=0,
            front_channel=4,
            rear_channel=6,
        )
    )
    assert gallery_dir.is_dir()
    assert runtime.gallery.root == str(gallery_dir)
    assert runtime.gallery.min_free_mb == 0
    assert runtime.cameras.front_channel == 4
    assert runtime.cameras.rear_channel == 6
    assert set(runtime.handlers) == {"camera.photo", "camera.record"}
