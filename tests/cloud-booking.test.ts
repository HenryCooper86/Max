// Booking finished Max Cloud sessions: a failed booking is kept and retried
// (never dropped, never charged twice), and a relay only books the sessions of
// relay processes that have stopped, never those of one still running.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chargeSession,
  cloudSessionAlive,
  cloudSessionEnded,
  cloudSessionStarted,
  recoverCloudSessions,
  remainingSeconds
} from "../server/cloud";
import { setCloudClock, setCloudInstanceId, setCloudPaymentProviders } from "../server/cloud/context";
import { cloudCounters } from "../server/cloud/counters";
import { createProject, signup } from "../server/cloud/customers";
import { resetCloudDatabase } from "../server/cloud/store";

const START = Date.UTC(2026, 10, 18, 12, 0, 0);
let clock = START;
let directory = "";
let file = "";
const saved = { key: process.env.CLOUD_SECRET_KEY, signup: process.env.CLOUD_SIGNUP };

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
  process.env.CLOUD_SIGNUP = "open";
  // A file, not :memory:, so a second connection can break the database the way a full disk would.
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "max-cloud-booking-"));
  file = path.join(directory, "cloud.sqlite");
  resetCloudDatabase(file);
  clock = START;
  setCloudClock(() => clock);
  setCloudPaymentProviders([]);
  setCloudInstanceId("relay-a");
});

afterEach(() => {
  resetCloudDatabase();
  setCloudClock();
  setCloudPaymentProviders();
  setCloudInstanceId();
  fs.rmSync(directory, { recursive: true, force: true });
  for (const [name, value] of [
    ["CLOUD_SECRET_KEY", saved.key],
    ["CLOUD_SIGNUP", saved.signup]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function customerWithProject() {
  const account = await signup(`c${randomBytes(4).toString("hex")}@example.com`, "correct horse battery");
  if (!account.ok) throw new Error(account.error);
  const customerId = account.value.customer.id;
  const project = createProject(customerId, { name: "Shop" });
  if (!project.ok) throw new Error(project.error);
  return { customerId, projectId: project.value.project.id };
}

/** Runs SQL on a second connection to the relay's database, as an operator (or a fault) would. */
function onDatabase(sql: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

const breakBookings = () =>
  onDatabase(
    "CREATE TRIGGER broken BEFORE INSERT ON ledger WHEN NEW.kind = 'usage' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"
  );
const fixBookings = () => onDatabase("DROP TRIGGER broken");

function liveRows(): Array<{ session_id: string; ended_at: number | null; seconds: number | null }> {
  const db = new DatabaseSync(file);
  try {
    return db.prepare("SELECT session_id, ended_at, seconds FROM live_sessions").all() as never;
  } finally {
    db.close();
  }
}

function bookedSessions(): string[] {
  const db = new DatabaseSync(file);
  try {
    return (db.prepare("SELECT ref FROM ledger WHERE kind = 'usage'").all() as { ref: string }[]).map((row) => row.ref);
  } finally {
    db.close();
  }
}

const counter = (name: string) => cloudCounters()[name] ?? 0;

describe("a booking that fails", () => {
  it("keeps the session with its final length and books it on a later retry, exactly once", async () => {
    const { customerId, projectId } = await customerWithProject();
    const before = remainingSeconds(customerId);
    const failures = counter("max_cloud_booking_failures_total");
    const retried = counter("max_cloud_bookings_retried_total");
    cloudSessionStarted({ sessionId: "s-1", customerId, projectId });
    clock += 30_000;
    cloudSessionAlive({ sessionId: "s-1", customerId, projectId }, 30);
    clock += 90_000;

    breakBookings();
    const usage = { customerId, projectId, sessionId: "s-1", seconds: 120, endedAt: clock };
    expect(cloudSessionEnded(usage)).toBe("failed");
    expect(bookedSessions()).toEqual([]);
    expect(liveRows()).toEqual([{ session_id: "s-1", ended_at: clock, seconds: 120 }]);
    expect(counter("max_cloud_booking_failures_total")).toBe(failures + 1);

    // Still broken: the retry fails too and the row stays.
    clock += 5_000;
    expect(recoverCloudSessions()).toBe(0);
    expect(liveRows()).toHaveLength(1);

    fixBookings();
    clock += 5_000;
    expect(recoverCloudSessions()).toBe(1);
    // The full 120 s it ran, not the 30 s of its last checkpoint.
    expect(before - remainingSeconds(customerId)).toBe(120);
    expect(liveRows()).toEqual([]);
    expect(counter("max_cloud_bookings_retried_total")).toBe(retried + 1);

    expect(recoverCloudSessions()).toBe(0);
    expect(chargeSession(usage)).toBe("already-booked");
    expect(bookedSessions()).toEqual(["s-1"]);
    expect(before - remainingSeconds(customerId)).toBe(120);
  });

  it("is retried by another relay sharing the database, still only once", async () => {
    const { customerId, projectId } = await customerWithProject();
    const before = remainingSeconds(customerId);
    cloudSessionStarted({ sessionId: "s-2", customerId, projectId });
    breakBookings();
    expect(cloudSessionEnded({ customerId, projectId, sessionId: "s-2", seconds: 45, endedAt: clock })).toBe("failed");
    fixBookings();
    setCloudInstanceId("relay-b");
    expect(recoverCloudSessions()).toBe(1);
    setCloudInstanceId("relay-a");
    expect(recoverCloudSessions()).toBe(0);
    expect(before - remainingSeconds(customerId)).toBe(45);
  });

  it("never charges twice when the booking landed but its row could not be cleared", async () => {
    const { customerId, projectId } = await customerWithProject();
    const before = remainingSeconds(customerId);
    cloudSessionStarted({ sessionId: "s-3", customerId, projectId });
    onDatabase(
      "CREATE TRIGGER stuck BEFORE DELETE ON live_sessions BEGIN SELECT RAISE(ABORT, 'database is locked'); END"
    );
    expect(cloudSessionEnded({ customerId, projectId, sessionId: "s-3", seconds: 60, endedAt: clock })).toBe("booked");
    expect(liveRows()).toHaveLength(1);
    onDatabase("DROP TRIGGER stuck");
    expect(recoverCloudSessions()).toBe(0);
    expect(liveRows()).toEqual([]);
    expect(before - remainingSeconds(customerId)).toBe(60);
  });

  it("is retried from memory when even the session's end could not be written", async () => {
    const { customerId, projectId } = await customerWithProject();
    const before = remainingSeconds(customerId);
    cloudSessionStarted({ sessionId: "s-5", customerId, projectId });
    clock += 2_000;
    cloudSessionAlive({ sessionId: "s-5", customerId, projectId }, 2);
    breakBookings();
    onDatabase(
      "CREATE TRIGGER frozen BEFORE UPDATE ON live_sessions BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"
    );
    expect(cloudSessionEnded({ customerId, projectId, sessionId: "s-5", seconds: 200, endedAt: clock })).toBe("failed");
    expect(liveRows()).toEqual([{ session_id: "s-5", ended_at: null, seconds: 2 }]);
    fixBookings();
    onDatabase("DROP TRIGGER frozen");
    expect(recoverCloudSessions()).toBe(1);
    expect(before - remainingSeconds(customerId)).toBe(200);
    expect(liveRows()).toEqual([]);
  });

  it("drops a session no customer can be charged for instead of retrying it forever", async () => {
    const { projectId } = await customerWithProject();
    cloudSessionStarted({ sessionId: "s-6", customerId: "cus_gone", projectId });
    expect(
      cloudSessionEnded({ customerId: "cus_gone", projectId, sessionId: "s-6", seconds: 30, endedAt: clock })
    ).toBe("not-billable");
    expect(liveRows()).toEqual([]);
  });

  it("counts a failed booking against the balance while it waits", async () => {
    const { customerId, projectId } = await customerWithProject();
    const before = remainingSeconds(customerId);
    cloudSessionStarted({ sessionId: "s-4", customerId, projectId });
    breakBookings();
    cloudSessionEnded({ customerId, projectId, sessionId: "s-4", seconds: 300, endedAt: clock });
    expect(before - remainingSeconds(customerId)).toBe(300);
    fixBookings();
    recoverCloudSessions();
    expect(before - remainingSeconds(customerId)).toBe(300);
  });
});

describe("sessions left open", () => {
  it("are never booked while the relay running them still checkpoints", async () => {
    const { customerId, projectId } = await customerWithProject();
    const before = remainingSeconds(customerId);
    // relay-a runs the session; relay-b shares the volume (a second instance, or a rolling restart).
    cloudSessionStarted({ sessionId: "s-run", customerId, projectId });
    for (let second = 5; second <= 300; second += 5) {
      clock += 5_000;
      setCloudInstanceId("relay-a");
      cloudSessionAlive({ sessionId: "s-run", customerId, projectId }, second);
      setCloudInstanceId("relay-b");
      expect(recoverCloudSessions()).toBe(0);
    }
    setCloudInstanceId("relay-a");
    expect(cloudSessionEnded({ customerId, projectId, sessionId: "s-run", seconds: 302, endedAt: clock })).toBe(
      "booked"
    );
    expect(before - remainingSeconds(customerId)).toBe(302);
  });

  it("are booked up to their last checkpoint once their relay stops checkpointing, exactly once", async () => {
    const { customerId, projectId } = await customerWithProject();
    const before = remainingSeconds(customerId);
    const recovered = counter("max_cloud_sessions_recovered_total");
    cloudSessionStarted({ sessionId: "s-crash", customerId, projectId });
    clock += 90_000;
    cloudSessionAlive({ sessionId: "s-crash", customerId, projectId }, 88);
    clock += 3_000; // relay-a dies before its next checkpoint

    // relay-a starts again as a new process: its old row is not its own any more.
    setCloudInstanceId("relay-a2");
    expect(recoverCloudSessions()).toBe(0); // still fresh: it could belong to a relay that is alive
    clock += 60_000;
    expect(recoverCloudSessions()).toBe(1);
    expect(before - remainingSeconds(customerId)).toBe(88);
    expect(counter("max_cloud_sessions_recovered_total")).toBe(recovered + 1);
    expect(recoverCloudSessions()).toBe(0);
    expect(liveRows()).toEqual([]);
  });

  it("have the rest booked at close when another relay booked them early, with nothing charged twice", async () => {
    const { customerId, projectId } = await customerWithProject();
    const before = remainingSeconds(customerId);
    const session = { sessionId: "s-stall", customerId, projectId };
    setCloudInstanceId("relay-a");
    cloudSessionStarted(session);
    clock += 60_000;
    cloudSessionAlive(session, 60);
    // The shared database stalls: relay-a cannot checkpoint for over a minute, and relay-b takes the session for abandoned.
    clock += 61_000;
    setCloudInstanceId("relay-b");
    expect(recoverCloudSessions()).toBe(1);
    expect(before - remainingSeconds(customerId)).toBe(60);
    expect(liveRows()).toEqual([]);

    // relay-a was alive all along: its next checkpoint writes the row again.
    setCloudInstanceId("relay-a");
    clock += 5_000;
    cloudSessionAlive(session, 126);
    expect(liveRows()).toEqual([{ session_id: "s-stall", ended_at: null, seconds: 126 }]);
    setCloudInstanceId("relay-b");
    expect(recoverCloudSessions()).toBe(0); // fresh again, so left alone

    setCloudInstanceId("relay-a");
    clock += 174_000;
    expect(cloudSessionEnded({ ...session, seconds: 300, endedAt: clock })).toBe("booked");
    expect(before - remainingSeconds(customerId)).toBe(300);
    expect(liveRows()).toEqual([]);
    // Booking it again, from either relay, changes nothing.
    expect(chargeSession({ ...session, seconds: 300, endedAt: clock })).toBe("already-booked");
    expect(chargeSession({ ...session, seconds: 60, endedAt: clock })).toBe("already-booked");
    expect(before - remainingSeconds(customerId)).toBe(300);
  });

  it("are recorded by a checkpoint when their start could not be", async () => {
    const { customerId, projectId } = await customerWithProject();
    const before = remainingSeconds(customerId);
    // No cloudSessionStarted: the database refused that write.
    clock += 30_000;
    cloudSessionAlive({ sessionId: "s-late", customerId, projectId }, 28);
    expect(liveRows()).toEqual([{ session_id: "s-late", ended_at: null, seconds: 28 }]);
    setCloudInstanceId("relay-a2"); // the relay dies and restarts
    clock += 61_000;
    expect(recoverCloudSessions()).toBe(1);
    expect(before - remainingSeconds(customerId)).toBe(28);
  });

  it("are not booked by their own relay when only its checkpoints failed", async () => {
    const { customerId, projectId } = await customerWithProject();
    cloudSessionStarted({ sessionId: "s-own", customerId, projectId });
    clock += 600_000;
    expect(recoverCloudSessions()).toBe(0);
    expect(liveRows()).toHaveLength(1);
  });

  it("books rows written before relays had ids, by how long they were open", async () => {
    const { customerId, projectId } = await customerWithProject();
    const before = remainingSeconds(customerId);
    onDatabase(
      `INSERT INTO live_sessions (session_id, customer_id, project_id, started_at, last_seen)
       VALUES ('s-old', '${customerId}', '${projectId}', ${START}, ${START + 75_000})`
    );
    clock = START + 75_000 + 61_000;
    expect(recoverCloudSessions()).toBe(1);
    expect(before - remainingSeconds(customerId)).toBe(75);
  });
});
