# Post-review fix — concurrent control-socket draining

## Root cause

`test_concurrent_writes_do_not_interleave` started four producers, then waited
up to five seconds on each producer before reading the socket. The socket
writers can block on backpressure, so the reader needed to run while the
producers write. The reported 21.04-second duration matches the four
sequential five-second joins.

## Minimal test-lifecycle change

- Start a non-daemon drain thread after the control handler is registered and
  before starting hazard broadcasters.
- The reader collects the exact 850 expected NDJSON messages (50 injected RPC
  results and 800 hazard events), preserving the prior registration and
  injected-handler assertions.
- Join each broadcaster with a one-second bound and assert every producer has
  terminated. This is the regression assertion: without concurrent draining,
  blocked producer threads make it fail.
- Await the reader's completion, surface reader errors, and join the
  non-daemon reader in `finally` after socket shutdown so failure paths cannot
  leak it.

## RED/GREEN evidence and transport anomaly

### RED setup

The RED-only diff added this real assertion immediately after the original
pre-drain producer joins:

```python
assert all(not thread.is_alive() for thread in threads)
```

The intended bounded RED command was:

```text
PATH="$PWD/.venv/bin:$PATH" perl -e 'alarm 60; exec @ARGV' .venv/bin/python -m pytest -c rdk/vision/pytest.ini --strict-markers rdk/vision/tests/test_control_socket.py::test_concurrent_writes_do_not_interleave -q 2>&1 | tee /tmp/rdk-post-review-red.log
```

It was interrupted by orchestration after 245.9 seconds with no captured test
output and no log file. It is therefore **not** claimed as a witnessed RED
result. The `exec`/pipe construction also proved unsuitable as a transport
wall-clock guard, and no test process output was available from it.

### GREEN

The first patched focused child run wrote:

```text
1 passed in 0.52s
```

to `/tmp/rdk-post-review-green-1.log`. Its attempted parent-managed
30-second command was:

```text
perl -e '<fork child; ALRM sends TERM/KILL after 30 seconds>' /tmp/rdk-post-review-green-1.log .venv/bin/python -m pytest -c rdk/vision/pytest.ini --strict-markers rdk/vision/tests/test_control_socket.py::test_concurrent_writes_do_not_interleave -q
```

Although the child completed in 0.52 seconds, the orchestration cell did not
return for 473.9 seconds; it was then terminated. This was transport delay,
not a test timeout.

Controller-provided independent outside-sandbox verification of the patched
file is the authoritative final GREEN evidence:

```text
.venv/bin/python -m pytest -q -c rdk/vision/pytest.ini rdk/vision/tests/test_control_socket.py
4 passed in 0.51s
exit 0
```

The controller reported the same approximately 340-second orchestration-cell
delay after the process itself returned, independently confirming the tool
transport anomaly.

## Review

- `git diff --check` exited 0.
- The change is limited to `rdk/vision/tests/test_control_socket.py` plus this
  required report; production code is unchanged.
- The reader starts only after real event-bus registration and before hazards,
  retains the injected `op` request success/detail checks, and validates all
  800 broadcasts rather than merely one.
- Cleanup closes the socket before joining the non-daemon reader and asserts
  it is dead; existing handler-unregister and server-thread teardown remain.

## Concerns

- The intended direct RED execution did not yield a result because of the
  orchestration interruption, so its failure is evidenced by the lifecycle
  condition and reported duration rather than a captured assertion traceback.
- The requested five repetitions and control/event companion suite were not
  launched after the controller explicitly directed no further long tool call
  once it independently obtained the 4/4, 0.51-second GREEN result. The
  controller result is clearly attributed above.
