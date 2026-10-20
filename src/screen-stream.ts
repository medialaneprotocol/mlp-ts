/**
 * The receiver-side screen-stream state machine.
 *
 * One instance drives one session's updates into one surface. It has two
 * entry points and they are deliberately different:
 *
 * - {@link ScreenStream.applyMediaPart} — one MLP v1 MEDIA object (MLP spec
 *   §5): one codec part with its transport metadata (`ANCHOR`, `DUP`,
 *   `chain_epoch`, `reflects_input_seq`). The ack is a `MediaAck` carrying the
 *   64-id grid, and the repair request is a *repair plan request* (MLP spec
 *   §6.6), never a reset request.
 * - {@link ScreenStream.applyMediaEpoch} — the chain epoch advanced, which
 *   marks the surface stale without clearing it (MLP spec §6.6).
 *
 * What does not change between the two: an update is assembled whole,
 * validated whole, and applied whole; the surface never sees a partial
 * update, and a `chain_epoch` bump marks the surface stale without clearing
 * the cells (MLP spec §6.6).
 */

import { MediaAckWindow, type MediaObject } from "./media-pdu";
import { DEFAULT_RTT_MS, waitingUpdateTimeoutMs } from "./protocol-constants";
import type { SurfaceCanvasRenderer } from "@tessellio/ts";
import {
  UpdateAssembler,
  type AssembledUpdate,
  type UpdatePart,
  type UpdateRegion,
} from "@tessellio/ts";
import { RegionOpsPool, decodeRegionInto, type ResyncReason } from "@tessellio/ts";

/** The transport metadata one MLP MEDIA object carries (MLP spec §5). */
export type MediaPartMeta = {
  updateId: number;
  baseUpdateId: number;
  chainEpoch: number;
  reflectsInputSeq: number;
  anchor: boolean;
  duplicate: boolean;
  objectId: number;
  /** The MLP fragment flags of the object, for the resume snapshot. */
  flags: number;
};

/** The receiver's ack payload (`MediaAck`, MLP spec §5). */
export type ViewerAck = {
  highestAppliedUpdateId: number;
  ackBitmap: number;
  chainEpoch: number;
  appliedBlockCount: number;
  staleBlocks: number;
  converged: boolean;
  renderLatencyMs: number;
  hasRenderLatencyMs: boolean;
  echoOfInputSeq: number;
  ackEpochMs: number;
};

export type ScreenStreamOptions = {
  renderer: SurfaceCanvasRenderer;
  now?: () => number;
  resyncIntervalMs?: number;
  /** The RTT the waiting-update timeout is relative to (MLP spec §9.2). */
  rttMs?: () => number;
  /**
   * Called once a update has been fully applied to the canvas (not merely
   * received): the UI uses it to leave its waiting state.
   */
  onUpdateApplied?: (updateId: number) => void;
  /** The media-lane ack sink (`MediaAck`, MLP spec §5). */
  onAck?: (ack: ViewerAck) => void;
  /** Called when the receiver asks for a repair plan (MLP spec §6.6). */
  onResync?: (heldUpdateId: number, reason: ResyncReason) => void;
  /** Output the lane reports in `MediaFeedback`/`MediaAck`. */
  onAckNow?: (ack: ViewerAck) => void;
  /** The block grid size the ack advertises (MLP spec §6.5.1). */
  appliedBlockCount?: () => number;
  /** The highest input sequence reflected by an applied update (MLP spec §5). */
  onMediaState?: (state: { chainEpoch: number; staleBlocks: number; appliedUpdateId: number }) => void;
};

export type ScreenStreamStats = {
  updatesApplied: number;
  updatesDropped: number;
  resyncs: Array<{ reason: ResyncReason; held: number }>;
  duplicatesIgnored: number;
  epochBreaks: number;
};

const DEFAULT_RESYNC_INTERVAL_MS = 200;
/** Whole updates held for rendering; a burst beyond this forces a resync. */
const READY_QUEUE_DEPTH = 2;
/** Bound on the diagnostic resync history. */
const RESYNC_HISTORY_LIMIT = 64;

/** How long a receiver may wait for an applicable update before asking again. */
function waitingTimeoutFor(options: ScreenStreamOptions): number {
  const rtt = options.rttMs?.() ?? DEFAULT_RTT_MS;
  return waitingUpdateTimeoutMs(rtt);
}

type ValidatedRegion = { region: UpdateRegion; ops: Uint8Array };

export class ScreenStream {
  private readonly options: ScreenStreamOptions;
  private readonly renderer: SurfaceCanvasRenderer;
  private readonly now: () => number;
  private readonly resyncIntervalMs: number;
  private readonly assembler = new UpdateAssembler();
  private readonly queue: AssembledUpdate[] = [];
  /** Reused per-update op storage and region list (no steady-state allocation). */
  private readonly opsPool = new RegionOpsPool();
  private readonly validatedRegions: ValidatedRegion[] = [];
  private readonly ackWindow = new MediaAckWindow();

  private applied = 0;
  private chainEpoch = 0;
  private staleBlocks = 0;
  private converged = true;
  private geometry: { width: number; height: number } | null = null;
  private updateStartedAtMs: number | null = null;
  private lastResyncAtMs = Number.NEGATIVE_INFINITY;
  private pendingResync: { reason: ResyncReason; held: number } | null = null;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingSinceMs: number | null = null;
  private pumping = false;
  private stopped = false;
  private flowing = false;
  private updatesApplied = 0;
  private updatesDropped = 0;
  private duplicatesIgnored = 0;
  private epochBreaks = 0;
  private readonly partedKeys = new Set<string>();
  private readonly partedOrder: string[] = [];
  private readonly resyncHistory: Array<{ reason: ResyncReason; held: number }> = [];

  constructor(options: ScreenStreamOptions) {
    this.options = options;
    this.renderer = options.renderer;
    this.now = options.now ?? (() => performance.now());
    this.resyncIntervalMs = options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
  }

  /** The update id the canvas holds; 0 while the canvas holds no update. */
  get appliedUpdateId(): number {
    return this.applied;
  }

  /** The codec chain epoch the canvas was built under (MLP spec §6.6). */
  get currentChainEpoch(): number {
    return this.chainEpoch;
  }

  /** The receiver's own block-stale estimate (`MediaAck.stale_blocks`). */
  get staleBlockCount(): number {
    return this.staleBlocks;
  }

  get isConverged(): boolean {
    return this.converged;
  }

  /** The ack the next report will carry. */
  get ack(): ViewerAck {
    return this.buildAck(0);
  }

  get stats(): ScreenStreamStats {
    return {
      updatesApplied: this.updatesApplied,
      updatesDropped: this.updatesDropped,
      resyncs: [...this.resyncHistory],
      duplicatesIgnored: this.duplicatesIgnored,
      epochBreaks: this.epochBreaks,
    };
  }

  /**
   * Apply one MLP v1 MEDIA object (MLP spec §5).
   *
   * One object carries exactly one codec part; the object's fragments were
   * assembled by the media lane before this call, so the part is whole.
   */
  applyMediaPart(part: UpdatePart, meta: MediaPartMeta): void {
    if (this.stopped || this.flowing) {
      return;
    }

    const key = `${meta.updateId}:${part.partIndex}`;
    if (meta.duplicate && this.partedKeys.has(key)) {
      // DUP idempotence (§5.5.2): a deliberate duplicate of an applied part
      // is not applied twice and is not an error.
      this.duplicatesIgnored += 1;
      return;
    }
    if (this.partedKeys.has(key)) {
      this.duplicatesIgnored += 1;
      return;
    }
    this.rememberPart(key);

    if (part.partIndex === 0) {
      this.updateStartedAtMs = this.now();
    }

    const anchor = meta.anchor || meta.baseUpdateId === 0;
    const { update, resync } = this.assembler.push({
      ...part,
      anchor,
    });
    if (resync) {
      this.dropUpdate();
      this.markWaiting();
      this.requestResync(resync);
      return;
    }

    if (!update) {
      this.markWaiting();
      return;
    }

    this.applyBehind(update, meta, anchor);
  }

  /**
   * Note the sender's chain epoch (MLP spec §6.6).
   *
   * A newer epoch means the sender broke the chain: the receiver resets its
   * *canvas trust* to "all stale" without clearing the cells, reports the
   * epoch in its next ack, and accepts the anchor plan that follows.
   */
  applyMediaEpoch(epoch: number): boolean {
    if (epoch <= this.chainEpoch) {
      return false;
    }
    this.chainEpoch = epoch;
    this.staleBlocks = this.blockCount();
    this.converged = false;
    this.epochBreaks += 1;
    this.ackWindow.reset();
    this.assembler.reset();
    this.partedKeys.clear();
    this.partedOrder.length = 0;
    this.emitMediaState();
    return true;
  }

  /** Note an input sequence reflected by the applied cells (§5.6 echo). */
  private lastReflectedInputSeq = 0;

  get reflectedInputSeq(): number {
    return this.lastReflectedInputSeq;
  }

  /**
   * WebRTC media took over (or gave the canvas back). While the video element
   * is the render surface the relay updates are dropped without acks and
   * without resyncs: the canvas is not what the operator is looking at.
   */
  onWebRtcFlowing(flowing: boolean): void {
    if (flowing === this.flowing) {
      return;
    }

    this.flowing = flowing;
    if (flowing) {
      this.queue.length = 0;
      this.assembler.reset();
      this.clearWaiting();
      this.updateStartedAtMs = null;
    }
  }

  /** Release timers and pending state; the canvas keeps its last content. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.assembler.reset();
    this.clearWaiting();
    this.clearResyncTimer();
    this.pendingResync = null;
    this.updateStartedAtMs = null;
    this.geometry = null;
    // A deliberate teardown forgets the applied update; a *reconnect* never
    // calls this (design §7.6), so the canvas and the ack window survive one.
    this.applied = 0;
    this.ackWindow.reset();
    this.partedKeys.clear();
    this.partedOrder.length = 0;
  }

  private blockCount(): number {
    return Math.max(1, this.options.appliedBlockCount?.() ?? 1);
  }

  private rememberPart(key: string): void {
    this.partedKeys.add(key);
    this.partedOrder.push(key);
    while (this.partedOrder.length > 512) {
      const dropped = this.partedOrder.shift();
      if (dropped !== undefined) {
        this.partedKeys.delete(dropped);
      }
    }
  }

  private applyBehind(update: AssembledUpdate, meta: MediaPartMeta, anchor: boolean): void {
    if (this.queue.length >= READY_QUEUE_DEPTH) {
      // A receiver that cannot keep up must not render a stale backlog: the
      // queue is cleared whole and one resync asks for a fresh base.
      this.queue.length = 0;
      this.dropUpdate();
      this.requestResync("QUEUE_OVERFLOW");
    }

    this.queue.push(update);
    this.pendingMeta = meta;
    this.pendingAnchor = anchor;
    void this.pump();
  }

  private pendingMeta: MediaPartMeta | null = null;
  private pendingAnchor = false;

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }

    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const update = this.queue.shift();
        if (!update || this.stopped) {
          return;
        }
        const meta = this.pendingMeta;
        const anchor = this.pendingAnchor;
        this.pendingMeta = null;
        this.pendingAnchor = false;
        if (meta === null) {
          this.dropUpdate();
          continue;
        }
        await this.applyUpdate(update, meta, anchor);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async applyUpdate(
    update: AssembledUpdate,
    meta: MediaPartMeta,
    anchor: boolean,
  ): Promise<void> {
    // A delta for a update the canvas already moved past is stale, not lost.
    if (!anchor && update.baseUpdateId !== 0 && update.updateId <= this.applied) {
      this.dropUpdate();
      return;
    }

    if (meta.chainEpoch < this.chainEpoch && meta.baseUpdateId !== 0) {
      // A update from an older epoch cannot extend the current canvas.
      this.dropUpdate();
      return;
    }

    if (anchor || update.baseUpdateId === 0) {
      if (this.geometry?.width !== update.width || this.geometry?.height !== update.height) {
        this.renderer.resize(update.width, update.height);
        this.geometry = { width: update.width, height: update.height };
      }
    } else {
      if (update.baseUpdateId !== this.applied) {
        this.dropUpdate();
        this.markWaiting();
        this.requestResync("BASE_MISMATCH");
        return;
      }
      if (this.geometry?.width !== update.width || this.geometry?.height !== update.height) {
        this.dropUpdate();
        this.markWaiting();
        this.requestResync("GEOMETRY_MISMATCH");
        return;
      }
    }

    const coverage = anchor || update.baseUpdateId === 0 ? "full" : "sparse";
    const regions = update.regions;
    const pool = this.opsPool;

    pool.beginUpdate();
    try {
      // Every region of the update is inflated and validated before the first
      // cell is written. The regions are independent slots, so the inflates
      // run concurrently: the decompressor's per-part promise overhead is a
      // large part of a reset update's cost when the regions are walked one
      // after another.
      const results = await Promise.all(
        regions.map((region, index) => decodeRegionInto(region.payload, region, coverage, pool, index)),
      );

      // The whole update is rejected on the first region that fails, in region
      // order, so the reported reason does not depend on completion order.
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (!result.ok) {
          this.dropUpdate();
          this.markWaiting();
          this.requestResync(result.reason);
          return;
        }
      }

      if (this.stopped) {
        return;
      }

      const validated = this.validatedRegions;
      validated.length = 0;
      for (let index = 0; index < regions.length; index += 1) {
        validated.push({ region: regions[index], ops: pool.view(index) });
      }

      this.renderer.applyUpdate({ width: update.width, height: update.height }, validated);
      this.renderer.flush();
    } finally {
      pool.endUpdate();
    }

    this.applied = update.updateId;
    this.updatesApplied += 1;
    this.clearWaiting();

    const startedAt = this.updateStartedAtMs;
    this.updateStartedAtMs = null;
    const renderLatencyMs = startedAt === null ? 0 : Math.max(0, this.now() - startedAt);

    this.ackWindow.mark(update.updateId);
    this.chainEpoch = Math.max(this.chainEpoch, meta.chainEpoch);
    this.lastReflectedInputSeq = Math.max(this.lastReflectedInputSeq, meta.reflectsInputSeq);
    this.staleBlocks = 0;
    this.converged = true;
    const ack = this.buildAck(renderLatencyMs);
    this.options.onAck?.(ack);
    this.emitMediaState();

    this.options.onUpdateApplied?.(update.updateId);
  }

  private buildAck(renderLatencyMs: number): ViewerAck {
    return {
      highestAppliedUpdateId: this.ackWindow.highestAppliedUpdateId,
      ackBitmap: this.ackWindow.bitmapNumber(),
      chainEpoch: this.chainEpoch,
      appliedBlockCount: this.blockCount(),
      staleBlocks: this.staleBlocks,
      converged: this.converged && this.staleBlocks === 0,
      renderLatencyMs,
      hasRenderLatencyMs: renderLatencyMs > 0,
      echoOfInputSeq: this.lastReflectedInputSeq,
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

  /** Seed the canvas trust from a resume ack (the cells are still there). */
  seedFromResume(appliedUpdateId: number, chainEpoch: number): void {
    if (appliedUpdateId > this.ackWindow.highestAppliedUpdateId) {
      this.ackWindow.seedFromResume(appliedUpdateId);
    }
    this.chainEpoch = Math.max(this.chainEpoch, chainEpoch);
  }

  private emitMediaState(): void {
    this.options.onMediaState?.({
      chainEpoch: this.chainEpoch,
      staleBlocks: this.staleBlocks,
      appliedUpdateId: this.applied,
    });
  }

  private dropUpdate(): void {
    this.updatesDropped += 1;
  }

  private markWaiting(): void {
    if (this.waitingSinceMs === null) {
      this.waitingSinceMs = this.now();
    }
    if (this.waitingTimer !== null || this.stopped) {
      return;
    }

    // The update that would heal the receiver may itself have been lost; a
    // receiver that keeps waiting asks for a repair plan instead of waiting
    // forever (MLP spec §9.2 `WAITING_UPDATE_TIMEOUT_MS`).
    this.waitingTimer = setTimeout(() => {
      this.waitingTimer = null;
      if (this.stopped || this.waitingSinceMs === null) {
        return;
      }
      this.requestResync("INCOMPLETE_UPDATE");
      this.markWaiting();
    }, waitingTimeoutFor(this.options));
  }

  private clearWaiting(): void {
    this.waitingSinceMs = null;
    if (this.waitingTimer !== null) {
      clearTimeout(this.waitingTimer);
      this.waitingTimer = null;
    }
  }

  /**
   * Ask for a repair plan, at most once per `resyncIntervalMs`; requests
   * inside the window coalesce into one that carries the newest held update
   * and the first reason seen in the window.
   *
   * MLP spec §6.6: `screen.update.resync` starts a plan. The only reset-update
   * case left is a geometry change, which the sender watches for itself.
   */
  private requestResync(reason: ResyncReason): void {
    const held = this.applied;
    const timestamp = this.now();
    this.staleBlocks = Math.max(this.staleBlocks, 0);

    if (timestamp - this.lastResyncAtMs >= this.resyncIntervalMs) {
      this.emitResync(held, reason);
      this.lastResyncAtMs = timestamp;
      return;
    }

    this.pendingResync = this.pendingResync
      ? { reason: this.pendingResync.reason, held }
      : { reason, held };

    if (this.resyncTimer === null) {
      const delay = Math.max(1, this.lastResyncAtMs + this.resyncIntervalMs - timestamp);
      this.resyncTimer = setTimeout(() => {
        this.resyncTimer = null;
        const pending = this.pendingResync;
        this.pendingResync = null;
        if (!pending || this.stopped) {
          return;
        }
        this.emitResync(pending.held, pending.reason);
        this.lastResyncAtMs = this.now();
      }, delay);
    }
  }

  private emitResync(held: number, reason: ResyncReason): void {
    // Repair is ack-driven on the media lane (D-7): the sender re-encodes the
    // blocks the receiver's `MediaAck` leaves pending, so nothing is sent here.
    // The history is diagnostics for the receiver's own state.
    this.resyncHistory.push({ reason, held });
    if (this.resyncHistory.length > RESYNC_HISTORY_LIMIT) {
      this.resyncHistory.shift();
    }
    this.options.onResync?.(held, reason);
    this.emitMediaState();
  }

  private clearResyncTimer(): void {
    if (this.resyncTimer !== null) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
  }
}

/** The MLP object's `chain_epoch` TLV, read by the media session. */
export type MediaPartObject = MediaObject;
