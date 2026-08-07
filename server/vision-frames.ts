/**
 * Pure chunked-frame assembler: collects multi-frame gallery understanding
 * requests into complete sets before passing them to Task 4's providers.
 *
 * Assembly is COMMAND-SCOPED: one set per commandId. Chunks from different
 * commands can interleave on one socket; assembly keeps them separate so the
 * relay can pipeline multiple lookups in parallel.
 *
 * FIRST-WRITE-WINS on duplicate indexes: a retransmitted chunk must not
 * corrupt a slot already filled. Silently ignoring duplicates avoids lock
 * overhead and prevents a stale copy from overwriting valid data.
 *
 * EXPIRED SETS NEVER RESURRECT: the timer drops the set on timeout, and a
 * late chunk for an expired commandId opens a NEW set instead of awakening
 * the old one. Why? The rider already heard "我看不清" (vision unavailable).
 * A belated completion would answer the same question twice, at best
 * redundant and at worst confusing if the rider has moved and the scene has
 * changed. The provider guard upstream only accepts issued commandIds anyway.
 *
 * Timers are injectable for deterministic testing (vi.useFakeTimers).
 */

import type { VisionFramesEvent } from "../shared/agent";

export type AssembledFrames = { commandId: string; frames: string[]; question?: string };

interface FrameSet {
  frames: (string | undefined)[];
  filledCount: number;
  question?: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

export function createFrameAssembler(options: {
  onComplete(assembled: AssembledFrames): void;
  onIncomplete(commandId: string): void;
  timeoutMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): { accept(event: VisionFramesEvent): void } {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const setTimeoutImpl = options.setTimeoutImpl ?? globalThis.setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? globalThis.clearTimeout;

  // Map from commandId to the current FrameSet
  const sets = new Map<string, FrameSet>();

  function accept(event: VisionFramesEvent): void {
    const { commandId, index, total, image, question } = event;

    let set = sets.get(commandId);

    // If no set exists for this commandId, create a new one
    if (!set) {
      set = {
        frames: new Array<string | undefined>(total),
        filledCount: 0,
        question: undefined,
        timeoutId: setTimeoutImpl(() => {
          // Timer fired: drop the set and call onIncomplete
          sets.delete(commandId);
          options.onIncomplete(commandId);
        }, timeoutMs)
      };
      sets.set(commandId, set);
    }

    // Ignore chunks with mismatched total
    if (set.frames.length !== total) {
      return;
    }

    // Ignore duplicate indexes (first write wins)
    if (set.frames[index] !== undefined) {
      return;
    }

    // Capture question from the first chunk carrying one
    if (question && !set.question) {
      set.question = question;
    }

    // Add the frame
    set.frames[index] = image;
    set.filledCount++;

    // If all slots are filled, complete and drop the set
    if (set.filledCount === total) {
      clearTimeoutImpl(set.timeoutId);
      sets.delete(commandId);
      options.onComplete({
        commandId,
        frames: set.frames as string[],
        ...(set.question ? { question: set.question } : {})
      });
    }
  }

  return { accept };
}
