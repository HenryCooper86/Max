import shutil
import socket
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import notify

from notify import sd_notify


def make_socket_dir():
    """Keep filesystem socket paths short on every supported test platform."""
    return Path(tempfile.mkdtemp(prefix="notify-", dir="/tmp"))


def test_is_a_no_op_outside_systemd():
    assert sd_notify("WATCHDOG=1", env={}) is False


def test_sends_the_state_to_the_notify_socket():
    socket_dir = make_socket_dir()
    path = str(socket_dir / "notify.sock")
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as server:
            server.bind(path)
            server.settimeout(2.0)
            assert sd_notify("WATCHDOG=1", env={"NOTIFY_SOCKET": path}) is True
            assert server.recv(64) == b"WATCHDOG=1"
    finally:
        shutil.rmtree(socket_dir)


def test_translates_the_abstract_namespace_prefix_and_sends_its_payload(monkeypatch):
    # systemd passes the abstract namespace as "@name"; AF_UNIX wants "\0name".
    class FakeSocket:
        connected = None
        sent = None

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def connect(self, path):
            self.connected = path

        def sendall(self, payload):
            self.sent = payload

    fake = FakeSocket()
    monkeypatch.setattr(notify.socket, "socket", lambda *args: fake)

    assert sd_notify("READY=1", env={"NOTIFY_SOCKET": "@max-test-notify"}) is True
    assert fake.connected == "\0max-test-notify"
    assert fake.sent == b"READY=1"


def test_swallows_a_missing_socket(tmp_path):
    assert sd_notify("WATCHDOG=1", env={"NOTIFY_SOCKET": str(tmp_path / "gone.sock")}) is False
