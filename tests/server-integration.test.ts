import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";

const require = createRequire(import.meta.url);
// Load tsx in-process via --import rather than the tsx CLI: the CLI wraps the
// server in a relay process that SIGKILLs it (and exits 143) whenever the
// child's IPC signal acknowledgment misses a 30 ms window, so on slower
// machines a graceful SIGTERM shutdown still fails the exit-code assertions.
const tsxImport = pathToFileURL(require.resolve("tsx")).href;

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

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForSocketClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close")), 1_500);
    socket.once("close", (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function waitForEvent(
  socket: WebSocket,
  predicate: (event: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket event")), 1_500);
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(event)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(event);
    };
    socket.on("message", onMessage);
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

describe("relay process integration", () => {
  it("serves hardened HTTP responses and closes a logged-out socket", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-relay-integration-"));
    let logs = "";
    relay = spawn(process.execPath, ["--import", tsxImport, "server/index.ts"], {
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
    // One byte over config.ts's maxPayloadBytes default (384 KiB) — must stay
    // in sync with that default so ws actually terminates this send.
    oversizedSocket.send(Buffer.alloc(384 * 1024 + 1));
    await expect(oversizedSocketClosed).resolves.toBe(1009);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${encodeURIComponent(registered.token)}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const socketClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    const companion = new WebSocket(`ws://127.0.0.1:${port}/companion?token=${encodeURIComponent(registered.token)}`);
    const companionStatus = new Promise<Record<string, unknown>>((resolve, reject) => {
      companion.once("message", (data, isBinary) => {
        if (isBinary) reject(new Error("Expected companion JSON"));
        else resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });
    await new Promise<void>((resolve, reject) => {
      companion.once("open", resolve);
      companion.once("error", reject);
    });
    await expect(companionStatus).resolves.toMatchObject({ type: "companion.status", state: "unpaired" });
    const companionClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      companion.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${registered.token}`, Connection: "close" },
      body: JSON.stringify({ token: registered.token })
    });
    expect(logout.status).toBe(200);
    await expect(socketClosed).resolves.toEqual({ code: 1008, reason: "signed out" });
    await expect(companionClosed).resolves.toEqual({ code: 1008, reason: "signed out" });

    relay.kill("SIGTERM");
    await expect(relayExit).resolves.toEqual({ code: 0, signal: null });
    relay = null;
  }, 15_000);

  it("does not let an authenticated account claim an RDK identity", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-rdk-account-auth-"));
    relay = spawn(process.execPath, ["--import", tsxImport, "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "production",
        VOICE_PROVIDER: "mock",
        RELAY_AUTH_TOKEN: "rdk-operator-token",
        AUTH_REGISTRATION: "on",
        ACCOUNTS_FILE: path.join(tempDir, "accounts.json"),
        COMPANION_BINDINGS_FILE: path.join(tempDir, "companion-bindings.json"),
        USER_MEMORY_FILE: path.join(tempDir, "user-memory.json"),
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
        Authorization: "Bearer rdk-operator-token",
        Connection: "close"
      },
      body: JSON.stringify({ username: "rdk-account", password: "password123" })
    });
    const account = (await registration.json()) as { token: string };
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${encodeURIComponent(account.token)}`);
    await waitForSocketOpen(socket);
    const closed = waitForSocketClose(socket);
    socket.send(
      JSON.stringify({
        type: "session.start",
        sampleRate: 16_000,
        channels: 1,
        deviceId: "rdk-66666666-6666-4666-8666-666666666666",
        platform: "embedded"
      })
    );

    await expect(closed).resolves.toMatchObject({ code: 1008 });
  });

  it("lets the operator RDK receive pairing and phone location without adding QA or user-memory evidence", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-rdk-companion-privacy-"));
    relay = spawn(process.execPath, ["--import", tsxImport, "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "production",
        VOICE_PROVIDER: "mock",
        RELAY_AUTH_TOKEN: "rdk-operator-token",
        AUTH_REGISTRATION: "on",
        ACCOUNTS_FILE: path.join(tempDir, "accounts.json"),
        COMPANION_BINDINGS_FILE: path.join(tempDir, "companion-bindings.json"),
        USER_MEMORY_FILE: path.join(tempDir, "user-memory.json"),
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
        Authorization: "Bearer rdk-operator-token",
        Connection: "close"
      },
      body: JSON.stringify({ username: "phone-rider", password: "password123" })
    });
    const account = (await registration.json()) as { token: string };
    const agentEvents: Array<Record<string, unknown>> = [];
    const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?token=rdk-operator-token`);
    agent.on("message", (data, isBinary) => {
      if (!isBinary) agentEvents.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await waitForSocketOpen(agent);
    const pairing = waitForEvent(agent, (event) => event.type === "companion.pairing");
    agent.send(
      JSON.stringify({
        type: "session.start",
        sampleRate: 16_000,
        channels: 1,
        deviceId: "rdk-77777777-7777-4777-8777-777777777777",
        deviceLabel: "  Privacy helmet  ",
        testerId: "rdk-privacy-evidence",
        platform: "embedded"
      })
    );
    const pairingEvent = await pairing;
    expect(pairingEvent).toMatchObject({ type: "companion.pairing", paired: false });
    expect(pairingEvent.code).toMatch(/^\d{6}$/);

    const companion = new WebSocket(`ws://127.0.0.1:${port}/companion?token=${encodeURIComponent(account.token)}`);
    const initialCompanionStatus = waitForEvent(companion, (event) => event.type === "companion.status");
    await waitForSocketOpen(companion);
    await expect(initialCompanionStatus).resolves.toMatchObject({ state: "unpaired" });
    const ready = waitForEvent(companion, (event) => event.type === "companion.status" && event.state === "ready");
    companion.send(JSON.stringify({ type: "companion.pair", code: pairingEvent.code }));
    await ready;
    const sharing = waitForEvent(companion, (event) => event.type === "companion.status" && event.state === "sharing");
    companion.send(JSON.stringify({ type: "companion.start" }));
    await sharing;

    const location = waitForEvent(agent, (event) => event.type === "phone.location");
    companion.send(
      JSON.stringify({
        type: "companion.location",
        sequence: 1,
        lat: 31.2304,
        lon: 121.4737,
        horizontalAccuracyMeters: 5,
        timestamp: Date.now()
      })
    );
    await expect(location).resolves.toMatchObject({
      type: "phone.location",
      sequence: 1,
      lat: 31.2304,
      lon: 121.4737
    });

    await closeSocket(agent);
    const sessionsResponse = await fetch(`${baseUrl}/testing/sessions?testerId=rdk-privacy-evidence`, {
      headers: { Authorization: "Bearer rdk-operator-token", Connection: "close" }
    });
    const sessions = (await sessionsResponse.json()) as {
      items: Array<{ serverEvents: number; controlDownBytes: number }>;
    };
    expect(sessions.items).toHaveLength(1);
    const recordedTypes = new Set([
      "companion.pairing",
      "companion.discovery",
      "phone.location",
      "phone.location.status"
    ]);
    const ordinaryEvents = agentEvents.filter(
      (event) => event.type !== "connection" && !recordedTypes.has(String(event.type))
    );
    expect(sessions.items[0]?.serverEvents).toBe(ordinaryEvents.length);
    expect(JSON.stringify(sessions.items[0])).not.toContain(String(pairingEvent.code));
    expect(JSON.stringify(sessions.items[0])).not.toContain("31.2304");

    const memoryResponse = await fetch(`${baseUrl}/auth/memory`, {
      headers: { Authorization: `Bearer ${account.token}`, Connection: "close" }
    });
    await expect(memoryResponse.json()).resolves.toMatchObject({ memory: { turnCount: 0, factCount: 0 } });
    await closeSocket(companion);
  }, 15_000);

  it("allows device registration only while development mode has no token and no accounts", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-rdk-open-development-"));
    relay = spawn(process.execPath, ["--import", tsxImport, "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "development",
        VOICE_PROVIDER: "mock",
        RELAY_AUTH_TOKEN: "",
        AUTH_REGISTRATION: "on",
        ACCOUNTS_FILE: path.join(tempDir, "accounts.json"),
        COMPANION_BINDINGS_FILE: path.join(tempDir, "companion-bindings.json"),
        USER_MEMORY_FILE: "off",
        TESTING_DATABASE: "off",
        TESTING_HISTORY_DIR: "off"
      },
      stdio: ["ignore", "ignore", "ignore"]
    });
    await waitForServer(baseUrl);

    const openDevice = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    await waitForSocketOpen(openDevice);
    const pairing = waitForEvent(openDevice, (event) => event.type === "companion.pairing");
    openDevice.send(
      JSON.stringify({
        type: "session.start",
        sampleRate: 16_000,
        channels: 1,
        deviceId: "rdk-88888888-8888-4888-8888-888888888888",
        platform: "embedded"
      })
    );
    await expect(pairing).resolves.toMatchObject({ type: "companion.pairing" });
    await closeSocket(openDevice);

    const registration = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ username: "development-account", password: "password123" })
    });
    const account = (await registration.json()) as { token: string };
    const claimedDevice = new WebSocket(`ws://127.0.0.1:${port}/agent?token=${encodeURIComponent(account.token)}`);
    await waitForSocketOpen(claimedDevice);
    const closed = waitForSocketClose(claimedDevice);
    claimedDevice.send(
      JSON.stringify({
        type: "session.start",
        sampleRate: 16_000,
        channels: 1,
        deviceId: "rdk-99999999-9999-4999-8999-999999999999",
        platform: "embedded"
      })
    );
    await expect(closed).resolves.toMatchObject({ code: 1008 });
  }, 15_000);

  it("keeps production readiness closed until access control and registration are hardened", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-relay-readiness-"));
    const unreadableCompanionPath = path.join(tempDir, "companion-bindings.json");
    fs.mkdirSync(unreadableCompanionPath);
    relay = spawn(process.execPath, ["--import", tsxImport, "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "production",
        VOICE_PROVIDER: "mock",
        RELAY_AUTH_TOKEN: "",
        AUTH_REGISTRATION: "on",
        ACCOUNTS_FILE: path.join(tempDir, "accounts.json"),
        COMPANION_BINDINGS_FILE: unreadableCompanionPath,
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
      issues: expect.arrayContaining([
        "access-control-not-configured",
        expect.stringContaining("Companion binding store unreadable")
      ])
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
    relay = spawn(process.execPath, ["--import", tsxImport, "server/index.ts"], {
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
