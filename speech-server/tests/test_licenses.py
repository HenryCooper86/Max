import importlib.resources

import pytest

from max_speech.licenses import (
    ALLOWED_WEIGHTS_LICENSES,
    LicenseError,
    RegistryError,
    load_registry,
    require,
)

SHA = "a" * 40
DIGEST = "b" * 64

HF_OK = f"""
[models.m]
kind = "stt"
source = "hf"
repo = "x/y"
revision = "{SHA}"
weights_license = "MIT"
code_license = "MIT"
license_url = "https://example.com"
checked = "2026-11-20"
attribution = "x"
"""

URL_OK = f"""
[models.m]
kind = "tts"
source = "url"
files = [{{ url = "https://example.com/a.bin", sha256 = "{DIGEST}" }}]
weights_license = "Apache-2.0"
code_license = "MIT"
license_url = "https://example.com"
checked = "2026-11-20"
attribution = "x"
"""


def test_shipped_registry_loads_and_every_entry_passes_require():
    text = (importlib.resources.files("max_speech.licenses") / "registry.toml").read_text()
    assert text
    registry = load_registry()
    assert {"kokoro-v1.0", "faster-whisper-small"} <= set(registry)
    for model_id, entry in registry.items():
        assert require(model_id, entry.kind, registry=registry) is entry
        assert entry.weights_license in ALLOWED_WEIGHTS_LICENSES


def test_valid_fixtures_parse():
    assert load_registry(HF_OK)["m"].revision == SHA
    assert load_registry(URL_OK)["m"].files[0].sha256 == DIGEST


@pytest.mark.parametrize(
    "text, field",
    [
        (HF_OK.replace('kind = "stt"', 'kind = "music"'), "kind"),
        (HF_OK.replace('repo = "x/y"\n', ""), "repo"),
        (HF_OK.replace(SHA, "abc123"), "revision"),
        (HF_OK.replace(SHA, "g" * 40), "revision"),
        (URL_OK.replace(DIGEST, "abc"), "sha256"),
        (URL_OK.replace(f', sha256 = "{DIGEST}"', ""), "sha256"),
        (
            URL_OK.replace(
                'files = [{ url = "https://example.com/a.bin", sha256 = "' + DIGEST + '" }]', "files = []"
            ),
            "files",
        ),
        (HF_OK.replace("2026-11-20", "yesterday"), "checked"),
        (HF_OK.replace('source = "hf"', 'source = "ftp"'), "source"),
    ],
)
def test_bad_registry_raises_naming_model_and_field(text, field):
    with pytest.raises(RegistryError) as exc:
        load_registry(text)
    assert "m" in str(exc.value)
    assert field in str(exc.value)


def test_non_commercial_license_refused():
    registry_text = HF_OK.replace('weights_license = "MIT"', 'weights_license = "CC-BY-NC-4.0"')
    with pytest.raises(LicenseError, match="CC-BY-NC-4.0"):
        require("m", "stt", registry=load_registry(registry_text))


def test_unknown_id_refused_with_exact_message():
    with pytest.raises(LicenseError) as exc:
        require("nope", "stt")
    assert str(exc.value) == (
        "nope is not in the license registry; add it to licenses/registry.toml after reading its license"
    )


def test_wrong_kind_refused():
    with pytest.raises(LicenseError, match="tts"):
        require("faster-whisper-small", "tts")


def test_shipped_registry_has_the_m2_models():
    registry = load_registry()
    assert registry["silero-vad-v6.2"].kind == "vad"
    assert registry["smart-turn-v3.2"].kind == "turn"
    x = registry["x-asr-zh-en-480ms"]
    assert (x.kind, x.archive) == ("stt", "tar.bz2")
    assert x.files[0].sha256.startswith("fa5f63d6") and x.files[0].sha256.endswith("bf74")
    p = registry["paraformer-zh-en-streaming"]
    assert p.source == "hf" and len(p.revision) == 40
    assert set(p.allow_patterns) == {"encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"}
    for model_id, kind in [("silero-vad-v6.2", "vad"), ("smart-turn-v3.2", "turn")]:
        require(model_id, kind, registry=registry)


def test_archive_and_allow_patterns_parse():
    arch = load_registry(URL_OK.replace('source = "url"', 'source = "url"\narchive = "tar.bz2"'))["m"]
    assert arch.archive == "tar.bz2"
    pats = load_registry(HF_OK.replace('repo = "x/y"', 'repo = "x/y"\nallow_patterns = ["a.onnx"]'))["m"]
    assert pats.allow_patterns == ("a.onnx",)


@pytest.mark.parametrize(
    "text",
    [
        URL_OK.replace('source = "url"', 'source = "url"\narchive = "zip"'),
        HF_OK.replace('source = "hf"', 'source = "hf"\narchive = "tar.bz2"'),
        URL_OK.replace("files = [", f'files = [{{ url = "https://e.com/b", sha256 = "{DIGEST}" }}, ').replace(
            'source = "url"', 'source = "url"\narchive = "tar.bz2"'
        ),
        URL_OK.replace('source = "url"', 'source = "url"\nallow_patterns = ["a"]'),
        HF_OK.replace('repo = "x/y"', 'repo = "x/y"\nallow_patterns = "a"'),
    ],
)
def test_bad_archive_or_patterns_rejected(text):
    with pytest.raises(RegistryError):
        load_registry(text)


def test_streaming_flag_is_parsed_and_only_for_stt():
    assert load_registry(HF_OK)["m"].streaming is False
    assert (
        load_registry(HF_OK.replace('kind = "stt"', 'kind = "stt"\nstreaming = true'))["m"].streaming is True
    )
    with pytest.raises(RegistryError, match="streaming"):
        load_registry(URL_OK.replace('kind = "tts"', 'kind = "tts"\nstreaming = true'))
    with pytest.raises(RegistryError, match="streaming"):
        load_registry(HF_OK.replace('kind = "stt"', 'kind = "stt"\nstreaming = "yes"'))


def test_the_shipped_streaming_models_are_flagged():
    registry = load_registry()
    assert {m.id for m in registry.values() if m.streaming} == {
        "x-asr-zh-en-480ms",
        "paraformer-zh-en-streaming",
    }


def _two(a_extra: str = "", b_extra: str = "") -> str:
    base = HF_OK.replace('kind = "stt"', 'kind = "tts"')
    a = base.replace("[models.m]", f"[models.a]\n{a_extra}")
    b = base.replace("[models.m]", f"[models.b]\n{b_extra}")
    return a + b


def test_cloning_and_requires_parse():
    reg = load_registry(_two('cloning = true\nrequires = ["b"]'))
    assert reg["a"].cloning and reg["a"].requires == ("b",)
    assert not reg["b"].cloning and reg["b"].requires == ()


@pytest.mark.parametrize(
    "text",
    [
        HF_OK.replace('source = "hf"', 'source = "hf"\ncloning = true'),  # stt cannot clone
        _two("cloning = 1"),
        _two('requires = "b"'),
        _two('requires = ["nope"]'),
        _two('requires = ["b"]', 'requires = ["a"]'),  # cycle
        _two('requires = ["a"]'),  # self cycle
    ],
)
def test_bad_cloning_or_requires_rejected(text):
    with pytest.raises(RegistryError):
        load_registry(text)


def test_companions_are_resolved_recursively_and_license_checked():
    reg = load_registry(_two('requires = ["b"]'))
    from max_speech.licenses import companions

    assert [e.id for e in companions(reg["a"], reg)] == ["b"]
    nc = _two('requires = ["b"]')
    head, tail = nc.split("[models.b]")
    nc = head + "[models.b]" + tail.replace('weights_license = "MIT"', 'weights_license = "CC-BY-NC-4.0"')
    reg_nc = load_registry(nc)
    with pytest.raises(LicenseError, match="CC-BY-NC-4.0"):
        companions(reg_nc["a"], reg_nc)


def test_shipped_registry_has_the_cloning_models():
    from max_speech.licenses import companions

    reg = load_registry()
    for model_id in ("qwen3-tts-0.6b-mlx", "qwen3-tts-1.7b-mlx", "moss-tts-nano-onnx"):
        assert reg[model_id].cloning and reg[model_id].kind == "tts"
        require(model_id, "tts", registry=reg)
    assert reg["qwen3-tts-0.6b-mlx"].revision == "1eccf1cb2519b5a4e8a95b5f0544f3303568164f"
    assert [e.id for e in companions(reg["moss-tts-nano-onnx"], reg)] == ["moss-audio-tokenizer-nano-onnx"]
    assert not reg["moss-audio-tokenizer-nano-onnx"].cloning
