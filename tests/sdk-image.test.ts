import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_MAX_SIDE, encodeImage, type ImageEncoder } from "../sdk/src/image";
import { MAX_IMAGE_BASE64_CHARS } from "../sdk/src/protocol";

/** A fake picture of the given size whose encoding is as long as `length(width, height, quality)` says. */
function fake(width: number, height: number, length: (width: number, height: number, quality: number) => number) {
  const encodes: Array<[number, number, number]> = [];
  let closed = 0;
  const open: ImageEncoder = async () => ({
    width,
    height,
    async encode(targetWidth, targetHeight, quality) {
      encodes.push([targetWidth, targetHeight, quality]);
      return "A".repeat(length(targetWidth, targetHeight, quality));
    },
    close: () => void (closed += 1)
  });
  return { open, encodes, closed: () => closed };
}

describe("encodeImage", () => {
  it("scales the longer side down to 1024 by default and keeps the proportions", async () => {
    const { open, encodes, closed } = fake(4000, 3000, () => 100);
    expect(await encodeImage("data:x", undefined, open)).toHaveLength(100);
    expect(encodes).toEqual([[1024, 768, 0.85]]);
    expect(DEFAULT_IMAGE_MAX_SIDE).toBe(1024);
    expect(closed()).toBe(1);
  });

  it("does not enlarge a small picture", async () => {
    const { open, encodes } = fake(300, 200, () => 100);
    await encodeImage("data:x", 1024, open);
    expect(encodes).toEqual([[300, 200, 0.85]]);
  });

  it("encodes a picture smaller than the smallest size as it is", async () => {
    const { open, encodes } = fake(10, 10, () => 100);
    await encodeImage("data:x", 1024, open);
    expect(encodes).toEqual([[10, 10, 0.85]]);
  });

  it("honours maxSide, and falls back to the default for a nonsense one", async () => {
    const small = fake(2000, 1000, () => 100);
    await encodeImage("data:x", 512, small.open);
    expect(small.encodes[0]).toEqual([512, 256, 0.85]);
    for (const bad of [0, -5, NaN, 10]) {
      const odd = fake(2000, 1000, () => 100);
      await encodeImage("data:x", bad, odd.open);
      expect(odd.encodes[0]).toEqual([1024, 512, 0.85]);
    }
  });

  it("lowers the quality before it lowers the size", async () => {
    const { open, encodes } = fake(2000, 1000, (_w, _h, quality) => (quality > 0.6 ? MAX_IMAGE_BASE64_CHARS + 1 : 5));
    expect(await encodeImage("data:x", 1024, open)).toHaveLength(5);
    expect(encodes).toEqual([
      [1024, 512, 0.85],
      [1024, 512, 0.7],
      [1024, 512, 0.55]
    ]);
  });

  it("then lowers the size until it fits", async () => {
    const { open, encodes } = fake(2000, 1000, (width) => (width > 600 ? MAX_IMAGE_BASE64_CHARS + 1 : 5));
    expect(await encodeImage("data:x", 1024, open)).toHaveLength(5);
    // 1024 -> 768 -> 576: the first size at or under 600 wide.
    expect(encodes.at(-1)).toEqual([576, 288, 0.85]);
    expect(encodes.map(([width]) => width)).toEqual([1024, 1024, 1024, 768, 768, 768, 576]);
  });

  it("accepts a result of exactly the limit", async () => {
    const { open } = fake(100, 100, () => MAX_IMAGE_BASE64_CHARS);
    expect(await encodeImage("data:x", 1024, open)).toHaveLength(MAX_IMAGE_BASE64_CHARS);
  });

  it("rejects with a clear error when nothing fits, and still releases the picture", async () => {
    const { open, closed } = fake(2000, 1000, () => MAX_IMAGE_BASE64_CHARS + 1);
    await expect(encodeImage("data:x", 1024, open)).rejects.toThrow(/does not fit in 240000 characters/);
    expect(closed()).toBe(1);
  });

  it("rejects a source with no pixels, such as a video that has not started", async () => {
    const { open } = fake(0, 0, () => 1);
    await expect(encodeImage("data:x", 1024, open)).rejects.toThrow(/no pixels/);
  });
});
