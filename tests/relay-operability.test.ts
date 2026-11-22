import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The real relay process: /metrics, JSON logs, the proxy-header notice on
// /ready and the per-account login backoff, wired up as an operator sees them.

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
  for (let attempt = 0; attempt < 200; attempt += 1) {
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

const METRICS_TOKEN = "integration-metrics-token-0123456789";

async function startRelay(): Promise<{ baseUrl: string; logs: () => string }> {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-relay-operability-"));
  let logs = "";
  relay = spawn(process.execPath, ["--import", tsxImport, "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STUDIO_DIR: tempDir,
      PORT: String(port),
      NODE_ENV: "development",
      VOICE_PROVIDER: "mock",
      RELAY_AUTH_TOKEN: "",
      RELAY_TRUST_PROXY: "off",
      CLOUD_SECRET_KEY: "",
      METRICS_TOKEN,
      LOG_FORMAT: "json",
      LOG_LEVEL: "info",
      AUTH_REGISTRATION: "on",
      AUTH_ATTEMPTS_PER_MINUTE: "1000",
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
  await waitForServer(baseUrl).catch((error) => {
    throw new Error(`${String(error)}\n${logs}`);
  });
  return { baseUrl, logs: () => logs };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify(body)
  });
}

describe("relay operability", () => {
  it("serves metrics, writes JSON logs, flags untrusted proxy headers and backs off logins", async () => {
    const { baseUrl, logs } = await startRelay();

    // /metrics: the dedicated token only.
    expect((await fetch(`${baseUrl}/metrics`, { headers: { Connection: "close" } })).status).toBe(401);
    const scrape = await fetch(`${baseUrl}/metrics`, {
      headers: { Authorization: `Bearer ${METRICS_TOKEN}`, Connection: "close" }
    });
    expect(scrape.status).toBe(200);
    expect(scrape.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const text = await scrape.text();
    expect(text).toContain("# TYPE max_relay_active_sessions gauge");
    expect(text).toContain("max_relay_agent_sockets_open 0");
    expect(text).toContain("max_relay_companion_sockets_open 0");
    expect(text).toMatch(/^max_relay_process_uptime_seconds \d+$/m);

    // /ready: a forwarded request with proxy trust off is reported, not fatal.
    const before = (await (await fetch(`${baseUrl}/ready`)).json()) as { warnings: string[] };
    expect(before.warnings).toEqual([]);
    await fetch(`${baseUrl}/health`, { headers: { "X-Forwarded-For": "198.51.100.7", Connection: "close" } });
    const ready = await fetch(`${baseUrl}/ready`, { headers: { Connection: "close" } });
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { warnings: string[] }).warnings).toEqual(["proxy-headers-untrusted"]);

    // Login backoff: an unknown name locks exactly like a real one.
    expect((await post(`${baseUrl}/auth/register`, { username: "rider", password: "password123" })).status).toBe(200);
    const statuses = async (username: string) => {
      const seen: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        seen.push((await post(`${baseUrl}/auth/login`, { username, password: "wrong-password" })).status);
      }
      return seen;
    };
    expect(await statuses("rider")).toEqual([401, 401, 401, 401, 401, 429]);
    expect(await statuses("nobody")).toEqual([401, 401, 401, 401, 401, 429]);
    const locked = await post(`${baseUrl}/auth/login`, { username: "rider", password: "password123" });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);

    // Every log line is one JSON object.
    const lines = logs()
      .split("\n")
      .filter((line) => line.startsWith("{"));
    expect(lines.length).toBeGreaterThan(5);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const entry of parsed) {
      expect(entry).toMatchObject({ time: expect.any(String), level: expect.any(String), message: expect.any(String) });
    }
    expect(parsed.some((entry) => String(entry.message).includes("RELAY_TRUST_PROXY is off"))).toBe(true);
    expect(parsed.some((entry) => entry.message === "login locked out")).toBe(true);
  }, 30_000);

  it("keeps /metrics hidden when METRICS_TOKEN is unset", async () => {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-relay-operability-"));
    relay = spawn(process.execPath, ["--import", tsxImport, "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STUDIO_DIR: tempDir,
        PORT: String(port),
        NODE_ENV: "development",
        VOICE_PROVIDER: "mock",
        METRICS_TOKEN: "",
        ACCOUNTS_FILE: path.join(tempDir, "accounts.json"),
        COMPANION_BINDINGS_FILE: path.join(tempDir, "companion-bindings.json"),
        USER_MEMORY_FILE: "off",
        TESTING_DATABASE: "off",
        TESTING_HISTORY_DIR: "off"
      },
      stdio: ["ignore", "ignore", "ignore"]
    });
    await waitForServer(baseUrl);
    const response = await fetch(`${baseUrl}/metrics`, {
      headers: { Authorization: "Bearer anything", Connection: "close" }
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("max_relay");
  }, 30_000);
});
