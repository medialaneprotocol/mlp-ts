/**
 * Media path selection (MLP spec §7.8) — the S1 half.
 *
 * S1 has exactly one carrier: the media WebSocket. The receiver therefore always
 * reports `ws` and never switches; what this module provides is the *decision
 * engine* the S2 datagram carrier plugs into, so that W10 adds a candidate and
 * a transport adapter rather than a second selection policy.
 *
 * The seam (recorded for W10):
 *
 * - a candidate registers with {@link MediaPathSelector.register} and reports
 *   its own availability, goodput and last probe window;
 * - the selector decides under the §6.8 hysteresis and calls `onSwitch` with a
 *   `MediaPathChange`-shaped object, at which point the *carrier* moves and the
 *   `frame_id` chain does not: the media lane keeps the same codec chain, the
 *   same `media_session_id`, and the same object-id counter;
 * - `the corresponding deployment setting=off` (bootstrap) forces `ws` even when a datagram
 *   candidate is available — the kill switch of §13.
 *
 * Everything here is policy, so it holds no transport and no timers: the caller
 * ticks it.
 *
 * S2 (the datagram carrier) needed **no new rule here**: the adapter registers
 * `dc-direct`/`dc-turn` candidates through {@link MediaPathSelector.register},
 * the switch is recorded with its real time in `atEpochMs`, and the wire
 * `MediaPathChange` is sent by the media lane client when `onSwitch` fires.
 */

import { MediaPathKind, type MediaPathName } from "./protocol-constants";

/** The sustained-window length: `3 × rtt_min` (§§7.8). */
export function sustainedWindowMs(rttMs: number): number {
  return Math.max(1, 3 * Math.max(1, rttMs));
}

/** `2 × rtt_min` of probes must precede a promotion (§§7.8). */
export function probeWindowMs(rttMs: number): number {
  return Math.max(1, 2 * Math.max(1, rttMs));
}

export const PATH_PROMOTION_RATIO = 1.2;
export const PATH_DEMOTION_RATIO = 0.8;
export const PATH_PROBE_REJECT_RATIO = 0.2;
export const PATH_PROBE_ACCEPT_RATIO = 0.5;
/** Demotions inside this window disable datagram switching for the session. */
export const PATH_OSCILLATION_WINDOW_MS = 10 * 60 * 1_000;
export const PATH_OSCILLATION_LIMIT = 3;
export const PATH_OSCILLATION_COOLDOWN_MS = 10 * 60 * 1_000;
/** Switching costs `1 × RTT` of the sender's airtime (§§7.8). */
export function pathSwitchCostMs(rttMs: number): number {
  return Math.max(1, Math.round(rttMs));
}

/**
 * A carrier the selector may choose.
 *
 * S1 registers exactly one: `ws`. W10 registers `dc-direct` / `dc-turn` in
 * addition; the selector already enforces the specification's admission rules
 * (`dc` needs a live channel, an ICE-connected peer and a passing probe
 * window), so the datagram half only implements this interface.
 */
export type MediaPathCandidate = {
  path: MediaPathName;
  /**
   * Whether the carrier is usable *right now*: connected transport, open
   * channel, ICE state — the specification's "ICE connected ∧ ≥ 1 media-channel
   * `open` event".
   */
  available(): boolean;
  /** The candidate's own goodput estimate in bits per second. */
  goodputBps(): number;
  /**
   * The delivered ratio of the candidate's most recent probe window
   * (`2 × rtt_min` of probes). `-1` when no window has completed.
   */
  probeDeliveredRatio(): number;
};

export type MediaPathChangeEvent = {
  fromPath: MediaPathName;
  toPath: MediaPathName;
  from: number;
  to: number;
  reason: string;
  atEpochMs: number;
};

export type MediaPathSelectorOptions = {
  /** `the corresponding deployment setting` from the bootstrap: `auto` or `off`. */
  selection?: "auto" | "off";
  /** The receiver's smoothed RTT; the selector re-reads it through `rtt()`. */
  rtt?: () => number;
  /** Session-relative or local epoch ms; the caller owns the clock. */
  now?: () => number;
  onSwitch?: (change: MediaPathChangeEvent) => void;
};

type WindowSample = {
  atMs: number;
  ratio: number;
};

const WS_PATH: MediaPathName = "WS";

/**
 * The path decision engine.
 *
 * Invariants it enforces for every caller:
 * - never switch while an anchor plan or an input pulse is in flight (§§7.8);
 * - never promote a candidate that has not passed a probe window;
 * - after `PATH_OSCILLATION_LIMIT` demotions inside 10 minutes, disable
 *   datagram switching for the session (`path_oscillation_total`).
 */
export class MediaPathSelector {
  private readonly candidates = new Map<MediaPathName, MediaPathCandidate>();
  private readonly promotionSince = new Map<MediaPathName, number>();
  private readonly demotionSince = new Map<MediaPathName, number>();
  private readonly demotions: number[] = [];
  private readonly selection: "auto" | "off";
  private readonly rtt: () => number;
  private readonly now: () => number;
  private readonly onSwitch: ((change: MediaPathChangeEvent) => void) | undefined;
  private active: MediaPathName = WS_PATH;
  private planActive = false;
  private inputPulseActive = false;
  private switches = 0;
  private oscillatingUntilMs = 0;

  constructor(options: MediaPathSelectorOptions = {}) {
    this.selection = options.selection ?? "auto";
    this.rtt = options.rtt ?? (() => 150);
    this.now = options.now ?? (() => Date.now());
    this.onSwitch = options.onSwitch;
  }

  /** The carrier currently in use. */
  get activePath(): MediaPathName {
    return this.active;
  }

  /** The wire value for `MediaFeedback.active_path` / `MediaResume`. */
  get activePathValue(): number {
    return MediaPathKind[this.active];
  }

  /** How many carrier switches this session has made. */
  get pathSwitches(): number {
    return this.switches;
  }

  /** When the oscillation cooldown ends (`0` = not disabled). */
  get pathSwitchingDisabledUntilMs(): number {
    return this.oscillatingUntilMs;
  }

  get pathSelectionEnabled(): boolean {
    return this.selection === "auto";
  }

  register(candidate: MediaPathCandidate): void {
    this.candidates.set(candidate.path, candidate);
  }

  unregister(path: MediaPathName): void {
    this.candidates.delete(path);
  }

  /** The WS candidate the S1 receiver always has. */
  registerWebSocket(goodputBps: () => number): void {
    this.candidates.set(WS_PATH, {
      path: WS_PATH,
      available: () => true,
      goodputBps,
      probeDeliveredRatio: () => -1,
    });
  }

  /** A plan is in flight: no carrier may change under it. */
  notePlanActive(active: boolean): void {
    this.planActive = active;
  }

  /** An input pulse is in flight: no carrier may change under it. */
  noteInputPulse(active: boolean): void {
    this.inputPulseActive = active;
  }

  /** A datagram channel closed: demote immediately if it was active. */
  noteChannelClosed(path: MediaPathName): void {
    const candidate = this.candidates.get(path);
    if (candidate) {
      this.candidates.delete(path);
    }
    if (this.active === path) {
      this.switchTo(WS_PATH, "channel_closed");
    }
  }

  /** Note the outcome of one probe window, as reported by the carrier. */
  noteProbeWindow(path: MediaPathName, deliveredRatio: number): void {
    this.probeWindows.set(path, { atMs: this.now(), ratio: deliveredRatio });
    if (path !== WS_PATH && deliveredRatio < PATH_PROBE_REJECT_RATIO && this.active === path) {
      this.switchTo(WS_PATH, "probe_rejected");
    }
  }

  private readonly probeWindows = new Map<MediaPathName, WindowSample>();

  /**
   * Evaluate the hysteresis. Returns the change when a switch happened.
   *
   * Called on the receiver's tick (the feedback cadence); a no-op while a plan
   * or an input pulse is live, while path selection is off, or while the
   * oscillation cooldown holds.
   */
  tick(): MediaPathChangeEvent | null {
    if (!this.pathSelectionEnabled || this.planActive || this.inputPulseActive) {
      return null;
    }

    const nowMs = this.now();
    if (nowMs < this.oscillatingUntilMs) {
      return null;
    }

    const ws = this.candidates.get(WS_PATH);
    if (!ws) {
      return null;
    }

    if (this.active !== WS_PATH) {
      const current = this.candidates.get(this.active);
      const demoteReason = current ? this.demoteReason(current, ws, nowMs) : "candidate_gone";
      if (demoteReason) {
        return this.switchTo(WS_PATH, demoteReason);
      }
      return null;
    }

    // `promotionCandidate` owns the per-candidate "sustained since" stamps: a
    // candidate that fails a condition has its stamp cleared there, and one
    // that is still merely early keeps its stamp so the window can elapse.
    const promoted = this.promotionCandidate(nowMs);
    if (!promoted) {
      return null;
    }

    return this.switchTo(promoted.path, "goodput_promotion");
  }

  private demoteReason(
    current: MediaPathCandidate,
    ws: MediaPathCandidate,
    nowMs: number,
  ): string | null {
    if (!current.available() || !current.path.startsWith("DC")) {
      return "candidate_gone";
    }

    const ratio = current.probeDeliveredRatio();
    if (ratio >= 0 && ratio < PATH_PROBE_REJECT_RATIO) {
      return "probe_rejected";
    }

    const wsGoodput = ws.goodputBps();
    const demotionBound = PATH_DEMOTION_RATIO * wsGoodput;
    if (wsGoodput > 0 && current.goodputBps() < demotionBound) {
      const since = this.demotionSince.get(current.path);
      if (since === undefined) {
        this.demotionSince.set(current.path, nowMs);
        this.promotionSince.delete(current.path);
        return null;
      }
      if (nowMs - since >= sustainedWindowMs(this.rtt())) {
        this.demotionSince.delete(current.path);
        return "goodput_demotion";
      }
      return null;
    }

    this.demotionSince.delete(current.path);
    return null;
  }

  private promotionCandidate(nowMs: number): MediaPathCandidate | null {
    const ws = this.candidates.get(WS_PATH);
    if (!ws) {
      return null;
    }

    const wsGoodput = ws.goodputBps();
    const required = PATH_PROMOTION_RATIO * wsGoodput;

    for (const candidate of this.candidates.values()) {
      if (candidate.path === WS_PATH || !candidate.path.startsWith("DC")) {
        continue;
      }
      if (!candidate.available()) {
        this.promotionSince.delete(candidate.path);
        continue;
      }

      const ratio = candidate.probeDeliveredRatio();
      if (ratio >= 0 && ratio < PATH_PROBE_ACCEPT_RATIO) {
        // The design's admission rule: a window below 0.5 delivered never
        // promotes, however good the estimate looks.
        this.promotionSince.delete(candidate.path);
        continue;
      }

      const current = this.probeWindows.get(candidate.path);
      if (!current) {
        // No probe window has completed: the specification's admission rule refuses
        // the candidate until `2 × rtt_min` of probes have delivered.
        this.promotionSince.delete(candidate.path);
        continue;
      }

      if (candidate.goodputBps() < required) {
        this.promotionSince.delete(candidate.path);
        continue;
      }

      const since = this.promotionSince.get(candidate.path);
      if (since === undefined) {
        this.promotionSince.set(candidate.path, nowMs);
        continue;
      }
      if (nowMs - since >= sustainedWindowMs(this.rtt())) {
        return candidate;
      }
    }

    return null;
  }

  private switchTo(path: MediaPathName, reason: string): MediaPathChangeEvent | null {
    if (path === this.active) {
      return null;
    }

    const from = this.active;
    const nowMs = this.now();
    this.active = path;
    this.switches += 1;
    this.promotionSince.clear();
    this.demotionSince.clear();

    if (path === WS_PATH && from !== WS_PATH) {
      this.demotions.push(nowMs);
      while (this.demotions.length > 0 && nowMs - this.demotions[0] > PATH_OSCILLATION_WINDOW_MS) {
        this.demotions.shift();
      }
      if (this.demotions.length >= PATH_OSCILLATION_LIMIT) {
        this.oscillatingUntilMs = nowMs + PATH_OSCILLATION_COOLDOWN_MS;
        this.demotions.length = 0;
      }
    }

    const change: MediaPathChangeEvent = {
      fromPath: from,
      toPath: path,
      from: MediaPathKind[from],
      to: MediaPathKind[path],
      reason,
      atEpochMs: nowMs,
    };
    this.onSwitch?.(change);
    return change;
  }
}
