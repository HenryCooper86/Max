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
});
