import { randomBytes } from "node:crypto";

/**
 * What a conversation needs to carry on after its connection drops: the turns
 * so far and the agent it was with. A voice model's own memory dies with its
 * socket, so without this a client that reconnects (a phone leaving a lift, a
 * laptop waking up) meets an assistant that has forgotten the conversation.
 *
 * The relay hands each session a resume id in `session.started`. A client that
 * reconnects sends it back as `session.start.resume` and the new session
 * starts from the stored state. Kept in memory only: it is gone after
 * {@link RESUME_TTL_MS} without an update, and after a relay restart.
 */

export type HistoryTurn = { speaker: "user" | "agent"; text: string };

export type ResumeState = {
  history: HistoryTurn[];
  /** The agent the conversation was with (see server/conversation-config.ts). */
  agent?: string;
  /** What the conversation's flow has collected and saved so far (see server/agent-entry.ts). */
  values?: Record<string, string | number | boolean>;
  /**
   * What the flow did when the conversation started, as the model was told it, and the sentences of it the user
   * has not been given yet.
   */
  start?: { note: string; unsaid?: string[] };
};

const RESUME_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 5_000;
const RESUME_ID = /^rsm_[A-Za-z0-9_-]{32}$/;

type Entry = { owner: string; state: ResumeState; touchedAt: number };

export type ResumeStore = {
  /** A new id for a session of `owner`. */
  create(owner: string): string;
  /** The state saved under `id`, when it exists, is fresh and belongs to `owner`. */
  load(id: unknown, owner: string): ResumeState | undefined;
  /** Replaces the state under `id`. Ignored for an id the store did not issue. */
  save(id: string, state: ResumeState): void;
  /** Number of live entries, for tests and metrics. */
  size(): number;
};

export function createResumeStore(now: () => number = Date.now): ResumeStore {
  // Insertion-ordered, and re-inserted on every save: the first key is the stalest.
  const entries = new Map<string, Entry>();

  function expire(): void {
    const cutoff = now() - RESUME_TTL_MS;
    for (const [id, entry] of entries) {
      if (entry.touchedAt > cutoff && entries.size <= MAX_ENTRIES) break;
      entries.delete(id);
    }
  }

  return {
    create(owner) {
      expire();
      const id = `rsm_${randomBytes(24).toString("base64url")}`;
      entries.set(id, { owner, state: { history: [] }, touchedAt: now() });
      return id;
    },
    load(id, owner) {
      if (typeof id !== "string" || !RESUME_ID.test(id)) return undefined;
      expire();
      const entry = entries.get(id);
      // The id alone is not enough: a session token minted for one user must
      // not pick up another user's conversation with a leaked id.
      if (!entry || entry.owner !== owner) return undefined;
      return entry.state;
    },
    save(id, state) {
      const entry = entries.get(id);
      if (!entry) return;
      entries.delete(id);
      entries.set(id, { owner: entry.owner, state, touchedAt: now() });
    },
    size() {
      expire();
      return entries.size;
    }
  };
}

/** The relay's own store. */
export const resumeStore = createResumeStore();

/** True for a value shaped like a resume id (it may still be unknown or expired). */
export function isResumeId(value: unknown): value is string {
  return typeof value === "string" && RESUME_ID.test(value);
}
