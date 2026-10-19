/**
 * Media-lane resume and the RTT-relative reconnect ladder (MLP spec §8.1–§7.4).
 *
 * Three pieces live here, all pure enough to unit-test without a socket:
 *
 * - {@link MediaResumeStore} — the resume token (opaque to the browser, §§8.1)
 *   plus the receiver state the `MediaResume` body carries (§§6.3). It survives
 *   the socket; the component is never recreated (§7.6).
 * - {@link ReconnectLadder} — the mirror of `rm_sans_io::media::resume`: no
 *   give-up, `delay_n = clamp(max(500 ms, RTT) × 2^(n-1), 500 ms, 30 s) + jitter`,
 *   control retries for attempts 1–2, a bootstrap refresh from attempt 3, and
 *   the `Suspended` cadence from attempt 6.
 * - {@link ParkLedger} — the terminal conditions of §7.4 that are *counted*
 *   rather than coded in a close update (`park_ttl_expired` twice in a row).
 */

import {
  DEFAULT_MEDIA_RESUME_TTL_SECONDS,
  ResumeRejectReason,
} from "./protocol-constants";

/** Where an attempt sits in the ladder (MLP spec §8.4). */
export const ReconnectStage = {
  CONTROL_RETRY: "control_retry",
  BOOTSTRAP: "bootstrap",
  SUSPENDED: "suspended",
} as const;

export type ReconnectStageName = (typeof ReconnectStage)[keyof typeof ReconnectStage];

export const RECONNECT_FLOOR_MS = 500;
export const RECONNECT_CAP_MS = 30_000;
export const RECONNECT_JITTER_MS = 250;
/** Attempts that also re-run `POST /api/session/bootstrap`. */
export const BOOTSTRAP_AFTER_ATTEMPTS = 3;
/** Attempts after which the UI enters `Suspended`. */
export const SUSPENDED_AFTER_ATTEMPTS = 6;

/**
 * Why the receiver stops retrying entirely (§§8.4). Every one of these is a
 * decision of the platform, not of the link, and none of them is "the link
 * stayed down".
 */
export type TerminalReason =
  | "unauthorized"
  | "forbidden"
  | "sender_retired"
  | "operator_disconnect"
  | "unsupported_media_version"
  | "park_expired"
  | "explicit_operator_action"
  | "protocol_mismatch";

export function isTerminalReason(value: string): value is TerminalReason {
  switch (value) {
    case "unauthorized":
    case "forbidden":
    case "sender_retired":
    case "operator_disconnect":
    case "unsupported_media_version":
    case "park_expired":
    case "explicit_operator_action":
    case "protocol_mismatch":
      return true;
    default:
      return false;
  }
}

/**
 * The ladder's state for one reconnect cycle.
 *
 * `rttMs` is the receiver's smoothed RTT; `jitterSampleMs` is injected by the
 * driver (`Math.random() * 250` in the browser, a fixed value in tests) so the
 * ladder itself stays deterministic.
 */
export class ReconnectLadder {
  private baseMs: number;
  private attempt = 0;

  constructor(rttMs: number) {
    this.baseMs = Math.max(RECONNECT_FLOOR_MS, Math.round(rttMs));
  }

  /** The base delay (`max(500 ms, 1 × RTT)`). */
  get baseDelayMs(): number {
    return this.baseMs;
  }

  /** How many attempts the ladder has issued in this cycle. */
  get attempts(): number {
    return this.attempt;
  }

  /** The delay before the next attempt, advancing the ladder. */
  nextDelayMs(jitterSampleMs = 0): number {
    const delay = this.delayFor(this.attempt, jitterSampleMs);
    this.attempt += 1;
    return delay;
  }

  /** The stage the next attempt belongs to. */
  nextStage(): ReconnectStageName {
    return this.stageFor(this.attempt);
  }

  /** Start a fresh cycle (a successful attach, or a user-initiated retry). */
  reset(rttMs?: number): void {
    this.attempt = 0;
    if (typeof rttMs === "number") {
      this.baseMs = Math.max(RECONNECT_FLOOR_MS, Math.round(rttMs));
    }
  }

  /** The delay for one attempt, without advancing the ladder. */
  delayFor(attempt: number, jitterSampleMs = 0): number {
    if (attempt <= 0) {
      return 0;
    }
    const exponent = Math.min(attempt - 1, 16);
    const scaled = this.baseMs * 2 ** exponent;
    const delay = Math.min(RECONNECT_CAP_MS, Math.max(RECONNECT_FLOOR_MS, scaled));
    return delay + Math.min(RECONNECT_JITTER_MS, Math.max(0, jitterSampleMs));
  }

  /** The stage one attempt belongs to. */
  stageFor(attempt: number): ReconnectStageName {
    if (attempt >= SUSPENDED_AFTER_ATTEMPTS) {
      return ReconnectStage.SUSPENDED;
    }
    if (attempt >= BOOTSTRAP_AFTER_ATTEMPTS) {
      return ReconnectStage.BOOTSTRAP;
    }
    return ReconnectStage.CONTROL_RETRY;
  }

  /** Whether an attempt of this stage also re-resolves the edge route. */
  stageNeedsBootstrap(attempt: number): boolean {
    return this.stageFor(attempt) !== ReconnectStage.CONTROL_RETRY;
  }
}

/** What the receiver held when the lane died (`MediaResume`, §§6.3). */
export type MediaResumeSnapshot = {
  appliedUpdateId: number;
  chainEpoch: number;
  ackBitmap: number;
  inputSeqNext: number;
  pressedKeys: number[];
  pressedButtons: number[];
  activePath: number;
};

export function emptyResumeSnapshot(): MediaResumeSnapshot {
  return {
    appliedUpdateId: 0,
    chainEpoch: 0,
    ackBitmap: 0,
    inputSeqNext: 1,
    pressedKeys: [],
    pressedButtons: [],
    activePath: 0,
  };
}

/** The stored record: the opaque token plus when it stops being usable. */
export type StoredResume = {
  token: string;
  sessionId: string;
  mediaSessionId: string;
  /** Epoch ms after which the token is known to be expired. */
  expiresAtMs: number;
};

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const RESUME_STORAGE_PREFIX = "rm.media.resume.v1";

/**
 * The resume token store.
 *
 * The token is opaque (§§8.1) and is only ever echoed back: the receiver never
 * parses it, never logs it, and never lets it outlive its TTL. It lives in
 * `sessionStorage` so a reload inside the same tab can resume while a second
 * tab cannot steal the session; when the storage is unavailable (a privacy
 * mode, a unit test) the store degrades to memory, exactly as §7.2's receiver
 * row says ("in-memory; survives the socket").
 */
export class MediaResumeStore {
  private readonly storage: StorageLike | null;
  private readonly key: string;
  private memory: StoredResume | null = null;

  constructor(scope: string, storage: StorageLike | null = defaultStorage()) {
    this.key = `${RESUME_STORAGE_PREFIX}:${scope}`;
    this.storage = storage;
    this.memory = this.readFromStorage();
  }

  /** The live record, or `null` when absent, unreadable or expired. */
  get(nowMs = Date.now()): StoredResume | null {
    const record = this.memory ?? this.readFromStorage();
    if (!record) {
      return null;
    }
    if (record.expiresAtMs > 0 && nowMs >= record.expiresAtMs) {
      this.clear();
      return null;
    }
    return record;
  }

  /** Remember a freshly minted or re-issued token. */
  put(
    record: { token: string; sessionId: string; mediaSessionId: string },
    ttlSeconds = DEFAULT_MEDIA_RESUME_TTL_SECONDS,
    nowMs = Date.now(),
  ): void {
    const token = record.token.trim();
    if (!token) {
      return;
    }
    const stored: StoredResume = {
      token,
      sessionId: record.sessionId,
      mediaSessionId: record.mediaSessionId,
      expiresAtMs: ttlSeconds > 0 ? nowMs + ttlSeconds * 1_000 : 0,
    };
    this.memory = stored;
    try {
      this.storage?.setItem(this.key, JSON.stringify(stored));
    } catch {
      // A storage that refuses writes (quota, privacy mode) leaves the
      // in-memory record authoritative.
    }
  }

  clear(): void {
    this.memory = null;
    try {
      this.storage?.removeItem(this.key);
    } catch {
      // Ignore removal failures: the memory copy is already gone.
    }
  }

  private readFromStorage(): StoredResume | null {
    if (!this.storage) {
      return this.memory;
    }
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) {
        return this.memory;
      }
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        return null;
      }
      const record = parsed as Partial<StoredResume>;
      if (typeof record.token !== "string" || record.token.length === 0) {
        return null;
      }
      return {
        token: record.token,
        sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
        mediaSessionId: typeof record.mediaSessionId === "string" ? record.mediaSessionId : "",
        expiresAtMs: typeof record.expiresAtMs === "number" ? record.expiresAtMs : 0,
      };
    } catch {
      return null;
    }
  }
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) {
      return null;
    }
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The counted terminal conditions of §7.4.
 *
 * A rejected resume is normal (`token_expired` after a long park, `park_evicted`
 * after the park window): the receiver starts a fresh media session and keeps the
 * session alive. Two *consecutive* `park_ttl_expired` rejections are the one
 * counted terminal condition, because they mean the platform is not holding the
 * session at all.
 */
export class ParkLedger {
  private consecutiveParkExpired = 0;
  private terminal: TerminalReason | null = null;

  /** Note one `MediaResumeAck` rejection; returns the terminal reason, if any. */
  noteReject(reason: string): TerminalReason | null {
    if (reason === ResumeRejectReason.TOKEN_EXPIRED || reason === "park_ttl_expired") {
      this.consecutiveParkExpired += 1;
      if (this.consecutiveParkExpired >= 2) {
        this.terminal = "park_expired";
      }
    } else {
      this.consecutiveParkExpired = 0;
    }
    return this.terminal;
  }

  /** Note an accepted resume: the counter resets. */
  noteAccepted(): void {
    this.consecutiveParkExpired = 0;
  }

  noteTerminal(reason: TerminalReason): void {
    this.terminal = reason;
  }

  get terminalReason(): TerminalReason | null {
    return this.terminal;
  }

  get needsFreshMediaSession(): boolean {
    return this.consecutiveParkExpired > 0 && this.terminal === null;
  }
}

/** The receiver-side meaning of a media close code (§§6.3). */
export type MediaCloseDisposition =
  | { kind: "park" }
  | { kind: "reconnect" }
  | { kind: "terminal"; reason: TerminalReason };

/**
 * Classify a received `MediaClose` plus the WebSocket close code.
 *
 * A close with `park=true` (sent as a `MediaClose` before the socket closes)
 * means "come back" and must never read as failure (§§6.3).
 */
export function classifyMediaClose(
  closeCode: number,
  mediaClosePark: boolean,
): MediaCloseDisposition {
  if (mediaClosePark) {
    return { kind: "park" };
  }

  switch (closeCode) {
    case 1000:
      return { kind: "park" };
    case 4401:
      return { kind: "terminal", reason: "unauthorized" };
    case 4403:
      return { kind: "terminal", reason: "forbidden" };
    case 4410:
      return { kind: "terminal", reason: "park_expired" };
    case 4415:
      return { kind: "terminal", reason: "unsupported_media_version" };
    default:
      return { kind: "reconnect" };
  }
}
