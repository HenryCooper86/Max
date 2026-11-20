import pytest

from max_speech.chunker import SentenceChunker, split_sentences

CASES = [
    ("Dr. Smith is here. He waits.", ["Dr. Smith is here.", "He waits."]),
    ("It costs 3.5 dollars.", ["It costs 3.5 dollars."]),
    ("See example.com. Then call.", ["See example.com.", "Then call."]),
    ("你好。今天天气不错！", ["你好。", "今天天气不错！"]),
    ("OK。Next one.", ["OK。", "Next one."]),
    ("Visit example.com/a.b for more. Thanks.", ["Visit example.com/a.b for more.", "Thanks."]),
    ("Mail a.b@c.d now. Done.", ["Mail a.b@c.d now.", "Done."]),
    ("Ask J. Smith about it. Now.", ["Ask J. Smith about it.", "Now."]),
    ("Mrs. Lee and Mr. Wu met Prof. Xu.", ["Mrs. Lee and Mr. Wu met Prof. Xu."]),
    ("Meet at 5 p.m. Tomorrow works.", ["Meet at 5 p.m. Tomorrow works."]),
    ("Cats, dogs, etc. are pets. Yes.", ["Cats, dogs, etc. are pets.", "Yes."]),
    ("Wait... Then he left.", ["Wait...", "Then he left."]),
    ("Wait... then he left.", ["Wait... then he left."]),
    ("Hmm… 然后呢", ["Hmm…", "然后呢"]),
    ("Really?! Yes.", ["Really?!", "Yes."]),
    ("One; two; three", ["One;", "two;", "three"]),
    ("line one\nline two\n\nline three", ["line one", "line two", "line three"]),
    ("", []),
    ("   \n  ", []),
    ("No terminator here", ["No terminator here"]),
    ("Version 2.0 is out. Pi is 3.14159.", ["Version 2.0 is out.", "Pi is 3.14159."]),
    ("你好，世界。How are you? 很好；谢谢！", ["你好，世界。", "How are you?", "很好；", "谢谢！"]),
    ("Ends with Dr.", ["Ends with Dr."]),
    ("Go to www.site.org/x?y=1 please. Ok.", ["Go to www.site.org/x?y=1 please.", "Ok."]),
    ("I said no. Then we left.", ["I said no.", "Then we left."]),
    ("See No. 5 on the list. Ok.", ["See No. 5 on the list.", "Ok."]),
    ("Room no. 12 is free.", ["Room no. 12 is free."]),
    ("Hello.  World.", ["Hello.", "World."]),
]


@pytest.mark.parametrize("text,expected", CASES)
def test_split_sentences(text, expected):
    assert split_sentences(text) == expected


@pytest.mark.parametrize("text,expected", CASES)
def test_streaming_char_by_char_matches(text, expected):
    c = SentenceChunker()
    out = []
    for ch in text:
        out += c.push(ch)
    out += c.flush()
    assert out == expected


def test_streaming_holds_back_undecided_text():
    c = SentenceChunker()
    assert c.push("Dr.") == []
    assert c.push(" Smith") == []
    assert c.push(" is here.") == []
    assert c.push(" He") == ["Dr. Smith is here."]
    assert c.flush() == ["He"]


def test_streaming_holds_after_no_until_next_word():
    c = SentenceChunker()
    assert c.push("I said no. ") == []
    assert c.push("Then") == ["I said no."]
    c2 = SentenceChunker()
    assert c2.push("See No. ") == []
    assert c2.push("5 is here. Ok") == ["See No. 5 is here."]


def test_streaming_holds_url_dot():
    c = SentenceChunker()
    assert c.push("See example.") == []
    assert c.push("com. Then") == ["See example.com."]
    assert c.flush() == ["Then"]


@pytest.mark.parametrize("size", [1, 2, 3, 5, 7])
def test_streaming_any_split_matches(size):
    for text, expected in CASES:
        c = SentenceChunker()
        out = []
        for i in range(0, len(text), size):
            out += c.push(text[i : i + size])
        out += c.flush()
        assert out == expected


def test_flush_resets():
    c = SentenceChunker()
    c.push("abc")
    assert c.flush() == ["abc"]
    assert c.flush() == []
