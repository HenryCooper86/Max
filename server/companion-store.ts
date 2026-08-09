import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTestingStorageDirectory } from "./testing-storage";

export type CompanionBinding = {
  accountId: string;
  deviceId: string;
  createdAt: number;
  updatedAt: number;
};

export type CompanionBindingStore = {
  ready(): boolean;
  bindingForAccount(accountId: string): CompanionBinding | undefined;
  bindingForDevice(deviceId: string): CompanionBinding | undefined;
  bind(
    accountId: string,
    deviceId: string,
    now?: number
  ): Promise<{
    binding: CompanionBinding;
    displaced: CompanionBinding[];
  }>;
  unbindAccount(accountId: string): Promise<CompanionBinding | undefined>;
  readinessIssue(): string | undefined;
  flush(): Promise<void>;
};

type BindingSnapshot = {
  version: 1;
  bindings: CompanionBinding[];
};

type BindingMaps = {
  byAccount: Map<string, CompanionBinding>;
  byDevice: Map<string, CompanionBinding>;
};

const DEFAULT_COMPANION_BINDINGS_FILE = path.join(os.homedir(), ".horizon-helmet-testing", "companion-bindings.json");

function cloneBinding(binding: CompanionBinding): CompanionBinding {
  return { ...binding };
}

function cloneMaps(source: BindingMaps): BindingMaps {
  const byAccount = new Map<string, CompanionBinding>();
  const byDevice = new Map<string, CompanionBinding>();
  for (const binding of source.byAccount.values()) {
    const copy = cloneBinding(binding);
    byAccount.set(copy.accountId, copy);
    byDevice.set(copy.deviceId, copy);
  }
  return { byAccount, byDevice };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function loadBinding(value: unknown): CompanionBinding | null {
  if (!isRecord(value)) return null;
  if (!validId(value.accountId) || !validId(value.deviceId)) return null;
  if (!validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) return null;
  return {
    accountId: value.accountId,
    deviceId: value.deviceId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function parseSnapshot(raw: unknown): BindingMaps {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.bindings)) {
    throw new Error("companion binding store has an invalid snapshot");
  }
  const byAccount = new Map<string, CompanionBinding>();
  const byDevice = new Map<string, CompanionBinding>();
  for (const entry of raw.bindings) {
    const binding = loadBinding(entry);
    if (!binding) throw new Error("companion binding store contains an invalid binding");
    if (byAccount.has(binding.accountId)) throw new Error("companion binding store contains duplicate accounts");
    if (byDevice.has(binding.deviceId)) throw new Error("companion binding store contains duplicate devices");
    byAccount.set(binding.accountId, binding);
    byDevice.set(binding.deviceId, binding);
  }
  return { byAccount, byDevice };
}

function serializeSnapshot(maps: BindingMaps): string {
  const snapshot: BindingSnapshot = { version: 1, bindings: [...maps.byAccount.values()] };
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function defaultFilePath(): string {
  return process.env.COMPANION_BINDINGS_FILE?.trim() || DEFAULT_COMPANION_BINDINGS_FILE;
}

function unreadableIssue(error: unknown): string {
  return `Companion binding store unreadable: ${error instanceof Error ? error.message : String(error)}`;
}

function persistIssue(error: unknown): string {
  return `Companion binding store persist failed: ${error instanceof Error ? error.message : String(error)}`;
}

export function createCompanionBindingStore(options: { filePath?: string | null; now?: () => number } = {}): CompanionBindingStore {
  const filePath = options.filePath === undefined ? defaultFilePath() : options.filePath;
  const clock = options.now ?? Date.now;
  let maps: BindingMaps = { byAccount: new Map(), byDevice: new Map() };
  let issue: string | undefined;
  let mutationQueue: Promise<void> = Promise.resolve();

  if (filePath) {
    try {
      maps = parseSnapshot(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        maps = { byAccount: new Map(), byDevice: new Map() };
        issue = unreadableIssue(error);
      }
    }
  }

  function assertReady(): void {
    if (issue) throw new Error(issue);
  }

  async function persist(candidate: BindingMaps): Promise<void> {
    if (!filePath) return;
    const tempPath = `${filePath}.write`;
    await ensureTestingStorageDirectory(filePath);
    await fs.promises.writeFile(tempPath, serializeSnapshot(candidate), { mode: 0o600 });
    await fs.promises.chmod(tempPath, 0o600);
    await fs.promises.rename(tempPath, filePath);
  }

  function commit(candidate: BindingMaps): void {
    maps = candidate;
  }

  function queueMutation<T>(mutate: () => Promise<T>): Promise<T> {
    const operation = mutationQueue.then(mutate);
    mutationQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  return {
    ready(): boolean {
      return issue === undefined;
    },

    bindingForAccount(accountId: string): CompanionBinding | undefined {
      const binding = maps.byAccount.get(accountId);
      return binding && cloneBinding(binding);
    },

    bindingForDevice(deviceId: string): CompanionBinding | undefined {
      const binding = maps.byDevice.get(deviceId);
      return binding && cloneBinding(binding);
    },

    bind(accountId: string, deviceId: string, now = clock()) {
      if (!validId(accountId)) return Promise.reject(new Error("Invalid accountId"));
      if (!validId(deviceId)) return Promise.reject(new Error("Invalid deviceId"));
      if (!validTimestamp(now)) return Promise.reject(new Error("Invalid binding timestamp"));
      return queueMutation(async () => {
        assertReady();
        const candidate = cloneMaps(maps);
        const existingAccount = candidate.byAccount.get(accountId);
        const existingDevice = candidate.byDevice.get(deviceId);
        const unchangedPair =
          existingAccount?.accountId === accountId &&
          existingAccount.deviceId === deviceId &&
          existingDevice === existingAccount;
        const displaced = (unchangedPair ? [] : [existingAccount, existingDevice])
          .filter((binding): binding is CompanionBinding => Boolean(binding))
          .filter((binding, index, bindings) => bindings.findIndex((item) => item === binding) === index);
        for (const binding of displaced) {
          candidate.byAccount.delete(binding.accountId);
          candidate.byDevice.delete(binding.deviceId);
        }
        const binding: CompanionBinding = {
          accountId,
          deviceId,
          createdAt: existingAccount?.accountId === accountId && existingAccount.deviceId === deviceId ? existingAccount.createdAt : now,
          updatedAt: now
        };
        candidate.byAccount.set(accountId, binding);
        candidate.byDevice.set(deviceId, binding);
        await persist(candidate);
        commit(candidate);
        return { binding: cloneBinding(binding), displaced: displaced.map(cloneBinding) };
      }).catch((error) => {
        issue ??= persistIssue(error);
        throw error;
      });
    },

    unbindAccount(accountId: string) {
      if (!validId(accountId)) return Promise.reject(new Error("Invalid accountId"));
      return queueMutation(async () => {
        assertReady();
        const binding = maps.byAccount.get(accountId);
        if (!binding) return undefined;
        const candidate = cloneMaps(maps);
        candidate.byAccount.delete(binding.accountId);
        candidate.byDevice.delete(binding.deviceId);
        await persist(candidate);
        commit(candidate);
        return cloneBinding(binding);
      }).catch((error) => {
        issue ??= persistIssue(error);
        throw error;
      });
    },

    readinessIssue(): string | undefined {
      return issue;
    },

    flush(): Promise<void> {
      return mutationQueue;
    }
  };
}
