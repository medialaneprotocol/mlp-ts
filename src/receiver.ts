/**
 * The media-lane receiver machine (MLP spec §5.1, §6.5).
 *
 * This is the browser mirror of `mlp_core::media::receiver::MediaReceiverMachine`:
 * it holds what the receiver has applied, answers with the protocol's
 * acknowledgement, and asks for a repair when the application cannot apply
 * what it was sent.
 *
 * The machine never looks inside a media body. The `MEDIA` class carries
 * opaque bytes (MLP spec §5.1): the protocol moves them, accounts for them
 * and paces them, and a codec defines what they mean. So the machine's own
 * handling of a media object stops at the transport's metadata — the object
 * id, the chain epoch, the `DUP` flag and the reflected input sequence — and
 * the application tells the machine what it applied.
 *
 * The split with the codec is the protocol's own (§1.3): a codec that cannot
 * be understood by the transport can still be moved by it.
 */

import { MediaAckWindow } from "./media-pdu";
import { emptyResumeSnapshot, type MediaResumeSnapshot } from "./media-resume";
import { DEFAULT_RTT_MS, waitingUpdateTimeoutMs } from "./protocol-constants";

/**
 * The transport's own metadata about one media object (MLP spec §4.3).
 *
 * The object's body is not here: it is opaque (MLP spec §5.1), and the
 * transport's machine has no use for it.
 */
export type MediaObjectMeta = {
  /** The object's id on the lane. */
  objectId: number;
  /** The chain epoch the object was sent under, when it carried one. */
  chainEpoch?: number;
  /** Whether the object carried the `DUP` flag (MLP spec §5.1). */
  duplicate?: boolean;
  /** The highest input sequence the object's content reflects. */
  reflectsInputSeq?: number;
};

/**
 * Why the receiver asks for a repair plan (MLP spec §6.6).
 *
 * - `REPORTED_INCOMPLETE` — the application reported an update it could not
 *   apply;
 * - `WAITING_UPDATE_TIMEOUT` — an expected update did not arrive in time;
 * - `EPOCH_MISMATCH` — the chain epoch moved under the receiver.
 */
export type RepairReason =
  | "REPORTED_INCOMPLETE"
  | "WAITING_UPDATE_TIMEOUT"
  | "EPOCH_MISMATCH";

/** One repair plan request: the update the receiver holds, and why. */
export type RepairRequest = { heldUpdateId: number; reason: RepairReason };

/** The receiver's ack payload (`MediaAck`, MLP spec §5.2). */
export type ViewerAck = {
  highestAppliedUpdateId: number;
  ackBitmap: number;
  chainEpoch: number;
  appliedCellCount: number;
  staleCells: number;
  converged: boolean;
  renderLatencyMs: number;
  hasRenderLatencyMs: boolean;
  echoOfInputSeq: number;
  ackEpochMs: number;
};

/** The receiver's counters. */
export type ReceiverStats = {
  /** Updates the application reported as applied. */
  appliedUpdates: number;
  /** Objects the sender deliberately duplicated. */
  duplicatesIgnored: number;
  /** Chain epochs the receiver adopted. */
  epochBreaks: number;
  /** Repair plan requests the receiver made. */
  repairsRequested: number;
};

/** How the receiver machine is set up. */
export type MediaReceiverOptions = {
  /** The millisecond clock; the default is the page's own clock. */
  now?: () => number;
  /** The rate limit of one repair request per interval (default 200 ms). */
  repairIntervalMs?: number;
  /** The size of the receiver's cell grid (MLP spec §6.5.1). */
  appliedCellCount?: () => number;
  /** The smoothed RTT the waiting-update timeout is relative to (§9.2). */
  rttMs?: () => number;
  /** Called when the machine's ack moved. */
  onAck?: (ack: ViewerAck) => void;
  /** Called when the receiver asks for a repair plan (MLP spec §6.6). */
  onRepair?: (request: RepairRequest) => void;
};

/** The default rate limit of one repair request per interval. */
const DEFAULT_REPAIR_INTERVAL_MS = 200;
/** Bound on the diagnostic repair history. */
const REPAIR_HISTORY_LIMIT = 64;
/** How many applied `(update, part)` pairs are remembered (MLP spec §5.1). */
const APPLIED_CHUNK_WINDOW = 512;

/** The key one applied `(update, part)` pair is remembered under. */
function chunkKey(updateId: number, partIndex: number): string {
  return `${updateId}:${partIndex}`;
}

/**
 * The receiver machine.
 *
 * One instance drives one receiver's half of a media lane. The application
 * feeds it the transport's metadata of every media object it receives, and
 * tells it what it applied:
 *
 * ```ts
 * const machine = new MediaReceiverMachine({
 *   onAck: (ack) => lane.sendAck(ack),
 *   onRepair: (request) => lane.requestRepair(request),
 * });
 *
 * machine.onMediaObject({ objectId, chainEpoch, duplicate, reflectsInputSeq });
 * // …the application applies what it can…
 * machine.noteApplied(updateId, partIndex);
 * machine.setViewerState(staleCells, appliedCellCount, converged);
 * ```
 */
export class MediaReceiverMachine {
  private readonly now: () => number;
  private readonly repairIntervalMs: number;
  private readonly cellCountOption: (() => number) | undefined;
  private readonly rttMs: () => number;
  private readonly onAck: ((ack: ViewerAck) => void) | undefined;
  private readonly onRepair: ((request: RepairRequest) => void) | undefined;

  /** The applied-update window (MLP spec §6.5.2). */
  private readonly ackWindow = new MediaAckWindow();
  /** The applied `(update, part)` pairs, for `DUP` idempotence. */
  private readonly appliedChunks = new Set<string>();
  private readonly appliedChunkOrder: string[] = [];

  private chainEpoch = 0;
  private staleCells = 0;
  private reportedCellCount = 0;
  private converged = false;
  private renderLatencyMs = 0;
  private echoOfInputSeq = 0;
  private lastObjectId = 0;

  private appliedUpdates = 0;
  private duplicatesIgnored = 0;
  private epochBreaks = 0;
  private repairsRequested = 0;

  private lastRepairAtMs = Number.NEGATIVE_INFINITY;
  private pendingRepair: RepairRequest | null = null;
  private repairTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly repairLog: RepairRequest[] = [];

  private waitingSinceMs: number | null = null;
  private waitingHeldUpdateId = 0;
  private waitingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MediaReceiverOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.repairIntervalMs = options.repairIntervalMs ?? DEFAULT_REPAIR_INTERVAL_MS;
    this.cellCountOption = options.appliedCellCount;
    this.rttMs = options.rttMs ?? (() => DEFAULT_RTT_MS);
    this.onAck = options.onAck;
    this.onRepair = options.onRepair;
  }

  /** The highest update the application reported as applied. */
  get appliedUpdateId(): number {
    return this.ackWindow.highestAppliedUpdateId;
  }

  /** The chain epoch the receiver holds (MLP spec §5.1). */
  get currentChainEpoch(): number {
    return this.chainEpoch;
  }

  /** The receiver's own count of the cells it believes stale. */
  get staleCellCount(): number {
    return this.staleCells;
  }

  /** Whether the receiver believes it holds the sender's surface. */
  get isConverged(): boolean {
    return this.converged && this.staleCells === 0;
  }

  /** The highest input sequence the receiver knows about. */
  get reflectedInputSeq(): number {
    return this.echoOfInputSeq;
  }

  /** The object id of the last media object the machine saw. */
  get lastMediaObjectId(): number {
    return this.lastObjectId;
  }

  /** The counters. */
  get stats(): ReceiverStats {
    return {
      appliedUpdates: this.appliedUpdates,
      duplicatesIgnored: this.duplicatesIgnored,
      epochBreaks: this.epochBreaks,
      repairsRequested: this.repairsRequested,
    };
  }

  /** The repair requests the receiver made, newest last (diagnostics only). */
  get repairHistory(): RepairRequest[] {
    return [...this.repairLog];
  }

  /** The ack the next report carries. */
  get ack(): ViewerAck {
    return {
      highestAppliedUpdateId: this.ackWindow.highestAppliedUpdateId,
      ackBitmap: this.ackWindow.bitmapNumber(),
      chainEpoch: this.chainEpoch,
      appliedCellCount: this.ackCellCount(),
      staleCells: this.staleCells,
      converged: this.isConverged,
      renderLatencyMs: this.renderLatencyMs,
      hasRenderLatencyMs: this.renderLatencyMs > 0,
      echoOfInputSeq: this.echoOfInputSeq,
      ackEpochMs: Math.round(this.now()),
    };
  }

  /** The ack grid, kept across reconnects (design §7.2's receiver row). */
  get ackWire(): { highestAppliedUpdateId: number; ackBitmap: number; chainEpoch: number } {
    return {
      highestAppliedUpdateId: this.ackWindow.highestAppliedUpdateId,
      ackBitmap: this.ackWindow.bitmapNumber(),
      chainEpoch: this.chainEpoch,
    };
  }

  /** The receiver's half of the resume body (MLP spec §7.1). */
  get resumeSnapshot(): MediaResumeSnapshot {
    return {
      ...emptyResumeSnapshot(),
      appliedUpdateId: this.ackWindow.highestAppliedUpdateId,
      chainEpoch: this.chainEpoch,
      ackBitmap: this.ackWindow.bitmapNumber(),
      inputSeqNext: this.echoOfInputSeq + 1,
    };
  }

  /**
   * Take one media object's transport metadata.
   *
   * The body is opaque (MLP spec §5.1), so the machine reads the metadata
   * and nothing else: it notes the object id, counts a `DUP`-flagged object,
   * adopts a chain epoch that moved, and remembers the input sequence the
   * object reflects.
   */
  onMediaObject(meta: MediaObjectMeta): void {
    this.lastObjectId = meta.objectId;
    if (meta.duplicate === true) {
      this.duplicatesIgnored += 1;
    }
    if (meta.chainEpoch !== undefined) {
      this.adoptEpoch(meta.chainEpoch);
    }
    if (meta.reflectsInputSeq !== undefined) {
      this.echoOfInputSeq = Math.max(this.echoOfInputSeq, meta.reflectsInputSeq);
    }
  }

  /**
   * Note that the application applied an update.
   *
   * The applied window slides one id at a time and holds the last 64 ids
   * (MLP spec §6.5.2): an update that fell out of the window is not marked,
   * and a jump of 64 ids or more leaves the window holding the new update
   * alone.
   *
   * When the application names the part it applied, the pair is remembered
   * as well: that is the idempotence record a `DUP`-flagged object is
   * checked against (MLP spec §5.1).
   */
  noteApplied(updateId: number, partIndex?: number): void {
    this.ackWindow.mark(updateId);
    this.appliedUpdates += 1;
    if (partIndex !== undefined) {
      this.noteAppliedChunk(updateId, partIndex);
    }
    this.emitAck();
  }

  /** Whether the application already applied this part of this update. */
  isChunkApplied(updateId: number, partIndex: number): boolean {
    return this.appliedChunks.has(chunkKey(updateId, partIndex));
  }

  /**
   * Note the application's own belief about the surface.
   *
   * The cells and the convergence are the application's: the machine reports
   * them and never second-guesses them (MLP spec §6.5.2).
   */
  setViewerState(staleCells: number, appliedCellCount: number, converged: boolean): void {
    this.staleCells = Math.max(0, staleCells);
    this.reportedCellCount = Math.max(0, appliedCellCount);
    this.converged = converged;
  }

  /** Note the render latency the next ack reports. */
  setRenderLatency(latencyMs: number): void {
    this.renderLatencyMs = latencyMs;
  }

  /**
   * Note the highest input sequence the applied cells reflect.
   *
   * The sequence never goes backwards: the lane's own objects and the
   * application both report it, and the highest one either of them saw is
   * the one the ack echoes.
   */
  setEchoOfInputSeq(inputSeq: number): void {
    this.echoOfInputSeq = Math.max(this.echoOfInputSeq, inputSeq);
  }

  /**
   * Note that the chain epoch moved.
   *
   * A newer epoch means the sender broke the chain: the receiver's *trust* in
   * the surface goes back to "all stale" without clearing the cells, the
   * convergence breaks, and the applied window starts again (MLP spec §5.1).
   *
   * The epoch is adopted once. Whichever side sees it first — the wire
   * through {@link MediaReceiverMachine.onMediaObject} or the application
   * through this method — performs the adoption, and the other one is told
   * the epoch is not newer.
   */
  noteChainEpoch(epoch: number): boolean {
    return this.adoptEpoch(epoch);
  }

  /**
   * Note that the application is waiting for an update that has not arrived.
   *
   * The update that would heal the receiver may itself have been lost, so a
   * receiver that keeps waiting asks for a repair plan instead of waiting
   * forever (MLP spec §9.2).
   */
  noteWaiting(heldUpdateId: number): void {
    this.waitingHeldUpdateId = heldUpdateId;
    if (this.waitingSinceMs === null) {
      this.waitingSinceMs = this.now();
    }
    if (this.waitingTimer !== null) {
      return;
    }
    this.waitingTimer = setTimeout(() => {
      this.waitingTimer = null;
      if (this.waitingSinceMs === null) {
        return;
      }
      this.requestRepair("WAITING_UPDATE_TIMEOUT", this.waitingHeldUpdateId);
      this.noteWaiting(this.waitingHeldUpdateId);
    }, this.waitingTimeoutMs());
  }

  /** The application stopped waiting: no repair is due for the wait. */
  clearWaiting(): void {
    this.waitingSinceMs = null;
    this.waitingHeldUpdateId = 0;
    if (this.waitingTimer !== null) {
      clearTimeout(this.waitingTimer);
      this.waitingTimer = null;
    }
  }

  /**
   * Ask for a repair plan (MLP spec §6.6).
   *
   * The request is rate-limited to one per `repairIntervalMs`: requests
   * inside the window coalesce into one that carries the newest held update
   * and the first reason seen in the window. The request is a *plan*
   * request, never a reset request — the sender re-sends the cells the
   * receiver's ack leaves pending.
   */
  requestRepair(reason: RepairReason, heldUpdateId?: number): void {
    const held = heldUpdateId ?? this.ackWindow.highestAppliedUpdateId;
    const timestamp = this.now();

    if (timestamp - this.lastRepairAtMs >= this.repairIntervalMs) {
      this.emitRepair({ heldUpdateId: held, reason });
      this.lastRepairAtMs = timestamp;
      return;
    }

    this.pendingRepair = this.pendingRepair
      ? { heldUpdateId: held, reason: this.pendingRepair.reason }
      : { heldUpdateId: held, reason };

    if (this.repairTimer === null) {
      const delay = Math.max(1, this.lastRepairAtMs + this.repairIntervalMs - timestamp);
      this.repairTimer = setTimeout(() => {
        this.repairTimer = null;
        const pending = this.pendingRepair;
        this.pendingRepair = null;
        if (!pending) {
          return;
        }
        this.emitRepair(pending);
        this.lastRepairAtMs = this.now();
      }, delay);
    }
  }

  /**
   * Seed the receiver's trust from a resume ack (the cells are still there).
   */
  seedFromResume(appliedUpdateId: number, chainEpoch: number): void {
    if (appliedUpdateId > this.ackWindow.highestAppliedUpdateId) {
      this.ackWindow.seedFromResume(appliedUpdateId);
    }
    this.chainEpoch = Math.max(this.chainEpoch, chainEpoch);
  }

  /** The size of the receiver's cell grid (MLP spec §6.5.1). */
  private gridSize(): number {
    if (this.reportedCellCount > 0) {
      return this.reportedCellCount;
    }
    return Math.max(1, this.cellCountOption?.() ?? 1);
  }

  /** The cell count the ack reports; it never claims fewer than it calls stale. */
  private ackCellCount(): number {
    const grid = this.reportedCellCount > 0 ? this.reportedCellCount : Math.max(0, this.cellCountOption?.() ?? 0);
    return Math.max(grid, this.staleCells);
  }

  /** Adopt a chain epoch, if it moved. */
  private adoptEpoch(epoch: number): boolean {
    if (!Number.isFinite(epoch) || epoch <= this.chainEpoch) {
      return false;
    }
    this.chainEpoch = epoch;
    this.staleCells = this.gridSize();
    this.converged = false;
    this.epochBreaks += 1;
    this.ackWindow.reset();
    this.emitAck();
    return true;
  }

  /** Remember one applied `(update, part)` pair. */
  private noteAppliedChunk(updateId: number, partIndex: number): void {
    const key = chunkKey(updateId, partIndex);
    if (this.appliedChunks.has(key)) {
      return;
    }
    this.appliedChunks.add(key);
    this.appliedChunkOrder.push(key);
    while (this.appliedChunkOrder.length > APPLIED_CHUNK_WINDOW) {
      const dropped = this.appliedChunkOrder.shift();
      if (dropped !== undefined) {
        this.appliedChunks.delete(dropped);
      }
    }
  }

  /** Report the ack the next feedback carries. */
  private emitAck(): void {
    this.onAck?.(this.ack);
  }

  /** Report one repair plan request. */
  private emitRepair(request: RepairRequest): void {
    this.repairsRequested += 1;
    this.repairLog.push(request);
    if (this.repairLog.length > REPAIR_HISTORY_LIMIT) {
      this.repairLog.shift();
    }
    this.onRepair?.(request);
  }

  /** How long the receiver waits before it asks for a repair (§9.2). */
  private waitingTimeoutMs(): number {
    return waitingUpdateTimeoutMs(this.rttMs());
  }
}
