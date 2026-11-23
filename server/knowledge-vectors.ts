/**
 * Vectors for the knowledge base, kept in one contiguous `Float32Array` so a query is a single
 * pass over memory, plus a bounded top-k selection so nothing sorts every score.
 */

/** `count` vectors of `dimensions` numbers, row after row. Rows are L2-normalised. */
export type VectorMatrix = { data: Float32Array; dimensions: number; count: number };

/** Copies a list of vectors into one matrix. Returns undefined when they differ in length. */
export function matrixFromVectors(vectors: Float32Array[]): VectorMatrix | undefined {
  const dimensions = vectors[0]?.length ?? 0;
  const data = new Float32Array(vectors.length * dimensions);
  for (let row = 0; row < vectors.length; row++) {
    const vector = vectors[row] as Float32Array;
    if (vector.length !== dimensions) return undefined;
    data.set(vector, row * dimensions);
  }
  return { data, dimensions, count: vectors.length };
}

/** Keeps the `k` best (id, score) pairs: higher score first, and the lower id wins a tie.
 *  Memory is fixed at `k`, and an offer that cannot get in costs one comparison. */
export function topSelector(k: number) {
  const size = Math.max(1, Math.floor(k));
  const ids = new Int32Array(size);
  const scores = new Float64Array(size);
  let held = 0;
  return {
    offer(id: number, score: number): void {
      if (held === size) {
        const worst = scores[held - 1] as number;
        if (score < worst || (score === worst && id > (ids[held - 1] as number))) return;
        held--;
      }
      let at = held;
      while (at > 0) {
        const above = scores[at - 1] as number;
        if (above > score || (above === score && (ids[at - 1] as number) < id)) break;
        ids[at] = ids[at - 1] as number;
        scores[at] = above;
        at--;
      }
      ids[at] = id;
      scores[at] = score;
      held++;
    },
    result(): { id: number; score: number }[] {
      return Array.from({ length: held }, (_, i) => ({ id: ids[i] as number, score: scores[i] as number }));
    }
  };
}

/** The `k` rows most similar to `query` (a dot product, so `query` must be unit length when
 *  the rows are), at or above `floor`. */
export function topSimilar(
  matrix: VectorMatrix,
  query: Float32Array,
  k: number,
  floor: number
): { id: number; score: number }[] {
  const { data, dimensions, count } = matrix;
  const top = topSelector(k);
  const stop = dimensions - (dimensions % 4);
  for (let row = 0, base = 0; row < count; row++, base += dimensions) {
    let a = 0;
    let b = 0;
    let c = 0;
    let d = 0;
    let i = 0;
    for (; i < stop; i += 4) {
      a += (data[base + i] as number) * (query[i] as number);
      b += (data[base + i + 1] as number) * (query[i + 1] as number);
      c += (data[base + i + 2] as number) * (query[i + 2] as number);
      d += (data[base + i + 3] as number) * (query[i + 3] as number);
    }
    for (; i < dimensions; i++) a += (data[base + i] as number) * (query[i] as number);
    const score = a + b + c + d;
    if (score >= floor) top.offer(row, score);
  }
  return top.result();
}
