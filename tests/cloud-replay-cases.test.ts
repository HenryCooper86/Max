import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProject, type Result } from "../server/cloud/customers";
import {
  createReplayCase,
  deleteReplayCase,
  listReplayCases,
  readReplayCase,
  recordReplayOutcome,
  updateReplayCase
} from "../server/cloud/replay-cases";
import { immediate, insertCustomer, resetCloudDatabase, softDeleteProject } from "../server/cloud/store";
import { saveStudioDraft, studioRelease } from "../server/cloud/revisions";
import { REPLAY_LIMITS } from "../shared/studio-replay";

const owner = "owner";
const other = "other";
const input = {
  prompt: "What is my order status?",
  expected: "shipped",
  fixtures: { lookup_order: { status: "shipped" } }
};
let directory: string;
let project: string;
let sibling: string;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

beforeEach(() => {
  vi.stubEnv("CLOUD_SECRET_KEY", "ac".repeat(32));
  directory = mkdtempSync(join(tmpdir(), "studio-replay-cases-"));
  resetCloudDatabase(join(directory, "cloud.db"));
  for (const id of [owner, other]) {
    insertCustomer({ id, email: id + "@example.com", password_hash: "", password_salt: "", created_at: 1 });
  }
  project = unwrap(createProject(owner, { name: "Desk" })).project.id;
  sibling = unwrap(createProject(owner, { name: "Other desk" })).project.id;
});

afterEach(() => {
  resetCloudDatabase();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("persists only editable replay data and gives the same inputs on repeated reads", () => {
  const { testCase } = unwrap(
    createReplayCase(owner, project, { ...input, conversationId: "original", transcript: "private transcript" })
  );
  expect(testCase).toEqual({ ...input, id: expect.any(String), version: 1 });
  resetCloudDatabase(join(directory, "cloud.db"));
  expect(unwrap(listReplayCases(owner, project)).cases).toEqual([testCase]);
  expect(unwrap(readReplayCase(owner, project, testCase.id, 1)).testCase).toEqual(testCase);
  expect(unwrap(readReplayCase(owner, project, testCase.id, 1)).testCase).toEqual(testCase);
  expect(softDeleteProject(project, owner, 10)).toBe(true);
  expect(listReplayCases(owner, project)).toMatchObject({ ok: false, status: 404 });
  expect(immediate((db) => db.prepare("SELECT id FROM studio_replay_cases").all())).toEqual([]);
});

it("requires the owning customer, project and current case version for access and mutation", () => {
  const { testCase } = unwrap(createReplayCase(owner, project, input));
  const id = testCase.id;
  expect(listReplayCases(other, project)).toMatchObject({ ok: false, status: 404 });
  expect(createReplayCase(other, project, input)).toMatchObject({ ok: false, status: 404 });
  expect(readReplayCase(other, project, id, 1)).toMatchObject({ ok: false, status: 404 });
  expect(unwrap(listReplayCases(owner, sibling)).cases).toEqual([]);
  expect(updateReplayCase(owner, sibling, id, { ...input, version: 1 })).toMatchObject({ ok: false, status: 404 });
  expect(deleteReplayCase(other, project, id, 1)).toMatchObject({ ok: false, status: 404 });

  expect(updateReplayCase(owner, project, id, input)).toMatchObject({ ok: false, status: 400 });
  const updated = unwrap(updateReplayCase(owner, project, id, { ...input, expected: "pending", version: 1 })).testCase;
  expect(updated).toEqual({ ...testCase, expected: "pending", version: 2 });
  expect(readReplayCase(owner, project, id, 1)).toMatchObject({ ok: false, status: 409 });
  expect(updateReplayCase(owner, project, id, { ...input, version: 1 })).toMatchObject({ ok: false, status: 409 });
  expect(deleteReplayCase(owner, project, id, 1)).toMatchObject({ ok: false, status: 409 });
  expect(unwrap(deleteReplayCase(owner, project, id, 2))).toEqual({ ok: true });
  expect(readReplayCase(owner, project, id, 2)).toMatchObject({ ok: false, status: 404 });
});

it("rejects empty, malformed and oversized inputs and enforces the project case limit", () => {
  for (const badInput of [
    { ...input, prompt: " " },
    { ...input, prompt: "x".repeat(REPLAY_LIMITS.prompt + 1) },
    { ...input, expected: false },
    { ...input, expected: "x".repeat(REPLAY_LIMITS.expected + 1) },
    { ...input, fixtures: [] },
    { ...input, fixtures: { lookup_order: "界".repeat(REPLAY_LIMITS.fixtureBytes) } },
    {
      ...input,
      fixtures: Object.fromEntries(
        Array.from({ length: REPLAY_LIMITS.fixtures + 1 }, (_, index) => ["tool" + index, null])
      )
    }
  ]) {
    expect(createReplayCase(owner, project, badInput)).toMatchObject({ ok: false, status: 400 });
  }
  for (let index = 0; index < REPLAY_LIMITS.cases; index++) unwrap(createReplayCase(owner, project, input));
  expect(createReplayCase(owner, project, input)).toMatchObject({ ok: false, status: 409 });
  expect(unwrap(listReplayCases(owner, project)).cases).toHaveLength(REPLAY_LIMITS.cases);
  expect(createReplayCase(owner, sibling, input)).toMatchObject({ ok: true });
});

it("keeps release checks after reopening the database and invalidates only the affected targets", () => {
  const release = () => unwrap(studioRelease(owner, project));
  const makeDraft = (greeting: string) => {
    const current = release();
    return unwrap(
      saveStudioDraft(owner, project, {
        baseRevision: current.liveRevision,
        draftRevision: current.draft?.id ?? null,
        patch: { greeting }
      })
    ).draft!;
  };
  const a = unwrap(createReplayCase(owner, project, input)).testCase;
  const b = unwrap(createReplayCase(owner, project, { ...input, prompt: "Order update?" })).testCase;
  const d = makeDraft("First draft");
  const outcome = { status: "passed" as const, answer: "Shipment is on the way", missingTools: [] };
  expect(unwrap(recordReplayOutcome(owner, project, d.id, a, outcome))).toBe(true);
  expect(recordReplayOutcome(other, project, d.id, a, outcome)).toMatchObject({ ok: false, status: 404 });
  expect(unwrap(recordReplayOutcome(owner, project, d.id, b, { status: "error", message: "Timed out" }))).toBe(true);
  resetCloudDatabase(join(directory, "cloud.db"));
  expect(release().draft?.replayChecks).toMatchObject([
    { id: a.id, outcome, stale: false },
    { id: b.id, outcome: { status: "error", message: "Timed out" } }
  ]);
  unwrap(updateReplayCase(owner, project, a.id, { ...input, version: 1, prompt: "Redacted" }));
  expect(recordReplayOutcome(owner, project, d.id, a, outcome)).toMatchObject({ ok: false, status: 409 });
  expect(release().draft?.replayChecks).toMatchObject([
    { id: a.id, version: 2, stale: true, outcome: null },
    { id: b.id, stale: false }
  ]);
  expect(JSON.stringify(release())).not.toContain("Shipment is on the way");
  const next = makeDraft("Revised draft");
  expect(next.replayChecks.every((c) => c.stale && !c.outcome)).toBe(true);
  expect(recordReplayOutcome(owner, project, d.id, b, outcome)).toMatchObject({ ok: false, status: 409 });
  unwrap(deleteReplayCase(owner, project, b.id, b.version));
  expect(release().draft?.replayChecks).toHaveLength(1);
});
