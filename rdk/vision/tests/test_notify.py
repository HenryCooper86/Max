import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from notify import sd_notify


def test_is_a_no_op_outside_systemd():
    assert sd_notify("WATCHDOG=1", env={}) is False


def test_sends_the_state_to_the_notify_socket(tmp_path):
    path = str(tmp_path / "notify.sock")
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as server:
        server.bind(path)
        server.settimeout(2.0)
        assert sd_notify("WATCHDOG=1", env={"NOTIFY_SOCKET": path}) is True
        assert server.recv(64) == b"WATCHDOG=1"


def test_translates_the_abstract_namespace_prefix(tmp_path):
    # systemd passes abstract sockets as "@name"; AF_UNIX wants "\0name".
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as server:
        server.bind("\0max-test-notify")
        server.settimeout(2.0)
        assert sd_notify("READY=1", env={"NOTIFY_SOCKET": "@max-test-notify"}) is True
        assert server.recv(64) == b"READY=1"


def test_swallows_a_missing_socket(tmp_path):
    assert sd_notify("WATCHDOG=1", env={"NOTIFY_SOCKET": str(tmp_path / "gone.sock")}) is False
