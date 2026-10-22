/**
 * MLP v1 — the protocol's shared constants and the RTT-relative timeouts.
 *
 * Every number here mirrors the frozen policy in `mlp-core` (the Rust
 * reference implementation). The Rust machines are the source of truth; a
 * browser cannot import them, so the mirror is explicit and the conformance
 * suite compares shapes rather than values.
 *
 * This module holds the *protocol's* constants only. A deployment's own
 * settings — its bootstrap fields, its environment, its product identity —
 * belong to the application that embeds the protocol, not to the protocol.
 */

/** The MLP protocol version carried by every fragment. */
export const MEDIA_PROTOCOL_VERSION = 1;

/**
 * The WebSocket subprotocol a media lane requests.
 *
 * The value is the protocol's identity on that socket. A peer that does not
 * recognise it must refuse the lane with a typed reason rather than fall
 * back to an older grammar.
 */
export const MEDIA_LANE_SUBPROTOCOL = "mlp-v1";

/** Path suffix appended to the control channel URL for the media lane. */
export const MEDIA_LANE_PATH_SEGMENT = "media";

/** Payload cap for one MLP fragment on the stream carrier (spec §5.1). */
export const MAX_WS_FRAGMENT = 65_536;

/** Payload cap for one MLP fragment on the datagram carrier (spec §5.1). */
export const TARGET_FRAGMENT_PAYLOAD = 1_150;

/** The media lane's close codes (spec §6.3), plus the protocol-close codes. */
export const MEDIA_CLOSE_CODES = {
  normal: 1000,
  internal: 1011,
  badFraming: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  noSession: 4404,
  sessionConflict: 4409,
  parkTtlExpired: 4410,
  oversize: 4413,
  unsupportedMediaVersion: 4415,
} as const;

export type MediaCloseCodeName = keyof typeof MEDIA_CLOSE_CODES;

/**
 * Browser-side close codes. `WebSocket.close()` only accepts 1000 or
 * 3000..4999, so an intentional local close uses the application range.
 */
export const RECEIVER_CLOSE_CODES = {
  normal: 1000,
  teardown: 4000,
  operatorAbort: 4001,
} as const;

/** `MediaError.code` (spec §6.3). */
export const MediaLaneErrorCode = {
  BAD_MAGIC: 1,
  UNSUPPORTED_VERSION: 2,
  BAD_CLASS: 3,
  BAD_FLAGS: 4,
  BAD_PRIORITY: 5,
  BAD_FRAGMENT: 6,
  BAD_LENGTH: 7,
  BAD_EXT: 8,
  META_MISMATCH: 9,
  ASSEMBLY_TIMEOUT: 10,
  ASSEMBLY_EVICTED: 11,
  OBJECT_ID_WRAP: 12,
  BODY_INVALID: 13,
  RATE_LIMITED: 14,
  LANE_DISABLED: 15,
} as const;

export type MediaLaneErrorCodeName = keyof typeof MediaLaneErrorCode;

/** The sender's authoritative lane state (`MediaLaneState.state`, spec §6.3). */
export const MediaLaneStateKind = {
  STARTING: 0,
  LIVE: 1,
  DEGRADED: 2,
  CONVERGING: 3,
  STALE: 4,
  PARKED: 5,
  DISABLED: 6,
  DECODE_BOUND: 7,
  NO_FEEDBACK: 8,
  MEDIA_UNSUPPORTED: 9,
} as const;

export type MediaLaneStateName = keyof typeof MediaLaneStateKind;

/** `active_path` / `MediaPathChange` values (spec §6.3, §7.8). */
export const MediaPathKind = {
  UNKNOWN: 0,
  WS: 1,
  DC_DIRECT: 2,
  DC_TURN: 3,
  QUIC: 4,
} as const;

export type MediaPathName = keyof typeof MediaPathKind;

/** `MediaInputEnvelope.kind` (spec §9.1). */
export const InputKind = {
  POINTER_MOVE: 0,
  POINTER_BUTTON: 1,
  KEY: 2,
  WHEEL: 3,
  CLIPBOARD: 4,
  RELEASE_ALL: 5,
  PRESSED_SET: 6,
} as const;

export type InputKindName = keyof typeof InputKind;

/** `MediaInputEnvelope.flags` bits (spec §9.1). */
export const InputFlags = {
  NONE: 0x00,
  RELEASE: 0x01,
  REPEAT: 0x02,
  CRITICAL: 0x04,
} as const;

/** `MediaResumeAck.reason` values a receiver acts on (spec §6.3, §§9.3). */
export const ResumeRejectReason = {
  OK: "ok",
  UNKNOWN_SESSION: "unknown_session",
  TOKEN_EXPIRED: "token_expired",
  TOKEN_INVALID: "token_invalid",
  PEER_MISMATCH: "peer_mismatch",
  EPOCH_STALE: "epoch_stale",
  EPOCH_MISMATCH: "epoch_mismatch",
  PARK_EVICTED: "park_evicted",
} as const;

/** `MediaHelloAck.media_unsupported_reason` (spec §6.3). */
export const MediaUnsupportedReason = {
  PROTOCOL: "protocol",
  DISABLED_BY_POLICY: "disabled_by_policy",
  NO_SENDER_CAPABILITY: "no_sender_capability",
} as const;

/**
 * `MediaHelloAck.lane_mode` values; `single` means the media lane shares the
 * control connection (spec §4.2 rule 6).
 */
export const MediaLaneMode = {
  DUAL: "dual",
  SINGLE: "single",
} as const;

/** The capabilities a receiver declares in `MediaHello.capabilities`. */
export const MEDIA_RECEIVER_CAPABILITIES = [
  "anchor",
  "patch",
  "dc",
  "cursor",
  "dupe",
] as const;

/** The default input deadline, when the deployment does not set one. */
export const DEFAULT_MEDIA_INPUT_DEADLINE_MS = 5_000;

/** The default resume TTL, when the deployment does not set one. */
export const DEFAULT_MEDIA_RESUME_TTL_SECONDS = 900;

/**
 * An application identifier for `MediaFeedback.app_version`.
 *
 * Diagnostics only; the protocol never parses it.
 */
export const MEDIA_APP_VERSION = "mlp-receiver-v1";

// ── RTT-relative timeouts (spec §10) ───────────────────────────────────────
//
// `RTT` is the receiver's smoothed round-trip time in milliseconds; every
// helper clamps so a broken estimator can neither hang nor spin.

/** The value an unknown RTT falls back to before the first measurement. */
export const DEFAULT_RTT_MS = 150;

export function clampNumber(value: number, floor: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(floor, value));
}

/** `clamp(2 × RTT + 2 s, 4 s, 45 s)` — the control handshake / command ack. */
export function handshakeTimeoutMs(rttMs: number): number {
  return clampNumber(2 * rttMs + 2_000, 4_000, 45_000);
}

/** `clamp(5 × RTT, 5 s, 60 s)` — the first-event wait after connecting. */
export function firstEventTimeoutMs(rttMs: number): number {
  return clampNumber(5 * rttMs, 5_000, 60_000);
}

/** `clamp(2 × RTT + 1 s, 3 s, 30 s)` — the media lane's establishment. */
export function laneProbeTimeoutMs(rttMs: number): number {
  return clampNumber(2 * rttMs + 1_000, 3_000, 30_000);
}

/** `clamp(2 × RTT + 500 ms, 1 s, 10 s)` — the waiting-update timeout. */
export function waitingUpdateTimeoutMs(rttMs: number): number {
  return clampNumber(2 * rttMs + 500, 1_000, 10_000);
}

/** `clamp(RTT / 8, 16 ms, 100 ms)` — the pointer-move dispatch cadence. */
export function mouseMoveDispatchIntervalMs(rttMs: number): number {
  return clampNumber(rttMs / 8, 16, 100);
}

/** `clamp(10 s, 3 × RTT, 60 s)` — the media lane's ping cadence. */
export function wsPingIntervalMs(rttMs: number): number {
  return clampNumber(3 * rttMs, 10_000, 60_000);
}

/** `clamp(4 × RTT, 250 ms, 2 s)` — the feedback report cadence. */
export function reportIntervalMs(rttMs: number): number {
  return clampNumber(4 * rttMs, 250, 2_000);
}

/**
 * `clamp(RTT / 4, 25 ms, 250 ms)` — the shortest wait between two prompt
 * reports (MLP spec §6.2.1).
 *
 * The report cadence is the **idle** cadence; a report goes out at once when
 * it carries an input echo or a loss attribution, and this is the rate that
 * bounds how often such a report may go out.
 */
export function promptIntervalMs(rttMs: number): number {
  return clampNumber(rttMs / 4, 25, 250);
}

/** `clamp(2 × RTT, 5 s, 30 s)` — the pressed-set heartbeat. */
export function inputPressedHeartbeatMs(rttMs: number): number {
  return clampNumber(2 * rttMs, 5_000, 30_000);
}

/** `3 × RTT + 500 ms` — the MLP object assembly timeout. */
export function assemblyTimeoutMs(rttMs: number): number {
  return 3 * clampNumber(rttMs, 1, 60_000) + 500;
}

/**
 * `0.05` — the attributed loss ratio above which a lane is `DEGRADED`
 * (MLP spec §6.7.1, §6.2.4).
 *
 * The ratio is measured by the receiver, in the update-id space, over its own
 * report window; the sender reads the same ratio from the feedback and
 * reports the same state. One threshold, one measurement, and the receiver
 * is the end that takes it.
 */
export const LOSS_DEGRADED = 0.05;

/**
 * `0.25` — the share of the grid a receiver must hold as stale for the lane
 * to read `CONVERGING` (MLP spec §6.7.1).
 *
 * Below it the holes are repaired inside a repair round, and a lane whose
 * whole fault is a cell or two is not a picture that is still arriving: it is
 * `LIVE` or `DEGRADED` by the other two facts. The same share the sender
 * reads from the acknowledgement's pending set, so the two ends name one
 * state.
 */
export const CONVERGING_PENDING = 0.25;

/** `now_ms + deadline` with the bootstrap deadline; `0` means "never". */
export function inputDeadlineMs(deadlineMs: number): number {
  return deadlineMs > 0 ? Math.trunc(deadlineMs) : 0;
}
