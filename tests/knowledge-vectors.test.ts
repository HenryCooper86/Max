import { describe, expect, it } from "vitest";
import { buildKnowledgeIndex } from "../server/knowledge";
import { matrixFromVectors, topSelector, topSimilar } from "../server/knowledge-vectors";

let seed = 7;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const unit = (size: number) => {
  const vector = Float32Array.from({ length: size }, () => random() - 0.5);
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
};

describe("topSelector", () => {
  it("keeps the best k, highest first, and the lower id wins a tie", () => {
    const top = topSelector(3);
    [
      [5, 0.5],
      [1, 0.9],
      [9, 0.5],
      [2, 0.5],
      [3, 0.1],
      [4, 0.7]
    ].forEach(([id, score]) => top.offer(id!, score!));
    expect(top.result()).toEqual([
      { id: 1, score: 0.9 },
      { id: 4, score: 0.7 },
      { id: 2, score: 0.5 }
    ]);
  });

  it("matches a full sort on random scores", () => {
    const scores = Array.from({ length: 500 }, (_, id) => ({ id, score: Math.round(random() * 40) / 40 }));
    const top = topSelector(20);
    for (const { id, score } of [...scores].reverse()) top.offer(id, score);
    const expected = [...scores].sort((a, b) => b.score - a.score || a.id - b.id).slice(0, 20);
    expect(top.result()).toEqual(expected);
  });
});

describe("topSimilar", () => {
  it("finds the same rows as scoring every row and sorting, for sizes that are not a multiple of 4", () => {
    for (const size of [3, 8, 13]) {
      const vectors = Array.from({ length: 300 }, () => unit(size));
      const matrix = matrixFromVectors(vectors)!;
      const query = unit(size);
      const expected = vectors
        .map((vector, id) => ({ id, score: vector.reduce((sum, value, i) => sum + value * query[i]!, 0) }))
        .filter((item) => item.score >= 0.1)
        .sort((a, b) => b.score - a.score || a.id - b.id)
        .slice(0, 10);
      const found = topSimilar(matrix, query, 10, 0.1);
      expect(found.map((item) => item.id)).toEqual(expected.map((item) => item.id));
      found.forEach((item, i) => expect(item.score).toBeCloseTo(expected[i]!.score, 5));
    }
  });

  it("drops rows below the floor", () => {
    const matrix = matrixFromVectors([Float32Array.of(1, 0), Float32Array.of(0, 1)])!;
    expect(topSimilar(matrix, Float32Array.of(1, 0), 5, 0.25)).toEqual([{ id: 0, score: 1 }]);
  });
});

describe("matrixFromVectors", () => {
  it("lays rows out one after another and refuses vectors of different sizes", () => {
    const matrix = matrixFromVectors([Float32Array.of(1, 2), Float32Array.of(3, 4)])!;
    expect([...matrix.data]).toEqual([1, 2, 3, 4]);
    expect(matrix).toMatchObject({ dimensions: 2, count: 2 });
    expect(matrixFromVectors([Float32Array.of(1), Float32Array.of(1, 2)])).toBeUndefined();
  });
});

describe("keyword search on a large index", () => {
  it("ranks the same with a bounded head as with every match, and leaves no scores behind", () => {
    const words = Array.from({ length: 60 }, (_, i) => `term${String.fromCharCode(97 + (i % 26))}${i}`);
    const documents = Array.from({ length: 40 }, (_, d) => ({
      source: `d${d}.md`,
      text: Array.from(
        { length: 30 },
        () => `common ${Array.from({ length: 12 }, () => words[Math.floor(random() * words.length)]).join(" ")}`
      ).join("\n\n")
    }));
    const index = buildKnowledgeIndex(documents, { chunkChars: 200 });
    expect(index.size).toBeGreaterThan(500);
    const all = index.rank("common terma0 termb1");
    expect(index.rank("common terma0 termb1", 7)).toEqual(all.slice(0, 7));
    expect(index.rank("common terma0 termb1")).toEqual(all);
    expect(index.rank("nothing-here-at-all")).toEqual([]);
    // Odd limits behave as `slice(0, limit)` on the full ranking always did.
    for (const odd of [0, -1, -3, Number.NaN, 0.5, 2.5, Number.POSITIVE_INFINITY])
      expect(index.rank("common terma0 termb1", odd)).toEqual(all.slice(0, odd));
    expect(index.rank("common", 0)).toEqual([]);
    expect(index.search("common", 4)).toHaveLength(4);
  });
});
