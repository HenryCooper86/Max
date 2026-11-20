import json
import os
import stat

import pytest

from max_speech.voices.lexicon import MAX_ENTRIES, Lexicon, LexiconError


def lex(entries):
    lexicon = Lexicon()
    lexicon.replace(entries)
    return lexicon


def test_empty_lexicon_changes_nothing():
    assert Lexicon().apply("Hello Dr Smith") == "Hello Dr Smith"


def test_whole_words_only_and_case_insensitive():
    lexicon = lex({"MAX": "Max", "Dr": "Doctor"})
    assert lexicon.apply("max and MAX and Max") == "Max and Max and Max"
    assert lexicon.apply("Dr Smith, dr. Jones") == "Doctor Smith, Doctor. Jones"
    assert lexicon.apply("maximum drum Android") == "maximum drum Android"


def test_hyphens_digits_and_apostrophes_stay_inside_words():
    lexicon = lex({"cat": "dog", "GIF": "jiff"})
    assert lexicon.apply("cat-like cat2 cat's") == "cat-like cat2 cat's"
    assert lexicon.apply("a GIF, the gif.") == "a jiff, the jiff."
    assert lex({"don't": "do not"}).apply("I don't know") == "I do not know"


def test_longest_key_wins():
    lexicon = lex({"Dr": "Doctor", "Dr.": "Drive", "New York": "NY", "York": "Yorkshire"})
    assert lexicon.apply("Dr. Who lives on Elm Dr.") == "Drive Who lives on Elm Drive"
    assert lexicon.apply("New York and York") == "NY and Yorkshire"


def test_cjk_keys_match_as_substrings():
    lexicon = lex({"重庆": "Chóngqìng", "行": "xíng"})
    assert lexicon.apply("我在重庆，可以。很行") == "我在Chóngqìng，可以。很xíng"
    assert lexicon.apply("abc") == "abc"


def test_replacements_are_not_rescanned():
    assert lex({"a": "b", "b": "a"}).apply("a b") == "b a"


def test_special_characters_in_keys_are_literal():
    assert lex({"C++": "see plus plus"}).apply("I like C++ a lot") == "I like see plus plus a lot"
    assert lex({"a.b": "x"}).apply("a.b axb") == "x axb"


@pytest.mark.parametrize(
    "entries",
    [
        {f"k{i}": "v" for i in range(MAX_ENTRIES + 1)},
        {"k" * 65: "v"},
        {"k": "v" * 129},
        {"": "v"},
        {" k": "v"},
        {"k": "line\nbreak"},
        {"Max": "a", "max": "b"},
        {"k": 3},
        ["not", "a", "dict"],
    ],
)
def test_limits_and_shape_are_enforced(entries):
    lexicon = Lexicon()
    with pytest.raises(LexiconError):
        lexicon.replace(entries)
    assert lexicon.entries == {}


def test_limits_at_the_boundary_are_accepted():
    lex({f"k{i}": "v" for i in range(MAX_ENTRIES)})
    lex({"k" * 64: "v" * 128})


def test_persists_atomically_and_reloads(tmp_path):
    path = tmp_path / "data" / "lexicon.json"
    lexicon = Lexicon(path)
    lexicon.replace({"MAX": "Max"})
    assert json.loads(path.read_text()) == {"entries": {"MAX": "Max"}}
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert [p.name for p in path.parent.iterdir()] == ["lexicon.json"]  # no temp files left behind
    assert Lexicon(path).apply("max") == "Max"


def test_failed_replace_keeps_the_old_entries(tmp_path):
    lexicon = Lexicon(tmp_path / "lexicon.json")
    lexicon.replace({"a": "b"})
    with pytest.raises(LexiconError):
        lexicon.replace({"a": "x" * 500})
    assert lexicon.entries == {"a": "b"}
    assert Lexicon(tmp_path / "lexicon.json").entries == {"a": "b"}


def test_corrupt_file_starts_empty(tmp_path):
    path = tmp_path / "lexicon.json"
    path.write_text("{not json")
    assert Lexicon(path).entries == {}


def test_latin_keys_match_next_to_cjk():
    lexicon = lex({"GIF": "jiff"})
    assert lexicon.apply("我喜欢GIF图片") == "我喜欢jiff图片"
    assert lexicon.apply("GIF图") == "jiff图"
    assert lexicon.apply("看GIF，好") == "看jiff，好"
    assert lexicon.apply("これはGIFです") == "これはjiffです"
    assert lexicon.apply("나는GIF를 좋아해") == "나는jiff를 좋아해"


def test_latin_whole_word_rules_hold_beside_cjk():
    lexicon = lex({"GIF": "jiff"})
    assert lexicon.apply("我喜欢GIFs图片") == "我喜欢GIFs图片"
    assert lexicon.apply("gif-like 图") == "gif-like 图"
    assert lexicon.apply("图GIF2") == "图GIF2"
