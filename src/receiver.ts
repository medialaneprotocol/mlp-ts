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

import { ACK_WINDOW_BITS, MediaAckWindow } from "./media-pdu";
import { FifoSet } from "./fifo-set";
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

/**
 * The receiver's ack payload (`MediaAck`, MLP spec §5.2).
 *
 * `ackBitmap` is the acknowledgement's 64-bit window (MLP spec §5.2: "a 64-bit
 * window of which updates around it were applied"), so it is a `bigint`: a
 * JavaScript number cannot hold the window's upper 11 bits, and a receiver
 * that reports 53 bits where the protocol says 64 is a different receiver —
 * the sender reads the missing bits as "not applied" and re-sends cells the
 * receiver already holds.
 */
export type ViewerAck = {
  highestAppliedUpdateId: number;
  ackBitmap: bigint;
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

/**
 * Whether an update id is covered by an acknowledgement's window.
 *
 * The mirror of `MediaAck::is_applied` (MLP spec §5.2): bit `i` names update
 * `highest − i`, the update ids start at 1, and the window is 64 ids wide.
 */
export function isAckApplied(ack: ViewerAck, updateId: number): boolean {
  if (updateId < 1 || updateId > ack.highestAppliedUpdateId) {
    return false;
  }
  const distance = ack.highestAppliedUpdateId - updateId;
  if (distance >= ACK_WINDOW_BITS) {
    return false;
  }
  return (ack.ackBitmap & (1n << BigInt(distance))) !== 0n;
}

/** Why a peer refuses an acknowledgement (MLP spec §5.2's validation rules). */
export type AckRejectReason = "ACK_BAD_BITMAP" | "ACK_BAD_COUNT" | "BODY_INVALID";

/**
 * Validate an acknowledgement against the specification's rules (MLP spec §5.2).
 *
 * The mirror of `MediaAck::validate`: a set bit may name only an update the
 * receiver applied — the update ids start at 1, so a set bit `i` must
 * satisfy `i < highest` — the stale count may not exceed the applied count,
 * and a latency that is not reported must be zero.
 */
export function validateAck(ack: ViewerAck): AckRejectReason | null {
  let bits = ack.ackBitmap;
  let bit = 0;
  while (bits !== 0n) {
    if ((bits & 1n) === 1n && bit >= ack.highestAppliedUpdateId) {
      return "ACK_BAD_BITMAP";
    }
    bits >>= 1n;
    bit += 1;
  }
  if (ack.staleCells > ack.appliedCellCount) {
    return "ACK_BAD_COUNT";
  }
  if (!ack.hasRenderLatencyMs && ack.renderLatencyMs !== 0) {
    return "BODY_INVALID";
  }
  return null;
}

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
  /**
   * The applied `(update, part)` pairs, for `DUP` idempotence.
   *
   * It is the reference implementation's shape — a set and a FIFO order over
   * the same keys — so the oldest pair is dropped in constant time.
   */
  private readonly appliedChunks = new FifoSet<string>(APPLIED_CHUNK_WINDOW);

  private chainEpoch = 0;
  private staleCells = 0;
  private reportedCellCount = 0;
  private converged = false;
  private renderLatencyMs = 0;
  /**
   * What the applied cells reflect.
   *
   * It is the driver's own report (MLP spec §5.2: the acknowledgement carries
   * "the highest input sequence visible in the applied cells"), and it is
   * taken as it comes.
   */
  private echoOfInputSeq = 0;
  /**
   * What the sender's stamps claim.
   *
   * The sender stamps every update with the highest input sequence its
   * content includes (MLP spec annex N, N-1), so the lane's stamps only grow.
   * They are the sender's claim about an object the receiver may not have
   * applied, so the acknowledgement does not report them.
   */
  private laneInputSeqStamp = 0;
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

  /**
   * The session's own zero.
   *
   * The acknowledgement's epoch is the session-relative millisecond clock
   * (MLP spec §5.2), the same clock the reference implementation reports
   * (`MediaReceiverMachine::session_ms`): the milliseconds since this
   * machine started, not the page's own clock.
   */
  private readonly startedAtMs: number;

  constructor(options: MediaReceiverOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.repairIntervalMs = options.repairIntervalMs ?? DEFAULT_REPAIR_INTERVAL_MS;
    this.cellCountOption = options.appliedCellCount;
    this.rttMs = options.rttMs ?? (() => DEFAULT_RTT_MS);
    this.onAck = options.onAck;
    this.onRepair = options.onRepair;
    this.startedAtMs = this.now();
  }

  /** The session-relative millisecond clock (MLP spec §5.2). */
  get sessionMs(): number {
    return Math.round(this.now() - this.startedAtMs);
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
    return this.converged;
  }

  /**
   * The highest input sequence the receiver's applied cells reflect.
   *
   * It is the driver's report, taken as it comes: a rebase drops the content
   * that reflected the older input, so the value may go backwards, and the
   * reference implementation takes it plainly
   * (`MediaReceiverMachine::set_echo_of_input_seq`).
   */
  get reflectedInputSeq(): number {
    return this.echoOfInputSeq;
  }

  /**
   * The highest input sequence the sender's stamps claim.
   *
   * The stamps are the sender's claims (MLP spec annex N, N-1) and they only
   * grow. They are what the driver reads when it reports the echo of the
   * update it applied; they are not the applied content's echo.
   */
  get laneReflectedInputSeq(): number {
    return this.laneInputSeqStamp;
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
      ackBitmap: this.ackWindow.bitmap,
      chainEpoch: this.chainEpoch,
      appliedCellCount: this.ackCellCount(),
      staleCells: this.staleCells,
      converged: this.converged,
      renderLatencyMs: this.renderLatencyMs,
      hasRenderLatencyMs: this.renderLatencyMs > 0,
      echoOfInputSeq: this.reflectedInputSeq,
      ackEpochMs: this.sessionMs,
    };
  }

  /** The ack grid, kept across reconnects (design §7.2's receiver row). */
  get ackWire(): { highestAppliedUpdateId: number; ackBitmap: bigint; chainEpoch: number } {
    return {
      highestAppliedUpdateId: this.ackWindow.highestAppliedUpdateId,
      ackBitmap: this.ackWindow.bitmap,
      chainEpoch: this.chainEpoch,
    };
  }

  /**
   * The receiver's half of the resume body (MLP spec §7.1).
   *
   * The input sequence is the deduplication boundary: it is one past the
   * highest input sequence the receiver knows about, which is the higher of
   * the echo the application reported and the stamp the sender put on the
   * objects it sent. The boundary never over-reports, so the sender never
   * applies an input twice (MLP spec annex INV, INV-3).
   */
  get resumeSnapshot(): MediaResumeSnapshot {
    return {
      ...emptyResumeSnapshot(),
      appliedUpdateId: this.ackWindow.highestAppliedUpdateId,
      chainEpoch: this.chainEpoch,
      ackBitmap: this.ackWindow.bitmap,
      inputSeqNext: Math.max(this.echoOfInputSeq, this.laneInputSeqStamp) + 1,
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
      // The sender's stamp on the object it sent: the sender's claims are
      // monotone, so the lane's stamp is accumulated with a maximum.
      this.laneInputSeqStamp = Math.max(this.laneInputSeqStamp, meta.reflectsInputSeq);
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
   * The application owns this report: it says what *its* applied content
   * reflects, and it may say less than it said before — a rebase drops the
   * content that reflected the older input. The report is therefore taken as
   * it comes, exactly as the reference implementation takes it
   * (`MediaReceiverMachine::set_echo_of_input_seq`).
   */
  setEchoOfInputSeq(inputSeq: number): void {
    this.echoOfInputSeq = inputSeq;
  }

  /**
   * Note that the chain epoch moved.
   *
   * A newer epoch means the sender broke the chain: the receiver's *trust* in
   * the surface goes back to "all stale" without clearing the cells, the
   * convergence breaks, and the sender starts an anchor plan (MLP spec §5.1).
   *
   * The applied window is *not* cleared: the receiver keeps the content it
   * holds, so the updates it applied are still applied. The window says what
   * the receiver holds, and an epoch is not an update.
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

  /**
   * The cell count the ack reports.
   *
   * It is the application's own number (MLP spec §6.5.2): the machine reports
   * it and never second-guesses it, exactly as the reference implementation
   * reports the count its driver gave it (`MediaAck::applied_cell_count`).
   * The grid size the application configured is the fallback for the time
   * before it has reported one.
   */
  private ackCellCount(): number {
    if (this.reportedCellCount > 0) {
      return this.reportedCellCount;
    }
    return Math.max(0, this.cellCountOption?.() ?? 0);
  }

  /** Adopt a chain epoch, if it moved. */
  private adoptEpoch(epoch: number): boolean {
    if (!Number.isFinite(epoch) || epoch <= this.chainEpoch) {
      return false;
    }
    this.chainEpoch = epoch;
    // The trust in the surface goes back to "all stale"; the content stays
    // (MLP spec §5.1), and so does the window of what was applied.
    this.staleCells = this.gridSize();
    this.converged = false;
    this.epochBreaks += 1;
    this.emitAck();
    return true;
  }

  /** Remember one applied `(update, part)` pair. */
  private noteAppliedChunk(updateId: number, partIndex: number): void {
    this.appliedChunks.add(chunkKey(updateId, partIndex));
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
