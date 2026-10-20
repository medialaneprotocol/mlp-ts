/**
 * A FIFO set: the keys it holds, with the oldest dropped once it is full.
 *
 * The reference implementation keeps the same shape — a hash set and a deque
 * of the same keys — for the two windows the protocol bounds: the
 * assembler's `(object_id, fragment_index)` dedupe window (MLP spec §5.4
 * step 5) and the receiver's applied-part record (MLP spec §5.1). A deque
 * drops its oldest key in constant time; an array's `shift` moves every
 * element it holds, and the dedupe window is 4096 pairs wide, so the
 * difference is a 32 kB move on every fragment once the window is full.
 *
 * The window is FIFO, not LRU: a key that is still held is not moved to the
 * back when it is seen again.
 */
export class FifoSet<T> {
  private readonly keys = new Set<T>();
  /** The keys in the order they were added; the prefix before `head` is spent. */
  private readonly order: T[] = [];
  /** How many keys at the front of `order` have been dropped. */
  private head = 0;

  constructor(private readonly capacity: number) {}

  /** Whether the key is held. */
  has(key: T): boolean {
    return this.keys.has(key);
  }

  /**
   * Add the key.
   *
   * A key that is already held is left where it is: the window is a record of
   * what arrived, not a count of how often it arrived.
   */
  add(key: T): void {
    if (this.keys.has(key)) {
      return;
    }
    this.keys.add(key);
    this.order.push(key);
    if (this.order.length - this.head > this.capacity) {
      const dropped = this.order[this.head];
      this.head += 1;
      this.keys.delete(dropped);
      // Reclaim the spent prefix once it is worth the move.
      if (this.head >= 1024 && this.head * 2 >= this.order.length) {
        this.order.splice(0, this.head);
        this.head = 0;
      }
    }
  }

  /** How many keys the window holds. */
  get size(): number {
    return this.keys.size;
  }
}
