import { describe, expect, it } from "vitest";
import { createResumeStore, isResumeId, type ResumeState } from "../server/session-resume";

const MINUTE = 60_000;
const state = (text: string): ResumeState => ({ history: [{ speaker: "user", text }], agent: "support" });

function clock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    }
  };
}

describe("createResumeStore", () => {
  it("issues ids shaped rsm_ + 32 url-safe characters", () => {
    const store = createResumeStore();
    const id = store.create("alice");
    expect(id).toMatch(/^rsm_[A-Za-z0-9_-]{32}$/);
    expect(isResumeId(id)).toBe(true);
  });

  it("issues unique ids", () => {
    const store = createResumeStore();
    const ids = new Set(Array.from({ length: 500 }, () => store.create("alice")));
    expect(ids.size).toBe(500);
  });

  it("starts a new entry with an empty history", () => {
    const store = createResumeStore();
    const id = store.create("alice");
    expect(store.load(id, "alice")).toEqual({ history: [] });
  });

  it("returns saved state for the owner only", () => {
    const store = createResumeStore();
    const id = store.create("alice");
    store.save(id, state("hello"));
    expect(store.load(id, "alice")).toEqual(state("hello"));
    expect(store.load(id, "bob")).toBeUndefined();
    expect(store.load(id, "")).toBeUndefined();
  });

  it("keeps the owner when state is replaced", () => {
    const store = createResumeStore();
    const id = store.create("alice");
    store.save(id, state("one"));
    store.save(id, state("two"));
    expect(store.load(id, "alice")).toEqual(state("two"));
    expect(store.load(id, "bob")).toBeUndefined();
  });

  it("returns undefined for unknown, malformed and non-string ids", () => {
    const store = createResumeStore();
    store.create("alice");
    expect(store.load(`rsm_${"a".repeat(32)}`, "alice")).toBeUndefined();
    expect(store.load("rsm_short", "alice")).toBeUndefined();
    expect(store.load(`rsm_${"a".repeat(33)}`, "alice")).toBeUndefined();
    expect(store.load(`rsm_${"!".repeat(32)}`, "alice")).toBeUndefined();
    expect(store.load(`xxx_${"a".repeat(32)}`, "alice")).toBeUndefined();
    expect(store.load("", "alice")).toBeUndefined();
    expect(store.load(undefined, "alice")).toBeUndefined();
    expect(store.load(null, "alice")).toBeUndefined();
    expect(store.load(42, "alice")).toBeUndefined();
    expect(store.load({ id: "x" }, "alice")).toBeUndefined();
    expect(store.load(["rsm_" + "a".repeat(32)], "alice")).toBeUndefined();
  });

  it("expires entries 10 minutes after the last save", () => {
    const time = clock();
    const store = createResumeStore(time.now);
    const id = store.create("alice");
    store.save(id, state("hi"));
    time.advance(10 * MINUTE - 1);
    expect(store.load(id, "alice")).toEqual(state("hi"));
    time.advance(1);
    expect(store.load(id, "alice")).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("expires an entry that was never saved, from its creation", () => {
    const time = clock();
    const store = createResumeStore(time.now);
    const id = store.create("alice");
    time.advance(10 * MINUTE + 1);
    expect(store.load(id, "alice")).toBeUndefined();
  });

  it("refreshes an entry on every save", () => {
    const time = clock();
    const store = createResumeStore(time.now);
    const id = store.create("alice");
    for (let i = 0; i < 5; i += 1) {
      time.advance(6 * MINUTE);
      store.save(id, state(`turn ${i}`));
    }
    expect(store.load(id, "alice")).toEqual(state("turn 4"));
    time.advance(10 * MINUTE + 1);
    expect(store.load(id, "alice")).toBeUndefined();
  });

  it("expires only the stale entries", () => {
    const time = clock();
    const store = createResumeStore(time.now);
    const old = store.create("alice");
    time.advance(6 * MINUTE);
    const fresh = store.create("alice");
    time.advance(6 * MINUTE);
    expect(store.load(old, "alice")).toBeUndefined();
    expect(store.load(fresh, "alice")).toEqual({ history: [] });
    expect(store.size()).toBe(1);
  });

  it("ignores a save to an id the store never issued", () => {
    const store = createResumeStore();
    const forged = `rsm_${"b".repeat(32)}`;
    store.save(forged, state("x"));
    expect(store.size()).toBe(0);
    expect(store.load(forged, "alice")).toBeUndefined();
  });

  it("does not resurrect an expired entry on save", () => {
    const time = clock();
    const store = createResumeStore(time.now);
    const id = store.create("alice");
    time.advance(11 * MINUTE);
    store.size();
    store.save(id, state("late"));
    expect(store.load(id, "alice")).toBeUndefined();
  });

  it("never holds more than 5,000 entries and drops the oldest first", () => {
    const store = createResumeStore(() => 1_000_000);
    const ids: string[] = [];
    for (let i = 0; i < 5_010; i += 1) ids.push(store.create("alice"));
    expect(store.size()).toBeLessThanOrEqual(5_000);
    expect(store.load(ids[0]!, "alice")).toBeUndefined();
    expect(store.load(ids[9]!, "alice")).toBeUndefined();
    expect(store.load(ids[5_009]!, "alice")).toEqual({ history: [] });
  });

  it("keeps a recently saved entry when the cap forces old ones out", () => {
    const store = createResumeStore(() => 1_000_000);
    const first = store.create("alice");
    for (let i = 0; i < 4_990; i += 1) store.create("alice");
    store.save(first, state("active"));
    for (let i = 0; i < 100; i += 1) store.create("alice");
    expect(store.size()).toBeLessThanOrEqual(5_000);
    expect(store.load(first, "alice")).toEqual(state("active"));
  });
});

describe("isResumeId", () => {
  it("accepts well-formed ids", () => {
    expect(isResumeId(`rsm_${"A".repeat(32)}`)).toBe(true);
    expect(isResumeId(`rsm_${"a-_9".repeat(8)}`)).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isResumeId(`rsm_${"a".repeat(31)}`)).toBe(false);
    expect(isResumeId(`rsm_${"a".repeat(33)}`)).toBe(false);
    expect(isResumeId(`rsm_${"a".repeat(31)}.`)).toBe(false);
    expect(isResumeId(`rsm_${"a".repeat(32)}\n`)).toBe(false);
    expect(isResumeId(` rsm_${"a".repeat(32)}`)).toBe(false);
    expect(isResumeId("")).toBe(false);
    expect(isResumeId(undefined)).toBe(false);
    expect(isResumeId(7)).toBe(false);
  });
});
