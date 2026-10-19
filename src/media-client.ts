"use client";

/**
 * The media-lane client (MLP spec §6.3, §§7.2, §§8.4).
 *
 * It is the second WebSocket the receiver owns — a dedicated carrier for MLP v1
 * fragments with the `mlp-v1` subprotocol — and it is also the
 * carrier-agnostic half of the S2 datagram path: everything above the
 * {@link MediaLaneTransport} seam is transport-independent, so the data channel
 * plugs in by implementing that interface (the W10 seam).
 *
 * Responsibilities, deliberately separated from the canvas and the input queue:
 *
 * - the `MediaHello` / `MediaResume` exchange with its RTT-relative timeouts;
 * - MLP fragment RX and TX, object assembly, and the typed reject path — a
 *   malformed object is counted and reported, never rendered;
 * - the feedback loop: `MediaAck` per applied update (the 64-id grid) and
 *   `MediaFeedback` at `clamp(4 × RTT, 250 ms, 2 s)` carrying the receiver's
 *   goodput, RTT, loss and queue numbers (MLP spec §7.2, §§12);
 * - the keepalive (`Ping` every `clamp(10 s, 3 × RTT, 60 s)`; any inbound byte
 *   resets the idle timer) and the RTT it measures;
 * - the reconnect ladder of §7.4: no give-up, park-aware, and every attempt
 *   reports its stage so the UI can say `Reconnecting (attempt N, next in N s)`;
 * - the single-lane fallback of §4.2 rule 6: when the dedicated WebSocket
 *   cannot be established, the same lane runs over the control connection.
 */

import {
  MediaAck,
  MediaControlObject,
  MediaCursor,
  MediaFeedback,
  MediaHello,
  MediaHelloAck,
  MediaPathChange,
  MediaProbe,
  type MediaResume,
} from "@medialaneprotocol/proto";
import {
  DEFAULT_RTT_MS,
  MEDIA_APP_VERSION,
  MEDIA_LANE_SUBPROTOCOL,
  MEDIA_PROTOCOL_VERSION,
  MEDIA_RECEIVER_CAPABILITIES,
  MediaLaneErrorCode,
  MediaLaneMode,
  MediaPathKind,
  MAX_WS_FRAGMENT,
  RECEIVER_CLOSE_CODES,
  DEFAULT_MEDIA_INPUT_DEADLINE_MS,
  clampNumber,
  laneProbeTimeoutMs,
  reportIntervalMs,
  type MediaPathName,
} from "./protocol-constants";
import {
  MediaFragmentClass,
  MediaFragmentFlags,
  type MediaFragment,
  type MediaObject,
  MediaObjectAssembler,
  type MediaRejectReason,
  MediaTlv,
  decodeMediaMessage,
  defaultObjectAssemblerConfig,
  defaultPriorityFor,
  encodeMediaFragment,
  mediaRejectCode,
  readTlvU32,
  readTlvU64,
} from "./media-pdu";
import {
  type MediaCloseDisposition,
  type MediaResumeSnapshot,
  ReconnectLadder,
  type ReconnectStageName,
  classifyMediaClose,
} from "./media-resume";
import { type MediaPathChangeEvent, type MediaPathSelector } from "./media-path";

/** One transport message's worth of media-lane bytes. */
export type MediaLaneTransport = {
  readonly carrier: "websocket" | "control" | "datagram";
  sendFragment(bytes: Uint8Array): void;
  bufferedAmount(): number;
  close(code: number, reason: string): void;
  readonly isOpen: boolean;
  /**
   * How the carrier reports its own close. The client sets this when it takes
   * ownership of a transport, so a carrier never has to know about the ladder;
   * a shared control connection leaves it unset because the control lane owns
   * its own lifecycle.
   */
  onClose?: (code: number, reason: string) => void;
};

export type MediaLaneConnectionState =
  | "idle"
  | "connecting"
  | "attached"
  | "reconnecting"
  | "suspended"
  | "unsupported"
  | "failed"
  | "stopped";

/** What the lane reports on behalf of the receiver (the caller owns the data). */
export type MediaFeedbackSource = {
  ack: MediaAck;
  fps: number;
  renderMsP50: number;
  renderMsP95: number;
  inputQueueDepth: number;
  inputSubmitted: number;
  inputExpired: number;
};

export type MediaLaneClientOptions = {
  /** Open a dedicated carrier (the media WebSocket, or the S2 data channel). */
  openTransport: (context: { attempt: number; stage: ReconnectStageName }) => Promise<MediaLaneTransport>;
  /** The control-lane session id (`MediaHello.session_id`). */
  sessionId: () => string;
  /** The media session id the lane was admitted with ("" = fresh). */
  mediaSessionId: () => string;
  /** The stored resume token, or `null`. */
  resumeToken: () => string | null;
  /** The receiver state a `MediaResume` must carry (§§6.3). */
  resumeSnapshot: () => MediaResumeSnapshot;
  /** The feedback body's receiver-owned fields. */
  feedbackSource: () => MediaFeedbackSource;
  /** `the corresponding deployment setting` from the bootstrap (diagnostics only here). */
  inputDeadlineMs?: number;
  /** Epoch ms; the caller owns the clock in tests. */
  now?: () => number;
  /** The media lane's session-relative milliseconds. */
  sessionMs: () => number;
  /** The RTT the ladder and the cadence use; fed by `noteRttSample`. */
  rttMs?: () => number;
  /** A uniform sample in `[0, 1)` for the ladder's jitter. */
  random?: () => number;
  /** The path selector; the S1 client keeps it on `ws`. */
  pathSelector?: MediaPathSelector;
  onObject?: (object: MediaObject) => void;
  onControl?: (control: MediaControlObject) => void;
  onCursor?: (cursor: MediaCursor) => void;
  onStateChange?: (state: MediaLaneConnectionState) => void;
  /** A fragment or object the lane refused, with its typed reason. */
  onReject?: (reason: MediaRejectReason, objectId: number) => void;
  onClose?: (disposition: MediaCloseDisposition) => void;
  /** `MediaHelloAck` accepted: the lane is admitted. */
  onAttached?: (ack: MediaHelloAck) => void;
  /** A carrier switch (S2); the S1 client never fires it. */
  onPathChange?: (change: MediaPathChangeEvent) => void;
  onReconnectAttempt?: (attempt: number, delayMs: number, stage: ReconnectStageName) => void;
  /** The lane fell back to the shared control connection. */
  onFallbackToSingleLane?: (reason: string) => void;
};

/** The lane's own counters, mirrored into `MediaFeedback`. */
export type MediaLaneCounters = {
  receivedBytes: number;
  receivedObjects: number;
  lostObjects: number;
  duplicatedObjects: number;
  reorderedObjects: number;
  rejectedFragments: number;
  rejectedObjects: number;
  expiredObjects: number;
  evictedObjects: number;
  droppedDuplicates: number;
};

export type MediaLaneStats = MediaLaneCounters & {
  rttMs: number;
  rttMinMs: number;
  jitterMs: number;
  goodputBps: number;
};

const DEDUPE_WINDOW_OBJECTS = 4_096;
const FEEDBACK_BACKLOG_LIMIT_BYTES = 262_144;

/**
 * Opens the dedicated media WebSocket.
 *
 * The subprotocol is *requested*; a server that does not know it rejects the
 * upgrade rather than silently accepting it, and the receiver then runs
 * `lane_mode = single` (§§6.3) — which is why a failed open is a carrier
 * failure, never a session failure.
 */
export class WebSocketMediaTransport implements MediaLaneTransport {
  readonly carrier = "websocket" as const;
  onClose?: (code: number, reason: string) => void;

  private open = false;
  private closed = false;

  private constructor(private readonly socket: WebSocket) {}

  static open(options: {
    url: string;
    onFragment: (bytes: Uint8Array) => void;
    /** Called only when the socket dies before it ever opened. */
    onClose?: (code: number, reason: string) => void;
    timeoutMs: number;
  }): Promise<WebSocketMediaTransport> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(options.url, [MEDIA_LANE_SUBPROTOCOL]);
      socket.binaryType = "arraybuffer";

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          socket.close(RECEIVER_CLOSE_CODES.teardown, "lane_open_timeout");
        } catch {
          // The socket may already be gone; the reject below is what matters.
        }
        reject(new Error("media lane open timed out"));
      }, options.timeoutMs);

      socket.onopen = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const transport = new WebSocketMediaTransport(socket);
        transport.open = true;
        transport.installHandlers(options);
        resolve(transport);
      };

      socket.onerror = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(new Error("media lane connection failed"));
      };

      socket.onclose = (event) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(event.reason || "media lane closed before open"));
        }
      };
    });
  }

  private installHandlers(options: {
    onFragment: (bytes: Uint8Array) => void;
    onClose?: (code: number, reason: string) => void;
  }): void {
    this.socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        // A text message is a framing breach: the lane closes 4400 rather
        // than letting a string reach the canvas (§§6.3).
        this.closed = true;
        this.open = false;
        try {
          this.socket.close(4400, "text_frame");
        } catch {
          // Already closed.
        }
        options.onClose?.(4400, "text_frame");
        this.onClose?.(4400, "text_frame");
        return;
      }

      const bytes = toBytes(event.data);
      if (bytes) {
        options.onFragment(bytes);
      }
    };

    this.socket.onclose = (event) => {
      this.closed = true;
      this.open = false;
      options.onClose?.(event.code, event.reason);
      this.onClose?.(event.code, event.reason);
    };

    this.socket.onerror = () => {
      // The close handler owns the lifecycle.
    };
  }

  get isOpen(): boolean {
    return this.open && !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  sendFragment(bytes: Uint8Array): void {
    if (!this.isOpen) {
      return;
    }
    this.socket.send(toArrayBuffer(bytes));
  }

  bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  close(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.open = false;
    try {
      this.socket.close(code, reason);
    } catch {
      // A close on an already-closing socket is not an error.
    }
  }
}

/**
 * A carrier that shares the control connection (`lane_mode = single`, §§4.2
 * rule 6). The session wires the control lane's raw-binary hook into
 * {@link MediaLaneClient.handleFragment} and its fragment sink here.
 */
export class ControlLaneMediaTransport implements MediaLaneTransport {
  readonly carrier = "control" as const;

  private open = true;

  constructor(
    private readonly sink: (bytes: Uint8Array) => void,
    private readonly backlog: () => number = () => 0,
  ) {}

  get isOpen(): boolean {
    return this.open;
  }

  sendFragment(bytes: Uint8Array): void {
    if (this.open) {
      this.sink(bytes);
    }
  }

  bufferedAmount(): number {
    return this.backlog();
  }

  close(): void {
    this.open = false;
  }
}

/**
 * The media lane.
 *
 * The client is *not* recreated on reconnect (§7.6): a reconnect re-attaches a
 * carrier, and the canvas, the ack window and the input queue survive in the
 * callers.
 */
export class MediaLaneClient {
  private readonly options: MediaLaneClientOptions;
  private readonly assembler: MediaObjectAssembler;
  private readonly ladder: ReconnectLadder;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly pendingProbes: Array<{
    objectId: number;
    sendEpochMs: number;
    echoEpochMs: number;
    payloadBytes: number;
  }> = [];
  private readonly reportedErrors = new Map<number, number>();
  private readonly seenObjectIds = new Map<number, number>();
  private readonly seenOrder: number[] = [];
  private mode: "idle" | "dual" | "single" = "idle";
  private transport: MediaLaneTransport | null = null;
  /**
   * The carrier a datagram switch left behind (§§7.8: both carriers stay open
   * during a switch). A demotion adopts it again; a close with no fallback
   * runs the ladder.
   */
  private fallbackTransport: MediaLaneTransport | null = null;
  private connectionState: MediaLaneConnectionState = "idle";
  private controlOnline = true;
  private stopped = false;
  private attachGeneration = 0;
  private attempt = 0;
  private nextRetryMs = 0;
  private pendingAttach: { resolve: (attached: boolean) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private ladderTimer: ReturnType<typeof setTimeout> | null = null;
  private windowStartedAtMs = 0;
  private windowBytes = 0;
  private windowObjects = 0;
  private windowLost = 0;
  private windowDuplicated = 0;
  private windowReordered = 0;
  private highestSeenObjectId = 0;
  private rttMs = DEFAULT_RTT_MS;
  private rttMinMs = Number.POSITIVE_INFINITY;
  private jitterMs = 0;
  private lastGoodputBps = 0;
  private counters = emptyCounters();
  private ackHint: MediaAck | null = null;
  private helloAck: MediaHelloAck | null = null;
  private outboundObjectId = 0x0100_0000;
  private lastPathHint: number | null = null;
  private lastRejectDetail = "";
  /** The path in force, mirrored from `notePathChange` (S2 diagnostics). */
  private activePathKind: number = MediaPathKind.WS;
  private activePathName: MediaPathName | null = null;

  constructor(options: MediaLaneClientOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
    this.rttMs = options.rttMs?.() ?? DEFAULT_RTT_MS;
    this.assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(this.rttMs));
    this.ladder = new ReconnectLadder(this.rttMs);
  }

  get state(): MediaLaneConnectionState {
    return this.connectionState;
  }

  get stats(): MediaLaneStats {
    return {
      ...this.counters,
      rttMs: Math.round(this.rttMs),
      rttMinMs: Number.isFinite(this.rttMinMs) ? Math.round(this.rttMinMs) : Math.round(this.rttMs),
      jitterMs: Math.round(this.jitterMs),
      goodputBps: this.lastGoodputBps,
    };
  }

  get mediaSessionId(): string {
    return this.helloAck?.mediaSessionId ?? "";
  }

  get laneMode(): string {
    return this.mode === "single" ? MediaLaneMode.SINGLE : MediaLaneMode.DUAL;
  }

  /** Whether the active carrier is a datagram path (S2). */
  get activePathIsDatagram(): boolean {
    return this.transport?.carrier === "datagram";
  }

  get reconnectAttempt(): number {
    return this.attempt;
  }

  get nextReconnectInMs(): number {
    return this.nextRetryMs;
  }

  get nextReconnectStage(): ReconnectStageName {
    return this.ladder.nextStage();
  }

  /** The last ack the lane sent (diagnostics and the resume snapshot). */
  get sentAckHint(): MediaAck | null {
    return this.ackHint;
  }

  /** The most recent PATH_HINT the peer declared (diagnostics; S2). */
  get pathHint(): number | null {
    return this.lastPathHint;
  }

  get lastReject(): string {
    return this.lastRejectDetail;
  }

  /** Feed an RTT sample measured elsewhere (for example the control lane). */
  noteRttSample(sampleMs: number): void {
    if (!Number.isFinite(sampleMs) || sampleMs <= 0) {
      return;
    }
    const previous = this.rttMs;
    this.rttMs = Math.min(60_000, Math.max(1, sampleMs));
    this.rttMinMs = Math.min(this.rttMinMs, this.rttMs);
    this.jitterMs = this.jitterMs + (Math.abs(this.rttMs - previous) - this.jitterMs) / 4;
    this.assembler.setAssemblyTimeout(this.rttMs);
  }

  /**
   * Attach the dedicated lane and wait for `MediaHelloAck`.
   *
   * `false` means the dedicated WebSocket could not be established (or the
   * sender refused the lane); the caller then runs the single-lane fallback.
   */
  async attachDual(): Promise<boolean> {
    if (this.stopped || !this.controlOnline) {
      return false;
    }
    this.mode = "dual";
    return await this.tryAttach("control_retry", true);
  }

  /**
   * Run the lane over the shared control connection (`lane_mode = single`).
   *
   * The caller wires the control lane's raw-binary hook to
   * {@link handleFragment} and calls this once the control connection is
   * connected.
   */
  useControlLane(transport: MediaLaneTransport): void {
    if (this.stopped) {
      return;
    }
    this.mode = "single";
    this.attachGeneration += 1;
    // A shared control connection keeps its own lifecycle hooks: the session
    // calls `noteControlDisconnected` when the control lane drops.
    transport.onClose = undefined;
    this.transport = transport;
    this.setConnectionState("connecting");
    this.sendHello();
  }

  /** Drop the current transport (the control lane failed, or a mandatory reset). */
  detach(reason: string): void {
    this.attachGeneration += 1;
    this.stopTimers();
    this.transport?.close(RECEIVER_CLOSE_CODES.teardown, reason);
    this.fallbackTransport?.close(RECEIVER_CLOSE_CODES.teardown, reason);
    this.transport = null;
    this.fallbackTransport = null;
  }

  /** The control connection went away: park the lane and wait for it. */
  noteControlDisconnected(): void {
    this.controlOnline = false;
    this.detach("control_lost");
    this.setConnectionState("reconnecting");
  }

  /** The control connection is back (with a possibly refreshed resume token). */
  noteControlReconnected(): void {
    if (this.stopped) {
      return;
    }
    this.controlOnline = true;
    this.attempt = 0;
    this.nextRetryMs = 0;
    this.startLane();
  }

  /** (Re)start the lane on the current mode. */
  startLane(): void {
    if (this.stopped || !this.controlOnline) {
      return;
    }
    if (this.mode === "single") {
      this.setConnectionState("connecting");
      this.sendHello();
      return;
    }
    void this.tryAttach("control_retry", false);
  }

  /** Route a raw MLP fragment (single-lane mode, or the S2 datagram carrier). */
  handleFragment(bytes: Uint8Array): void {
    if (this.stopped) {
      return;
    }

    const message = decodeMediaMessage(bytes, "stream");
    if (!message.ok) {
      this.countReject(message.reason, 0);
      return;
    }

    this.ingestFragments(message.fragments);
  }

  /**
   * Route one datagram message (S2): exactly one fragment per transport
   * message (§§5.4 step 3). The bytes are otherwise identical to the stream
   * carrier's.
   */
  handleDatagramMessage(bytes: Uint8Array): void {
    if (this.stopped) {
      return;
    }

    const message = decodeMediaMessage(bytes, "datagram");
    if (!message.ok) {
      this.countReject(message.reason, 0);
      return;
    }

    this.ingestFragments(message.fragments);
  }

  private ingestFragments(fragments: MediaFragment[]): void {
    for (const fragment of fragments) {
      const outcome = this.assembler.accept(fragment, this.now(), this.options.sessionMs());
      switch (outcome.kind) {
        case "incomplete":
          this.armExpiryTimer();
          break;
        case "drop":
          this.countDrop(outcome.reason);
          break;
        case "reject":
          this.countReject(outcome.reason, fragment.objectId);
          break;
        case "object":
          this.noteObjectArrival(outcome.object);
          break;
        default:
          break;
      }
    }
  }

  /**
   * Send one `MediaAck` for a update the canvas actually holds.
   *
   * Acks travel at priority 0 and reports at priority 2 (MLP spec §4.1: "0 for
   * acks, 2 for reports"); the FEEDBACK class has no body discriminator, so
   * the priority is what separates the two protobuf bodies on the wire.
   */
  sendAck(ack: MediaAck): void {
    this.ackHint = ack;
    this.sendObject(MediaFragmentClass.FEEDBACK, MediaFragmentFlags.NONE, MediaAck.encode(ack).finish(), 0);
  }

  /** Queue a `MediaProbe` echo; it rides the next report (§§6.2). */
  echoProbe(objectId: number, sendEpochMs: number, payloadBytes: number): void {
    this.pendingProbes.push({
      objectId,
      sendEpochMs,
      echoEpochMs: this.options.sessionMs(),
      payloadBytes,
    });
    if (this.pendingProbes.length >= 8) {
      this.sendFeedbackNow();
    }
  }

  /** Send a typed lane error (rate-limited per code, §§6.3). */
  sendError(code: number, objectId: number, detail: string): void {
    if (!this.transport?.isOpen) {
      return;
    }
    const last = this.reportedErrors.get(code) ?? Number.NEGATIVE_INFINITY;
    if (this.now() - last < 1_000) {
      return;
    }
    this.reportedErrors.set(code, this.now());
    this.sendControlObject({ error: { code, objectId, detail } });
  }

  /** Build and send one `MediaFeedback` report (§§7.2.1). */
  sendFeedbackNow(): void {
    if (!this.transport?.isOpen) {
      return;
    }

    const sessionMs = this.options.sessionMs();
    const windowMs = Math.max(1, sessionMs - this.windowStartedAtMs);
    const source = this.options.feedbackSource();
    const goodputBps = Math.round((this.windowBytes * 8_000) / windowMs);

    const feedback: MediaFeedback = {
      rttMs: Math.round(clampNumber(this.rttMs, 1, 60_000)),
      rttMinMs: Math.round(Number.isFinite(this.rttMinMs) ? this.rttMinMs : this.rttMs),
      jitterMs: Math.round(this.jitterMs),
      receivedBytes: this.windowBytes,
      receivedObjects: this.windowObjects,
      lostObjects: this.windowLost,
      duplicatedObjects: this.windowDuplicated,
      reorderedObjects: this.windowReordered,
      windowMs,
      ack: source.ack,
      probes: this.pendingProbes.splice(0, this.pendingProbes.length),
      bufferedAmountBytes: Math.round(this.transport.bufferedAmount()),
      displayFps: Math.round(source.fps),
      renderMsP50: Math.round(source.renderMsP50),
      renderMsP95: Math.round(source.renderMsP95),
      inputQueueDepth: source.inputQueueDepth,
      inputSubmitted: source.inputSubmitted,
      inputExpired: source.inputExpired,
      pathSwitches: this.options.pathSelector?.pathSwitches ?? 0,
      activePath: this.options.pathSelector?.activePathValue ?? MediaPathKind.WS,
      appVersion: MEDIA_APP_VERSION,
    };

    this.lastGoodputBps = goodputBps;
    this.windowBytes = 0;
    this.windowObjects = 0;
    this.windowLost = 0;
    this.windowDuplicated = 0;
    this.windowReordered = 0;
    this.windowStartedAtMs = sessionMs;

    this.sendFeedbackObject(MediaFeedback.encode(feedback).finish());
  }

  /** Tear the lane down deliberately (the operator closed the session). */
  stop(reason = "receiver_stop"): void {
    this.stopped = true;
    this.controlOnline = false;
    this.attachGeneration += 1;
    this.stopTimers();
    this.resolvePendingAttach(false);
    this.transport?.close(RECEIVER_CLOSE_CODES.teardown, reason);
    this.fallbackTransport?.close(RECEIVER_CLOSE_CODES.teardown, reason);
    this.transport = null;
    this.fallbackTransport = null;
    this.setConnectionState("stopped");
  }

  /**
   * S2 seam: move the lane onto another carrier mid-session (§§7.8).
   *
   * Both carriers stay open: the previous one becomes the fallback that a
   * demotion adopts again. The `frame_id` chain, the assembler, the ack
   * window and the input queue are untouched — the carrier changes, the lane
   * does not. The `MediaPathChange` object is sent on the **new** carrier.
   */
  switchTransport(transport: MediaLaneTransport, change: MediaPathChangeEvent): boolean {
    if (this.stopped || !transport.isOpen) {
      return false;
    }
    if (this.transport === transport) {
      return false;
    }
    const previous = this.transport;
    transport.onClose = (code, reason) => this.handleTransportClose(code, reason, transport);
    this.transport = transport;
    if (previous && previous.carrier !== "control") {
      this.fallbackTransport = previous;
    } else {
      this.fallbackTransport = null;
    }
    this.notePathChange(change);
    return true;
  }

  /**
   * Return to the carrier a switch left open (a demotion, §§7.8).
   *
   * `false` means the fallback is gone or closed; the caller then lets the
   * ladder rebuild a carrier.
   */
  switchBackToFallback(change: MediaPathChangeEvent): boolean {
    const fallback = this.fallbackTransport;
    if (this.stopped || !fallback || !fallback.isOpen) {
      return false;
    }
    this.fallbackTransport = null;
    this.transport = fallback;
    this.notePathChange(change);
    return true;
  }

  /** Whether a carrier is held open behind the active one. */
  get hasFallbackTransport(): boolean {
    return this.fallbackTransport !== null;
  }

  /** S2 seam: record a carrier switch; the `frame_id` chain continues. */
  notePathChange(change: MediaPathChangeEvent): void {
    this.activePathKind = change.to;
    this.activePathName = change.toPath;
    this.options.onPathChange?.(change);
    // The design's §6.8 rule: "the media lane sends a MediaPathChange". It
    // travels as a PATH-class object on whatever carrier is active now; when
    // the lane is not attached (or the carrier is closed) it is not sent, and
    // the sender follows the next `MediaFeedback.active_path` instead.
    if (!this.transport?.isOpen) {
      return;
    }
    this.outboundObjectId = this.outboundObjectId >= 0x7fff_ffff ? 1 : this.outboundObjectId + 1;
    const bytes = encodeMediaFragment({
      classValue: MediaFragmentClass.PATH,
      flags: MediaFragmentFlags.NONE,
      priority: defaultPriorityFor(MediaFragmentClass.PATH),
      objectId: this.outboundObjectId,
      fragmentIndex: 0,
      fragmentCount: 1,
      headerExt: [],
      payload: MediaPathChange.encode({
        fromPath: change.from,
        toPath: change.to,
        reason: change.reason,
        atEpochMs: change.atEpochMs,
      }).finish(),
    });
    this.transport.sendFragment(bytes);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async tryAttach(stage: ReconnectStageName, awaited: boolean): Promise<boolean> {
    if (this.stopped || !this.controlOnline) {
      return false;
    }

    this.setConnectionState(this.attempt > 0 ? "reconnecting" : "connecting");
    const generation = ++this.attachGeneration;

    let transport: MediaLaneTransport;
    try {
      transport = await this.options.openTransport({ attempt: this.attempt, stage });
    } catch {
      if (generation === this.attachGeneration && !this.stopped) {
        this.setConnectionState("reconnecting");
        if (awaited) {
          return false;
        }
        this.scheduleReattach();
      }
      return false;
    }

    if (generation !== this.attachGeneration || this.stopped) {
      transport.close(RECEIVER_CLOSE_CODES.teardown, "superseded");
      return false;
    }

    transport.onClose = (code, reason) => this.handleTransportClose(code, reason, transport);
    this.transport = transport;
    this.sendHello();

    if (!awaited) {
      return true;
    }

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAttach = null;
        resolve(false);
      }, laneProbeTimeoutMs(this.rttMs));
      this.pendingAttach = { resolve, timer };
    });
  }

  private resolvePendingAttach(attached: boolean): void {
    const pending = this.pendingAttach;
    if (!pending) {
      return;
    }
    this.pendingAttach = null;
    clearTimeout(pending.timer);
    pending.resolve(attached);
  }

  private sendHello(): void {
    const sessionId = this.options.sessionId();
    if (!sessionId) {
      // §6.3: the media lane is admitted by the control session; without one
      // it waits rather than opening a lane that would be refused `4409`.
      this.scheduleReattach();
      return;
    }

    const mediaSessionId = this.options.mediaSessionId();
    const hello: MediaHello = {
      protocolVersion: MEDIA_PROTOCOL_VERSION,
      mediaSessionId,
      sessionId,
      maxFragmentPayload: MAX_WS_FRAGMENT,
      cellSize: 0,
      cellCols: 0,
      cellRows: 0,
      capabilities: [...MEDIA_RECEIVER_CAPABILITIES],
      encoderMaxFps: 30,
      startEpochMs: this.options.sessionMs(),
    };
    this.sendControlObject({ hello });

    const token = this.options.resumeToken();
    // A resume belongs to a named lane: an empty media id is a fresh session,
    // and sending a MediaResume for it is what made the sender hand out a second
    // media id the intermediary was never paired on.
    if (token && mediaSessionId.trim().length > 0) {
      const snapshot = this.options.resumeSnapshot();
      const resume: MediaResume = {
        resumeToken: token,
        appliedUpdateId: snapshot.appliedUpdateId,
        chainEpoch: snapshot.chainEpoch,
        ackBitmap: snapshot.ackBitmap,
        inputSeqNext: snapshot.inputSeqNext,
        pressedKeys: snapshot.pressedKeys,
        pressedButtons: snapshot.pressedButtons,
        activePath: snapshot.activePath || MediaPathKind.WS,
        dcTransportId: "",
      };
      this.sendControlObject({ resume });
    }
  }

  private handleControlObject(control: MediaControlObject): void {
    if (control.helloAck) {
      this.helloAck = control.helloAck;
      if (!control.helloAck.mediaSupported) {
        this.setConnectionState("unsupported");
        this.stopTimers();
        this.resolvePendingAttach(false);
        this.options.onAttached?.(control.helloAck);
        return;
      }
      this.attachSucceeded();
      this.options.onAttached?.(control.helloAck);
    }

    this.options.onControl?.(control);

    if (control.close) {
      const disposition = classifyMediaClose(RECEIVER_CLOSE_CODES.normal, control.close.park);
      this.options.onClose?.(disposition);
      if (disposition.kind === "terminal") {
        this.setConnectionState("failed");
        this.stopTimers();
        return;
      }
    }

    if (control.error) {
      this.lastRejectDetail = control.error.detail || `error_${control.error.code}`;
      if (control.error.code === MediaLaneErrorCode.LANE_DISABLED) {
        this.setConnectionState("reconnecting");
        this.scheduleReattach();
      }
    }
  }

  private attachSucceeded(): void {
    this.attempt = 0;
    this.nextRetryMs = 0;
    this.ladder.reset(this.rttMs);
    this.setConnectionState("attached");
    this.windowStartedAtMs = this.options.sessionMs();
    // The keepalive is outbound and measured, not simulated: a browser cannot
    // emit a WebSocket Ping (no API for it), so the lane's own acks and
    // reports — every `report_interval` — are what reset the edge's idle
    // window, and its own idle timeout plus the transport's close event are
    // what tell the receiver the lane is gone. The design's `ws_ping_interval`
    // is the *edge's* timer, mirrored in `edge-protocol-constants.ts`.
    this.armFeedback();
    this.resolvePendingAttach(true);
  }

  private handleTransportClose(
    code: number,
    reason: string,
    source?: MediaLaneTransport,
  ): void {
    const active = this.transport;
    if (source && active && source !== active) {
      // A closed standby carrier: drop it and keep the active one running.
      if (this.fallbackTransport === source) {
        this.fallbackTransport = null;
      }
      return;
    }
    if (this.transport === null) {
      return;
    }
    this.transport = null;
    this.stopTimers();
    const disposition = classifyMediaClose(code, false);
    this.options.onClose?.(disposition);
    if (disposition.kind === "terminal") {
      this.setConnectionState("failed");
      this.resolvePendingAttach(false);
      return;
    }
    this.lastRejectDetail = reason || `close_${code}`;
    if (this.mode === "single") {
      // The control lane owns the reconnect; the lane just reports.
      this.setConnectionState("reconnecting");
      return;
    }
    // §6.8 demotion: the other carrier stayed open across the switch, so the
    // lane returns to it instead of paying a full reattach.
    const fallback = this.fallbackTransport;
    this.fallbackTransport = null;
    if (fallback && fallback.isOpen) {
      this.transport = fallback;
      this.notePathChange({
        fromPath: this.activePathName ?? "WS",
        toPath: "WS",
        from: this.activePathKind,
        to: MediaPathKind.WS,
        reason: "channel_closed",
        atEpochMs: this.now(),
      });
      this.setConnectionState("attached");
      this.armFeedback();
      if (this.pendingAttach) {
        this.resolvePendingAttach(true);
      }
      return;
    }
    this.setConnectionState("reconnecting");
    this.scheduleReattach();
  }

  private scheduleReattach(): void {
    if (this.stopped || !this.controlOnline) {
      return;
    }

    const attempt = this.attempt;
    const delay = this.ladder.delayFor(attempt, jitter(this.random));
    const stage = this.ladder.stageFor(attempt);
    this.nextRetryMs = delay;
    this.attempt += 1;
    this.options.onReconnectAttempt?.(attempt + 1, delay, stage);
    this.setConnectionState(stage === "suspended" ? "suspended" : "reconnecting");

    if (this.ladderTimer !== null) {
      clearTimeout(this.ladderTimer);
    }
    this.ladderTimer = setTimeout(() => {
      this.ladderTimer = null;
      void this.tryAttach(stage, false);
    }, delay);
  }

  private armFeedback(): void {
    this.clearFeedback();
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = null;
      this.sendFeedbackNow();
      if (!this.stopped && this.transport?.isOpen) {
        this.armFeedback();
      }
    }, reportIntervalMs(this.rttMs));
  }

  private armExpiryTimer(): void {
    this.clearExpiry();
    const pending = this.assembler.nextExpiryInMs(this.now());
    if (pending === null) {
      return;
    }
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      const expired = this.assembler.expire(this.now());
      for (const objectId of expired) {
        this.counters.expiredObjects += 1;
        this.countReject("ASSEMBLY_TIMEOUT", objectId);
      }
      this.armExpiryTimer();
    }, Math.max(1, pending));
  }

  private sendFeedbackObject(payload: Uint8Array): void {
    this.sendObject(MediaFragmentClass.FEEDBACK, 0, payload);
  }

  private sendControlObject(body: MediaControlObject): void {
    this.sendObject(MediaFragmentClass.CONTROL, MediaFragmentFlags.URGENT, MediaControlObject.encode(body).finish());
  }

  private sendObject(
    classValue: number,
    flags: number,
    payload: Uint8Array,
    priority = defaultPriorityFor(classValue),
  ): void {
    const transport = this.transport;
    if (!transport?.isOpen) {
      return;
    }
    if (transport.bufferedAmount() > FEEDBACK_BACKLOG_LIMIT_BYTES) {
      // The design's bounded-writer rule (§§4.2 rule 4): the sender's own queue
      // is the authority; a report is never worth unbounded backlog.
      return;
    }

    this.outboundObjectId = this.outboundObjectId >= 0x7fff_ffff ? 1 : this.outboundObjectId + 1;
    const bytes = encodeMediaFragment({
      classValue,
      // One object is one fragment here, so it is always the final fragment:
      // a hop only delivers an object once FIN has been seen (INV-1), and an
      // object without it never leaves the next assembler.
      flags: flags | MediaFragmentFlags.FIN,
      priority,
      objectId: this.outboundObjectId,
      fragmentIndex: 0,
      fragmentCount: 1,
      headerExt: [],
      payload,
    });
    transport.sendFragment(bytes);
  }

  private noteObjectArrival(object: MediaObject): void {
    this.counters.receivedObjects += 1;
    this.counters.receivedBytes += object.payload.byteLength;
    this.windowObjects += 1;
    this.windowBytes += object.payload.byteLength;
    this.noteObjectId(object.objectId);

    switch (object.classValue) {
      case MediaFragmentClass.MEDIA:
        this.options.onObject?.(object);
        break;
      case MediaFragmentClass.CURSOR:
        this.decodeCursor(object);
        break;
      case MediaFragmentClass.FEEDBACK:
        this.decodeFeedbackObject(object);
        break;
      case MediaFragmentClass.CONTROL:
        this.decodeControl(object);
        break;
      case MediaFragmentClass.PATH:
        this.notePathHint(object);
        break;
      default:
        break;
    }
  }

  private noteObjectId(id: number): void {
    const previous = this.seenObjectIds.get(id);
    if (previous !== undefined) {
      this.counters.duplicatedObjects += 1;
      this.windowDuplicated += 1;
      return;
    }

    if (id > this.highestSeenObjectId + 1) {
      const gap = id - this.highestSeenObjectId - 1;
      this.counters.lostObjects += gap;
      this.windowLost += gap;
    } else if (id <= this.highestSeenObjectId) {
      this.counters.reorderedObjects += 1;
      this.windowReordered += 1;
    }

    this.highestSeenObjectId = Math.max(this.highestSeenObjectId, id);
    this.seenObjectIds.set(id, this.now());
    this.seenOrder.push(id);
    while (this.seenOrder.length > DEDUPE_WINDOW_OBJECTS) {
      const dropped = this.seenOrder.shift();
      if (dropped !== undefined) {
        this.seenObjectIds.delete(dropped);
      }
    }
  }

  private decodeCursor(object: MediaObject): void {
    try {
      this.options.onCursor?.(MediaCursor.decode(object.payload));
    } catch {
      this.countReject("BODY_INVALID", object.objectId);
    }
  }

  private decodeFeedbackObject(object: MediaObject): void {
    if (object.priority === 0) {
      // The peer's ack (receiver acks are ours to send, so this only happens if
      // a hop echoes one back): nothing to do with it.
      return;
    }
    const sendEpochMs = readTlvU64(object, MediaTlv.SEND_EPOCH_MS) ?? 0;
    try {
      const probe = MediaProbe.decode(object.payload);
      if ((object.flags & MediaFragmentFlags.ECHO_REQUESTED) !== 0) {
        this.echoProbe(probe.probeId || object.objectId, probe.sendEpochMs || sendEpochMs, object.payload.byteLength);
      }
    } catch {
      this.countReject("BODY_INVALID", object.objectId);
    }
  }

  private decodeControl(object: MediaObject): void {
    try {
      this.handleControlObject(MediaControlObject.decode(object.payload));
    } catch {
      this.countReject("BODY_INVALID", object.objectId);
    }
  }

  private notePathHint(object: MediaObject): void {
    const hint = readTlvU32(object, MediaTlv.PATH_HINT);
    if (hint !== null) {
      this.lastPathHint = hint;
    }
  }

  private countDrop(reason: "expired" | "duplicate" | "evicted" | "rejected"): void {
    if (reason === "expired") {
      this.counters.expiredObjects += 1;
    } else if (reason === "duplicate") {
      // A repeated fragment is a repeated object on the wire: the specification's
      // `duplicated_objects` counts it (§§7.2.2).
      this.counters.droppedDuplicates += 1;
      this.counters.duplicatedObjects += 1;
      this.windowDuplicated += 1;
    } else if (reason === "evicted") {
      this.counters.evictedObjects += 1;
    }
  }

  private countReject(reason: MediaRejectReason, objectId: number): void {
    this.counters.rejectedFragments += 1;
    this.counters.rejectedObjects += 1;
    this.lastRejectDetail = reason;
    this.options.onReject?.(reason, objectId);
    this.sendError(mediaRejectCode(reason), objectId, reason);
  }

  private setConnectionState(state: MediaLaneConnectionState): void {
    if (state === this.connectionState) {
      return;
    }
    this.connectionState = state;
    this.options.onStateChange?.(state);
  }

  private stopTimers(): void {
    this.clearFeedback();
    this.clearExpiry();
    if (this.ladderTimer !== null) {
      clearTimeout(this.ladderTimer);
      this.ladderTimer = null;
    }
  }

  private clearFeedback(): void {
    if (this.feedbackTimer !== null) {
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = null;
    }
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}

function emptyCounters(): MediaLaneCounters {
  return {
    receivedBytes: 0,
    receivedObjects: 0,
    lostObjects: 0,
    duplicatedObjects: 0,
    reorderedObjects: 0,
    rejectedFragments: 0,
    rejectedObjects: 0,
    expiredObjects: 0,
    evictedObjects: 0,
    droppedDuplicates: 0,
  };
}

function jitter(random: () => number): number {
  return Math.floor(random() * 250);
}

/** Exports the specification pinned for the client's diagnostics surface. */
export { DEFAULT_MEDIA_INPUT_DEADLINE_MS, MediaLaneMode, MediaPathKind };

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
