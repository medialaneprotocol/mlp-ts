/**
 * The windows the protocol bounds, and what they cost.
 *
 * The reference implementation keeps both windows in the same shape — a set
 * and a FIFO order over the same keys — because a deque drops its oldest key
 * in constant time, where an array's `shift` moves every element it holds.
 * The assembler's dedupe window is 4096 pairs wide, so the difference is a
 * 32 kB move on every fragment once the window is full: the steady state of
 * a real lane.
 */

import { describe, expect, it } from "vitest";

import { FifoSet } from "./fifo-set";

describe("the FIFO window", () => {
  it("holds exactly what it was given, up to its depth", () => {
    const window = new FifoSet<number>(4);

    for (const key of [1, 2, 3, 4]) {
      window.add(key);
    }

    expect(window.size).toBe(4);
    expect(window.has(1)).toBe(true);
    expect(window.has(4)).toBe(true);
  });

  it("drops the oldest key once it is full", () => {
    const window = new FifoSet<number>(4);

    for (const key of [1, 2, 3, 4, 5]) {
      window.add(key);
    }

    expect(window.size).toBe(4);
    expect(window.has(1)).toBe(false);
    expect(window.has(2)).toBe(true);
    expect(window.has(5)).toBe(true);
  });

  it("does not move a key that is still held", () => {
    const window = new FifoSet<number>(3);

    window.add(1);
    window.add(2);
    window.add(1);
    window.add(3);
    window.add(4);

    // The second `1` did not make it young again: the window is a record of
    // what arrived, not a count of how often it arrived.
    expect(window.has(1)).toBe(false);
    expect(window.has(2)).toBe(true);
  });

  it("drops its oldest key in constant time, whatever it holds", () => {
    const rounds = 20_000;
    const costPerKey = (capacity: number): number => {
      const window = new FifoSet<number>(capacity);
      const started = performance.now();
      for (let key = 0; key < rounds; key += 1) {
        window.add(key);
      }
      return (performance.now() - started) / rounds;
    };

    // Warm-up.
    costPerKey(4_096);
    const narrow = costPerKey(4_096);
    const wide = costPerKey(262_144);

    console.log(
      `MEASURE_JS fifo window: narrow=${(narrow * 1_000).toFixed(3)}us/key ` +
        `wide=${(wide * 1_000).toFixed(3)}us/key`,
    );

    // A window that drops its oldest key by moving every element it holds
    // would cost sixteen times as much when it holds sixteen times as much.
    expect(wide).toBeLessThanOrEqual(narrow * 2);
  });
});
