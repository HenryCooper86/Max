// Project configuration releases. The project row is authoritative for all identity,
// credentials used to access Max, and operational state. Snapshots only overlay settings.
import type { DatabaseSync } from "node:sqlite";
import {
  prepareProjectChanges,
  projectStudio,
  publicProject,
  tracesHeadersScope,
  type PublicProject,
  type Result
} from "./customers";
import { cloudSecretKeys } from "./context";
import { decryptModelKey, newId } from "./secrets";
import { immediate, liveProject, readStudioDraft, updateProject, type ProjectRow } from "./store";

export type ReleaseState = {
  project: PublicProject;
  liveRevision: string;
  previousRevision: string | null;
  draft: { id: string; project: PublicProject; tested: boolean; changedFields: string[] } | null;
};

const configFields = {
  name: "name",
  backend: "backend",
  assistant_name: "assistantName",
  greeting: "greeting",
  instructions: "instructions"
} as const;

function config(row: ProjectRow) {
  const { name, backend, assistant_name, greeting, instructions, studio } = row;
  return { name, backend, assistant_name, greeting, instructions, studio };
}

type Snapshot = {
  revision: string;
  config: string;
  tested: number;
  model_key_enc: string | null;
  traces_headers_enc: string | null;
};
type Release = { db: DatabaseSync; live: ProjectRow; id: string; draft?: Snapshot; previous?: Snapshot };
const fail = (status: number, error: string) => ({ ok: false, status, error }) as const;
const conflict = () => fail(409, "The project has changed. Reload Studio to review the current revision.");

function withRelease<T>(customerId: string, projectId: string, work: (release: Release) => Result<T>): Result<T> {
  return immediate((db) => {
    const live = liveProject(projectId, customerId);
    if (!live) return fail(404, "Project not found.");
    const row = live as ProjectRow & { studio_revision: string | null };
    const id = row.studio_revision ?? newId("rev_");
    if (!row.studio_revision) db.prepare("UPDATE projects SET studio_revision=? WHERE id=?").run(id, projectId);
    const rows = db.prepare("SELECT * FROM studio_snapshots WHERE project_id=?").all(projectId) as (Snapshot & {
      role: string;
    })[];
    return work({
      db,
      live,
      id,
      draft: rows.find((s) => s.role === "draft"),
      previous: rows.find((s) => s.role === "previous")
    });
  });
}

function overlay(live: ProjectRow, s: Snapshot): ProjectRow {
  return { ...live, ...JSON.parse(s.config), model_key_enc: s.model_key_enc, traces_headers_enc: s.traces_headers_enc };
}

function changedFields(live: ProjectRow, next: ProjectRow): string[] {
  const fields: string[] = [];
  for (const k of Object.keys(configFields) as (keyof typeof configFields)[]) {
    if (live[k] !== next[k]) fields.push(configFields[k]);
  }
  const before = projectStudio(live),
    after = projectStudio(next);
  for (const k of Object.keys(before) as (keyof typeof before)[]) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) fields.push(`studio.${k}`);
  }
  // A key rotation can independently rewrap the live and draft copies of the same secret.
  for (const [column, name, scope] of [
    ["model_key_enc", "modelKey", live.id],
    ["traces_headers_enc", "tracesHeaders", tracesHeadersScope(live.id)]
  ] as const) {
    const a = live[column],
      b = next[column];
    if (a === b) continue;
    if (a && b) {
      const plain = decryptModelKey(a, cloudSecretKeys(), scope);
      if (plain !== undefined && plain === decryptModelKey(b, cloudSecretKeys(), scope)) continue;
    }
    fields.push(name);
  }
  return fields;
}

function state({ live, id, draft, previous }: Release): Result<ReleaseState> {
  const next = draft && overlay(live, draft);
  return {
    ok: true,
    value: {
      project: publicProject(live),
      liveRevision: id,
      previousRevision: previous?.revision ?? null,
      draft:
        draft && next
          ? {
              id: draft.revision,
              project: publicProject(next),
              tested: !!draft.tested,
              changedFields: changedFields(live, next)
            }
          : null
    }
  };
}

export function studioRelease(customerId: string, projectId: string) {
  return withRelease(customerId, projectId, state);
}

export function saveStudioDraft(
  customerId: string,
  projectId: string,
  body: Record<string, unknown>
): Result<ReleaseState> {
  return withRelease(customerId, projectId, (r) => {
    if (r.id !== body.baseRevision || (r.draft?.revision ?? null) !== body.draftRevision) return conflict();
    if (!body.patch || typeof body.patch !== "object" || Array.isArray(body.patch))
      return fail(400, "A project patch is required.");
    if ("monthlyMinutesCap" in body.patch) return fail(400, "Set the live monthly minutes limit in Settings.");
    const current = r.draft ? overlay(r.live, r.draft) : r.live;
    const prepared = prepareProjectChanges(current, body.patch as Record<string, unknown>);
    if (!prepared.ok) return prepared;
    const next = { ...current, ...prepared.value };
    const metadata = { public_id: prepared.value.public_id, webhook_secret_enc: prepared.value.webhook_secret_enc };
    updateProject(projectId, customerId, metadata);
    if (metadata.public_id) r.live.public_id = metadata.public_id;
    if (metadata.webhook_secret_enc) r.live.webhook_secret_enc = metadata.webhook_secret_enc;
    if (!changedFields(r.live, next).length) {
      r.db.prepare("DELETE FROM studio_snapshots WHERE project_id=? AND role='draft'").run(projectId);
      return state({ ...r, draft: undefined });
    }
    if (r.draft && !changedFields(current, next).length) return state(r);
    const draft: Snapshot = {
      revision: newId("rev_"),
      config: JSON.stringify(config(next)),
      model_key_enc: next.model_key_enc,
      traces_headers_enc: next.traces_headers_enc,
      tested: 0
    };
    r.db
      .prepare(
        `INSERT OR REPLACE INTO studio_snapshots(project_id,role,revision,config,model_key_enc,traces_headers_enc,tested)
      VALUES(?,'draft',?,?,?,?,0)`
      )
      .run(projectId, draft.revision, draft.config, draft.model_key_enc, draft.traces_headers_enc);
    return state({ ...r, draft });
  });
}

function activate(r: Release, s: Snapshot, id: string) {
  const next = overlay(r.live, s);
  updateProject(
    r.live.id,
    r.live.customer_id,
    { ...config(next), model_key_enc: next.model_key_enc, traces_headers_enc: next.traces_headers_enc },
    id
  );
  return {
    ok: true,
    value: { project: publicProject(next), liveRevision: id, previousRevision: r.id, draft: null }
  } as const;
}

export function publishStudioRevision(
  customerId: string,
  projectId: string,
  body: Record<string, unknown>
): Result<ReleaseState> {
  return withRelease(customerId, projectId, (r) => {
    if (r.id !== body.baseRevision || !r.draft || r.draft.revision !== body.revision) return conflict();
    if (!r.draft.tested) return fail(409, "Test this saved draft before publishing.");
    return activate(r, r.draft, r.draft.revision);
  });
}

export function restoreStudioRevision(
  customerId: string,
  projectId: string,
  body: Record<string, unknown>
): Result<ReleaseState> {
  return withRelease(customerId, projectId, (r) => {
    if (
      r.id !== body.baseRevision ||
      !r.previous ||
      r.previous.revision !== body.revision ||
      (r.draft?.revision ?? null) !== (body.draftRevision ?? null)
    )
      return conflict();
    return activate(r, r.previous, newId("rev_"));
  });
}

export function draftRevisionProject(customerId: string, projectId: string, revision: string): ProjectRow | undefined {
  return readStudioDraft(projectId, customerId, revision);
}

export function markStudioRevisionTested(
  customerId: string,
  projectId: string,
  revision: string,
  expectedKeyHash?: string
): boolean {
  const result = withRelease(customerId, projectId, (r) => {
    if (expectedKeyHash !== undefined && expectedKeyHash !== r.live.key_hash) return { ok: true, value: false };
    const write = r.db
      .prepare("UPDATE studio_snapshots SET tested=1 WHERE project_id=? AND role='draft' AND revision=?")
      .run(projectId, revision);
    return { ok: true, value: write.changes === 1 };
  });
  return result.ok && result.value;
}
