import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
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

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for companion event")), 5_000);
    socket.once("message", (data, isBinary) => {
      clearTimeout(timeout);
      if (isBinary) reject(new Error("Expected a JSON companion event"));
      else resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function rejectedUpgrade(url: string, options?: WebSocket.ClientOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    let settled = false;
    socket.once("unexpected-response", (_request, response) => {
      settled = true;
      const status = response.statusCode ?? 0;
      response.resume();
      resolve(status);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("Expected the WebSocket upgrade to be rejected"));
    });
    socket.once("error", () => {
      // A bare TCP destroy is observably different from a bounded HTTP rejection.
      if (!settled) resolve(0);
    });
  });
}

describe("/companion WebSocket relay", () => {
  it("requires an account, isolates malformed traffic, and revokes the account socket", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-companion-websocket-"));
    let logs = "";
    relay = spawn(process.execPath, ["--import", tsxImport, "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "production",
        VOICE_PROVIDER: "mock",
        RELAY_AUTH_TOKEN: "operator-only-token",
        RELAY_ALLOWED_ORIGINS: "https://max.example.com",
        RELAY_CONN_PER_MINUTE: "13",
        AUTH_REGISTRATION: "on",
        ACCOUNTS_FILE: path.join(tempDir, "accounts.json"),
        COMPANION_BINDINGS_FILE: path.join(tempDir, "companion-bindings.json"),
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

    const registration = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer operator-only-token",
        Connection: "close"
      },
      body: JSON.stringify({ username: "companion-rider", password: "password123" })
    });
    const account = (await registration.json()) as { ok: boolean; token: string };
    expect(account.ok).toBe(true);

    const secondRegistration = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer operator-only-token",
        Connection: "close"
      },
      body: JSON.stringify({ username: "second-rider", password: "password123" })
    });
    const secondAccount = (await secondRegistration.json()) as { ok: boolean; token: string };
    expect(secondAccount.ok).toBe(true);

    const secondSessionResponse = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ username: "companion-rider", password: "password123" })
    });
    const secondSession = (await secondSessionResponse.json()) as { ok: boolean; token: string };
    expect(secondSession.ok).toBe(true);

    const wsBase = `ws://127.0.0.1:${port}`;
    await expect(rejectedUpgrade(`${wsBase}/companion`)).resolves.toBe(401);
    await expect(rejectedUpgrade(`${wsBase}/companion?token=operator-only-token`)).resolves.toBe(401);
    await expect(
      rejectedUpgrade(`${wsBase}/companion?token=${encodeURIComponent(account.token)}`, {
        origin: "https://evil.example.com"
      })
    ).resolves.toBe(403);

    await expect(rejectedUpgrade(`${wsBase}/companion?token=sess_expired`)).resolves.toBe(401);

    const agent = new WebSocket(`${wsBase}/agent?token=${encodeURIComponent(account.token)}`);
    await waitForOpen(agent);

    const companion = new WebSocket(`${wsBase}/companion?token=${encodeURIComponent(account.token)}`);
    const initialStatus = waitForJson(companion);
    await waitForOpen(companion);
    await expect(initialStatus).resolves.toMatchObject({ type: "companion.status", state: "unpaired" });

    const displacedClose = waitForClose(companion);
    const replacement = new WebSocket(`${wsBase}/companion?token=${encodeURIComponent(account.token)}`);
    const replacementStatus = waitForJson(replacement);
    await waitForOpen(replacement);
    await expect(replacementStatus).resolves.toMatchObject({ type: "companion.status", state: "unpaired" });
    await expect(displacedClose).resolves.toEqual({ code: 1008, reason: "companion replaced" });

    const malformedError = waitForJson(replacement);
    const malformedClose = waitForClose(replacement);
    replacement.send("{");
    await expect(malformedError).resolves.toMatchObject({ type: "companion.error" });
    await expect(malformedClose).resolves.toMatchObject({ code: 1008 });
    expect(agent.readyState).toBe(WebSocket.OPEN);

    const oversized = new WebSocket(`${wsBase}/companion?token=${encodeURIComponent(account.token)}`);
    const oversizedInitial = waitForJson(oversized);
    await waitForOpen(oversized);
    await oversizedInitial;
    const oversizedError = waitForJson(oversized);
    const oversizedClose = waitForClose(oversized);
    oversized.send("x".repeat(8 * 1024 + 1));
    await expect(oversizedError).resolves.toMatchObject({ type: "companion.error" });
    await expect(oversizedClose).resolves.toMatchObject({ code: 1008 });
    expect(agent.readyState).toBe(WebSocket.OPEN);

    const hardOversized = new WebSocket(`${wsBase}/companion?token=${encodeURIComponent(account.token)}`);
    const hardOversizedInitial = waitForJson(hardOversized);
    await waitForOpen(hardOversized);
    await hardOversizedInitial;
    const hardOversizedClose = waitForClose(hardOversized);
    hardOversized.send("x".repeat(64 * 1024 + 1));
    await expect(hardOversizedClose).resolves.toMatchObject({ code: 1009 });
    expect(agent.readyState).toBe(WebSocket.OPEN);

    const binary = new WebSocket(`${wsBase}/companion?token=${encodeURIComponent(account.token)}`);
    const binaryInitial = waitForJson(binary);
    await waitForOpen(binary);
    await binaryInitial;
    const binaryError = waitForJson(binary);
    const binaryClose = waitForClose(binary);
    binary.send(Buffer.from([1, 2, 3]));
    await expect(binaryError).resolves.toMatchObject({ type: "companion.error" });
    await expect(binaryClose).resolves.toMatchObject({ code: 1008 });
    expect(agent.readyState).toBe(WebSocket.OPEN);

    const unknown = new WebSocket(`${wsBase}/companion?token=${encodeURIComponent(account.token)}`);
    const unknownInitial = waitForJson(unknown);
    await waitForOpen(unknown);
    await unknownInitial;
    const unknownError = waitForJson(unknown);
    const unknownClose = waitForClose(unknown);
    unknown.send(JSON.stringify({ type: "companion.location.secret", lat: 31.2, lon: 121.5 }));
    await expect(unknownError).resolves.toMatchObject({ type: "companion.error" });
    await expect(unknownClose).resolves.toMatchObject({ code: 1008 });
    expect(agent.readyState).toBe(WebSocket.OPEN);

    const revoked = new WebSocket(`${wsBase}/companion?token=${encodeURIComponent(secondSession.token)}`);
    const revokedInitial = waitForJson(revoked);
    await waitForOpen(revoked);
    await revokedInitial;
    const revokedClose = waitForClose(revoked);
    const shutdownCompanion = new WebSocket(`${wsBase}/companion?token=${encodeURIComponent(secondAccount.token)}`);
    const shutdownInitial = waitForJson(shutdownCompanion);
    await waitForOpen(shutdownCompanion);
    await shutdownInitial;
    const shutdownClose = waitForClose(shutdownCompanion);

    const password = await fetch(`${baseUrl}/auth/password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${account.token}`,
        Connection: "close"
      },
      body: JSON.stringify({
        token: account.token,
        currentPassword: "password123",
        newPassword: "password456"
      })
    });
    expect(password.status).toBe(200);
    await expect(revokedClose).resolves.toEqual({ code: 1008, reason: "session revoked" });
    expect(shutdownCompanion.readyState).toBe(WebSocket.OPEN);

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${account.token}`,
        Connection: "close"
      },
      body: JSON.stringify({ token: account.token })
    });
    expect(logout.status).toBe(200);

    await expect(rejectedUpgrade(`${wsBase}/companion`)).resolves.toBe(429);

    agent.terminate();
    relay.kill("SIGTERM");
    await expect(shutdownClose).resolves.toEqual({ code: 1001, reason: "server shutdown" });
    await expect(relayExit).resolves.toEqual({ code: 0, signal: null });
    relay = null;
  }, 15_000);
});
