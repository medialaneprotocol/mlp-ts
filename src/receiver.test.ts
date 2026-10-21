import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MediaFragmentClass,
  MediaFragmentFlags,
  MediaTlv,
  type MediaObject,
} from "./media-pdu";
import {
  MediaReceiverMachine,
  isAckApplied,
  protocolUpdateId,
  validateAck,
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
    expect(machine.ack.ackBitmap).toBe(0b1101n);
    expect(machine.stats.appliedUpdates).toBe(3);
    expect(acks).toHaveLength(3);
    expect(acks[2]).toMatchObject({ highestAppliedUpdateId: 4, ackBitmap: 0b1101n });
  });

  it("slides the window beyond 64 updates", () => {
    const { machine } = createMachine();

    for (let update = 1; update <= 100; update += 1) {
      machine.noteApplied(update);
    }

    expect(machine.appliedUpdateId).toBe(100);
    // The low 32 bits of the window are the last 32 updates, all applied.
    expect(machine.ack.ackBitmap & 0xffff_ffffn).toBe(0xffff_ffffn);
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
    expect(machine.ack.ackBitmap).toBe(1n);
  });

  it("reports the whole 64-bit window", () => {
    const { machine } = createMachine();

    for (let update = 1; update <= 64; update += 1) {
      machine.noteApplied(update);
    }

    // Every one of the 64 ids is applied: the window is all ones, and the
    // upper 11 bits are the ones a JavaScript number cannot hold.
    expect(machine.ack.ackBitmap).toBe((1n << 64n) - 1n);
  });

  it("marks the update id zero, the way the reference implementation does", () => {
    const { machine } = createMachine();

    machine.noteApplied(0);

    expect(machine.ack.ackBitmap).toBe(1n);
    expect(machine.appliedUpdateId).toBe(0);
    expect(machine.stats.appliedUpdates).toBe(1);
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
    // The receiver keeps the content it holds, so the window of what it
    // applied keeps standing: an epoch is not an update.
    expect(machine.appliedUpdateId).toBe(5);
    expect(machine.ack.ackBitmap).toBe(1n);
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
    // The belief is the application's, and the machine reports it as it comes:
    // the sender's accounting is the authoritative one (MLP spec §5.2).
    expect(machine.ack.converged).toBe(true);
    expect(machine.isConverged).toBe(true);
  });

  it("reports the convergence the application believes, not its own", () => {
    const { machine } = createMachine();

    machine.setViewerState(0, 16, false);

    expect(machine.ack.converged).toBe(false);
    expect(machine.isConverged).toBe(false);
  });

  it("reports the render latency only when one was measured", () => {
    const { machine } = createMachine();

    expect(machine.ack.hasRenderLatencyMs).toBe(false);
    expect(machine.ack.renderLatencyMs).toBe(0);

    machine.setRenderLatency(12.5);

    expect(machine.ack.hasRenderLatencyMs).toBe(true);
    expect(machine.ack.renderLatencyMs).toBe(12.5);
  });

  it("carries the input sequence the applied cells reflect", () => {
    const { machine } = createMachine();

    machine.setEchoOfInputSeq(42);
    expect(machine.ack.echoOfInputSeq).toBe(42);
    expect(machine.reflectedInputSeq).toBe(42);

    // The sender's stamp on an object is the sender's claim; it is not the
    // applied content's echo, so the acknowledgement does not carry it.
    machine.onMediaObject({ objectId: 1, reflectsInputSeq: 7 });
    expect(machine.ack.echoOfInputSeq).toBe(42);
    expect(machine.laneReflectedInputSeq).toBe(7);
  });

  it("takes the application's report as it comes and keeps the lane's stamp apart", () => {
    const { machine } = createMachine();

    // The lane's stamps are the sender's claims: they only grow.
    machine.onMediaObject({ objectId: 1, reflectsInputSeq: 7 });
    machine.onMediaObject({ objectId: 2, reflectsInputSeq: 3 });
    expect(machine.laneReflectedInputSeq).toBe(7);
    expect(machine.ack.echoOfInputSeq).toBe(0);

    // The application owns its own report: a rebase drops the content that
    // reflected the older input, and the machine takes the report as it comes.
    machine.setEchoOfInputSeq(11);
    expect(machine.ack.echoOfInputSeq).toBe(11);
    machine.setEchoOfInputSeq(2);
    expect(machine.ack.echoOfInputSeq).toBe(2);
  });

  it("reports the session-relative epoch, not the page's clock", () => {
    const { machine, clock } = createMachine();

    clock.now = 1_500;
    expect(machine.ack.ackEpochMs).toBe(1_500);
    expect(machine.sessionMs).toBe(1_500);

    clock.now = 2_000;
    expect(machine.ack.ackEpochMs).toBe(2_000);
  });

  it("carries the three fields the sender reads", () => {
    const { machine } = createMachine();

    machine.noteChainEpoch(2);
    machine.noteApplied(3);

    expect(machine.ackWire).toEqual({
      highestAppliedUpdateId: 3,
      ackBitmap: 1n,
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
    expect(machine.ack.ackBitmap).toBe(1n);
  });

  it("reports the receiver's half of the resume body", () => {
    const { machine } = createMachine();

    machine.noteChainEpoch(1);
    machine.noteApplied(7);
    machine.setEchoOfInputSeq(11);

    expect(machine.resumeSnapshot).toMatchObject({
      appliedUpdateId: 7,
      chainEpoch: 1,
      ackBitmap: 1n,
      inputSeqNext: 12,
    });
  });

  it("keeps the deduplication boundary past the sender's stamp", () => {
    const { machine } = createMachine();

    machine.onMediaObject({ objectId: 1, reflectsInputSeq: 30 });

    // The boundary is one past the highest input sequence the receiver knows
    // about, so the sender never applies an input twice (MLP spec INV-3).
    expect(machine.resumeSnapshot.inputSeqNext).toBe(31);
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

describe("the acknowledgement's own rules", () => {
  it("answers the same way the reference implementation's window does", () => {
    const { machine } = createMachine();

    for (let update = 1; update <= 100; update += 1) {
      machine.noteApplied(update);
    }

    // The reference implementation's own assertion: the window is 64 updates
    // wide, so update 37 is inside it and update 36 is not.
    const ack = machine.ack;
    expect(isAckApplied(ack, 100)).toBe(true);
    expect(isAckApplied(ack, 37)).toBe(true);
    expect(isAckApplied(ack, 36)).toBe(false);
    expect(isAckApplied(ack, 0)).toBe(false);
    expect(isAckApplied(ack, 101)).toBe(false);
  });

  it("validates the acknowledgement the way a peer does", () => {
    const { machine } = createMachine();

    machine.noteApplied(4);
    machine.setViewerState(0, 16, true);

    expect(validateAck(machine.ack)).toBeNull();
  });

  it("refuses an acknowledgement whose window names an update it never applied", () => {
    const { machine } = createMachine();

    // A window that claims update 0 is applied names an update id that does
    // not exist: the update ids start at 1.
    machine.noteApplied(0);

    expect(validateAck(machine.ack)).toBe("ACK_BAD_BITMAP");
  });

  it("refuses an acknowledgement that calls more cells stale than it applied", () => {
    const { machine } = createMachine();

    machine.setViewerState(9, 4, false);

    expect(validateAck(machine.ack)).toBe("ACK_BAD_COUNT");
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
    expect(machine.ack.ackBitmap).toBe(0n);
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
    expect(machine.ack.ackBitmap).toBe(0n);
  });
});

describe("the protocol's update id (MLP spec §5.1.1)", () => {
  it("is the update id the acknowledgement credits, and it is null without one", () => {
    const media: MediaObject = {
      objectId: 7,
      classValue: MediaFragmentClass.MEDIA,
      flags: MediaFragmentFlags.FIN,
      priority: 6,
      headerExt: [{ type: MediaTlv.UPDATE_ID, value: new Uint8Array([10, 0, 0, 0, 0, 0, 0, 0]) }],
      payload: new Uint8Array(0),
      receivedAtMs: 0,
    };
    expect(protocolUpdateId(media)).toBe(10);
    // An intermediary's own object carries no update id.
    expect(protocolUpdateId({ ...media, headerExt: [] })).toBeNull();
  });
});
