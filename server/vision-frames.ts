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
