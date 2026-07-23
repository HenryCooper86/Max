# Web Admin Review and Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix confirmed web/server Admin defects and replace the settings-nested testing console with a responsive, Chinese-first, full-width Admin workspace.

**Architecture:** `App` keeps the existing `useHelmetAgent` and authentication state alive while switching among Voice, Settings, and a lazy Admin workspace. Pure Admin models define role-scoped navigation, corpus-wide derived metrics, session merging, and request states; typed API results preserve HTTP failure causes; focused workspace sections consume one shared testing-data hook instead of the current monolith.

**Tech Stack:** React 19, TypeScript 7, Vite 8, Vitest 4, Express 5, CSS, ESLint, Knip, Prettier

## Global Constraints

- Scope is the React web client, Node/Express server, and shared TypeScript used by those surfaces.
- Do not modify native iOS or Android UI, audio, networking, or generated protocol code.
- Do not add a router, a public `/admin` route, or a third-party dependency.
- Preserve the existing `useHelmetAgent` instance, relay connection, authentication state, and active voice session when opening or leaving Admin.
- Preserve server-side role enforcement. Testers see their own assignments/evidence; reviewers see corpus/review tools; administrators additionally manage accounts, approvals, policies, and destructive actions.
- Use Chinese-first copy while retaining established technical terms: QA, ASR, build, PASS, WATCH, FAIL, P95, TTS, iOS, and Android.
- Preserve deterministic evaluation as release authority and retain no raw microphone audio.
- Destructive actions require a target-specific second confirmation that expires after four seconds.
- Every confirmed behavior defect gets a failing regression test before production code changes.
- Add no production function without a focused test of its behavior.
- All final repository gates, including the aggregate `npm run check`, must pass.

---

## File Structure

### Create

- `src/lib/api-client.ts` — typed JSON request success/failure boundary.
- `src/components/admin/admin-model.ts` — pure navigation, permission, status, corpus metrics, filtering, and session merge rules.
- `src/components/admin/useAdminTestingData.ts` — shared Admin summary/session/operations request state.
- `src/components/admin/AdminWorkspace.tsx` — full-width shell, header, section navigation, auth-expiry handoff, and section composition.
- `src/components/admin/AdminOverview.tsx` — release gate, queue, evidence, latency, prioritized work, and release progress.
- `src/components/admin/ReleaseValidation.tsx` — release runs, assignments, coverage, approval, and baseline comparison.
- `src/components/admin/EvidenceWorkspace.tsx` — filters, tester/session evidence, pagination, details, notes, and review issue actions.
- `src/components/admin/AccountManagement.tsx` — accounts, roles, invitation links, expiry state, and protected deletion.
- `src/components/admin/GovernanceWorkspace.tsx` — testing policy publication and audit history.
- `tests/api-client.test.ts` — typed request success and failure mapping.
- `tests/admin-model.test.ts` — pure Admin behavior and regression coverage.

### Modify

- `src/App.tsx` — explicit Voice/Settings/Admin surface state and lazy Admin entry.
- `src/components/WebSettingsSheet.tsx` — replace the embedded console with an Admin-workspace entry card.
- `src/components/AccountBar.tsx` — keep `AccountForm`, replace the nullable `AccountBar` wrapper with authenticated-only `AccountSessionControls`.
- `src/lib/testing-api.ts` — return typed results for every Admin testing endpoint.
- `src/lib/auth.ts` — return typed results for Admin account endpoints.
- `src/lib/utils.ts` — remove the boolean-only testing-clear request in favor of the typed API boundary.
- `src/styles.css` — dedicated workspace layout, responsive navigation, focused section styles, and removal of obsolete nested-console rules.
- `server/index.ts` — validate invite revocation input and report whether a target was removed.
- `tests/server-integration.test.ts` — Admin endpoint validation regression coverage.
- `.superpowers/sdd/*.md` — mechanical formatting only so the existing aggregate repository check no longer stops before code checks.

### Delete after migration

- `src/components/TestingAdminPanel.tsx`
- `src/components/TestingControlPlane.tsx`
- `src/components/AccountAdmin.tsx`

`src/components/AccountBar.tsx` remains because `LoginGate.tsx` consumes `AccountForm`. Task 8 replaces the nullable `AccountBar` wrapper with authenticated-only `AccountSessionControls`, preserving token copy, password change, memory clearing, and sign-out for every role.

---

### Task 1: Pure Admin model and confirmed derived-state regressions

**Files:**

- Create: `src/components/admin/admin-model.ts`
- Create: `tests/admin-model.test.ts`

**Interfaces:**

- Consumes: `AuthUser["role"]`, `TesterStats`, `TesterSessionSummary`, and `TestingQuality`.
- Produces:
  - `AppSurface = "voice" | "settings" | "admin"`
  - `AdminSection = "overview" | "releases" | "evidence" | "accounts" | "governance"`
  - `ADMIN_SECTION_LABELS`
  - `allowedAdminSections(role)`
  - `normalizeAdminSection(section, role)`
  - `surfaceAfterAuthentication(surface, authenticated)`
  - `corpusIssueCount(users)`
  - `mergeAdminSessions(current, incoming)`
  - `adminRoleLabel(role)`
  - `confirmationCopy(kind, target)`

- [ ] **Step 1: Write the failing pure-model tests**

Create `tests/admin-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TesterSessionSummary, TesterStats } from "../shared/agent";
import {
  allowedAdminSections,
  adminRoleLabel,
  confirmationCopy,
  corpusIssueCount,
  mergeAdminSessions,
  normalizeAdminSection,
  surfaceAfterAuthentication
} from "../src/components/admin/admin-model";

function tester(overrides: Partial<TesterStats> = {}): TesterStats {
  return {
    testerKey: "tester-key",
    testerId: "rider",
    ipAddress: "127.0.0.1",
    region: "local",
    activeSessions: 0,
    totalSessions: 0,
    totalSessionMs: 0,
    audioUpBytes: 0,
    audioDownBytes: 0,
    controlDownBytes: 0,
    micFrames: 0,
    serverEvents: 0,
    latencySamples: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    errorEvents: 0,
    ttsFallbacks: 0,
    qualityCounts: { pass: 0, watch: 0, fail: 0 },
    lastSeenAt: 0,
    recentTurns: [],
    ...overrides
  };
}

function session(sessionId: string, endedAt: number): TesterSessionSummary {
  return {
    sessionId,
    testerKey: "tester-key",
    testerId: "rider",
    ipAddress: "127.0.0.1",
    region: "local",
    campaignId: "campaign",
    campaignName: "Campaign",
    testCaseId: "case",
    testCaseName: "Case",
    appVersion: "0.1.0",
    gitCommit: "local",
    deviceLabel: "browser",
    browserLanguage: "zh-CN",
    networkType: "wifi",
    platform: "web",
    startedAt: endedAt - 1_000,
    endedAt,
    durationMs: 1_000,
    audioUpBytes: 0,
    audioDownBytes: 0,
    controlDownBytes: 0,
    micFrames: 0,
    serverEvents: 0,
    latencySamples: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    errorEvents: 0,
    ttsFallbacks: 0,
    quality: "pass",
    validity: { status: "valid", detail: "", reasons: [] },
    flags: [],
    notes: "",
    policyVersion: "policy-v1",
    evidenceHash: "digest",
    evidenceIntegrity: "verified",
    capturedEvaluation: { testCaseId: "case", testCaseName: "Case", score: 100, quality: "pass", checks: [] },
    capturedValidity: { status: "valid", detail: "", reasons: [] },
    audioQuality: { droppedFrames: 0, outgoingFps: 0, jitterMs: 0, clippingPct: 0, silencePct: 0 },
    evaluation: { testCaseId: "case", testCaseName: "Case", score: 100, quality: "pass", checks: [] },
    turns: []
  };
}

describe("Admin navigation permissions", () => {
  it("shows only role-authorized workspace sections", () => {
    expect(allowedAdminSections("tester")).toEqual(["overview", "releases", "evidence"]);
    expect(allowedAdminSections("reviewer")).toEqual(["overview", "releases", "evidence", "governance"]);
    expect(allowedAdminSections("admin")).toEqual(["overview", "releases", "evidence", "accounts", "governance"]);
    expect(normalizeAdminSection("accounts", "reviewer")).toBe("overview");
  });

  it("returns to the login flow when authentication is lost", () => {
    expect(surfaceAfterAuthentication("admin", false)).toBe("voice");
    expect(surfaceAfterAuthentication("admin", true)).toBe("admin");
  });
});

describe("Admin derived data", () => {
  it("counts issues across the full server aggregate instead of the loaded page", () => {
    expect(
      corpusIssueCount([
        tester({ qualityCounts: { pass: 120, watch: 4, fail: 2 } }),
        tester({ testerKey: "second", qualityCounts: { pass: 80, watch: 3, fail: 1 } })
      ])
    ).toBe(10);
  });

  it("keeps an externally selected detail through the next first-page refresh", () => {
    const external = session("external", 30);
    const merged = mergeAdminSessions([external, session("old", 10)], [session("new", 40), session("old", 50)]);

    expect(merged.map((item) => [item.sessionId, item.endedAt])).toEqual([
      ["old", 50],
      ["new", 40],
      ["external", 30]
    ]);
  });

  it("uses Chinese role and target-specific confirmation copy", () => {
    expect(adminRoleLabel("reviewer")).toBe("审核员");
    expect(confirmationCopy("user", "@alice")).toContain("@alice");
    expect(confirmationCopy("all-evidence", "全部测试证据")).toContain("全部测试证据");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- tests/admin-model.test.ts
```

Expected: FAIL because `src/components/admin/admin-model.ts` does not exist.

- [ ] **Step 3: Implement the pure model**

Create `src/components/admin/admin-model.ts`:

```ts
import type { TesterSessionSummary, TesterStats } from "../../../shared/agent";
import type { AuthUser } from "../../lib/auth";

export type AppSurface = "voice" | "settings" | "admin";
export type AdminSection = "overview" | "releases" | "evidence" | "accounts" | "governance";

export const ADMIN_SECTION_LABELS: Record<AdminSection, string> = {
  overview: "概览",
  releases: "发布验证",
  evidence: "证据与问题",
  accounts: "账号管理",
  governance: "策略与审计"
};

const BASE_SECTIONS: AdminSection[] = ["overview", "releases", "evidence"];

export function allowedAdminSections(role: AuthUser["role"]): AdminSection[] {
  if (role === "admin") return [...BASE_SECTIONS, "accounts", "governance"];
  if (role === "reviewer") return [...BASE_SECTIONS, "governance"];
  return [...BASE_SECTIONS];
}

export function normalizeAdminSection(section: AdminSection, role: AuthUser["role"]): AdminSection {
  return allowedAdminSections(role).includes(section) ? section : "overview";
}

export function surfaceAfterAuthentication(surface: AppSurface, authenticated: boolean): AppSurface {
  return authenticated ? surface : "voice";
}

export function corpusIssueCount(users: TesterStats[]): number {
  return users.reduce((sum, user) => sum + user.qualityCounts.watch + user.qualityCounts.fail, 0);
}

export function mergeAdminSessions(
  current: TesterSessionSummary[],
  incoming: TesterSessionSummary[]
): TesterSessionSummary[] {
  const byId = new Map(current.map((item) => [item.sessionId, item]));
  for (const item of incoming) byId.set(item.sessionId, item);
  return [...byId.values()].sort((a, b) => b.endedAt - a.endedAt || b.sessionId.localeCompare(a.sessionId));
}

export function adminRoleLabel(role: AuthUser["role"]): string {
  return role === "admin" ? "管理员" : role === "reviewer" ? "审核员" : "测试员";
}

export function confirmationCopy(kind: "user" | "invite" | "session" | "tester" | "all-evidence", target: string) {
  const action = kind === "user" ? "删除" : kind === "invite" ? "撤销" : "清除";
  return `确认${action} ${target}？`;
}
```

- [ ] **Step 4: Verify GREEN and the full pure suite**

Run:

```bash
npm test -- tests/admin-model.test.ts
npm test
```

Expected: focused tests pass; all existing tests remain green.

- [ ] **Step 5: Commit the model**

```bash
git add src/components/admin/admin-model.ts tests/admin-model.test.ts
git commit -m "test(admin): define workspace state and corpus metrics"
```

---

### Task 2: Typed Admin API results

**Files:**

- Create: `src/lib/api-client.ts`
- Create: `tests/api-client.test.ts`
- Modify: `src/lib/testing-api.ts`
- Modify: `src/lib/auth.ts`
- Modify: `src/lib/utils.ts`

**Interfaces:**

- Produces:
  - `ApiErrorKind = "unauthorized" | "forbidden" | "not-found" | "conflict" | "invalid" | "server" | "unavailable"`
  - `ApiError`
  - `ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError }`
  - `requestJson<T>(path, init)`
- `testingApi` exposes typed `ApiResult<T>` methods alongside the current nullable compatibility functions until Task 8 deletes the old Admin components.
- `adminAccountApi` exposes typed account methods alongside the current compatibility functions until Task 8.
- Task 8 removes the compatibility functions, leaving only typed Admin request paths.

- [ ] **Step 1: Write failing API-boundary tests**

Create `tests/api-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "../src/lib/api-client";

afterEach(() => vi.unstubAllGlobals());

describe("requestJson", () => {
  it("returns typed success data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: 7 })
      })
    );

    await expect(requestJson<{ ok: true; value: number }>("/testing/example")).resolves.toEqual({
      ok: true,
      data: { ok: true, value: 7 }
    });
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not-found"],
    [409, "conflict"],
    [400, "invalid"],
    [500, "server"]
  ] as const)("maps HTTP %s to %s and keeps the server message", async (status, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        json: async () => ({ ok: false, error: "具体错误" })
      })
    );

    await expect(requestJson("/testing/example")).resolves.toEqual({
      ok: false,
      error: { kind, status, message: "具体错误" }
    });
  });

  it("distinguishes an unavailable relay from an HTTP rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(requestJson("/testing/example")).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable", message: "无法连接中继，请稍后重试。" }
    });
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- tests/api-client.test.ts
```

Expected: FAIL because `src/lib/api-client.ts` does not exist.

- [ ] **Step 3: Implement the request boundary**

Create `src/lib/api-client.ts`:

```ts
export type ApiErrorKind =
  "unauthorized" | "forbidden" | "not-found" | "conflict" | "invalid" | "server" | "unavailable";

export type ApiError = { kind: ApiErrorKind; message: string; status?: number };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

function errorKind(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "invalid";
  return "server";
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, init);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `请求失败（HTTP ${response.status}）。`;
      return { ok: false, error: { kind: errorKind(response.status), status: response.status, message } };
    }
    return { ok: true, data: payload as T };
  } catch {
    return { ok: false, error: { kind: "unavailable", message: "无法连接中继，请稍后重试。" } };
  }
}
```

- [ ] **Step 4: Add the typed testing API without breaking current consumers**

Modify `src/lib/testing-api.ts` to export this typed object while retaining the existing named nullable functions for the old components during migration:

```ts
export type TestingApi = {
  fetchSummary: () => Promise<ApiResult<TestingStats>>;
  fetchSessions: (query?: TestingSessionQuery) => Promise<ApiResult<TestingSessionPage<TesterSessionSummary>>>;
  fetchSession: (sessionId: string) => Promise<ApiResult<TesterSessionSummary>>;
  updateSessionNotes: (sessionId: string, notes: string) => Promise<ApiResult<TesterSessionSummary>>;
  fetchOperations: () => Promise<ApiResult<{ operations: TestingOperationsSnapshot; policies: TestingPolicy[] }>>;
  fetchRuns: () => Promise<ApiResult<TestingRun[]>>;
  createRun: (input: {
    name: string;
    build: string;
    owner: string;
    dueAt?: number;
    notes?: string;
  }) => Promise<ApiResult<TestingRun>>;
  updateRun: (
    runId: string,
    patch: Partial<Pick<TestingRun, "status" | "owner" | "dueAt" | "notes">>
  ) => Promise<ApiResult<TestingRun>>;
  createAssignment: (runId: string, requirementId: string, assignee: string) => Promise<ApiResult<TestingRun>>;
  saveReview: (input: Partial<TestingReview> & { sessionId: string }) => Promise<ApiResult<TestingReview>>;
  createPolicy: (input: Partial<TestingPolicy>) => Promise<ApiResult<TestingPolicy>>;
  clear: (payload: TestingClearScope) => Promise<ApiResult<TestingClearResult>>;
};

export type CreateTestingRunInput = Parameters<TestingApi["createRun"]>[0];
export type UpdateTestingRunPatch = Parameters<TestingApi["updateRun"]>[1];

export const testingApi: TestingApi = {
  fetchSummary,
  fetchSessions,
  fetchSession,
  updateSessionNotes,
  fetchOperations,
  fetchRuns,
  createRun,
  updateRun,
  createAssignment,
  saveReview,
  createPolicy,
  clear
};
```

Each method transforms only the success payload, for example:

```ts
async function fetchSummary(): Promise<ApiResult<TestingStats>> {
  const result = await requestJson<{ ok: true; testing: TestingStats }>("/testing/summary", { headers: headers() });
  return result.ok ? { ok: true, data: result.data.testing } : result;
}
```

Define:

```ts
export type TestingClearScope =
  { scope: "all" } | { scope: "tester"; testerKey: string } | { scope: "session"; sessionId: string };

export type TestingClearResult = { removedTesters: number; removedSessions: number };
```

Keep `TestingClearScope` and `requestTestingClear` in `src/lib/utils.ts` until the old Admin component is deleted in Task 8.

- [ ] **Step 5: Add typed Admin account methods**

Modify the Admin-only portion of `src/lib/auth.ts` to export:

```ts
export type AdminAccountApi = {
  fetchOverview: () => Promise<ApiResult<AdminOverview>>;
  createInvite: () => Promise<ApiResult<InviteInfo>>;
  revokeInvite: (code: string) => Promise<ApiResult<{ removed: boolean }>>;
  deleteUser: (username: string) => Promise<ApiResult<AuthUser>>;
  updateRole: (username: string, role: AuthUser["role"]) => Promise<ApiResult<AuthUser>>;
};

export const adminAccountApi: AdminAccountApi = {
  fetchOverview,
  createInvite,
  revokeInvite,
  deleteUser,
  updateRole
};
```

Keep the current named Admin wrappers temporarily so the old `AccountAdmin.tsx` still compiles. Login, registration, current-user revalidation, password, and memory APIs remain unchanged because their result semantics are consumed by the login flow and are outside this Admin request migration.

- [ ] **Step 6: Verify the typed boundary and compatibility build**

Run:

```bash
npm test -- tests/api-client.test.ts
npm run build
```

Expected: the focused test and production build both pass. No existing consumer changes behavior in this task.

- [ ] **Step 7: Commit the typed boundary**

```bash
git add src/lib/api-client.ts src/lib/testing-api.ts src/lib/auth.ts src/lib/utils.ts tests/api-client.test.ts
git commit -m "refactor(admin): preserve API failure causes"
```

---

### Task 3: Server validation for invitation revocation

**Files:**

- Modify: `tests/server-integration.test.ts`
- Modify: `server/index.ts:285-291`

**Interfaces:**

- `POST /auth/admin/invites/revoke` returns:
  - HTTP 400 with `{ ok: false, error }` when `code` is absent or not a string.
  - HTTP 200 with `{ ok: true, removed: true }` for a live invite.
  - HTTP 200 with `{ ok: true, removed: false }` for an already-revoked well-formed code, preserving idempotency.

- [ ] **Step 1: Add the failing integration regression**

In the first test in `tests/server-integration.test.ts`, immediately after registration, add:

```ts
const missingInviteCode = await fetch(`${baseUrl}/auth/admin/invites/revoke`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${registered.token}`,
    Connection: "close"
  },
  body: JSON.stringify({})
});
expect(missingInviteCode.status).toBe(400);
await expect(missingInviteCode.json()).resolves.toMatchObject({ ok: false });

const createdInvite = await fetch(`${baseUrl}/auth/admin/invites`, {
  method: "POST",
  headers: { Authorization: `Bearer ${registered.token}`, Connection: "close" }
});
const invitePayload = (await createdInvite.json()) as { invite: { code: string } };
const revokeInvite = await fetch(`${baseUrl}/auth/admin/invites/revoke`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${registered.token}`,
    Connection: "close"
  },
  body: JSON.stringify({ code: invitePayload.invite.code })
});
expect(revokeInvite.status).toBe(200);
await expect(revokeInvite.json()).resolves.toEqual({ ok: true, removed: true });
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/server-integration.test.ts
```

Expected: FAIL because missing `code` currently returns HTTP 200 and successful revocation omits `removed`.

- [ ] **Step 3: Implement request validation**

Replace the route body in `server/index.ts` with:

```ts
app.post("/auth/admin/invites/revoke", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.code !== "string" || !body.code.trim()) {
    res.status(400).json({ ok: false, error: "邀请代码不能为空。" });
    return;
  }
  const removed = revokeInvite(body.code);
  res.json({ ok: true, removed });
});
```

- [ ] **Step 4: Verify focused and auth suites**

Run:

```bash
npm test -- tests/server-integration.test.ts tests/auth.test.ts
```

Expected: both test files pass.

- [ ] **Step 5: Commit the endpoint correction**

```bash
git add server/index.ts tests/server-integration.test.ts
git commit -m "fix(admin): validate invite revocation"
```

---

### Task 4: Top-level Admin surface and settings entry

**Files:**

- Create: `src/components/admin/AdminWorkspace.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/WebSettingsSheet.tsx`
- Test: `tests/admin-model.test.ts`

**Interfaces:**

- `AdminWorkspace` consumes:

```ts
type AdminWorkspaceProps = {
  agent: HelmetAgent;
  user: AuthUser;
  onAuthenticationExpired: () => void;
  onClose: () => void;
};
```

- `WebSettingsSheet` removes `authUser`, `onSignedIn`, and `onSignedOut`, then gains `onOpenAdmin: () => void`.
- `App` uses `AppSurface` instead of `settingsOpen`.

- [ ] **Step 1: Add the view-transition regression**

Extend `tests/admin-model.test.ts`:

```ts
it("keeps authenticated workspace surfaces explicit", () => {
  expect(surfaceAfterAuthentication("settings", true)).toBe("settings");
  expect(surfaceAfterAuthentication("admin", true)).toBe("admin");
  expect(surfaceAfterAuthentication("settings", false)).toBe("voice");
});
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
npm test -- tests/admin-model.test.ts
```

Expected: PASS because Task 1 already supplied the pure transition. This is a behavior lock before wiring React state.

- [ ] **Step 3: Add the lazy workspace shell**

Create `src/components/admin/AdminWorkspace.tsx` with:

```tsx
import { ArrowLeft, Broadcast, ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { HelmetAgent } from "../../hooks/useHelmetAgent";
import type { AuthUser } from "../../lib/auth";
import {
  ADMIN_SECTION_LABELS,
  adminRoleLabel,
  allowedAdminSections,
  normalizeAdminSection,
  type AdminSection
} from "./admin-model";

type Props = {
  agent: HelmetAgent;
  user: AuthUser;
  onAuthenticationExpired: () => void;
  onClose: () => void;
};

export function AdminWorkspace({ agent, user, onAuthenticationExpired: _onAuthenticationExpired, onClose }: Props) {
  const [section, setSection] = useState<AdminSection>("overview");
  const closeRef = useRef<HTMLButtonElement>(null);
  const allowed = allowedAdminSections(user.role);
  const active = normalizeAdminSection(section, user.role);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <main className="adminWorkspace">
      <header className="adminWorkspaceHeader">
        <div className="adminWorkspaceBrand">
          <span className="adminWorkspaceLogo">M</span>
          <div>
            <small>MAX QA</small>
            <h1>测试与管理</h1>
          </div>
        </div>
        <div className="adminWorkspaceContext">
          <span className={agent.connected ? "online" : ""}>
            <Broadcast aria-hidden="true" /> {agent.connected ? "中继在线" : "中继离线"}
          </span>
          <span>
            <ShieldCheck aria-hidden="true" /> @{user.username} · {adminRoleLabel(user.role)}
          </span>
          <button ref={closeRef} type="button" onClick={onClose}>
            <ArrowLeft aria-hidden="true" /> 返回 Max
          </button>
        </div>
      </header>
      <div className="adminWorkspaceLayout">
        <nav className="adminWorkspaceNav" aria-label="Admin 工作区">
          {allowed.map((item) => (
            <button
              type="button"
              key={item}
              className={active === item ? "active" : ""}
              aria-current={active === item ? "page" : undefined}
              onClick={() => setSection(item)}
            >
              {ADMIN_SECTION_LABELS[item]}
            </button>
          ))}
        </nav>
        <section className="adminWorkspaceContent" aria-live="polite">
          <p className="adminWorkspaceLoading">正在加载 {ADMIN_SECTION_LABELS[active]}…</p>
        </section>
      </div>
    </main>
  );
}
```

The underscore-prefixed authentication callback is temporary only until Task 5 wires typed request expiry; it must not remain after Task 5.

- [ ] **Step 4: Replace `settingsOpen` with one explicit surface**

In `src/App.tsx`:

```tsx
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { surfaceAfterAuthentication, type AppSurface } from "./components/admin/admin-model";

const AdminWorkspace = lazy(() =>
  import("./components/admin/AdminWorkspace").then((module) => ({ default: module.AdminWorkspace }))
);

const [surface, setSurface] = useState<AppSurface>("voice");
const closeSettings = useCallback(() => setSurface("voice"), []);
const openSettings = useCallback(() => setSurface("settings"), []);
const openAdmin = useCallback(() => setSurface("admin"), []);
```

Update `handleSignedOut` to call:

```ts
setSurface((current) => surfaceAfterAuthentication(current, false));
```

Update the Space-key guard to use `surface !== "voice"` and change the settings button to `openSettings`. Immediately before the normal voice-surface return, add:

```tsx
if (surface === "admin") {
  return (
    <Suspense fallback={<main className="adminWorkspace adminWorkspaceLoading">正在加载测试与管理…</main>}>
      <AdminWorkspace
        agent={agent}
        user={authUser}
        onAuthenticationExpired={handleSignedOut}
        onClose={() => setSurface("voice")}
      />
    </Suspense>
  );
}
```

Inside the existing voice-surface return, render Settings only for its explicit state:

```tsx
{
  surface === "settings" ? <WebSettingsSheet agent={agent} onOpenAdmin={openAdmin} onClose={closeSettings} /> : null;
}
```

This conditional return prevents `voiceFace` from rendering under Admin while `App` and `useHelmetAgent` remain mounted.

- [ ] **Step 5: Replace the nested console with an entry card**

In `src/components/WebSettingsSheet.tsx`:

- Remove `lazy`, `Suspense`, `useState`, `TestingAdminPanel`, and `advancedOpen`.
- Remove `authUser`, `onSignedIn`, and `onSignedOut` from `Props` and the component parameters because their only consumer was the embedded Admin panel.
- Add `onOpenAdmin` to `Props`.
- Replace the entire `<details className="advancedSettings">` block with:

```tsx
<section className="settingsCard adminEntryCard">
  <div className="settingsCardTitle">
    <Flask size={22} aria-hidden="true" />
    <div>
      <h2>测试与管理</h2>
      <p>账号、发布验证、会话证据和运营工具</p>
    </div>
  </div>
  <button type="button" className="adminEntryAction" onClick={onOpenAdmin}>
    打开 Admin 工作区
  </button>
</section>
```

- [ ] **Step 6: Verify the focused model, lint, and build**

Run:

```bash
npm test -- tests/admin-model.test.ts
npm run lint
npm run build
```

Expected: all commands pass. The compatibility wrappers keep the old components buildable until their migration completes.

- [ ] **Step 7: Commit the surface architecture**

```bash
git add src/App.tsx src/components/WebSettingsSheet.tsx src/components/admin/AdminWorkspace.tsx tests/admin-model.test.ts
git commit -m "feat(admin): add dedicated workspace surface"
```

---

### Task 5: Shared Admin testing data and stable evidence selection

**Files:**

- Create: `src/components/admin/useAdminTestingData.ts`
- Modify: `src/components/admin/AdminWorkspace.tsx`
- Modify: `src/components/admin/admin-model.ts`
- Modify: `tests/admin-model.test.ts`

**Interfaces:**

`useAdminTestingData` returns:

```ts
type AdminTestingData = {
  testing: TestingStats | null;
  sessions: TesterSessionSummary[];
  sessionDetails: Record<string, TesterSessionSummary>;
  operations: TestingOperationsSnapshot | null;
  policies: TestingPolicy[];
  runs: TestingRun[];
  nextCursor?: string;
  sessionTotal: number;
  status: "loading" | "ready" | "stale" | "error";
  error: ApiError | null;
  lastSyncedAt: number | null;
  refresh: (replace?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<TesterSessionSummary | null>;
  saveNotes: (sessionId: string, notes: string) => Promise<boolean>;
  clearEvidence: (scope: TestingClearScope) => Promise<boolean>;
  createRun: (input: CreateTestingRunInput) => Promise<ApiResult<TestingRun>>;
  updateRun: (runId: string, patch: UpdateTestingRunPatch) => Promise<ApiResult<TestingRun>>;
  createAssignment: (runId: string, requirementId: string, assignee: string) => Promise<ApiResult<TestingRun>>;
  saveReview: (input: Partial<TestingReview> & { sessionId: string }) => Promise<ApiResult<TestingReview>>;
  createPolicy: (input: Partial<TestingPolicy>) => Promise<ApiResult<TestingPolicy>>;
};
```

- [ ] **Step 1: Add the failing request-state regression**

Extend `tests/admin-model.test.ts`:

```ts
it("distinguishes an empty load failure from stale previously loaded data", () => {
  expect(adminStatusAfterFailure(false)).toBe("error");
  expect(adminStatusAfterFailure(true)).toBe("stale");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/admin-model.test.ts
```

Expected: FAIL because `adminStatusAfterFailure` does not exist.

- [ ] **Step 3: Implement the request-state rule**

Add to `src/components/admin/admin-model.ts`:

```ts
export type AdminDataStatus = "loading" | "ready" | "stale" | "error";

export function adminStatusAfterFailure(hasLoadedData: boolean): AdminDataStatus {
  return hasLoadedData ? "stale" : "error";
}
```

Import it in the test and use it from the hook whenever a request fails. This replaces the old misleading `statsLocked` state that treated an authenticated initial load failure as an account lock.

- [ ] **Step 4: Implement the shared data hook**

Create `src/components/admin/useAdminTestingData.ts`. Required behavior:

```ts
export function useAdminTestingData({
  user,
  onAuthenticationExpired
}: {
  user: AuthUser;
  onAuthenticationExpired: () => void;
}): AdminTestingData;
```

Implementation rules:

- Fetch summary plus the first 100 sessions in parallel.
- Fetch operations for reviewers/admins; fetch assigned runs for testers.
- On success, merge the first page into current records with `mergeAdminSessions`; never drop an externally loaded selected detail on a timer refresh.
- On `unauthorized`, call `onAuthenticationExpired`.
- On all other errors, retain loaded data, set `status: "stale"`, and expose the typed `ApiError`.
- Set `lastSyncedAt` only after all role-required reads succeed.
- Poll every 10 seconds and clear the timer on unmount/user change.
- `loadMore` guards duplicate calls and appends with `mergeAdminSessions`.
- `loadSession` checks `sessionDetails`, then loads and inserts the detail into both `sessionDetails` and `sessions`.
- `saveNotes` updates the cached detail and summary row only on success.
- `clearEvidence` refreshes with replacement only on success.
- Run, assignment, review, and policy mutation methods delegate to `testingApi`, refresh the affected operations/runs data after success, and return the typed result so each section can show the server message.

Use `useCallback`, `useEffect`, `useRef`, and `useState`; guard every async state write with an `activeRef` that is cleared on unmount.

- [ ] **Step 5: Wire request state into the shell**

In `AdminWorkspace.tsx`, instantiate the hook once and render:

```tsx
{
  data.error ? (
    <div className={`adminSyncNotice ${data.error.kind}`} role="status">
      <strong>{data.status === "stale" ? "数据可能已过期" : "加载失败"}</strong>
      <span>{data.error.message}</span>
      {data.error.kind !== "unauthorized" ? (
        <button type="button" onClick={() => void data.refresh()}>
          重试
        </button>
      ) : null}
    </div>
  ) : null;
}
```

Header freshness copy:

```tsx
<small>{data.lastSyncedAt ? `最近同步 ${formatRelativeTime(data.lastSyncedAt)}` : "等待首次同步"}</small>
```

- [ ] **Step 6: Verify focused tests, lint, and build**

Run:

```bash
npm test -- tests/admin-model.test.ts tests/api-client.test.ts
npm run lint
npm run build
```

Expected: all commands pass; no nullable-result consumer remains in the new hook.

- [ ] **Step 7: Commit the data boundary**

```bash
git add src/components/admin/useAdminTestingData.ts src/components/admin/AdminWorkspace.tsx src/components/admin/admin-model.ts tests/admin-model.test.ts
git commit -m "fix(admin): preserve evidence and request state"
```

---

### Task 6: Overview and Evidence & Issues workspace

**Files:**

- Create: `src/components/admin/AdminOverview.tsx`
- Create: `src/components/admin/EvidenceWorkspace.tsx`
- Modify: `src/components/admin/AdminWorkspace.tsx`
- Migrate from: `src/components/TestingAdminPanel.tsx`
- Test: `tests/admin-model.test.ts`

**Interfaces:**

- `AdminOverview` consumes `agent`, `testing`, `sessions`, `operations`, and `onOpenEvidence(sessionId?)`.
- `EvidenceWorkspace` consumes the shared `AdminTestingData`, current `user`, testing context setters from `agent`, and a notice callback.
- `AdminOverview` must use `corpusIssueCount(testing.users)`, not loaded-page counts.

- [ ] **Step 1: Lock the corpus-wide issue metric**

Run:

```bash
npm test -- tests/admin-model.test.ts -t "counts issues across the full server aggregate"
```

Expected: PASS. This is the regression guard for the old `testingSessions.reduce(...)` undercount.

- [ ] **Step 2: Build the approved overview**

Create `AdminOverview.tsx` with:

- Four metrics: release gate, corpus issue count, valid evidence, and P95 first audio.
- A work queue ordered: release blockers, fail evidence, watch evidence, invalid evidence, missing release coverage.
- Recent release progress sourced from `operations?.runs`.
- No destructive actions.
- Chinese-first copy and retained PASS/WATCH/FAIL status tokens.

Use this component contract:

```tsx
type Props = {
  agent: HelmetAgent;
  testing: TestingStats | null;
  sessions: TesterSessionSummary[];
  operations: TestingOperationsSnapshot | null;
  onOpenEvidence: (sessionId?: string) => void;
  onOpenReleases: () => void;
};
```

For issue count:

```ts
const issueCount = corpusIssueCount(testing?.users ?? []);
```

For the highest-priority loaded evidence:

```ts
const priority = { fail: 3, watch: 2, pass: 1 } as const;
const latestIssue = [...sessions]
  .filter((session) => session.quality !== "pass" || session.flags.length || session.validity.status === "invalid")
  .sort((a, b) => priority[b.quality] - priority[a.quality] || b.endedAt - a.endedAt)[0];
```

- [ ] **Step 3: Extract the evidence workflow**

Create `EvidenceWorkspace.tsx` by migrating the following responsibilities from `TestingAdminPanel.tsx`:

- Tester and session filters.
- Quality filter.
- Campaign/test-case context selection.
- Aggregate metric and timeline displays.
- Tester table.
- Session list and detail.
- On-demand detail load.
- Reviewer notes.
- Session/tester/all evidence clear actions.
- Export actions.

Delete these old behaviors during the move:

- Nullable `authUser`.
- Embedded `AccountBar`.
- `statsLocked`.
- Local polling and `loadedSessionCountRef`.
- Local summary/session API calls.
- Loaded-page-derived global issue count.

Use typed hook methods and target-specific confirmation text:

```tsx
const [armedAction, setArmedAction] = useState<string | null>(null);
const arm = (key: string, action: () => void) => {
  if (armedAction === key) {
    setArmedAction(null);
    action();
  } else {
    setArmedAction(key);
  }
};
```

The confirm label must use `confirmationCopy` and include the session ID, tester ID, or “全部测试证据”.

- [ ] **Step 4: Compose both sections**

In `AdminWorkspace.tsx`:

```tsx
{
  active === "overview" ? (
    <AdminOverview
      agent={agent}
      testing={data.testing}
      sessions={data.sessions}
      operations={data.operations}
      onOpenEvidence={(sessionId) => {
        if (sessionId) void data.loadSession(sessionId);
        setSection("evidence");
      }}
      onOpenReleases={() => setSection("releases")}
    />
  ) : null;
}
{
  active === "evidence" ? <EvidenceWorkspace agent={agent} user={user} data={data} /> : null;
}
```

- [ ] **Step 5: Verify tests, lint, dead-code scan, and build**

Run:

```bash
npm test -- tests/admin-model.test.ts
npm run lint
npm run check:dead-code
npm run build
```

Expected: all commands pass. Knip may still report the old components as used until Tasks 7–8 finish the migration; do not delete live code early.

- [ ] **Step 6: Commit overview and evidence**

```bash
git add src/components/admin/AdminOverview.tsx src/components/admin/EvidenceWorkspace.tsx src/components/admin/AdminWorkspace.tsx src/components/TestingAdminPanel.tsx
git commit -m "feat(admin): add overview and evidence workspaces"
```

---

### Task 7: Release Validation and Governance workspace

**Files:**

- Create: `src/components/admin/ReleaseValidation.tsx`
- Create: `src/components/admin/GovernanceWorkspace.tsx`
- Modify: `src/components/admin/AdminWorkspace.tsx`
- Migrate from: `src/components/TestingControlPlane.tsx`

**Interfaces:**

- `ReleaseValidation` consumes `user`, current build, `data.runs`, `data.operations`, refresh/mutation callbacks, and `onUseAssignment`.
- `GovernanceWorkspace` consumes `user`, `data.operations`, `data.policies`, and refresh/mutation callbacks.
- Review issue creation/status moves into `EvidenceWorkspace`; runs/assignments move to `ReleaseValidation`; policy/audit move to `GovernanceWorkspace`.

- [ ] **Step 1: Extract release operations**

Create `ReleaseValidation.tsx` by moving the run creation, run list, status transition, coverage matrix, assignment owner, and “use next session” workflow from `TestingControlPlane.tsx`.

Required behavior corrections:

- Use typed server error messages rather than generic “could not be changed.”
- Clear a previous error after a successful refresh/mutation.
- Disable only the active mutation target, represented as:

```ts
type BusyTarget =
  { kind: "create-run" } | { kind: "run-status"; id: string } | { kind: "assignment"; id: string } | null;
```

- Keep Admin-only approval options and server enforcement.
- Keep tester platform guidance for native assignments.
- Use Chinese labels for form fields, empty states, and buttons.

- [ ] **Step 2: Move review issue operations into Evidence**

Move the review composer, open review queue, severity/status updates, and selected-evidence binding from `TestingControlPlane.tsx` into `EvidenceWorkspace.tsx`.

After a successful mutation:

```ts
setNotice({ tone: "success", message: "复核记录已保存并写入审计日志。" });
await data.refresh();
```

On failure:

```ts
setNotice({ tone: "error", message: result.error.message });
```

- [ ] **Step 3: Extract policy and audit**

Create `GovernanceWorkspace.tsx` with two internal tabs: `policy` and `audit`.

Required rules:

- Reviewers can read policy and audit.
- Only administrators can edit/publish.
- Reset the policy draft whenever `activePolicy.version` changes; do not keep the old `policyInitializedRef` behavior that can leave fields stale.
- Preserve numeric floors: latency ≥ 100, invalid evidence ≥ 0, safety samples ≥ 1.
- Show typed publication failures.
- Use Chinese-first labels and readable audit detail rather than “No extra detail.”

Use:

```ts
useEffect(() => {
  setPolicyLatency(activePolicy.release.maxP95LatencyMs);
  setPolicyInvalid(activePolicy.release.maxInvalidSessions);
  setPolicySafetySamples(activePolicy.release.minSafetyCriticalSessions);
  setPolicyDescription("");
}, [activePolicy.version]);
```

- [ ] **Step 4: Compose the sections**

In `AdminWorkspace.tsx`:

```tsx
{
  active === "releases" ? <ReleaseValidation agent={agent} user={user} data={data} /> : null;
}
{
  active === "governance" ? <GovernanceWorkspace user={user} data={data} /> : null;
}
```

- [ ] **Step 5: Verify lint, typecheck/build, and focused tests**

Run:

```bash
npm test -- tests/admin-model.test.ts tests/api-client.test.ts
npm run lint
npm run build
```

Expected: all commands pass.

- [ ] **Step 6: Commit release and governance extraction**

```bash
git add src/components/admin/ReleaseValidation.tsx src/components/admin/GovernanceWorkspace.tsx src/components/admin/EvidenceWorkspace.tsx src/components/admin/AdminWorkspace.tsx src/components/TestingControlPlane.tsx
git commit -m "refactor(admin): split release and governance workflows"
```

---

### Task 8: Account Management and removal of unreachable Admin branches

**Files:**

- Create: `src/components/admin/AccountManagement.tsx`
- Modify: `src/components/admin/AdminWorkspace.tsx`
- Modify: `src/components/AccountBar.tsx`
- Migrate from: `src/components/AccountAdmin.tsx`
- Delete: `src/components/TestingAdminPanel.tsx`
- Delete: `src/components/TestingControlPlane.tsx`
- Delete: `src/components/AccountAdmin.tsx`

**Interfaces:**

- `AccountManagement` consumes `user: AuthUser` and `onAuthenticationExpired`.
- It uses typed account APIs and role labels from `admin-model.ts`.
- `AdminWorkspace` renders it only when `user.role === "admin"`.
- `AccountSessionControls` consumes a non-null `user` and `onSignedOut`; it is available to all roles.

- [ ] **Step 1: Build typed account management**

Create `AccountManagement.tsx` from the current account UI with these corrections:

- Load state is explicit: `loading`, `ready`, or `stale`.
- An HTTP 401 calls `onAuthenticationExpired`.
- An HTTP 403 shows the server message.
- Revocation checks `removed`; an already-used/revoked invite reports “邀请已不存在，无需再次撤销。”
- Clipboard failures do not claim success; show “链接已生成，但无法写入剪贴板。”
- Role labels and options are Chinese.
- Deletion confirmation includes `@username`.
- Successful mutations refresh and clear prior error notices.
- Timers and async writes are cleaned up on unmount.

Role options:

```tsx
<option value="tester">测试员</option>
<option value="reviewer">审核员</option>
<option value="admin">管理员</option>
```

- [ ] **Step 2: Compose Admin-only accounts**

In `AdminWorkspace.tsx`:

```tsx
{
  active === "accounts" && user.role === "admin" ? (
    <AccountManagement user={user} onAuthenticationExpired={onAuthenticationExpired} />
  ) : null;
}
```

- [ ] **Step 3: Preserve authenticated session controls without the dead login branch**

In `src/components/AccountBar.tsx`:

- Keep `AccountForm` and its login/registration behavior unchanged for `LoginGate.tsx`.
- Rename the current authenticated `AccountBar` behavior to:

```tsx
export function AccountSessionControls({ user, onSignedOut }: { user: AuthUser; onSignedOut: () => void }) {
  // Keep token copy, password change, memory summary/clear, and logout state.
  // Render only the current `if (user)` branch; remove the nullable-user branch.
}
```

- Remove `authEnabled`, `registrationOpen`, nullable `user`, and `onSignedIn` from this authenticated component.
- Preserve the existing async cleanup and four-second memory-clear confirmation.

Render `AccountSessionControls` in the Admin navigation footer for every role:

```tsx
<AccountSessionControls user={user} onSignedOut={onAuthenticationExpired} />
```

- [ ] **Step 4: Delete migrated monoliths**

After every rendered block exists in a new workspace:

```bash
git rm src/components/TestingAdminPanel.tsx
git rm src/components/TestingControlPlane.tsx
git rm src/components/AccountAdmin.tsx
```

Confirm the split account interfaces have only their intended callers:

```bash
rg -n "AccountBar|AccountForm|AccountSessionControls" src
```

Expected: `LoginGate.tsx` uses `AccountForm`; `AdminWorkspace.tsx` uses `AccountSessionControls`; no `AccountBar` symbol remains.

- [ ] **Step 5: Remove temporary compatibility request functions**

From `src/lib/testing-api.ts`, remove the old named nullable wrappers now that no component imports them. Keep only `testingApi`, its public types, header construction, and private typed helpers.

From the Admin-only portion of `src/lib/auth.ts`, remove `fetchAdminOverview`, `createInviteLink`, `revokeInviteLink`, `deleteUserAccount`, and `updateUserRole`; keep `adminAccountApi`.

Remove `TestingClearScope` and `requestTestingClear` from `src/lib/utils.ts`; the final caller uses `testingApi.clear`.

- [ ] **Step 6: Verify no dead modules or unreachable Admin auth branches remain**

Run:

```bash
rg -n "statsLocked|registrationOpen|onSignedIn|AccountBar|relayAuthToken" src/components/admin
npm run check:dead-code
npm run lint
npm run build
```

Expected: the `rg` command finds none of the removed authenticated-only branches; Knip, lint, and build pass.

- [ ] **Step 7: Commit account migration and dead-code removal**

```bash
git add src/components/admin/AccountManagement.tsx src/components/admin/AdminWorkspace.tsx src/components/AccountBar.tsx src/lib/testing-api.ts src/lib/auth.ts src/lib/utils.ts
git add -u src/components
git commit -m "refactor(admin): remove nested console dead paths"
```

---

### Task 9: Approved visual system, Chinese-first copy, and responsive behavior

**Files:**

- Modify: `src/styles.css`
- Modify: all files under `src/components/admin/`
- Modify: `src/components/WebSettingsSheet.tsx`

**Interfaces:**

- Desktop: 190–220px sidebar and full-width content.
- Tablet: compact sidebar or compressed grid without page overflow.
- Narrow mobile: horizontal section bar and single-column content.
- Status colors: green healthy/live, amber incomplete/caution, red failure/destructive, neutral metadata.

- [ ] **Step 1: Add the workspace shell styles**

Add a dedicated `/* --- Admin workspace --- */` section to `src/styles.css` with:

```css
.adminWorkspace {
  min-height: 100dvh;
  background: radial-gradient(circle at 72% 0%, rgba(62, 232, 159, 0.055), transparent 32%), #0b100e;
  color: #eaf2ee;
}

.adminWorkspaceHeader {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  min-height: 78px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 14px clamp(16px, 3vw, 30px);
  border-bottom: 1px solid rgba(180, 198, 190, 0.13);
  background: rgba(16, 23, 20, 0.96);
  backdrop-filter: blur(16px);
}

.adminWorkspaceLayout {
  display: grid;
  min-height: calc(100dvh - 78px);
  grid-template-columns: 210px minmax(0, 1fr);
}

.adminWorkspaceNav {
  display: flex;
  padding: 20px 13px;
  flex-direction: column;
  gap: 5px;
  border-right: 1px solid rgba(180, 198, 190, 0.11);
  background: #0e1512;
}

.adminWorkspaceNav button.active {
  border-color: rgba(62, 232, 159, 0.2);
  background: rgba(62, 232, 159, 0.1);
  color: #5ff0b0;
}

.adminWorkspaceContent {
  width: min(100%, 1480px);
  min-width: 0;
  margin: 0 auto;
  padding: clamp(18px, 3vw, 34px);
}
```

- [ ] **Step 2: Add section, metric, table, form, status, and focus styles**

Implement the approved mockup hierarchy:

- `.adminMetricGrid` with four cards.
- `.adminWorkGrid` for queue/release progress.
- `.adminSectionCard` shared surface.
- `.adminSyncNotice` typed error/stale tones.
- `.adminStatus` PASS/WATCH/FAIL tokens.
- `.adminDataSplit` list/detail split.
- `.adminDanger` and `.armed` target confirmation states.
- `:focus-visible` on every Admin button, input, select, textarea, and link.
- `@media (prefers-reduced-motion: reduce)` removing nonessential transitions.

- [ ] **Step 3: Add responsive layout**

```css
@media (max-width: 900px) {
  .adminWorkspaceLayout {
    grid-template-columns: 1fr;
  }

  .adminWorkspaceNav {
    position: sticky;
    top: 78px;
    z-index: 4;
    overflow-x: auto;
    padding: 10px 14px;
    flex-direction: row;
    border-right: 0;
    border-bottom: 1px solid rgba(180, 198, 190, 0.11);
  }

  .adminWorkspaceNav button {
    flex: 0 0 auto;
  }
}

@media (max-width: 640px) {
  .adminWorkspaceHeader,
  .adminWorkspaceContext,
  .adminDataSplit,
  .adminWorkGrid {
    align-items: stretch;
    grid-template-columns: 1fr;
  }

  .adminMetricGrid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
```

- [ ] **Step 4: Remove obsolete settings-nested console CSS**

Delete selectors whose only consumers were the removed components or nested `<details>`:

- `.settingsSheet .testingPanel`
- `.advancedSettings` and descendants
- `.settingsAdminLoading`
- old `.testingControlPlane` tab shell rules that have no new consumer
- obsolete `.accountAdmin*` selectors replaced by `.adminAccount*`

Use `rg` to prove every removed selector has no TSX consumer before deletion.

- [ ] **Step 5: Complete Chinese-first copy review**

Run:

```bash
rg -n '"(All|Pass|Watch|Fail|Find|Create|Run name|Owner|Due|Assign|Policy|Audit|No |Select |Current |Baseline |History|Active|Sessions|Errors|Evidence|Regression|Release gate)' src/components/admin
```

Replace rider-facing strings while retaining the approved technical tokens. The command should return no accidental English UI sentences.

- [ ] **Step 6: Verify format, lint, dead-code, and build**

Run:

```bash
npx prettier --check src/App.tsx src/components/WebSettingsSheet.tsx src/components/admin src/lib/api-client.ts src/lib/testing-api.ts src/lib/auth.ts src/styles.css
npm run lint
npm run check:dead-code
npm run build
```

Expected: all commands pass.

- [ ] **Step 7: Commit visual polish**

```bash
git add src/styles.css src/components/admin src/components/WebSettingsSheet.tsx
git commit -m "style(admin): polish responsive QA workspace"
```

---

### Task 10: Browser verification, full review sweep, and repository gate

**Files:**

- Modify only if a new reproducible defect is found: the exact source plus its failing regression test.
- Mechanically format: `.superpowers/sdd/*.md`
- Update: `README.md` only if the documented Admin entry path still says it is embedded in Settings.

**Interfaces:**

- Acceptance widths: 1440px desktop, 900px tablet, 390px narrow mobile.
- Acceptance roles: admin, reviewer, tester.
- Acceptance states: loading, ready, stale/offline, unauthorized, empty, mutation success/failure, armed destructive action.

- [ ] **Step 1: Run the React best-practices review**

Invoke the `vercel:react-best-practices` skill and review every changed TSX file. Fix only findings that are applicable to this repository and preserve the approved design.

- [ ] **Step 2: Start the mock relay and client**

Run:

```bash
VOICE_PROVIDER=mock AUTH_REGISTRATION=on npm run dev
```

Use a separate tool session so the server stays available during browser verification. Create an administrator through the existing bootstrap UI, then create reviewer and tester accounts through invitation links.

- [ ] **Step 3: Verify desktop Admin behavior**

At 1440px:

- Open Settings, then Admin.
- Confirm the Settings sheet closes and the full-width workspace opens.
- Confirm returning to Max preserves auth, agent settings, and any active mock session.
- Confirm the header, five Admin sections, four overview metrics, risk-sorted queue, and release progress match the approved concept.
- Confirm the corpus issue total does not change when loading another evidence page.
- Open an issue by ID, wait longer than the 10-second poll, and confirm selection remains stable.
- Confirm target-specific confirmation and four-second expiry for user, invite, session, tester, and all-evidence actions.

- [ ] **Step 4: Verify role and error behavior**

- Tester: only Overview, Release Validation, and Evidence & Issues appear; evidence is scoped to that tester.
- Reviewer: Governance appears; Account Management and Admin-only mutations do not.
- Admin: all sections and allowed mutations appear.
- Stop the relay after data loads: current data stays visible with a stale notice and retry.
- Restart the relay: retry clears the stale notice and updates last-sync time.
- Revoke the login session: the existing login flow appears without exposing the Admin surface.

- [ ] **Step 5: Verify tablet, narrow mobile, keyboard, and reduced motion**

At 900px and 390px:

- No horizontal page overflow.
- Section navigation becomes horizontally scrollable.
- Metric cards become two columns and work areas become one column.
- Tables/details remain readable through local contained scrolling where necessary.
- Keyboard Tab order follows header → navigation → content.
- Escape returns to Max.
- Focus is visibly styled and returns to the persistent Settings trigger after closing.
- With reduced motion enabled, no nonessential animated transition remains.

- [ ] **Step 6: Complete the web/server review sweep**

Run and inspect:

```bash
rg -n "TODO|FIXME|HACK|@ts-ignore|eslint-disable|as unknown as" src server shared
rg -n "TestingAdminPanel|TestingControlPlane|AccountAdmin|statsLocked" src tests
rg -n "return null|catch \\{" src/lib src/components/admin
npm run check:dead-code
```

For any new candidate:

1. Reproduce it.
2. Add and run a failing focused test.
3. Implement one minimal fix.
4. Re-run focused and relevant broader tests.

Do not change code for comments, defensive catches, or casts that are justified by validated external data.

- [ ] **Step 7: Repair the existing formatting gate**

Run:

```bash
npx prettier --write .superpowers/sdd/*.md
npx prettier --check .superpowers/sdd/*.md
```

Expected: the second command passes. This is a mechanical formatting correction to tracked workflow notes; do not alter their meaning.

- [ ] **Step 8: Run fresh full verification**

Run:

```bash
npm run check:protocol
npm run format:check
npm run lint
npm run check:dead-code
npm test
npm run test:fault-matrix
npm run build
npm run check
git diff --check
```

Expected:

- Protocol generation is current.
- Prettier reports all matched files formatted.
- ESLint reports no errors.
- Knip reports no dead files/exports/dependencies.
- All Vitest files and tests pass.
- The 24-case fault matrix passes.
- TypeScript and Vite build succeed.
- The aggregate check exits 0.
- `git diff --check` is silent.

- [ ] **Step 9: Review the final diff against the spec**

Check every acceptance criterion in `docs/superpowers/specs/2026-07-23-web-admin-review-polish-design.md`. Confirm no native, protocol, audio, or unrelated rider-HUD implementation changed.

- [ ] **Step 10: Commit final verification and documentation**

```bash
git add .superpowers/sdd README.md
git commit -m "chore: restore full repository quality gate"
```

If `README.md` did not require a correction, omit it. If the workflow-note formatting was already included in an earlier commit, do not create an empty commit.
