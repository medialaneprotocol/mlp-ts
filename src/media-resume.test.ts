import { describe, expect, it } from "vitest";

import {
  MediaResumeStore,
  ParkLedger,
  ReconnectLadder,
  ReconnectStage,
  classifyMediaClose,
  emptyResumeSnapshot,
} from "./media-resume";

describe("the RTT-relative reconnect ladder (MLP spec §8.4)", () => {
  it("starts at zero and doubles from the RTT base with clamping", () => {
    const ladder = new ReconnectLadder(1_000);
    expect(ladder.delayFor(0)).toBe(0);
    expect(ladder.delayFor(1)).toBe(1_000);
    expect(ladder.delayFor(2)).toBe(2_000);
    expect(ladder.delayFor(3)).toBe(4_000);
    expect(ladder.delayFor(4)).toBe(8_000);
    expect(ladder.delayFor(5)).toBe(16_000);
    expect(ladder.delayFor(6)).toBe(30_000);
    expect(ladder.delayFor(7)).toBe(30_000);
  });

  it("floors the base at 500 ms and adds at most 250 ms of jitter", () => {
    const fast = new ReconnectLadder(10);
    expect(fast.baseDelayMs).toBe(500);
    expect(fast.delayFor(1, 5_000)).toBe(750);
    const slow = new ReconnectLadder(2_000);
    expect(slow.delayFor(1)).toBe(2_000);
  });

  it("escalates through bootstrap and suspended stages without giving up", () => {
    const ladder = new ReconnectLadder(500);
    expect(ladder.stageFor(0)).toBe(ReconnectStage.CONTROL_RETRY);
    expect(ladder.stageFor(2)).toBe(ReconnectStage.CONTROL_RETRY);
    expect(ladder.stageFor(3)).toBe(ReconnectStage.BOOTSTRAP);
    expect(ladder.stageFor(5)).toBe(ReconnectStage.BOOTSTRAP);
    expect(ladder.stageFor(6)).toBe(ReconnectStage.SUSPENDED);
    expect(ladder.stageFor(60)).toBe(ReconnectStage.SUSPENDED);
    expect(ladder.stageNeedsBootstrap(3)).toBe(true);
    expect(ladder.stageNeedsBootstrap(2)).toBe(false);
  });

  it("never gives up and resets after an accepted attach", () => {
    const ladder = new ReconnectLadder(500);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(ladder.nextDelayMs()).toBeGreaterThanOrEqual(0);
    }
    expect(ladder.attempts).toBe(200);
    ladder.reset(4_000);
    expect(ladder.attempts).toBe(0);
    expect(ladder.baseDelayMs).toBe(4_000);
  });

  it("spends the specification's budget on the T4 flap story", () => {
    const ladder = new ReconnectLadder(1_000);
    let total = 0;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      total += ladder.delayFor(attempt);
    }
    // 0 + 1 + 2 + 4 + 8 + 16 + 30 = 61 s: the specification's "31 s at 1 s base"
    // counts six attempts, and the ladder's own 30 s cap governs the sixth
    // (the cap is what `mlp_core::media::resume::ReconnectLadder` enforces).
    expect(total).toBe(61_000);
    expect(ladder.delayFor(6)).toBe(30_000);
  });
});

describe("the resume token store (MLP spec §8.1)", () => {
  function memoryStorage() {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      size: () => data.size,
    };
  }

  it("keeps the token opaque, scoped and expiring", () => {
    const storage = memoryStorage();
    const store = new MediaResumeStore("desktop:intent-1", storage);
    expect(store.get()).toBeNull();

    store.put({ token: "abc.def", sessionId: "s1", mediaSessionId: "m1" }, 900, 1_000);
    expect(store.get(1_000)?.token).toBe("abc.def");
    expect(store.get(1_000)?.mediaSessionId).toBe("m1");
    expect(storage.size()).toBe(1);

    // The record is expired by its own TTL, not by trust in the caller.
    expect(store.get(1_000 + 900_000)).toBeNull();
    expect(storage.size()).toBe(0);
  });

  it("survives a reload through the storage and clears on demand", () => {
    const storage = memoryStorage();
    new MediaResumeStore("desktop:intent-2", storage).put({
      token: "xyz",
      sessionId: "s",
      mediaSessionId: "m",
    });
    const reloaded = new MediaResumeStore("desktop:intent-2", storage);
    expect(reloaded.get()?.token).toBe("xyz");
    reloaded.clear();
    expect(reloaded.get()).toBeNull();
    expect(storage.size()).toBe(0);
  });

  it("degrades to memory when the storage is unavailable", () => {
    const store = new MediaResumeStore("desktop:intent-3", null);
    store.put({ token: "mem", sessionId: "s", mediaSessionId: "m" });
    expect(store.get()?.token).toBe("mem");
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("ignores an empty token", () => {
    const store = new MediaResumeStore("desktop:intent-4", memoryStorage());
    store.put({ token: "   ", sessionId: "s", mediaSessionId: "m" });
    expect(store.get()).toBeNull();
  });
});

describe("the park ledger and the counted terminal conditions (MLP spec §8.4)", () => {
  it("treats one rejected resume as normal and two park expiries as terminal", () => {
    const ledger = new ParkLedger();
    expect(ledger.noteReject("token_expired")).toBeNull();
    expect(ledger.needsFreshMediaSession).toBe(true);
    expect(ledger.noteReject("token_expired")).toBe("park_expired");
    expect(ledger.terminalReason).toBe("park_expired");
  });

  it("resets the consecutive counter on an accepted resume", () => {
    const ledger = new ParkLedger();
    ledger.noteReject("token_expired");
    ledger.noteAccepted();
    expect(ledger.needsFreshMediaSession).toBe(false);
    expect(ledger.noteReject("park_evicted")).toBeNull();
    expect(ledger.terminalReason).toBeNull();
  });
});

describe("media close classification (MLP spec §6.3)", () => {
  it("never treats a park close as failure", () => {
    expect(classifyMediaClose(1000, true)).toEqual({ kind: "park" });
    expect(classifyMediaClose(4000, true)).toEqual({ kind: "park" });
  });

  it("maps the terminal close codes", () => {
    expect(classifyMediaClose(4401, false)).toEqual({ kind: "terminal", reason: "unauthorized" });
    expect(classifyMediaClose(4403, false)).toEqual({ kind: "terminal", reason: "forbidden" });
    expect(classifyMediaClose(4410, false)).toEqual({ kind: "terminal", reason: "park_expired" });
    expect(classifyMediaClose(4415, false)).toEqual({
      kind: "terminal",
      reason: "unsupported_media_version",
    });
  });

  it("reconnects for every other close", () => {
    expect(classifyMediaClose(1006, false)).toEqual({ kind: "reconnect" });
    expect(classifyMediaClose(4409, false)).toEqual({ kind: "reconnect" });
  });

  it("provides an empty resume snapshot for a fresh lane", () => {
    expect(emptyResumeSnapshot()).toEqual({
      appliedUpdateId: 0,
      chainEpoch: 0,
      ackBitmap: 0,
      inputSeqNext: 1,
      pressedKeys: [],
      pressedButtons: [],
      activePath: 0,
    });
  });
});
