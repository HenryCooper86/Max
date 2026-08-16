// tests/voice-shell-classes.test.ts
import { describe, expect, it } from "vitest";
import { voiceFaceClassName } from "../src/lib/voice-shell";

// The landscape grid collapses its `captions` row to zero height when captions
// are closed, on the assumption that the row is then empty. The navigation
// panel shares that same grid area, so navigating with captions closed put the
// guidance card in a 0-height row: measured 140px clipped, drawn over the
// utility controls. CSS cannot see that the row is occupied, so the shell has
// to say so.

describe("voiceFaceClassName", () => {
  it("is just the base class with nothing open", () => {
    expect(voiceFaceClassName({ captionsOpen: false, navigationVisible: false })).toBe("voiceFace");
  });

  it("marks captions so the grid hands them the flexible row", () => {
    expect(voiceFaceClassName({ captionsOpen: true, navigationVisible: false })).toBe("voiceFace captionsVisible");
  });

  /// The regression: without this the captions row collapses under the card.
  it("marks navigation so the shared row is not collapsed under the card", () => {
    expect(voiceFaceClassName({ captionsOpen: false, navigationVisible: true })).toBe("voiceFace navVisible");
  });

  it("marks both when captions and navigation share the row", () => {
    expect(voiceFaceClassName({ captionsOpen: true, navigationVisible: true })).toBe(
      "voiceFace captionsVisible navVisible"
    );
  });

  // Trailing/duplicate spaces used to be emitted by the inline template this
  // replaces; class lists are compared verbatim in snapshots and tests.
  it("never emits stray whitespace", () => {
    for (const captionsOpen of [true, false]) {
      for (const navigationVisible of [true, false]) {
        const value = voiceFaceClassName({ captionsOpen, navigationVisible });
        expect(value).toBe(value.trim());
        expect(value).not.toContain("  ");
      }
    }
  });
});
