import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanionBindingStore } from "../server/companion-store";

let tempDir: string | null = null;

function bindingPath(name = "companion-bindings.json"): string {
  tempDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "horizon-companion-store-"));
  return path.join(tempDir, "private", name);
}

function writeStoredBindings(filePath: string, bindings: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, bindings }));
}

afterEach(() => {
  vi.restoreAllMocks();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("companion binding store", () => {
  it("bootstraps an absent file into a private durable store", async () => {
    const filePath = bindingPath();
    const store = createCompanionBindingStore({ filePath });

    expect(store.ready()).toBe(true);
    await store.bind("acct-a", "rdk-a", 100);
    await store.flush();

    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      version: 1,
      bindings: [{ accountId: "acct-a", deviceId: "rdk-a", createdAt: 100, updatedAt: 100 }]
    });
  });

  it("repairs an existing explicit binding directory to private mode", async () => {
    const filePath = bindingPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.dirname(filePath), 0o755);
    const store = createCompanionBindingStore({ filePath });

    await store.bind("acct-a", "rdk-a", 100);

    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
  });

  it("writes a staged .write file before atomically renaming it into place", async () => {
    const filePath = bindingPath();
    const originalRename = fs.promises.rename;
    const rename = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      expect(from).toBe(`${filePath}.write`);
      expect(to).toBe(filePath);
      expect(fs.existsSync(from)).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.statSync(from).mode & 0o777).toBe(0o600);
      await originalRename(from, to);
    });
    const store = createCompanionBindingStore({ filePath });

    await store.bind("acct-a", "rdk-a", 100);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${filePath}.write`)).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("reloads the binding persisted by an earlier store", async () => {
    const filePath = bindingPath();
    const first = createCompanionBindingStore({ filePath });
    await first.bind("acct-a", "rdk-a", 100);
    await first.flush();

    const reloaded = createCompanionBindingStore({ filePath });

    expect(reloaded.ready()).toBe(true);
    expect(reloaded.bindingForAccount("acct-a")).toEqual({
      accountId: "acct-a",
      deviceId: "rdk-a",
      createdAt: 100,
      updatedAt: 100
    });
    expect(reloaded.bindingForDevice("rdk-a")?.accountId).toBe("acct-a");
  });

  it("replaces bindings one-to-one and reports each displaced record", async () => {
    const store = createCompanionBindingStore({ filePath: null });
    const first = await store.bind("acct-a", "rdk-a", 100);
    const second = await store.bind("acct-b", "rdk-a", 200);
    const third = await store.bind("acct-b", "rdk-b", 300);

    expect(second.displaced).toEqual([first.binding]);
    expect(third.displaced).toEqual([second.binding]);
    expect(store.bindingForAccount("acct-a")).toBeUndefined();
    expect(store.bindingForAccount("acct-b")).toEqual({
      accountId: "acct-b",
      deviceId: "rdk-b",
      createdAt: 300,
      updatedAt: 300
    });
    expect(store.bindingForDevice("rdk-a")).toBeUndefined();
  });

  it("updates an unchanged pair without displacing it and preserves its creation time", async () => {
    const store = createCompanionBindingStore({ filePath: null });
    await store.bind("acct-a", "rdk-a", 100);

    const rebound = await store.bind("acct-a", "rdk-a", 200);

    expect(rebound).toEqual({
      binding: { accountId: "acct-a", deviceId: "rdk-a", createdAt: 100, updatedAt: 200 },
      displaced: []
    });
  });

  it("removes an account binding durably", async () => {
    const filePath = bindingPath();
    const store = createCompanionBindingStore({ filePath });
    await store.bind("acct-a", "rdk-a", 100);

    expect(await store.unbindAccount("acct-a")).toEqual({
      accountId: "acct-a",
      deviceId: "rdk-a",
      createdAt: 100,
      updatedAt: 100
    });
    expect(store.bindingForAccount("acct-a")).toBeUndefined();
    await store.flush();
    expect(createCompanionBindingStore({ filePath }).bindingForDevice("rdk-a")).toBeUndefined();
  });

  it("fails closed for malformed JSON and does not expose a trusted empty binding set", async () => {
    const filePath = bindingPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not json");

    const store = createCompanionBindingStore({ filePath });

    expect(store.ready()).toBe(false);
    expect(store.readinessIssue()).toContain("unreadable");
    expect(store.bindingForAccount("acct-a")).toBeUndefined();
    await expect(store.bind("acct-a", "rdk-a", 1)).rejects.toThrow("unreadable");
  });

  it("fails closed for malformed records and duplicate account or device records", () => {
    const malformedPath = bindingPath("malformed.json");
    writeStoredBindings(malformedPath, [{ accountId: "acct-a", deviceId: "rdk-a", createdAt: "now", updatedAt: 1 }]);
    expect(createCompanionBindingStore({ filePath: malformedPath }).ready()).toBe(false);

    const duplicateAccountPath = bindingPath("duplicate-account.json");
    writeStoredBindings(duplicateAccountPath, [
      { accountId: "acct-a", deviceId: "rdk-a", createdAt: 1, updatedAt: 1 },
      { accountId: "acct-a", deviceId: "rdk-b", createdAt: 2, updatedAt: 2 }
    ]);
    expect(createCompanionBindingStore({ filePath: duplicateAccountPath }).ready()).toBe(false);

    const duplicateDevicePath = bindingPath("duplicate-device.json");
    writeStoredBindings(duplicateDevicePath, [
      { accountId: "acct-a", deviceId: "rdk-a", createdAt: 1, updatedAt: 1 },
      { accountId: "acct-b", deviceId: "rdk-a", createdAt: 2, updatedAt: 2 }
    ]);
    expect(createCompanionBindingStore({ filePath: duplicateDevicePath }).ready()).toBe(false);
  });

  it("fails closed when the persisted path cannot be read", () => {
    const directoryPath = bindingPath();
    fs.mkdirSync(directoryPath, { recursive: true });

    const store = createCompanionBindingStore({ filePath: directoryPath });

    expect(store.ready()).toBe(false);
    expect(store.readinessIssue()).toContain("unreadable");
  });

  it("keeps the previous binding authoritative after a real filesystem write failure", async () => {
    const filePath = bindingPath();
    const store = createCompanionBindingStore({ filePath });
    await store.bind("acct-a", "rdk-a", 100);
    await store.flush();
    fs.rmSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(path.dirname(filePath), "not a directory");

    await expect(store.bind("acct-b", "rdk-b", 200)).rejects.toThrow();

    expect(store.ready()).toBe(false);
    expect(store.readinessIssue()).toContain("persist");
    expect(store.bindingForAccount("acct-a")).toEqual({
      accountId: "acct-a",
      deviceId: "rdk-a",
      createdAt: 100,
      updatedAt: 100
    });
    expect(store.bindingForAccount("acct-b")).toBeUndefined();
  });

  it("validates binding values even for an in-memory store", async () => {
    const store = createCompanionBindingStore({ filePath: null });

    await expect(store.bind("", "rdk-a", 1)).rejects.toThrow("Invalid accountId");
    await expect(store.bind("acct-a", "", 1)).rejects.toThrow("Invalid deviceId");
    await expect(store.bind("acct-a", "rdk-a", Number.NaN)).rejects.toThrow("Invalid binding timestamp");
    expect(store.ready()).toBe(true);
  });
});
