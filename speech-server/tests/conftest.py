import pytest


@pytest.fixture
def clean_env(monkeypatch):
    """Drop every SPEECH_* variable so tests see only what they set."""
    import os

    for key in list(os.environ):
        if key.startswith("SPEECH_"):
            monkeypatch.delenv(key, raising=False)
    return monkeypatch


@pytest.fixture
def make_app():
    from max_speech.app import create_app
    from max_speech.engines.fake import FakeStt, FakeTts
    from max_speech.settings import Settings

    def build(settings=None, **kw):
        kw.setdefault("stt", FakeStt())
        kw.setdefault("tts", FakeTts())
        kw.setdefault("profile", "cpu")
        return create_app(settings or Settings(), **kw)

    return build
