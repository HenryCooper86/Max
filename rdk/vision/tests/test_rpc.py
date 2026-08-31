import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rpc import decode_lines, dispatch, encode_event, encode_response


def test_decode_lines_returns_whole_messages_and_remainder():
    messages, rest = decode_lines('{"id":"a","op":"ping","args":{}}\n{"id":"b"')
    assert messages == [{"id": "a", "op": "ping", "args": {}}]
    assert rest == '{"id":"b"'


def test_decode_lines_skips_malformed_lines():
    messages, rest = decode_lines('garbage\n{"id":"a"}\n')
    assert messages == [{"id": "a"}]
    assert rest == ""


def test_encode_response_is_one_newline_terminated_object():
    line = encode_response("c7", "ok", detail="pair-1")
    assert line.endswith("\n")
    assert json.loads(line) == {"id": "c7", "status": "ok", "detail": "pair-1"}


def test_encode_response_omits_empty_fields():
    assert json.loads(encode_response("c7", "ok")) == {"id": "c7", "status": "ok"}


def test_encode_event_has_no_id():
    payload = json.loads(encode_event("hazard", threat="rear_approach"))
    assert payload == {"event": "hazard", "threat": "rear_approach"}
    assert "id" not in payload


def test_dispatch_routes_to_the_handler():
    handlers = {"camera.photo": lambda args: {"status": "ok", "detail": "pair-1"}}
    line = dispatch({"id": "c1", "op": "camera.photo", "args": {}}, handlers)
    assert json.loads(line) == {"id": "c1", "status": "ok", "detail": "pair-1"}


def test_dispatch_reports_an_unknown_op_as_unsupported():
    line = dispatch({"id": "c2", "op": "nope", "args": {}}, {})
    assert json.loads(line)["status"] == "unsupported"


def test_dispatch_converts_a_raised_handler_into_a_failure():
    def boom(args):
        raise RuntimeError("camera exploded")

    line = dispatch({"id": "c3", "op": "camera.photo", "args": {}}, {"camera.photo": boom})
    payload = json.loads(line)
    assert payload["status"] == "failed"
    assert payload["reason"] == "capture.failed"


def test_dispatch_ignores_a_message_with_no_id():
    assert dispatch({"op": "camera.photo", "args": {}}, {}) == ""
