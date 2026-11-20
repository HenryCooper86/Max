"""Custom (cloned) voices: the on-disk store and the pronunciation lexicon."""

from max_speech.voices.lexicon import Lexicon, LexiconError
from max_speech.voices.store import CustomVoice, ProcessedReference, VoiceError, VoiceStore, is_custom_id

__all__ = [
    "CustomVoice",
    "Lexicon",
    "LexiconError",
    "ProcessedReference",
    "VoiceError",
    "VoiceStore",
    "is_custom_id",
]
