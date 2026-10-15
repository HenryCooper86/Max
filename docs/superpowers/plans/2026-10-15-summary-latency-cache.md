# Summary latency cache implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Remove repeated synchronous evidence processing from GUI polling while preserving every release decision and immediate freshness.

**Architecture:** Reuse immutable normalized completed evidence and build queries under an exact storage revision. Keep live metrics live. Read the current storage revision, policy and approved baseline before using derived evidence; storage failures must not serve stale passing decisions.

**Tech Stack:** Node 22+, TypeScript, DatabaseSync SQLite, Vitest.

**Spec:** The user's current request requires reliable fast GUI behavior and a passing release gate without weakening policy. Existing implementation and unchanged policy are the behavioral specification. Private diagnostic evidence is in `/tmp/max-release-repair-20261015/summary-perf/FINDINGS.md`; three production loopback summary GETs took 592.96, 278.25, 303.29 ms. Offline full637-row evaluation blocks the same event loop for median31.88/p9549.26 ms on Apple M5 Max. This does not establish the cause of any specific first-audio regression.

## Global constraints

- Source begins at actual main2854325c42cde385a6c444135588a233b228eb4b; existing user files remain untouched.
- No release thresholds, sample counts, cohort metadata, evidence bodies, historical failures, approval rules, baselines, VAD clocks, fixtures or provider configuration changes.
- Preserve all raw latency samples and legitimate measured zero, partial-distribution guards, original baseline selection, captured evidence and integrity verification.
- No time-only stale PASS cache. A mutation must be visible in the next decision request.
- Synthetic audio only; no real microphone, camera, GPS or motion acquisition.
- The failed provider configuration A/B intervention stays out of production.

## Review focus

- Same-connection writes: evidence completion, notes/feedback, deletes, import/reset must immediately invalidate relevant results.
- Other SQLite writers and database reopen: changed rows cannot reuse previously verified evidence or stale policy state; malformed existing rows cannot disappear as if intentionally deleted.
- Policy or approved-baseline changes: cached decisions must immediately reflect the current rule and baseline, including changes under an unchanged version label.
- Caller isolation: scoped requests and mutable returned arrays cannot expose another tester or poison a later decision.
- Data failure and bounds: unavailable revision reads cannot return cached PASS; cache memory is bounded and cold/changed paths preserve complete evidence.

---

### Task 1: Revision-aware evidence reuse

**Files:** Modify `server/testing-store.ts`, `server/metrics.ts`; add focused cache module only if it reduces responsibilities; extend `tests/testing-store.test.ts` and `tests/metrics.test.ts` (or dedicated focused tests).

**Interfaces:** Preserve all existing public request/response types and function signatures. Add `testingStoreRevision(): string` in testing-store if needed; it must combine database connection identity with same-connection and external write revisions. SQLite `total_changes()` plus `PRAGMA data_version` can cover writes without missing a mutation call site. Reopening a database must change connection identity. Expose no revision controls through product UI.

- [x] Write failing correctness tests that warm a passing snapshot, then add FAIL/invalid evidence and assert the very next snapshot changes. Warm once, alter stored payload outside the connection, and assert tampering is not cached as verified. Warm once, change current policy and baseline, and assert next decision differs. Reopen/reset the database and assert no old evidence leaks.
- [x] Run focused tests and preserve actual RED logs privately. Use real test SQLite where external data_version is exercised; isolate its path and clean only owned test files.
- [x] Implement minimal revision-aware bounded reuse. A stored query cache key includes storage revision and exact query identity/build/limit; row normalization includes exact payload and current evaluator/policy identity. Reuse baseline rows already normalized in the same request. Never cache live counters/timeline or caller-mutated response objects.
- [x] Verify changing notes/feedback is visible without corrupting captured integrity, tester scoping remains isolated, returned data mutations cannot poison later requests, and a revision-read failure bypasses/invalidates caches or fails closed rather than returning old PASS. A notes edit must update only notes on the current durable payload and preserve concurrent evidence edits. Existing malformed active-policy or blank approved-baseline rows must fail closed; a genuinely absent baseline remains valid. Malformed JSON or a row rejected by normalization must not silently remove a slow/failing sample from a decision. Public detail/page reads must also reject known corrupt durable evidence rather than show a stale verified PASS or silently omit the row.
- [x] Run `npx vitest run tests/metrics.test.ts tests/testing-store.test.ts` plus every new focused test. Preserve zero/raw130k/partial-distribution regression checks unchanged. Run types, lint and formatting for owned files.
- [x] Freeze the backend patch for independent review; root commits the complete reviewed change.

### Task 2: Independent performance and freshness validation

**Files:** Private diagnostics under `/tmp/max-release-repair-20261015/summary-cache-verification/`; production source remains frozen during measurement.

**Interfaces:** Consume exactly the same637 original full payloads and unchanged build identity in old/new offline diagnostic processes. No new formal release identities or provider calls for this benchmark.

- [x] Replay old285 and repaired source with the same full input, active policy and approved baseline. Deep-compare complete quality/regression outputs, cohort math, integrity flags and all42 current rows; normalize only response timestamps for comparison.
- [x] Measure cold first call and thirty warm synchronous summary calls, queued timer delay, and JSON response size; preserve every timing sample. Do not infer a production CPU multiplier from desktop measurements.
- [x] Demonstrate a controlled scheduled mock-PCM callback is delayed by the old synchronous polling work and materially less by the repaired warm path. This validates the event-loop repair without pretending to explain the previous live provider regression.
- [x] Independently exercise every Review Focus mutation against warmed caches and inspect bounded memory behavior. Any stale PASS is a release blocker.
- [ ] Root runs full `npm run check`, obtains independent code review, and freezes source. All relevant CI checks must pass before merging.

### Task 3: Deploy and verify the real release

**Files:** Existing deployment and synthetic QA scripts; private new run/config/evidence directory for the actual merged source.

- [ ] Merge the genuine reviewed performance repair into main on both remotes, delete its merged branch, and deploy with `deploy-lightsail.command`; preserve and restore only the user's notes as before.
- [ ] Confirm health/readiness/source match; measure three read-only production loopback summary GETs with the same request shape, retaining all results.
- [ ] Create a new predeclared2x6 web/iOS/Android synthetic run, build actual merged native artifacts and run all36 strict cases. Preserve every failure; no rerun-to-green.
- [ ] Independently audit all raw bodies, source stamps, full PCM/warnings/reconnect/teardown and durable links. Retain preapproval normal baseline and explicit original8dd comparison, unchanged policy SHA and all historical failures.
- [ ] Save the complete preapproval gate. Approve only if policy and regression pass with complete requirements/reviews and no unresolved source issue. Otherwise preserve BLOCKED and continue causal investigation without changing policy or comparison history.

## Execution

The user has repeatedly instructed autonomous repair, merge, deployment and complete synthetic verification. Root executes this plan with the existing delegated implementer and independent reviewer; no additional planning approval is required. A passing software suite alone never implies release approval.

Verified frozen backend: full check1,942 tests/133 files passed. Complete637-row output is byte-identical to control. Serial desktop warm median33.18→0.59ms/p9554.01→0.85ms; cold66.01→88.72ms. Scheduled mock-PCM maxlateness43.27→1.76ms. This is offline event-loop evidence; live voice latency and approval remain unverified for the new source.
