# Final review route attribution fix

Date: 2026-07-23

## Scope

Fix the final review finding in `POST /testing/reviews`. No native, protocol,
or audio files changed.

## Regression and fix

- Added a store regression proving an old review updates in place while retaining
  its original `sessionId` and `runId`, even if the update body supplies unrelated
  values.
- Added an integration regression that creates an original review, creates 601
  newer unrelated reviews, updates the buried review through `POST
/testing/reviews` with another session/run, and verifies its original release
  run still has one unresolved approval blocker.
- Added uncapped `getTestingReview(id)` retrieval for update-by-id and used it in
  the route instead of the bounded `listTestingReviews(500)` feed.
- Enforced the same immutable attribution invariant inside
  `upsertTestingReview`, while retaining existing editable review fields,
  status behavior, and endpoint authorization.

## Test-first evidence

The focused regression suite initially failed in both layers:

- direct `upsertTestingReview` changed the buried review to the unrelated
  session/run;
- the HTTP update returned that unrelated attribution after the review fell
  outside the 500-item route lookup window.

After the minimal fix:

```text
npm test -- tests/testing-store.test.ts tests/server-integration.test.ts  pass (2 files, 16 tests)
```

## Verification

```text
npm run check    pass
  check:protocol pass
  format:check   pass
  lint           pass
  check:dead-code pass
  test           pass (37 files, 377 tests)
  test:fault-matrix pass (24 cases)
  build          pass
git diff --check pass
```
