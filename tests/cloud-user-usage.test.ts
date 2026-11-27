// Max Cloud's usage per end user: recorded with each booking, kept to the
// project's per-user monthly limit, reported to the owner by project key, and
// erased with the project.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chargeSession,
  cloudSessionAlive,
  cloudSessionEnded,
  cloudSessionStarted,
  projectForApiKey,
  projectUsageForApiKey,
  recoverCloudSessions
} from "../server/cloud";
import { setCloudClock, setCloudInstanceId } from "../server/cloud/context";
import { cloudCounters } from "../server/cloud/counters";
import { createProject, deleteProject, patchProject, rotateProjectKey, signup } from "../server/cloud/customers";
import {
  CLOUD_CHECK_INTERVAL_MS,
  admitCloudSession,
  openCloudSession,
  resetLiveCloudSessions,
  userLimitRefusal
} from "../server/cloud/live";
import { saveStudioDraft, studioRelease } from "../server/cloud/revisions";
import { mintProjectSession, resetCloudSessionLimits } from "../server/cloud/sessions";
import {
  backupDatabase,
  immediate,
  ledgerEntries,
  liveSessionRows,
  resetCloudDatabase,
  usageSummary
} from "../server/cloud/store";
import { userUsageReport } from "../server/cloud/usage";
import { cloudSessionTokens } from "../server/session-tokens";

const START = Date.UTC(2026, 10, 18, 12, 0, 0);
const USAGE_LIMIT = 4003;
const USER_LIMIT_REFUSAL = {
  code: USAGE_LIMIT,
  message: "This user has used their minutes for this month.",
  reason: "user monthly limit"
};
const MINT_REFUSED = {
  ok: false,
  status: 403,
  error: "This user has used their monthly minutes limit. Raise the per-user limit in the console's Settings."
};
let clock = START;
const saved = { key: process.env.CLOUD_SECRET_KEY, signup: process.env.CLOUD_SIGNUP };

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.CLOUD_SIGNUP = "open";
  resetCloudDatabase(":memory:");
  resetCloudSessionLimits();
  resetLiveCloudSessions();
  setCloudInstanceId("relay-a");
  clock = START;
  setCloudClock(() => clock);
});

afterEach(() => {
  resetCloudDatabase();
  resetLiveCloudSessions();
  setCloudClock();
  setCloudInstanceId();
  for (const [name, value] of [
    ["CLOUD_SECRET_KEY", saved.key],
    ["CLOUD_SIGNUP", saved.signup]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Project = { customerId: string; projectId: string; apiKey: string };

async function setup(name = "Shop"): Promise<Project> {
  const account = await signup(`c${randomBytes(4).toString("hex")}@example.com`, "correct horse battery");
  if (!account.ok) throw new Error(account.error);
  const customerId = account.value.customer.id;
  const created = createProject(customerId, { name });
  if (!created.ok) throw new Error(created.error);
  return { customerId, projectId: created.value.project.id, apiKey: created.value.apiKey };
}

/** A session's usage as the relay books it. */
function booking(project: Project) {
  return (sessionId: string, seconds: number, userId?: string, endedAt = clock) => ({
    customerId: project.customerId,
    projectId: project.projectId,
    sessionId,
    seconds,
    endedAt,
    ...(userId ? { userId } : {})
  });
}

/** A session token's grant for `userId`, as the relay makes it from a token minted with the project key (server/index.ts). */
function grantFor(apiKey: string, userId?: string) {
  const minted = mintProjectSession(projectForApiKey(apiKey)!, userId === undefined ? {} : { userId });
  if (!minted.ok) throw new Error(minted.error);
  const grant = cloudSessionTokens.grant(minted.value.token)!;
  return { ...grant.project!, userId: grant.userId };
}

/** The same grant without minting a token, for a session the mint would already refuse. */
const grantOf = (project: Project, userId?: string) => ({
  projectId: project.projectId,
  customerId: project.customerId,
  keyHash: "key-hash",
  source: "api" as const,
  ...(userId ? { userId } : {})
});

const mint = (apiKey: string, body: Record<string, unknown>) => mintProjectSession(projectForApiKey(apiKey)!, body);
const status = (state: string) => ({ type: "status", state, detail: "" });
const counter = (name: string) => cloudCounters()[name] ?? 0;
function report(projectId: string, query: Record<string, unknown> = {}) {
  const result = userUsageReport(projectId, query);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const userRows = () => immediate((db) => db.prepare("SELECT COUNT(*) AS n FROM user_usage").get()) as { n: number };

describe("usage per user", () => {
  it("is recorded with each booking: a user's seconds and sessions, the rest of a session booked early, and nothing for a session that never talked", async () => {
    const project = await setup();
    const usage = booking(project);
    expect(chargeSession(usage("silent", 0, "u1"))).toBe("not-billable");
    expect(chargeSession(usage("a", 90, "u1"))).toBe("booked");
    expect(chargeSession(usage("b", 30, "u1"))).toBe("booked");
    // Booked early as abandoned at 40 s, then closed at 100 s: one session, 100 s.
    expect(chargeSession(usage("d", 40, "u2"))).toBe("booked");
    expect(chargeSession(usage("d", 100, "u2"))).toBe("booked"); // the remainder, as a second ledger entry
    expect(
      ledgerEntries(project.customerId, 20)
        .map((entry) => entry.ref)
        .filter((ref) => ref?.startsWith("d"))
    ).toEqual(["d:rest:1", "d"]);
    expect(chargeSession(usage("none", 45))).toBe("booked");
    expect(chargeSession(usage("none", 45))).toBe("already-booked");
    expect(chargeSession(usage("unnamed", 15))).toBe("booked");

    expect(report(project.projectId)).toEqual({
      month: "2026-11",
      limitMinutes: 0,
      totals: { sessions: 5, minutes: 4.67, seconds: 280 },
      users: [
        { userId: "u1", sessions: 2, minutes: 2, seconds: 120 },
        { userId: "u2", sessions: 1, minutes: 1.67, seconds: 100 },
        // The sessions that named no user are listed as "anonymous", by their seconds like the others, and are no
        // user: the count is of the users named.
        { userId: "anonymous", sessions: 2, minutes: 1, seconds: 60 }
      ],
      userCount: 2
    });
    // The sessions without a user are the user "anonymous".
    expect(report(project.projectId, { userId: "anonymous" })).toEqual({
      month: "2026-11",
      limitMinutes: 0,
      totals: { sessions: 2, minutes: 1, seconds: 60 },
      users: [{ userId: "anonymous", sessions: 2, minutes: 1, seconds: 60 }],
      userCount: 1
    });
    // All of it adds up to the project's minutes in the ledger.
    expect(report(project.projectId).totals.seconds).toBe(
      usageSummary(project.customerId, "2026-11").projects[0]!.seconds
    );
  });

  it("is booked to the month a session ends in, so the report and the limit start again in a new month", async () => {
    const project = await setup();
    const usage = booking(project);
    patchProject(project.customerId, project.projectId, { perUserMonthlyMinutes: 1 });
    expect(chargeSession(usage("nov", 60, "u1", Date.UTC(2026, 10, 30, 23, 59)))).toBe("booked");
    expect(mint(project.apiKey, { userId: "u1" })).toEqual(MINT_REFUSED);
    expect(report(project.projectId)).toMatchObject({ month: "2026-11", totals: { seconds: 60 } });
    expect(report(project.projectId, { month: "2026-12" })).toMatchObject({
      totals: { sessions: 0, seconds: 0 },
      users: [],
      userCount: 0
    });

    clock = Date.UTC(2026, 11, 1, 0, 0, 1);
    expect(mint(project.apiKey, { userId: "u1" }).ok).toBe(true);
    expect(chargeSession(usage("dec", 30, "u1"))).toBe("booked");
    expect(report(project.projectId)).toMatchObject({ month: "2026-12", totals: { sessions: 1, seconds: 30 } });
    // Earlier months can still be read.
    expect(report(project.projectId, { month: "2026-11" })).toMatchObject({ totals: { sessions: 1, seconds: 60 } });
  });
});

describe("a project's per-user monthly minutes limit", () => {
  it("is set by the owner, whole minutes or none, and shown with the project", async () => {
    const project = await setup();
    const { customerId, projectId } = project;
    expect(patchProject(customerId, projectId, { perUserMonthlyMinutes: 300 })).toMatchObject({
      ok: true,
      value: { project: { monthlyMinutesCap: null, perUserMonthlyMinutes: 300 } }
    });
    for (const bad of [0, -5, 1.5, "300", 250_001, true, {}]) {
      expect(patchProject(customerId, projectId, { perUserMonthlyMinutes: bad })).toEqual({
        ok: false,
        status: 400,
        error: "Per-user monthly minutes limit must be a whole number from 1 to 250,000, or empty for none."
      });
    }
    expect(patchProject(customerId, projectId, { name: "Still capped" })).toMatchObject({
      value: { project: { perUserMonthlyMinutes: 300 } }
    });
    // Each limit stands on its own.
    expect(patchProject(customerId, projectId, { perUserMonthlyMinutes: 400, monthlyMinutesCap: 5 })).toMatchObject({
      value: { project: { perUserMonthlyMinutes: 400, monthlyMinutesCap: 5 } }
    });
    expect(report(projectId).limitMinutes).toBe(400);
    expect(patchProject(customerId, projectId, { perUserMonthlyMinutes: null })).toMatchObject({
      value: { project: { perUserMonthlyMinutes: null, monthlyMinutesCap: 5 } }
    });
    expect(report(projectId).limitMinutes).toBe(0);
    // It is a live setting, not part of a draft.
    const release = studioRelease(customerId, projectId);
    if (!release.ok) throw new Error(release.error);
    expect(
      saveStudioDraft(customerId, projectId, {
        baseRevision: release.value.liveRevision,
        draftRevision: null,
        patch: { perUserMonthlyMinutes: 5 }
      })
    ).toEqual({ ok: false, status: 400, error: "Set the live monthly minutes limits in Settings." });
  });

  it("refuses a token and a new session for a user at the limit, and nobody else", async () => {
    const project = await setup();
    const usage = booking(project);
    patchProject(project.customerId, project.projectId, { perUserMonthlyMinutes: 1 });
    const refusals = counter("max_cloud_spend_cap_refusals_total");
    expect(chargeSession(usage("earlier", 59, "u1"))).toBe("booked");
    expect(mint(project.apiKey, { userId: " u1 " }).ok).toBe(true);
    expect(chargeSession(usage("more", 1, "u1"))).toBe("booked");

    expect(mint(project.apiKey, { userId: "u1" })).toEqual(MINT_REFUSED);
    expect(admitCloudSession(grantOf(project, "u1"), "203.0.113.5")).toEqual(USER_LIMIT_REFUSAL);
    // Another user, and a session without a user (the embed, a Studio test), are not held by it.
    expect(mint(project.apiKey, { userId: "u2" }).ok).toBe(true);
    expect(admitCloudSession(grantOf(project, "u2"), "203.0.113.5")).toBeUndefined();
    expect(mint(project.apiKey, {}).ok).toBe(true);
    expect(admitCloudSession(grantOf(project), "203.0.113.5")).toBeUndefined();
    expect(counter("max_cloud_spend_cap_refusals_total")).toBe(refusals + 2);

    // Raising the limit or removing it works at once.
    patchProject(project.customerId, project.projectId, { perUserMonthlyMinutes: 2 });
    expect(admitCloudSession(grantOf(project, "u1"), "203.0.113.5")).toBeUndefined();
    patchProject(project.customerId, project.projectId, { perUserMonthlyMinutes: null });
    expect(chargeSession(usage("lots", 50_000, "u1"))).toBe("booked");
    expect(mint(project.apiKey, { userId: "u1" }).ok).toBe(true);
  });

  it("closes a user's open session when it reaches the limit, counting every one of their sessions and only theirs", async () => {
    const project = await setup();
    const { customerId, projectId, apiKey } = project;
    patchProject(customerId, projectId, { perUserMonthlyMinutes: 2 });
    expect(chargeSession(booking(project)("earlier", 60, "u1"))).toBe("booked");
    const first = openCloudSession("s-u1", grantFor(apiKey, "u1"), "203.0.113.5");
    const second = openCloudSession("s-u1-again", grantFor(apiKey, "u1"), "203.0.113.6");
    const other = openCloudSession("s-u2", grantFor(apiKey, "u2"), "203.0.113.7");
    const nobody = openCloudSession("s-none", grantFor(apiKey), "203.0.113.8");
    for (const session of [first, second, other, nobody]) session.observe(status("ready"));

    clock += 25_000; // 60 s booked + 2 x 25 s open = 110 s of the 120 s
    expect(first.check()).toBeUndefined();
    clock += CLOUD_CHECK_INTERVAL_MS; // 120 s
    expect(first.check()).toEqual(USER_LIMIT_REFUSAL);
    expect(first.check()).toBeUndefined(); // reported once
    // A new session of theirs is refused from here on, and their other open one ends at its next check.
    expect(admitCloudSession(grantOf(project, "u1"), "203.0.113.9")).toEqual(USER_LIMIT_REFUSAL);
    expect(second.check()).toEqual(USER_LIMIT_REFUSAL);
    expect(other.check()).toBeUndefined();
    expect(nobody.check()).toBeUndefined();
    // The whole session is still charged, under its user.
    clock += 100_000;
    expect(first.close()).toBe(130);
    expect(
      cloudSessionEnded({ customerId, projectId, sessionId: "s-u1", seconds: 130, endedAt: clock, userId: "u1" })
    ).toBe("booked");
    expect(report(projectId, { userId: "u1" })).toMatchObject({
      users: [{ userId: "u1", sessions: 2, seconds: 190 }]
    });
    expect(
      liveSessionRows({ projectId })
        .map((row) => row.session_id)
        .sort()
    ).toEqual(["s-none", "s-u1-again", "s-u2"]);
  });

  it("counts a session of theirs still running on another relay", async () => {
    const project = await setup();
    const usage = booking(project);
    const { projectId, apiKey } = project;
    patchProject(project.customerId, projectId, { perUserMonthlyMinutes: 1 });
    expect(chargeSession(usage("earlier", 30, "u1"))).toBe("booked");
    setCloudInstanceId("relay-b");
    const elsewhere = openCloudSession("s-b", grantFor(apiKey, "u1"), "198.51.100.1");
    elsewhere.observe(status("ready"));
    clock += 29_000;
    expect(elsewhere.check()).toBeUndefined();
    expect(liveSessionRows({ projectId, userId: "u1" })).toMatchObject([
      { session_id: "s-b", seconds: 29, user_id: "u1" }
    ]);
    expect(liveSessionRows({ projectId, userId: "u2" })).toEqual([]);
    resetLiveCloudSessions(); // relay-b's memory is not this relay's
    setCloudInstanceId("relay-a");
    // 30 s booked and 29 s not booked yet: one second short.
    expect(userLimitRefusal(projectId, "u1")).toBeUndefined();
    expect(chargeSession(usage("more", 1, "u1"))).toBe("booked");
    expect(userLimitRefusal(projectId, "u2")).toBeUndefined();
    expect(userLimitRefusal(projectId, "u1")).toEqual(USER_LIMIT_REFUSAL);
    expect(userLimitRefusal(projectId, undefined)).toBeUndefined();
    // What the report shows is the booked part only.
    expect(report(projectId, { userId: "u1" })).toMatchObject({ users: [{ userId: "u1", sessions: 2, seconds: 31 }] });
  });

  it("does not hold a session without a user, however much the project's users have used", async () => {
    const project = await setup();
    const usage = booking(project);
    patchProject(project.customerId, project.projectId, { perUserMonthlyMinutes: 1 });
    expect(chargeSession(usage("u1", 3_600, "u1"))).toBe("booked");
    expect(chargeSession(usage("embed", 3_600))).toBe("booked");
    expect(userLimitRefusal(project.projectId, undefined)).toBeUndefined();
    const session = openCloudSession("s-none", grantFor(project.apiKey), "203.0.113.8");
    session.observe(status("ready"));
    clock += 3_600_000;
    expect(session.check()).toBeUndefined();
    expect(session.close()).toBe(3_600);
  });

  it("is refused for a user named like the sessions that have no user", async () => {
    const project = await setup();
    expect(mint(project.apiKey, { userId: "anonymous" })).toEqual({
      ok: false,
      status: 400,
      error: 'userId cannot be "anonymous": usage reports use it for sessions without a user.'
    });
    expect(mint(project.apiKey, { userId: " anonymous " })).toMatchObject({ ok: false, status: 400 });
    expect(mint(project.apiKey, { userId: "Anonymous" }).ok).toBe(true);
    expect(userRows()).toEqual({ n: 0 });
  });

  it("records the user of a session a crashed relay left, from its checkpoint row", async () => {
    const project = await setup();
    const { customerId, projectId } = project;
    cloudSessionStarted({ sessionId: "s-crash", customerId, projectId, userId: "u9" });
    expect(liveSessionRows({ projectId })[0]!.user_id).toBe("u9");
    clock += 20_000;
    expect(cloudSessionAlive({ sessionId: "s-crash", customerId, projectId, userId: "u9" }, 20)).toBe(false);
    // A row that had to be written again carries the user too.
    immediate((db) => db.prepare("DELETE FROM live_sessions").run());
    expect(cloudSessionAlive({ sessionId: "s-crash", customerId, projectId, userId: "u9" }, 25)).toBe(true);
    expect(liveSessionRows({ projectId })[0]!.user_id).toBe("u9");

    setCloudInstanceId("relay-b"); // relay-a is gone for good
    clock += 61_000;
    expect(recoverCloudSessions()).toBe(1);
    expect(report(projectId)).toEqual({
      month: "2026-11",
      limitMinutes: 0,
      totals: { sessions: 1, minutes: 0.42, seconds: 25 },
      users: [{ userId: "u9", sessions: 1, minutes: 0.42, seconds: 25 }],
      userCount: 1
    });
  });
});

describe("the usage report", () => {
  async function projectWithUsers() {
    const project = await setup();
    const usage = booking(project);
    expect(chargeSession(usage("a", 600, "heavy"))).toBe("booked");
    expect(chargeSession(usage("b", 300, "light"))).toBe("booked");
    expect(chargeSession(usage("c", 300, "light"))).toBe("booked");
    expect(chargeSession(usage("d", 300, "alpha"))).toBe("booked");
    expect(chargeSession(usage("e", 60))).toBe("booked");
    return project;
  }

  it("lists the users with the most seconds first, a page at a time, and one user when asked", async () => {
    const { projectId } = await projectWithUsers();
    expect(report(projectId)).toEqual({
      month: "2026-11",
      limitMinutes: 0,
      totals: { sessions: 5, minutes: 26, seconds: 1560 },
      userCount: 3,
      users: [
        // Ties go by userId.
        { userId: "heavy", sessions: 1, minutes: 10, seconds: 600 },
        { userId: "light", sessions: 2, minutes: 10, seconds: 600 },
        { userId: "alpha", sessions: 1, minutes: 5, seconds: 300 },
        { userId: "anonymous", sessions: 1, minutes: 1, seconds: 60 }
      ]
    });
    const page = (limit: number | string, offset: number | string) =>
      report(projectId, { limit, offset }).users.map((user) => user.userId);
    expect(page(2, 0)).toEqual(["heavy", "light"]);
    expect(page("2", "2")).toEqual(["alpha", "anonymous"]);
    expect(page(2, 4)).toEqual([]);
    expect(report(projectId, { userId: "light" })).toEqual({
      month: "2026-11",
      limitMinutes: 0,
      totals: { sessions: 2, minutes: 10, seconds: 600 },
      users: [{ userId: "light", sessions: 2, minutes: 10, seconds: 600 }],
      userCount: 1
    });
    expect(report(projectId, { userId: "nobody" })).toMatchObject({
      totals: { sessions: 0, seconds: 0 },
      users: [],
      userCount: 0
    });
    expect(report(projectId, { userId: "" })).toMatchObject({ userCount: 3 });
  });

  it("refuses what it cannot report", async () => {
    const { projectId } = await projectWithUsers();
    for (const query of [
      { month: "2026-13" },
      { month: "nope" },
      { month: 202611 },
      { month: ["2026-11", "2026-10"] },
      { userId: 42 },
      { userId: ["u1"] },
      { userId: "u".repeat(129) },
      { limit: 0 },
      { limit: 1001 },
      { limit: "1.5" },
      { limit: "many" },
      { offset: -1 },
      { offset: "later" }
    ]) {
      expect(userUsageReport(projectId, query), JSON.stringify(query)).toMatchObject({ ok: false, status: 400 });
    }
    expect(userUsageReport(projectId, { month: "2026-10" })).toMatchObject({
      ok: true,
      value: { totals: { seconds: 0 } }
    });
    expect(userUsageReport(projectId, { limit: "1000", offset: "0" })).toMatchObject({ ok: true });
  });

  it("is read for a month from its index, in order, without sorting the month", async () => {
    const { projectId } = await projectWithUsers();
    const plan = immediate((db) =>
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT user_id AS userId, sessions, seconds FROM user_usage WHERE project_id = ? AND month = ? ORDER BY seconds DESC, user_id LIMIT ? OFFSET ?"
        )
        .all(projectId, "2026-11", 50, 0)
    ) as Array<{ detail: string }>;
    const steps = plan.map((step) => step.detail).join("\n");
    expect(steps).toContain("USING INDEX idx_user_usage_month_seconds");
    expect(steps).not.toContain("TEMP B-TREE");
  });
});

describe("GET /v1/usage with a project key", () => {
  it("reports the key's own project and no other", async () => {
    const shop = await setup("Shop");
    const kiosk = await setup("Kiosk");
    for (const project of [shop, kiosk]) {
      expect(chargeSession(booking(project)(`${project.projectId}-a`, 120, "shared-id"))).toBe("booked");
    }
    expect(chargeSession(booking(shop)("shop-only", 30, "shop-user"))).toBe("booked");
    expect(projectUsageForApiKey(shop.apiKey, {})).toMatchObject({
      ok: true,
      value: {
        users: [
          { userId: "shared-id", sessions: 1, seconds: 120 },
          { userId: "shop-user", sessions: 1, seconds: 30 }
        ],
        totals: { sessions: 2, seconds: 150 }
      }
    });
    expect(projectUsageForApiKey(kiosk.apiKey, {})).toMatchObject({
      ok: true,
      value: { users: [{ userId: "shared-id", sessions: 1, seconds: 120 }], totals: { sessions: 1, seconds: 120 } }
    });
    // Asking for another project's user by name searches only the key's project.
    expect(projectUsageForApiKey(kiosk.apiKey, { userId: "shop-user" })).toMatchObject({
      ok: true,
      value: { users: [], totals: { sessions: 0, seconds: 0 } }
    });
  });

  it("needs a live project key: none, a wrong one, a rotated one and a console login are refused", async () => {
    const project = await setup();
    const rotated = rotateProjectKey(project.customerId, project.projectId);
    if (!rotated.ok) throw new Error(rotated.error);
    const stranger = await signup(`c${randomBytes(4).toString("hex")}@example.com`, "correct horse battery");
    if (!stranger.ok) throw new Error(stranger.error);
    const refused = { ok: false, status: 401, error: "Unknown or revoked project key." };
    // The key that was rotated out is as dead as a made-up one, and a console login is no project key.
    for (const key of [
      "",
      "mpk_",
      `${rotated.value.apiKey}x`,
      "mcs_not-a-project-key",
      project.apiKey,
      stranger.value.token
    ]) {
      expect(projectUsageForApiKey(key, {}), key).toEqual(refused);
    }
    expect(projectUsageForApiKey(rotated.value.apiKey, { month: "nope" })).toMatchObject({ ok: false, status: 400 });
  });

  it("is limited per project, whoever holds the key", async () => {
    const shop = await setup("Shop");
    const kiosk = await setup("Kiosk");
    for (let ask = 0; ask < 60; ask += 1) expect(projectUsageForApiKey(shop.apiKey, {}).ok).toBe(true);
    expect(projectUsageForApiKey(shop.apiKey, {})).toEqual({
      ok: false,
      status: 429,
      error: "At most 60 usage reports a minute per project."
    });
    expect(projectUsageForApiKey(kiosk.apiKey, {}).ok).toBe(true);
    clock += 60_000;
    expect(projectUsageForApiKey(shop.apiKey, {}).ok).toBe(true);
  });
});

describe("a deleted project's usage per user", () => {
  it("is erased with the project, and nothing of it is written afterwards", async () => {
    const project = await setup();
    const usage = booking(project);
    const { customerId, projectId, apiKey } = project;
    patchProject(customerId, projectId, { perUserMonthlyMinutes: 10 });
    expect(chargeSession(usage("a", 120, "u1"))).toBe("booked");
    expect(chargeSession(usage("b", 30))).toBe("booked");
    // A session still running when the project is deleted: its row names its user until then.
    cloudSessionStarted({ sessionId: "s-open", customerId, projectId, userId: "u1" });
    expect(userRows()).toEqual({ n: 2 });

    expect(deleteProject(customerId, projectId)).toEqual({ ok: true, value: { ok: true } });
    expect(userRows()).toEqual({ n: 0 });
    expect(report(projectId).users).toEqual([]);
    expect(
      immediate((db) => db.prepare("SELECT per_user_minutes_cap FROM projects WHERE id = ?").get(projectId))
    ).toEqual({ per_user_minutes_cap: null });
    expect(liveSessionRows({ projectId })[0]!.user_id).toBeNull();
    // The session ends and is still charged, in the ledger and to the customer, but to no user.
    expect(
      cloudSessionEnded({ customerId, projectId, sessionId: "s-open", seconds: 30, endedAt: clock, userId: "u1" })
    ).toBe("booked");
    expect(chargeSession(usage("later", 5, "u1"))).toBe("booked");
    expect(userRows()).toEqual({ n: 0 });
    expect(usageSummary(customerId, "2026-11").projects).toEqual([
      { projectId, name: "Shop", seconds: 185, chargedFen: 0 }
    ]);
    expect(projectUsageForApiKey(apiKey, {})).toMatchObject({ ok: false, status: 401 });
  });

  it("left behind by an earlier release is erased the next time the database is opened", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-user-usage-"));
    const file = path.join(directory, "cloud.sqlite");
    try {
      resetCloudDatabase(file);
      const project = await setup();
      expect(chargeSession(booking(project)("a", 120, "u1"))).toBe("booked");
      // A release that knew nothing of this usage deletes the project.
      const older = new DatabaseSync(file);
      try {
        older.prepare("UPDATE projects SET deleted_at = ? WHERE id = ?").run(clock, project.projectId);
      } finally {
        older.close();
      }
      resetCloudDatabase(file); // the relay starts again: the purge runs
      expect(userRows()).toEqual({ n: 0 });
    } finally {
      resetCloudDatabase(":memory:");
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is in the backup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-user-backup-"));
    const file = path.join(directory, "cloud.sqlite");
    try {
      resetCloudDatabase(file);
      const project = await setup();
      expect(chargeSession(booking(project)("a", 120, "u1"))).toBe("booked");
      const copy = new DatabaseSync(backupDatabase(path.join(directory, "backup.sqlite")), { readOnly: true });
      try {
        expect(copy.prepare("SELECT project_id, month, user_id, sessions, seconds FROM user_usage").all()).toEqual([
          { project_id: project.projectId, month: "2026-11", user_id: "u1", sessions: 1, seconds: 120 }
        ]);
      } finally {
        copy.close();
      }
    } finally {
      resetCloudDatabase(":memory:");
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
