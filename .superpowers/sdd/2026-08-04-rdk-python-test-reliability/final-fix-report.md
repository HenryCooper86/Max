# Final review fix — control socket test reliability

## Changes

- Added a test-local `threading.Event` that is set only after the real
  `EventBus.register()` call returns. The concurrent hazard broadcasters wait
  on it before starting, so they cannot complete before the control handler is
  eligible to receive their events.
- Updated the concurrent requests from the obsolete `method` field to the
  protocol's `op: "camera.photo"` field.
- Made the injected `camera.photo` handler return the distinctive successful
  detail `"injected-handler-ran"`. The test verifies all 50 RPC responses are
  successful and carry that detail, as well as verifying the complete request
  id set.
- Preserved the existing NDJSON parsing/concurrent-write coverage and the
  client-close, handler-unregister, server-shutdown teardown path.

## Files

- Modified: `rdk/vision/tests/test_control_socket.py`
- Added: this report.

No production code or design/plan document was modified.

## RED/GREEN evidence

### RED

The strengthened RPC assertions were first run while the requests still used
`"method": "camera.photo"`. In the sandbox, this test could not reach those
assertions because AF_UNIX socket binding is disallowed:

```text
PATH="$PWD/.venv/bin:$PATH" perl -e 'alarm 60; exec @ARGV' .venv/bin/python -m pytest -c rdk/vision/pytest.ini --strict-markers rdk/vision/tests/test_control_socket.py -q
2 failed, 2 passed in 0.04s
PermissionError: [Errno 1] Operation not permitted
```

The protocol mismatch is independently direct: `rpc.dispatch()` selects
handlers with `message.get("op", "")`, so the prior `method` requests would
return `unsupported`, not the injected successful result. The subsequent
outside-sandbox invocation that would have provided the behavioral RED result
was interrupted before it returned output.

### GREEN

The final test-only change passed the requested bounded focused suite outside
the socket sandbox. Complete output was captured in
`/tmp/rdk-final-fix-focused.log`:

```text
PATH="$PWD/.venv/bin:$PATH" perl -e 'alarm 60; exec @ARGV' .venv/bin/python -m pytest -c rdk/vision/pytest.ini --strict-markers rdk/vision/tests/test_control_socket.py rdk/vision/tests/test_service_runtime.py rdk/vision/tests/test_notify.py -q 2>&1 | tee /tmp/rdk-final-fix-focused.log
................                                                         [100%]
16 passed in 16.09s
```

`git diff --check` also exited 0.

## Self-review

- Registration signalling wraps the real event-bus method and is awaited after
  connection, before any broadcaster thread starts; it uses no sleep.
- The success assertions catch both a wrong dispatch key and an unsupported or
  otherwise non-injected handler result.
- Response-id coverage remains exact, and event parsing continues to prove
  that shared concurrent writes remain valid NDJSON.
- Teardown still shuts down/closes the client, waits for unregister, shuts
  down/closes the server, joins its thread, and removes the temporary socket
  directory.
- The final diff is test-only apart from this required report.

## Concerns

- The full shared Python gate was intentionally not rerun: the final-review
  direction treats the recorded focused 16/16 run as sufficient coverage
  evidence and explicitly prohibits another shared-gate run.
- The functional RED command was prevented by this environment's socket
  sandbox; the final outside-sandbox GREEN command is the authoritative test
  result.
