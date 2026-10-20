import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MediaReceiverMachine,
  type MediaObjectMeta,
  type MediaReceiverOptions,
  type RepairRequest,
  type ViewerAck,
} from "./receiver";

/**
 * The receiver machine is the transport's half: it holds what the
 * application applied, answers with the ack, and asks for a repair when the
 * application cannot apply what it was sent. It never looks inside a media
 * body — the `MEDIA` class is opaque (MLP spec §5.1).
 */

type Harness = {
  machine: MediaReceiverMachine;
  acks: ViewerAck[];
  repairs: RepairRequest[];
  clock: { now: number };
};

function createMachine(options: Partial<MediaReceiverOptions> = {}): Harness {
  const clock = { now: 0 };
  const acks: ViewerAck[] = [];
  const repairs: RepairRequest[] = [];
  const machine = new MediaReceiverMachine({
    now: () => clock.now,
    repairIntervalMs: 30,
    appliedCellCount: () => 16,
    onAck: (ack) => {
      acks.push(ack);
    },
    onRepair: (request) => {
      repairs.push(request);
    },
    ...options,
  });
  return { machine, acks, repairs, clock };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the applied window", () => {
  it("marks an applied update and answers with the ack", () => {
    const { machine, acks } = createMachine();

    machine.noteApplied(1);
    machine.noteApplied(2);
    machine.noteApplied(4);

    expect(machine.appliedUpdateId).toBe(4);
    expect(machine.ack.highestAppliedUpdateId).toBe(4);
    // Bit i names update `highest - i`: 4, 2 and 1 are applied, 3 is not.
    expect(machine.ack.ackBitmap).toBe(0b1101);
    expect(machine.stats.appliedUpdates).toBe(3);
    expect(acks).toHaveLength(3);
    expect(acks[2]).toMatchObject({ highestAppliedUpdateId: 4, ackBitmap: 0b1101 });
  });

  it("slides the window beyond 64 updates", () => {
    const { machine } = createMachine();

    for (let update = 1; update <= 100; update += 1) {
      machine.noteApplied(update);
    }

    expect(machine.appliedUpdateId).toBe(100);
    // The low 32 bits of the window are the last 32 updates, all applied.
    expect(machine.ack.ackBitmap % 2 ** 32).toBe(0xffff_ffff);
  });

  it("does not mark an update that fell out of the window", () => {
    const { machine } = createMachine();

    for (let update = 1; update <= 100; update += 1) {
      machine.noteApplied(update);
    }
    const bitmap = machine.ack.ackBitmap;

    // Update 30 is 70 ids behind the window: it cannot be marked any more.
    machine.noteApplied(30);

    expect(machine.ack.ackBitmap).toBe(bitmap);
    expect(machine.appliedUpdateId).toBe(100);
    expect(machine.stats.appliedUpdates).toBe(101);
  });

  it("collapses the window when the jump is 64 ids or more", () => {
    const { machine } = createMachine();

    machine.noteApplied(1);
    machine.noteApplied(2);
    machine.noteApplied(70);

    expect(machine.appliedUpdateId).toBe(70);
    expect(machine.ack.ackBitmap).toBe(1);
  });
});

describe("the chain epoch", () => {
  it("adopts a newer epoch, marks the cells stale and breaks convergence", () => {
    const { machine } = createMachine();
    machine.noteApplied(5);
    machine.setViewerState(0, 16, true);
    expect(machine.isConverged).toBe(true);

    expect(machine.noteChainEpoch(2)).toBe(true);

    expect(machine.currentChainEpoch).toBe(2);
    expect(machine.staleCellCount).toBe(16);
    expect(machine.isConverged).toBe(false);
    expect(machine.stats.epochBreaks).toBe(1);
    // The applied window starts again with the new chain.
    expect(machine.appliedUpdateId).toBe(0);
    expect(machine.ack.ackBitmap).toBe(0);
  });

  it("refuses an epoch that is not newer", () => {
    const { machine } = createMachine();

    expect(machine.noteChainEpoch(3)).toBe(true);
    expect(machine.noteChainEpoch(3)).toBe(false);
    expect(machine.noteChainEpoch(2)).toBe(false);

    expect(machine.currentChainEpoch).toBe(3);
    expect(machine.stats.epochBreaks).toBe(1);
  });

  it("adopts the epoch the wire shows, once", () => {
    const { machine } = createMachine();

    machine.onMediaObject({ objectId: 4, chainEpoch: 5 });

    expect(machine.currentChainEpoch).toBe(5);
    expect(machine.staleCellCount).toBe(16);
    expect(machine.stats.epochBreaks).toBe(1);
    // The application hears about the same epoch afterwards: it is not newer.
    expect(machine.noteChainEpoch(5)).toBe(false);
    expect(machine.stats.epochBreaks).toBe(1);
  });
});

describe("the ack", () => {
  it("reports the application's own belief about the surface", () => {
    const { machine } = createMachine();

    machine.setViewerState(3, 16, true);

    expect(machine.ack.staleCells).toBe(3);
    expect(machine.ack.appliedCellCount).toBe(16);
    // The receiver is not converged while it believes a cell is stale.
    expect(machine.ack.converged).toBe(false);
    expect(machine.isConverged).toBe(false);
  });

  it("reports convergence only when no cell is stale", () => {
    const { machine } = createMachine();

    machine.setViewerState(0, 16, true);

    expect(machine.ack.converged).toBe(true);
    expect(machine.isConverged).toBe(true);
  });

  it("reports the render latency only when one was measured", () => {
    const { machine } = createMachine();

    expect(machine.ack.hasRenderLatencyMs).toBe(false);
    expect(machine.ack.renderLatencyMs).toBe(0);

    machine.setRenderLatency(12.5);

    expect(machine.ack.hasRenderLatencyMs).toBe(true);
    expect(machine.ack.renderLatencyMs).toBe(12.5);
  });

  it("carries the highest input sequence the receiver knows about", () => {
    const { machine } = createMachine();

    machine.setEchoOfInputSeq(42);
    expect(machine.ack.echoOfInputSeq).toBe(42);
    expect(machine.reflectedInputSeq).toBe(42);

    machine.onMediaObject({ objectId: 1, reflectsInputSeq: 7 });
    expect(machine.ack.echoOfInputSeq).toBe(42);
  });

  it("carries the three fields the sender reads", () => {
    const { machine } = createMachine();

    machine.noteChainEpoch(2);
    machine.noteApplied(3);

    expect(machine.ackWire).toEqual({
      highestAppliedUpdateId: 3,
      ackBitmap: 1,
      chainEpoch: 2,
    });
  });
});

describe("the repair request", () => {
  it("rate-limits the requests and coalesces the ones inside the window", async () => {
    const { machine, repairs, clock } = createMachine();

    machine.requestRepair("REPORTED_INCOMPLETE", 7);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toEqual({ heldUpdateId: 7, reason: "REPORTED_INCOMPLETE" });

    // Inside the window: the request coalesces into the one already made.
    clock.now = 5;
    machine.requestRepair("EPOCH_MISMATCH", 9);
    expect(repairs).toHaveLength(1);

    // The window closes and the coalesced request goes out, carrying the
    // newest held update and the first reason seen in the window.
    clock.now = 40;
    await vi.waitFor(() => expect(repairs).toHaveLength(2));
    expect(repairs[1]).toEqual({ heldUpdateId: 9, reason: "EPOCH_MISMATCH" });
    expect(machine.stats.repairsRequested).toBe(2);
    expect(machine.repairHistory).toHaveLength(2);
  });

  it("holds the newest held update and the first reason in the window", async () => {
    const { machine, repairs, clock } = createMachine();

    machine.requestRepair("REPORTED_INCOMPLETE", 1);
    clock.now = 10;
    machine.requestRepair("EPOCH_MISMATCH", 2);
    clock.now = 20;
    machine.requestRepair("WAITING_UPDATE_TIMEOUT", 3);

    expect(repairs).toHaveLength(1);

    await vi.waitFor(() => expect(repairs).toHaveLength(2));
    expect(repairs[1]).toEqual({ heldUpdateId: 3, reason: "EPOCH_MISMATCH" });
    expect(machine.repairHistory).toHaveLength(2);
  });

  it("asks again once the window closed", () => {
    const { machine, repairs, clock } = createMachine();

    machine.requestRepair("REPORTED_INCOMPLETE", 1);
    clock.now = 100;
    machine.requestRepair("EPOCH_MISMATCH", 2);

    expect(repairs).toHaveLength(2);
    expect(repairs[1]).toEqual({ heldUpdateId: 2, reason: "EPOCH_MISMATCH" });
  });

  it("asks again when the receiver kept waiting for an update", async () => {
    vi.useFakeTimers();
    const { machine, repairs } = createMachine();

    machine.noteWaiting(4);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toEqual({ heldUpdateId: 4, reason: "WAITING_UPDATE_TIMEOUT" });
  });

  it("stops asking once the application stopped waiting", async () => {
    vi.useFakeTimers();
    const { machine, repairs } = createMachine();

    machine.noteWaiting(4);
    machine.clearWaiting();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(repairs).toHaveLength(0);
  });
});

describe("the resume", () => {
  it("seeds the applied window and the epoch from a resume ack", () => {
    const { machine } = createMachine();

    machine.seedFromResume(42, 3);

    expect(machine.appliedUpdateId).toBe(42);
    expect(machine.currentChainEpoch).toBe(3);
    expect(machine.ack.ackBitmap).toBe(1);
  });

  it("reports the receiver's half of the resume body", () => {
    const { machine } = createMachine();

    machine.noteChainEpoch(1);
    machine.noteApplied(7);
    machine.setEchoOfInputSeq(11);

    expect(machine.resumeSnapshot).toMatchObject({
      appliedUpdateId: 7,
      chainEpoch: 1,
      ackBitmap: 1,
      inputSeqNext: 12,
    });
  });
});

describe("the duplicate objects", () => {
  it("counts a duplicate object", () => {
    const { machine } = createMachine();

    machine.onMediaObject({ objectId: 1 });
    machine.onMediaObject({ objectId: 1, duplicate: true });

    expect(machine.stats.duplicatesIgnored).toBe(1);
    expect(machine.lastMediaObjectId).toBe(1);
  });

  it("remembers the applied part so a duplicate is not applied twice", () => {
    const { machine } = createMachine();

    expect(machine.isChunkApplied(7, 1)).toBe(false);

    machine.noteApplied(7, 1);

    expect(machine.isChunkApplied(7, 1)).toBe(true);
    expect(machine.isChunkApplied(7, 2)).toBe(false);
  });
});

describe("the opaque body", () => {
  it("does not interpret a media body", () => {
    const { machine, acks, repairs } = createMachine();
    const body = new Uint8Array([0xff, 0x00, 0x12, 0x34, 0x9a, 0x7f]);

    // A body may ride along with the metadata; the machine has no use for it.
    const meta: MediaObjectMeta & { body: Uint8Array } = { objectId: 7, body };
    machine.onMediaObject(meta);

    expect(machine.appliedUpdateId).toBe(0);
    expect(machine.ack.ackBitmap).toBe(0);
    expect(machine.stats.appliedUpdates).toBe(0);
    expect(machine.stats.duplicatesIgnored).toBe(0);
    expect(machine.lastMediaObjectId).toBe(7);
    expect(acks).toHaveLength(0);
    expect(repairs).toHaveLength(0);
  });

  it("applies nothing from a body it cannot read", () => {
    const { machine } = createMachine();

    const meta: MediaObjectMeta & { body: Uint8Array } = {
      objectId: 8,
      chainEpoch: 1,
      body: new Uint8Array(64).fill(0xab),
    };
    machine.onMediaObject(meta);

    // The epoch moved, so the trust is stale; the body itself changed nothing.
    expect(machine.currentChainEpoch).toBe(1);
    expect(machine.staleCellCount).toBe(16);
    expect(machine.appliedUpdateId).toBe(0);
    expect(machine.ack.ackBitmap).toBe(0);
  });
});
