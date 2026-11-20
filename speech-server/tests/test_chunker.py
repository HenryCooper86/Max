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


EARLY_CASES = [
    # no break before the sentence end: the normal first sentence
    (
        "Sure, I can help with that. It takes a minute.",
        ["Sure, I can help with that.", "It takes a minute."],
    ),
    ("Okay then, let us go. We can leave now.", ["Okay then, let us go.", "We can leave now."]),
    ("One two three four five six seven.", ["One two three four five six seven."]),
    # long sentence cut at the first comma with 3+ words before it
    (
        "If you ask me, we should leave now because it is late. Go.",
        ["If you ask me,", "we should leave now because it is late.", "Go."],
    ),
    (
        "Well, if you want to know, it takes a minute.",
        ["Well, if you want to know,", "it takes a minute."],
    ),
    ("Here is the list: apples and pears.", ["Here is the list:", "apples and pears."]),
    ("I really think—maybe—we should go now.", ["I really think—", "maybe—we should go now."]),
    # only the first chunk is cut early
    (
        "If you ask me, we leave. And then we go, because it is late.",
        ["If you ask me,", "we leave.", "And then we go, because it is late."],
    ),
    # long sentence cut by the word limit, at the last word boundary
    (
        "We should leave now because the weather is turning bad quickly.",
        ["We should leave now because the", "weather is turning bad quickly."],
    ),
    ("One two three four five six seven eight.", ["One two three four five six", "seven eight."]),
    # a comma inside a number or URL is not a break
    ("It costs 1,000 yes.", ["It costs 1,000 yes."]),
    ("It is 12:30 now, so go.", ["It is 12:30 now,", "so go."]),
    ("Meet me at 12:30 sharp.", ["Meet me at 12:30 sharp."]),
    (
        "Please open https://example.com/a,b,c today if you can, thanks.",
        ["Please open https://example.com/a,b,c today if you", "can, thanks."],
    ),
    (
        "The price is 1,000 dollars for this item today.",
        ["The price is 1,000 dollars for", "this item today."],
    ),
    # Chinese
    ("今天天气真不错，我们一起去公园玩吧。", ["今天天气真不错，", "我们一起去公园玩吧。"]),
    ("你好，今天天气不错。", ["你好，今天天气不错。"]),
    ("我们今天下午一起去公园。", ["我们今天下午一起去公园。"]),
    (
        "我们今天下午一起去公园里面玩耍然后回家吃饭。",
        ["我们今天下午一起去公", "园里面玩耍然后回家吃饭。"],
    ),
    ("我们今天下午一起去公园里面。你好。", ["我们今天下午一起去公", "园里面。", "你好。"]),
    ("", []),
]


def _early(**kw):
    return SentenceChunker(early_first_chunk=True, **kw)


@pytest.mark.parametrize("text,expected", EARLY_CASES)
def test_early_first_chunk_whole_text(text, expected):
    c = _early()
    assert c.push(text) + c.flush() == expected


@pytest.mark.parametrize("size", [1, 2, 3, 5, 7])
@pytest.mark.parametrize("text,expected", EARLY_CASES)
def test_early_first_chunk_streaming_matches(text, expected, size):
    c = _early()
    out = []
    for i in range(0, len(text), size):
        out += c.push(text[i : i + size])
    out += c.flush()
    assert out == expected


def test_early_default_off_keeps_sentence_chunking():
    text = "If you ask me, we should leave now because it is late."
    c = SentenceChunker()
    assert c.push(text) + c.flush() == [text]


def test_early_comma_cut_is_decided_as_soon_as_possible():
    c = _early()
    assert c.push("If you ask me") == []
    assert c.push(",") == []  # a digit could still follow ("1,000")
    assert c.push(" we") == ["If you ask me,"]


def test_early_comma_before_digit_holds_then_decides():
    c = _early()
    assert c.push("It costs about 1,") == []
    assert c.push("000 dollars") == []


def test_early_word_limit_cut_streaming():
    c = _early()
    assert c.push("one two three four five six seven") == []
    assert c.push(" eight") == ["one two three four five six"]


def test_early_custom_limits():
    c = _early(first_chunk_max_words=3, first_chunk_max_chars=4)
    assert c.push("a b c d e. ") == ["a b c", "d e."]
    c2 = _early(first_chunk_max_chars=4)
    assert c2.push("你好吗朋友们今天") == ["你好吗朋"]
    assert c2.flush() == ["友们今天"]


def test_reset_makes_next_chunk_first_again():
    c = _early()
    assert c.push("If you ask me, we leave. Then we go, yes. ") == [
        "If you ask me,",
        "we leave.",
        "Then we go, yes.",
    ]
    # without reset the next reply is not "first": no early cut
    assert c.push("I think we should go, then. ") == ["I think we should go, then."]
    c.reset()
    assert c.push("I think we should go, then. ") == ["I think we should go,", "then."]


def test_reset_drops_buffered_text():
    c = _early()
    c.push("half a sen")
    c.reset()
    assert c.flush() == []
