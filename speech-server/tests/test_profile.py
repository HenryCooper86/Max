import sys
import types

import pytest

from max_speech import profile as profile_module
from max_speech.profile import detect_profile, resolve_profile
from max_speech.settings import Settings


@pytest.fixture
def fake_onnxruntime(monkeypatch):
    """Install a fake onnxruntime module; tests set which providers it reports."""
    module = types.ModuleType("onnxruntime")
    module.providers = ["CPUExecutionProvider"]
    module.get_available_providers = lambda: list(module.providers)
    monkeypatch.setitem(sys.modules, "onnxruntime", module)
    return module


@pytest.fixture
def no_ctranslate2(monkeypatch):
    """Make `import ctranslate2` fail, as on a machine without it installed."""
    monkeypatch.setitem(sys.modules, "ctranslate2", None)


def set_platform(monkeypatch, platform: str, machine: str):
    monkeypatch.setattr(profile_module.sys, "platform", platform)
    monkeypatch.setattr(profile_module.platform, "machine", lambda: machine)


def test_cuda_when_onnxruntime_reports_cuda(monkeypatch, fake_onnxruntime, no_ctranslate2):
    fake_onnxruntime.providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    set_platform(monkeypatch, "linux", "x86_64")
    assert detect_profile() == "cuda"


def test_cuda_when_ctranslate2_reports_devices(monkeypatch, fake_onnxruntime):
    fake_onnxruntime.providers = ["CPUExecutionProvider"]
    fake_ct2 = types.ModuleType("ctranslate2")
    fake_ct2.get_cuda_device_count = lambda: 1
    monkeypatch.setitem(sys.modules, "ctranslate2", fake_ct2)
    set_platform(monkeypatch, "linux", "x86_64")
    assert detect_profile() == "cuda"


def test_cuda_probe_failures_are_ignored(monkeypatch, no_ctranslate2):
    broken = types.ModuleType("onnxruntime")

    def explode():
        raise RuntimeError("driver missing")

    broken.get_available_providers = explode
    monkeypatch.setitem(sys.modules, "onnxruntime", broken)
    set_platform(monkeypatch, "linux", "x86_64")
    assert detect_profile() == "cpu"


def test_mlx_on_apple_silicon(monkeypatch, fake_onnxruntime, no_ctranslate2):
    set_platform(monkeypatch, "darwin", "arm64")
    assert detect_profile() == "mlx"


def test_cpu_on_intel_mac(monkeypatch, fake_onnxruntime, no_ctranslate2):
    set_platform(monkeypatch, "darwin", "x86_64")
    assert detect_profile() == "cpu"


def test_cpu_on_linux_without_gpu(monkeypatch, fake_onnxruntime, no_ctranslate2):
    set_platform(monkeypatch, "linux", "x86_64")
    assert detect_profile() == "cpu"


def test_resolve_prefers_explicit_profile(monkeypatch, fake_onnxruntime, no_ctranslate2):
    set_platform(monkeypatch, "darwin", "arm64")
    assert resolve_profile(Settings.from_env({"SPEECH_PROFILE": "cpu"})) == "cpu"


def test_resolve_detects_when_unset(monkeypatch, fake_onnxruntime, no_ctranslate2):
    set_platform(monkeypatch, "darwin", "arm64")
    assert resolve_profile(Settings.from_env({})) == "mlx"
