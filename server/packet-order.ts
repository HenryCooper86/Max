/** How many newer packets may arrive before a missing one is given up: 60 ms of speech. */
const REORDER_WINDOW = 3;
/** A jump this large is a new stream, not a gap. */
const SEQUENCE_RESET = 500;

/**
 * Puts audio packets back in order. A network may deliver them out of order,
 * and a packet resent after a loss arrives after its successors. A packet that
 * is ahead of the next one expected waits, for at most {@link REORDER_WINDOW}
 * newer packets; then the gap is taken as lost. Duplicates and packets that
 * come too late are dropped. Sequence numbers count modulo 65,536.
 */
export class PacketOrder {
  private expected: number | undefined;
  private readonly waiting = new Map<number, Buffer>();

  /** Takes one packet; returns the payloads now ready, in order. */
  push(sequence: number, payload: Buffer): Buffer[] {
    if (this.expected === undefined) this.expected = sequence;
    const ahead = (sequence - this.expected) & 0xffff;
    if (ahead >= 0x8000) {
      // Behind what was already handed on. Far behind: the sender started again.
      if (0x10000 - ahead < SEQUENCE_RESET) return [];
      this.reset();
      this.expected = sequence;
    } else if (ahead >= SEQUENCE_RESET) {
      this.reset();
      this.expected = sequence;
    }
    // The payload's memory belongs to the network layer: keep a copy while it waits.
    if (sequence !== this.expected) this.waiting.set(sequence, Buffer.from(payload));
    const ready: Buffer[] = [];
    if (sequence === this.expected) {
      ready.push(payload);
      this.expected = (this.expected + 1) & 0xffff;
    } else if (this.waiting.size >= REORDER_WINDOW) {
      // The missing packets are not coming: carry on from the oldest one held.
      let oldest = sequence;
      for (const held of this.waiting.keys()) {
        if (((held - this.expected) & 0xffff) < ((oldest - this.expected) & 0xffff)) oldest = held;
      }
      this.expected = oldest;
    }
    for (let next = this.waiting.get(this.expected); next; next = this.waiting.get(this.expected)) {
      this.waiting.delete(this.expected);
      ready.push(next);
      this.expected = (this.expected + 1) & 0xffff;
    }
    return ready;
  }

  reset(): void {
    this.expected = undefined;
    this.waiting.clear();
  }
}
