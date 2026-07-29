import json
import socket
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import service


def test_concurrent_writes_do_not_interleave(tmp_path):
    """RPC responses and hazard broadcasts share one wfile; every line must
    still parse alone."""
    sock_path = str(tmp_path / "ctl.sock")
    server = service.ControlServer(sock_path, service.ControlHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(sock_path)
        client.settimeout(5.0)

        hammer_done = threading.Event()

        def hammer():
            for i in range(200):
                service.events.broadcast({"event": "hazard", "threat": f"t{i}"})
            hammer_done.set()

        threads = [threading.Thread(target=hammer) for _ in range(4)]
        for thread in threads:
            thread.start()
        for i in range(50):
            client.sendall(
                (json.dumps({"id": i, "method": "camera.photo", "args": {}}) + "\n").encode()
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
        for line in lines:
            json.loads(line)  # raises if two writes interleaved mid-line
    finally:
        server.shutdown()


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
