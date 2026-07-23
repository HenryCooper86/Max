import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

let relay: ChildProcess | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (relay && relay.exitCode === null && relay.signalCode === null) {
    relay.kill("SIGKILL");
    await new Promise<void>((resolve) => relay?.once("exit", () => resolve()));
  }
  relay = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForServer(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`, { headers: { Connection: "close" } });
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Relay did not become healthy");
}

describe("relay process integration", () => {
  it("serves hardened HTTP responses and closes a logged-out socket", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-relay-integration-"));
    let logs = "";
    relay = spawn(process.execPath, [tsxCli, "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "production",
        VOICE_PROVIDER: "mock",
        RELAY_AUTH_TOKEN: "integration-operator-token",
        AUTH_REGISTRATION: "on",
        ACCOUNTS_FILE: path.join(tempDir, "accounts.json"),
        USER_MEMORY_FILE: "off",
        TESTING_DATABASE: "off",
        TESTING_HISTORY_DIR: "off"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    relay.stdout?.on("data", (chunk) => (logs += String(chunk)));
    relay.stderr?.on("data", (chunk) => (logs += String(chunk)));
    const relayExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      relay?.once("exit", (code, signal) => resolve({ code, signal }));
    });

    await waitForServer(baseUrl).catch((error) => {
      throw new Error(`${String(error)}\n${logs}`);
    });

    const health = await fetch(`${baseUrl}/health`, { headers: { Connection: "close" } });
    expect(health.headers.get("x-powered-by")).toBeNull();
    expect(health.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(health.headers.get("strict-transport-security")).toContain("max-age=");

    const malformed = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: "{"
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ ok: false });

    const oversized = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ value: "x".repeat(40_000) })
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ ok: false });

    const missingApi = await fetch(`${baseUrl}/auth/not-a-route`, { headers: { Connection: "close" } });
    expect(missingApi.status).toBe(404);
    await expect(missingApi.json()).resolves.toMatchObject({ ok: false });

    const registration = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer integration-operator-token",
        Connection: "close"
      },
      body: JSON.stringify({ username: "integration-admin", password: "password123" })
    });
    expect(registration.status).toBe(200);
    const registered = (await registration.json()) as { ok: boolean; token: string };
    expect(registered.ok).toBe(true);

    const backupRegistration = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer integration-operator-token",
        Connection: "close"
      },
      body: JSON.stringify({ username: "backup-admin", password: "password123" })
    });
    expect(backupRegistration.status).toBe(200);

    const promoteBackup = await fetch(`${baseUrl}/auth/admin/users/role`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${registered.token}`,
        Connection: "close"
      },
      body: JSON.stringify({ username: "backup-admin", role: "admin" })
    });
    expect(promoteBackup.status).toBe(200);

    const selfRoleChange = await fetch(`${baseUrl}/auth/admin/users/role`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${registered.token}`,
        Connection: "close"
      },
      body: JSON.stringify({ username: "INTEGRATION-ADMIN", role: "reviewer" })
    });
    expect(selfRoleChange.status).toBe(400);
    await expect(selfRoleChange.json()).resolves.toEqual({
      ok: false,
      error: "不能修改当前登录账号的角色。"
    });

    const selfDelete = await fetch(`${baseUrl}/auth/admin/users/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${registered.token}`,
        Connection: "close"
      },
      body: JSON.stringify({ username: "integration-admin" })
    });
    expect(selfDelete.status).toBe(400);
    await expect(selfDelete.json()).resolves.toEqual({
      ok: false,
      error: "不能删除管理员账号。"
    });

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

    const revokeInviteAgain = await fetch(`${baseUrl}/auth/admin/invites/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${registered.token}`,
        Connection: "close"
      },
      body: JSON.stringify({ code: invitePayload.invite.code })
    });
    expect(revokeInviteAgain.status).toBe(200);
    await expect(revokeInviteAgain.json()).resolves.toEqual({ ok: true, removed: false });

    const invalidClearScope = await fetch(`${baseUrl}/testing/clear`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${registered.token}`,
        Connection: "close"
      },
      body: JSON.stringify({ scope: "unknown" })
    });
    expect(invalidClearScope.status).toBe(400);
    await expect(invalidClearScope.json()).resolves.toEqual({
      ok: false,
      error: "scope 必须为 all、tester（testerKey）或 session（sessionId）。"
    });

    const ready = await fetch(`${baseUrl}/ready`, { headers: { Connection: "close" } });
    expect(ready.status).toBe(200);

    const oversizedSocket = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${encodeURIComponent(registered.token)}`);
    await new Promise<void>((resolve, reject) => {
      oversizedSocket.once("open", resolve);
      oversizedSocket.once("error", reject);
    });
    const oversizedSocketClosed = new Promise<number>((resolve) => {
      oversizedSocket.once("close", (code) => resolve(code));
    });
    oversizedSocket.send(Buffer.alloc(65_537));
    await expect(oversizedSocketClosed).resolves.toBe(1009);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${encodeURIComponent(registered.token)}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const socketClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${registered.token}`, Connection: "close" },
      body: JSON.stringify({ token: registered.token })
    });
    expect(logout.status).toBe(200);
    await expect(socketClosed).resolves.toEqual({ code: 1008, reason: "signed out" });

    relay.kill("SIGTERM");
    await expect(relayExit).resolves.toEqual({ code: 0, signal: null });
    relay = null;
  }, 15_000);

  it("keeps production readiness closed until access control and registration are hardened", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-relay-readiness-"));
    relay = spawn(process.execPath, [tsxCli, "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "production",
        VOICE_PROVIDER: "mock",
        RELAY_AUTH_TOKEN: "",
        AUTH_REGISTRATION: "on",
        ACCOUNTS_FILE: path.join(tempDir, "accounts.json"),
        USER_MEMORY_FILE: "off",
        TESTING_DATABASE: "off",
        TESTING_HISTORY_DIR: "off"
      },
      stdio: ["ignore", "ignore", "ignore"]
    });
    const relayExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      relay?.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await waitForServer(baseUrl);

    const unprotected = await fetch(`${baseUrl}/ready`, { headers: { Connection: "close" } });
    expect(unprotected.status).toBe(503);
    expect((await unprotected.json()) as { issues: string[] }).toMatchObject({
      issues: expect.arrayContaining(["access-control-not-configured"])
    });

    const registration = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ username: "bootstrap-admin", password: "password123" })
    });
    expect(registration.status).toBe(200);

    const openRegistration = await fetch(`${baseUrl}/ready`, { headers: { Connection: "close" } });
    expect(openRegistration.status).toBe(503);
    expect((await openRegistration.json()) as { issues: string[] }).toMatchObject({
      issues: expect.arrayContaining(["open-registration-enabled"])
    });

    relay.kill("SIGTERM");
    await expect(relayExit).resolves.toEqual({ code: 0, signal: null });
    relay = null;
  });

  it("keeps a buried review attributed to its original session and run on POST update", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-relay-review-attribution-"));
    relay = spawn(process.execPath, [tsxCli, "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "production",
        VOICE_PROVIDER: "mock",
        RELAY_AUTH_TOKEN: "integration-operator-token",
        AUTH_REGISTRATION: "on",
        ACCOUNTS_FILE: path.join(tempDir, "accounts.json"),
        USER_MEMORY_FILE: "off",
        TESTING_DATABASE: "off",
        TESTING_HISTORY_DIR: "off"
      },
      stdio: ["ignore", "ignore", "ignore"]
    });
    await waitForServer(baseUrl);

    const registration = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer integration-operator-token",
        Connection: "close"
      },
      body: JSON.stringify({ username: "review-admin", password: "password123" })
    });
    expect(registration.status).toBe(200);
    const { token } = (await registration.json()) as { token: string };
    const authenticatedJson = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Connection: "close"
    };

    async function createRun(build: string): Promise<{ id: string }> {
      const response = await fetch(`${baseUrl}/testing/runs`, {
        method: "POST",
        headers: authenticatedJson,
        body: JSON.stringify({ build })
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { run: { id: string } }).run;
    }

    async function createCompletedSession(runId: string): Promise<string> {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${encodeURIComponent(token)}`);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const started = new Promise<void>((resolve, reject) => {
        socket.on("message", (data) => {
          const event = JSON.parse(String(data)) as { type?: string };
          if (event.type === "session.started") resolve();
        });
        socket.once("error", reject);
      });
      socket.send(
        JSON.stringify({
          type: "session.start",
          sampleRate: 16_000,
          channels: 1,
          testingRunId: runId,
          testingTestCaseId: "baseline-live-session",
          deviceLabel: "integration browser",
          platform: "web"
        })
      );
      await started;
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.close();
      await closed;

      const sessions = await fetch(`${baseUrl}/testing/sessions?runId=${encodeURIComponent(runId)}`, {
        headers: { Authorization: `Bearer ${token}`, Connection: "close" }
      });
      expect(sessions.status).toBe(200);
      const page = (await sessions.json()) as { items: Array<{ sessionId: string }> };
      expect(page.items).toHaveLength(1);
      return page.items[0].sessionId;
    }

    const originalRun = await createRun("review-original-build");
    const unrelatedRun = await createRun("review-unrelated-build");
    const originalSessionId = await createCompletedSession(originalRun.id);
    const unrelatedSessionId = await createCompletedSession(unrelatedRun.id);
    const created = await fetch(`${baseUrl}/testing/reviews`, {
      method: "POST",
      headers: authenticatedJson,
      body: JSON.stringify({ sessionId: originalSessionId, title: "Original critical review", severity: "critical" })
    });
    expect(created.status).toBe(200);
    const originalReview = (await created.json()) as { review: { id: string } };

    for (let index = 0; index < 601; index += 1) {
      const filler = await fetch(`${baseUrl}/testing/reviews`, {
        method: "POST",
        headers: authenticatedJson,
        body: JSON.stringify({
          id: `newer-unrelated-review-${index}`,
          sessionId: unrelatedSessionId,
          runId: unrelatedRun.id,
          title: "Unrelated review"
        })
      });
      expect(filler.status).toBe(200);
    }

    const updated = await fetch(`${baseUrl}/testing/reviews`, {
      method: "POST",
      headers: authenticatedJson,
      body: JSON.stringify({
        id: originalReview.review.id,
        sessionId: unrelatedSessionId,
        runId: unrelatedRun.id,
        title: "Updated critical review",
        status: "triaged"
      })
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      review: {
        id: originalReview.review.id,
        sessionId: originalSessionId,
        runId: originalRun.id,
        status: "triaged"
      }
    });

    const approval = await fetch(`${baseUrl}/testing/runs/${encodeURIComponent(originalRun.id)}`, {
      method: "PATCH",
      headers: authenticatedJson,
      body: JSON.stringify({ status: "approved" })
    });
    expect(approval.status).toBe(409);
    await expect(approval.json()).resolves.toMatchObject({ blockers: { unresolvedReviews: 1 } });
  }, 30_000);
});
