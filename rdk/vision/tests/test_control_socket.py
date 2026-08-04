import contextlib
import json
import shutil
import socket
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import service


def make_runtime(tmp_path, name="runtime"):
    runtime = service.build_runtime(
        service.VisionConfig(
            gallery_dir=str(tmp_path / name / "gallery"),
            min_free_mb=0,
        )
    )
    runtime.handlers = {
        "camera.photo": lambda args: {"status": "ok", "detail": "injected-handler-ran"}
    }
    return runtime


def make_socket_dir():
    """Keep Unix socket paths short on every supported test platform."""
    return Path(tempfile.mkdtemp(prefix="vision-", dir="/tmp"))


def test_concurrent_writes_do_not_interleave(tmp_path):
    """RPC responses and hazard broadcasts share one wfile; every line must
    still parse alone."""
    socket_dir = make_socket_dir()
    sock_path = str(socket_dir / "ctl.sock")
    runtime = make_runtime(tmp_path)
    handler_registered = threading.Event()
    handler_finished = threading.Event()
    register = runtime.events.register
    unregister = runtime.events.unregister

    def register_and_signal(write):
        register(write)
        handler_registered.set()

    def unregister_and_signal(write):
        unregister(write)
        handler_finished.set()

    runtime.events.register = register_and_signal
    runtime.events.unregister = unregister_and_signal
    server = service.ControlServer(sock_path, service.ControlHandler, runtime)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    client = None
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(sock_path)
        client.settimeout(5.0)
        assert handler_registered.wait(timeout=5.0)

        def hammer():
            for i in range(200):
                runtime.events.broadcast({"event": "hazard", "threat": f"t{i}"})

        threads = [threading.Thread(target=hammer) for _ in range(4)]
        for thread in threads:
            thread.start()
        for i in range(50):
            client.sendall(
                (json.dumps({"id": str(i), "op": "camera.photo", "args": {}}) + "\n").encode()
            )
        for thread in threads:
            thread.join(timeout=5.0)

        received = b""
        client.settimeout(1.0)
        try:
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    break
                received += chunk
        except socket.timeout:
            pass

        lines = [line for line in received.decode("utf-8").split("\n") if line]
        assert len(lines) >= 50
        parsed = [json.loads(line) for line in lines]  # raises if two writes interleaved mid-line
        rpc_responses = [message for message in parsed if "id" in message]
        hazard_events = [message for message in parsed if message.get("event") == "hazard"]
        assert len(rpc_responses) == 50
        assert {response["id"] for response in rpc_responses} == {str(i) for i in range(50)}
        assert all(response["status"] == "ok" for response in rpc_responses)
        assert all(response["detail"] == "injected-handler-ran" for response in rpc_responses)
        assert len(hazard_events) > 0
    finally:
        if client is not None:
            with contextlib.suppress(OSError):
                client.shutdown(socket.SHUT_RDWR)
            client.close()
            assert handler_finished.wait(timeout=5.0)
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5.0)
        assert not server_thread.is_alive()
        shutil.rmtree(socket_dir)


def test_control_servers_own_separate_runtime_state(tmp_path):
    first_runtime = make_runtime(tmp_path, "first")
    second_runtime = make_runtime(tmp_path, "second")
    socket_dir = make_socket_dir()
    first = service.ControlServer(
        str(socket_dir / "first.sock"), service.ControlHandler, first_runtime
    )
    second = service.ControlServer(
        str(socket_dir / "second.sock"), service.ControlHandler, second_runtime
    )
    try:
        assert first.runtime is first_runtime
        assert second.runtime is second_runtime
        assert first.runtime.events is not second.runtime.events
        assert first.runtime.handlers is not second.runtime.handlers
    finally:
        first.server_close()
        second.server_close()
        shutil.rmtree(socket_dir)


class FakeRecordingPair:
    def __init__(self):
        self.recording_id = "pair-1"
        self.stopped_with = None
        self.front = None
        self.rear = None

    def stop_recording(self, gallery):
        self.stopped_with = gallery
        self.recording_id = None
        return {"status": "ok"}


class FakeRide:
    def __init__(self):
        self.stopped = False

    def stop(self):
        self.stopped = True


def test_finalize_finishes_a_live_recording_and_stops_the_ride():
    pair = FakeRecordingPair()
    ride = FakeRide()
    sentinel_gallery = object()
    service.finalize(pair, sentinel_gallery, ride)
    assert pair.stopped_with is sentinel_gallery
    assert ride.stopped is True


def test_finalize_tolerates_no_recording_and_no_ride():
    pair = FakeRecordingPair()
    pair.recording_id = None
    service.finalize(pair, object(), None)
    assert pair.stopped_with is None
