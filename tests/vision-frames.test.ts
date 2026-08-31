import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameAssembler } from "../server/vision-frames";
import type { VisionFramesEvent } from "../shared/agent";

const chunk = (
  commandId: string,
  index: number,
  total: number,
  image: string,
  question?: string
): VisionFramesEvent => ({
  type: "vision.frames",
  commandId,
  reason: "gallery",
  index,
  total,
  image,
  ...(question ? { question } : {})
});

describe("createFrameAssembler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function harness() {
    const completed: Array<{ commandId: string; frames: string[]; question?: string }> = [];
    const incomplete: string[] = [];
    const assembler = createFrameAssembler({
      onComplete: (a) => completed.push(a),
      onIncomplete: (id) => incomplete.push(id)
    });
    return { assembler, completed, incomplete };
  }

  it("assembles frames in index order regardless of arrival order", () => {
    const { assembler, completed } = harness();
    assembler.accept(chunk("c1", 1, 3, "B"));
    assembler.accept(chunk("c1", 0, 3, "A", "有什么"));
    assembler.accept(chunk("c1", 2, 3, "C"));
    expect(completed).toEqual([{ commandId: "c1", frames: ["A", "B", "C"], question: "有什么" }]);
  });

  it("times out an incomplete set and never completes it later", () => {
    const { assembler, completed, incomplete } = harness();
    assembler.accept(chunk("c2", 0, 2, "A"));
    vi.advanceTimersByTime(10_000);
    expect(incomplete).toEqual(["c2"]);
    assembler.accept(chunk("c2", 1, 2, "B")); // opens a NEW 2-slot set, does not complete the old one
    expect(completed).toEqual([]);
  });

  it("ignores duplicate indexes and mismatched totals", () => {
    const { assembler, completed } = harness();
    assembler.accept(chunk("c3", 0, 2, "A"));
    assembler.accept(chunk("c3", 0, 2, "OVERWRITE"));
    assembler.accept(chunk("c3", 1, 3, "WRONG_TOTAL"));
    assembler.accept(chunk("c3", 1, 2, "B"));
    expect(completed).toEqual([{ commandId: "c3", frames: ["A", "B"] }]);
  });

  it("completes a single-frame set immediately without waiting", () => {
    const { assembler, completed } = harness();
    assembler.accept(chunk("c4", 0, 1, "ONLY"));
    expect(completed).toEqual([{ commandId: "c4", frames: ["ONLY"] }]);
  });

  it("tracks independent commands independently", () => {
    const { assembler, completed, incomplete } = harness();
    assembler.accept(chunk("a", 0, 1, "A"));
    assembler.accept(chunk("b", 0, 2, "B0"));
    vi.advanceTimersByTime(10_000);
    expect(completed.map((c) => c.commandId)).toEqual(["a"]);
    expect(incomplete).toEqual(["b"]);
  });
});
