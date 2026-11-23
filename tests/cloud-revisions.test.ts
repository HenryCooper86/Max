import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProject,
  deleteProject,
  patchProject,
  rotateProjectKey,
  rotateWebhookSecret,
  type Result
} from "../server/cloud/customers";
import {
  draftRevisionProject,
  markStudioRevisionTested,
  publishStudioRevision,
  restoreStudioRevision,
  saveStudioDraft,
  studioRelease
} from "../server/cloud/revisions";
import { projectRuntime } from "../server/cloud";
import { checkStoredSecrets, reencryptStoredSecrets } from "../server/cloud/keyring";
import { insertCustomer, liveProject, resetCloudDatabase } from "../server/cloud/store";

const owner = "owner";
let id: string;
let dbPath: string;
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function release() {
  return unwrap(studioRelease(owner, id));
}
function save(patch: Record<string, unknown>) {
  const state = release();
  return unwrap(
    saveStudioDraft(owner, id, { baseRevision: state.liveRevision, draftRevision: state.draft?.id ?? null, patch })
  );
}
function publish(revision: string) {
  return publishStudioRevision(owner, id, { baseRevision: release().liveRevision, revision });
}
beforeEach(() => {
  vi.stubEnv("CLOUD_SECRET_KEY", "ac".repeat(32));
  dbPath = mkdtempSync(join(tmpdir(), "studio-revisions-"));
  resetCloudDatabase(join(dbPath, "cloud.db"));
  insertCustomer({ id: owner, email: "owner@example.com", password_hash: "", password_salt: "", created_at: 1 });
  id = unwrap(createProject(owner, { name: "Desk" })).project.id;
});
afterEach(() => {
  resetCloudDatabase();
  rmSync(dbPath, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("Studio revisions", () => {
  it("persists a private draft, tests exactly one revision and restores the previous live settings", () => {
    const original = release();
    const first = save({ instructions: "A", modelKey: "private-provider-credential" });
    expect(first.project.instructions).toBe("");
    expect(first.draft?.changedFields).toEqual(["instructions", "modelKey"]);
    expect(JSON.stringify(first)).not.toContain("private-provider-credential");
    resetCloudDatabase(join(dbPath, "cloud.db"));
    expect(release()).toEqual(first);
    const old = first.draft!.id;
    expect(publish(old)).toMatchObject({ ok: false, status: 409 });
    expect(markStudioRevisionTested(owner, id, old, "wrong key")).toBe(false);
    expect(markStudioRevisionTested(owner, id, old)).toBe(true);
    expect(save({ instructions: "A" }).draft).toMatchObject({ id: old, tested: true });
    const next = save({ greeting: "Hello" }).draft!;
    expect(next.tested).toBe(false);
    expect(draftRevisionProject(owner, id, old)).toBeUndefined();
    expect(markStudioRevisionTested(owner, id, old)).toBe(false);
    expect(draftRevisionProject("someone-else", id, next.id)).toBeUndefined();
    expect(liveProject(id, owner)?.greeting).toEqual("");
    markStudioRevisionTested(owner, id, next.id);
    const rotated = unwrap(rotateProjectKey(owner, id));
    const live = unwrap(publish(next.id));
    expect(live).toMatchObject({
      liveRevision: next.id,
      previousRevision: original.liveRevision,
      project: { greeting: "Hello", hasModelKey: true, keyPrefix: rotated.project.keyPrefix },
      draft: null
    });
    const body = { baseRevision: live.liveRevision, revision: original.liveRevision };
    const pending = save({ greeting: "Later" }).draft!;
    expect(restoreStudioRevision(owner, id, body)).toMatchObject({ ok: false, status: 409 });
    const restored = unwrap(restoreStudioRevision(owner, id, { ...body, draftRevision: pending.id }));
    expect(restored.project).toEqual({ ...original.project, keyPrefix: rotated.project.keyPrefix });
    expect(restored.liveRevision).not.toBe(original.liveRevision);
  });
  it.each([true, false])("revokes all recoverable keys and tested drafts when live has a key: %s", (liveHasKey) => {
    unwrap(patchProject(owner, id, { greeting: "Go live", ...(liveHasKey ? { modelKey: "previous-key" } : {}) }));
    const previous = release();
    const next = save({ modelKey: "live-key" }).draft!;
    markStudioRevisionTested(owner, id, next.id);
    const published = unwrap(publish(next.id));
    const active = liveHasKey
      ? published
      : unwrap(
          restoreStudioRevision(owner, id, {
            baseRevision: published.liveRevision,
            revision: previous.liveRevision
          })
        );
    const pending = save({ modelKey: "draft-key" }).draft!;
    markStudioRevisionTested(owner, id, pending.id);
    expect(patchProject("another-owner", id, { modelKey: "" })).toMatchObject({ ok: false, status: 404 });
    expect(release().draft?.tested).toBe(true);
    expect(active.project.hasModelKey).toBe(liveHasKey);
    const cleared = unwrap(patchProject(owner, id, { modelKey: "" }));
    expect(cleared.project.hasModelKey).toBe(false);
    const state = release();
    expect(state).toMatchObject({ previousRevision: null, draft: null, project: { greeting: "Go live" } });
    expect(state.liveRevision).not.toBe(active.liveRevision);
    expect(checkStoredSecrets().total).toBe(0);
    expect(draftRevisionProject(owner, id, pending.id)).toBeUndefined();
    expect(markStudioRevisionTested(owner, id, pending.id)).toBe(false);
    expect(publishStudioRevision(owner, id, { baseRevision: active.liveRevision, revision: pending.id })).toMatchObject(
      { ok: false, status: 409 }
    );
    expect(
      restoreStudioRevision(owner, id, { baseRevision: state.liveRevision, revision: active.previousRevision })
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("rejects stale saves and publish after a legacy edit, including when the settings change back", () => {
    const first = save({ name: "Edited" }),
      revision = first.draft!.id;
    expect(
      saveStudioDraft(owner, id, {
        baseRevision: first.liveRevision,
        draftRevision: null,
        patch: { name: "Second tab" }
      })
    ).toMatchObject({ ok: false, status: 409 });
    markStudioRevisionTested(owner, id, revision);
    unwrap(patchProject(owner, id, { name: "Legacy" }));
    unwrap(patchProject(owner, id, { name: "Desk" }));
    expect(release().liveRevision).not.toBe(first.liveRevision);
    expect(publishStudioRevision(owner, id, { baseRevision: first.liveRevision, revision })).toMatchObject({
      ok: false,
      status: 409
    });
    expect(release().project.name).toEqual("Desk");
  });
  it("keeps live spend limits independent and pairs restored trace headers with their collector", () => {
    const endpoint = "https://otel.example.com/v1/traces";
    unwrap(
      patchProject(owner, id, {
        studio: { ...release().project.studio, traces: { endpoint, content: false } },
        tracesHeaders: "x-api-key=private"
      })
    );
    const original = release();
    const pending = save({
      studio: { ...original.project.studio, traces: { endpoint: "https://new.example.com/v1/traces", content: false } }
    }).draft!;
    expect(pending.project.hasTracesHeaders).toBe(false);
    unwrap(patchProject(owner, id, { monthlyMinutesCap: 7 }));
    expect(release().liveRevision).toBe(original.liveRevision);
    expect(
      saveStudioDraft(owner, id, {
        baseRevision: original.liveRevision,
        draftRevision: pending.id,
        patch: { monthlyMinutesCap: 30 }
      })
    ).toMatchObject({ ok: false, status: 400 });
    markStudioRevisionTested(owner, id, pending.id);
    const published = unwrap(publish(pending.id));
    expect(published.project).toMatchObject({ hasTracesHeaders: false, monthlyMinutesCap: 7 });
    unwrap(patchProject(owner, id, { monthlyMinutesCap: 12 }));
    const restored = unwrap(
      restoreStudioRevision(owner, id, { baseRevision: published.liveRevision, revision: original.liveRevision })
    );
    expect(restored.project).toMatchObject({
      monthlyMinutesCap: 12,
      hasTracesHeaders: true,
      studio: { traces: { endpoint } }
    });
  });

  it("rewraps distinct dormant previous, live and draft credentials before the old key is removed", () => {
    const credentials = (label: string) => ({
      modelKey: `model-${label}`,
      tracesHeaders: `authorization=token-${label}`
    });
    unwrap(
      patchProject(owner, id, {
        ...credentials("previous"),
        studio: {
          ...release().project.studio,
          traces: { endpoint: "https://otel.example.com/v1/traces", content: false }
        }
      })
    );
    const live = save(credentials("live")).draft!;
    markStudioRevisionTested(owner, id, live.id);
    const published = unwrap(publish(live.id));
    const draft = save(credentials("draft")).draft!;
    markStudioRevisionTested(owner, id, draft.id);
    vi.stubEnv("CLOUD_SECRET_KEY_PREVIOUS", "ac".repeat(32));
    vi.stubEnv("CLOUD_SECRET_KEY", "bd".repeat(32));
    expect(checkStoredSecrets().previous).toBe(6);
    expect(reencryptStoredSecrets()).toEqual({ reencrypted: 6, skipped: 0, unreadable: [] });
    vi.stubEnv("CLOUD_SECRET_KEY_PREVIOUS", "");
    expect(checkStoredSecrets().current).toBe(6);
    expect(release().draft).toMatchObject({ id: draft.id, tested: true });
    expect(projectRuntime(id)).toMatchObject(credentials("live"));
    const grant = {
      customerId: owner,
      projectId: id,
      keyHash: liveProject(id, owner)!.key_hash,
      source: "test" as const,
      testRevision: draft.id
    };
    expect(projectRuntime(id, grant)).toMatchObject(credentials("draft"));
    unwrap(
      restoreStudioRevision(owner, id, {
        baseRevision: published.liveRevision,
        revision: published.previousRevision,
        draftRevision: draft.id
      })
    );
    expect(projectRuntime(id)).toMatchObject(credentials("previous"));
  });

  it("rewraps draft secrets without changing the tested revision and preserves rotated signing keys on restore", () => {
    const studio = release().project.studio;
    const initial = save({
      modelKey: "a-secret",
      studio: { ...studio, conversationWebhook: "https://events.example.com/receive" }
    });
    const rev = initial.draft!.id;
    markStudioRevisionTested(owner, id, rev);
    vi.stubEnv("CLOUD_SECRET_KEY_PREVIOUS", "ac".repeat(32));
    vi.stubEnv("CLOUD_SECRET_KEY", "bd".repeat(32));
    expect(checkStoredSecrets().previous).toBeGreaterThan(0);
    expect(reencryptStoredSecrets().unreadable).toEqual([]);
    vi.stubEnv("CLOUD_SECRET_KEY_PREVIOUS", "");
    expect(checkStoredSecrets().unreadable).toEqual([]);
    expect(release().draft).toMatchObject({ id: rev, tested: true });
    const live = unwrap(publish(rev));
    unwrap(rotateWebhookSecret(owner, id));
    const secret = liveProject(id, owner)?.webhook_secret_enc;
    unwrap(restoreStudioRevision(owner, id, { baseRevision: live.liveRevision, revision: live.previousRevision }));
    expect(liveProject(id, owner)?.webhook_secret_enc).toEqual(secret);
    unwrap(deleteProject(owner, id));
    expect(studioRelease(owner, id)).toMatchObject({ ok: false, status: 404 });
  });
});
