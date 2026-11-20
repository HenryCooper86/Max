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
