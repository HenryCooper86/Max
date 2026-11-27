// HTTP-level tests of the real relay routes in server/index.ts for Max Cloud
// project keys: POST /v1/session-tokens (minting a session token for a user)
// and GET /v1/usage (a project's per-user usage report). The relay is started
// as its own process, the way tests/server-integration.test.ts does, so these
// exercise the routes as they are wired in server/index.ts — not the cloud
// functions in isolation. The cloud database is seeded before the relay starts.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monthOf } from "../server/cloud/billing";
import { hashToken } from "../server/cloud/secrets";

const require = createRequire(import.meta.url);
const tsxImport = pathToFileURL(require.resolve("tsx")).href;

const SECRET = randomBytes(32).toString("base64");
const RELAY_TOKEN = "operator-relay-token";
const MONTH = monthOf(Date.now());
// The relay checks the limit against its own clock: seeding the next month as well keeps the over-limit
// case over the limit if the run crosses a UTC month boundary. The report assertions stay on MONTH.
const NEXT_MONTH = monthOf(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));

// Three projects: A carries the per-user limit and a user already over it;
// B is a stranger project (proves reports stay within the key's project); C
// is the project whose report budget the 61-request case exhausts.
const KEY_A = `mpk_${randomBytes(32).toString("base64url")}`;
const KEY_B = `mpk_${randomBytes(32).toString("base64url")}`;
const KEY_C = `mpk_${randomBytes(32).toString("base64url")}`;

const PROJECT_A = "prj_a";
const PROJECT_B = "prj_b";
const PROJECT_C = "prj_c";

let relay: ChildProcess | null = null;
let tempDir = "";
let base = "";
let logs = "";

function seedDatabase(file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE customers (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        backend TEXT NOT NULL CHECK (backend IN ('openai', 'gemini', 'grok')),
        model_key_enc TEXT NULL,
        assistant_name TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        greeting TEXT NOT NULL DEFAULT '',
        studio TEXT NOT NULL DEFAULT '{}',
        public_id TEXT NULL,
        webhook_secret_enc TEXT NULL,
        traces_headers_enc TEXT NULL,
        monthly_minutes_cap INTEGER NULL,
        per_user_minutes_cap INTEGER NULL,
        first_website_conversation_at INTEGER NULL,
        studio_revision TEXT NULL,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER NULL
      );
      CREATE TABLE user_usage (
        project_id TEXT NOT NULL,
        month TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        sessions INTEGER NOT NULL DEFAULT 0,
        seconds INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, month, user_id)
      ) WITHOUT ROWID;
    `);
    const customer = db.prepare(
      `INSERT INTO customers (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    const project = db.prepare(
      `INSERT INTO projects (id, customer_id, name, key_hash, key_prefix, backend, model_key_enc, assistant_name,
         instructions, greeting, studio, public_id, webhook_secret_enc, traces_headers_enc, monthly_minutes_cap,
         per_user_minutes_cap, first_website_conversation_at, studio_revision, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, 'openai', NULL, '', '', '', '{}', NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, NULL)`
    );
    customer.run("cus_a", "a@example.com", "hash", "salt", Date.now());
    customer.run("cus_b", "b@example.com", "hash", "salt", Date.now());
    customer.run("cus_c", "c@example.com", "hash", "salt", Date.now());
    project.run(PROJECT_A, "cus_a", "Shop A", hashToken(KEY_A), KEY_A.slice(0, 8), 1, Date.now());
    project.run(PROJECT_B, "cus_b", "Kiosk B", hashToken(KEY_B), KEY_B.slice(0, 8), null, Date.now());
    project.run(PROJECT_C, "cus_c", "Stall C", hashToken(KEY_C), KEY_C.slice(0, 8), null, Date.now());
    // A user already over project A's 1-minute per-user allowance, this month and next.
    const usage = db.prepare(
      `INSERT INTO user_usage (project_id, month, user_id, sessions, seconds) VALUES (?, ?, ?, ?, ?)`
    );
    for (const month of [MONTH, NEXT_MONTH]) usage.run(PROJECT_A, month, "u1", 2, 120);
  } finally {
    db.close();
  }
}

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

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Connection: "close" } });
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Relay did not become healthy.\n${logs}`);
}

type Call = { status: number; body: Record<string, unknown>; text: string };

async function call(method: string, route: string, options: { token?: string; json?: unknown } = {}): Promise<Call> {
  const headers: Record<string, string> = { Connection: "close" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let requestBody: string | undefined;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${route}`, { method, headers, body: requestBody, redirect: "manual" });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: response.status, body, text };
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-v1-routes-"));
  seedDatabase(path.join(tempDir, "cloud.sqlite"));
  const port = await reservePort();
  base = `http://127.0.0.1:${port}`;
  relay = spawn(process.execPath, ["--import", tsxImport, "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STUDIO_DIR: tempDir,
      PORT: String(port),
      NODE_ENV: "production",
      VOICE_PROVIDER: "mock",
      RELAY_AUTH_TOKEN: RELAY_TOKEN,
      CLOUD_SECRET_KEY: SECRET,
      CLOUD_PUBLIC_URL: `http://127.0.0.1:${port}`,
      USER_MEMORY_FILE: "off",
      TESTING_DATABASE: "off",
      TESTING_HISTORY_DIR: "off"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  relay.stdout?.on("data", (chunk) => (logs += String(chunk)));
  relay.stderr?.on("data", (chunk) => (logs += String(chunk)));
  await waitForServer(`${base}/health`).catch((error) => {
    throw new Error(`${String(error)}\n${logs}`);
  });
}, 30_000);

afterAll(async () => {
  if (relay && relay.exitCode === null && relay.signalCode === null) {
    relay.kill("SIGKILL");
    await new Promise<void>((resolve) => relay?.once("exit", () => resolve()));
  }
  relay = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("POST /v1/session-tokens with a project key", () => {
  it("mints a token for a named user", async () => {
    const response = await call("POST", "/v1/session-tokens", { token: KEY_A, json: { userId: "u2" } });
    expect(response.status).toBe(201);
    expect(typeof response.body.token).toBe("string");
    expect(response.body.token).toMatch(/^vst_/);
    expect(typeof response.body.expiresAt).toBe("number");
  });

  it('refuses the reserved "anonymous" userId', async () => {
    const response = await call("POST", "/v1/session-tokens", { token: KEY_A, json: { userId: "anonymous" } });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: 'userId cannot be "anonymous": usage reports use it for sessions without a user.'
    });
  });

  it("refuses a user over the per-user minutes limit", async () => {
    const response = await call("POST", "/v1/session-tokens", { token: KEY_A, json: { userId: "u1" } });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      ok: false,
      error: "This user has used their monthly minutes limit. Raise the per-user limit in the console's Settings."
    });
  });
});

describe("GET /v1/usage with a project key", () => {
  it("reports the key's own project with the documented shape", async () => {
    const response = await call("GET", `/v1/usage?month=${MONTH}`, { token: KEY_A });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      month: MONTH,
      limitMinutes: 1,
      totals: { sessions: 2, minutes: 2, seconds: 120 },
      userCount: 1,
      users: [{ userId: "u1", sessions: 2, minutes: 2, seconds: 120 }]
    });
  });

  it("refuses a month that is not YYYY-MM", async () => {
    const response = await call("GET", "/v1/usage?month=nope", { token: KEY_A });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, error: "month must look like 2026-11." });
  });

  it("shows another project's key nothing of this one", async () => {
    const response = await call("GET", `/v1/usage?month=${MONTH}`, { token: KEY_B });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      month: MONTH,
      limitMinutes: 0,
      totals: { sessions: 0, minutes: 0, seconds: 0 },
      userCount: 0,
      users: []
    });
  });

  it("rejects an unknown or revoked project key", async () => {
    const response = await call("GET", "/v1/usage", { token: "mpk_not-a-real-key" });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Unknown or revoked project key." });
  });

  it("limits reports to 60 a minute per project", async () => {
    for (let ask = 0; ask < 60; ask += 1) {
      const response = await call("GET", `/v1/usage?month=${MONTH}`, { token: KEY_C });
      expect(response.status, `report ${ask + 1} should be allowed`).toBe(200);
    }
    const sixtyFirst = await call("GET", `/v1/usage?month=${MONTH}`, { token: KEY_C });
    expect(sixtyFirst.status).toBe(429);
    expect(sixtyFirst.body).toEqual({
      ok: false,
      error: "At most 60 usage reports a minute per project."
    });
  });
});

describe("GET /v1/usage for a self-hosted relay", () => {
  it("still returns the relay's own usage report for the relay token", async () => {
    const response = await call("GET", "/v1/usage", { token: RELAY_TOKEN });
    expect(response.status).toBe(200);
    expect(response.body.month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(typeof response.body.limitMinutes).toBe("number");
    expect(response.body.totals).toMatchObject({ sessions: 0, seconds: 0 });
    expect(typeof (response.body.totals as Record<string, unknown>).toolCalls).toBe("number");
    expect(Array.isArray(response.body.users)).toBe(true);
    // The self-hosted report has no per-user userCount; that key is Max Cloud's.
    expect(response.body.userCount).toBeUndefined();
  });
});
