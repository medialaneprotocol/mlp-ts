/**
 * MLP v1 — the media-lane fragment codec and object assembler (MLP spec §5).
 *
 * This module is the receiver's mirror of `mlp_core::media::pdu` and
 * `::object` (W1). It is byte-for-byte compatible: little-endian throughout,
 * the same validation order, the same reject vocabulary, and the same
 * carrier rules (1..N fragments on a stream carrier, exactly one on a
 * datagram carrier).
 *
 * Two rules from the specification are load-bearing here and are enforced as types
 * rather than conventions:
 *
 * - A malformed fragment is a *typed* reject that never touches the canvas:
 *   {@link decodeMediaMessage} returns a verdict, and a rejected fragment can
 *   never reach {@link MediaObjectAssembler}.
 * - A body is classified by its class, so a MEDIA-class payload is handed to
 *   the codec decoder only after the objection layer says it is complete.
 */

import {
  MEDIA_PROTOCOL_VERSION,
  MediaLaneErrorCode,
  TARGET_FRAGMENT_PAYLOAD,
  MAX_WS_FRAGMENT,
} from "./protocol-constants";

/** `magic` — `52 4D 4C 50` ("RMLP", MLP spec §5.2). */
export const MEDIA_FRAGMENT_MAGIC = [0x52, 0x4d, 0x4c, 0x50] as const;

/**
 * The one fragment version this receiver speaks. It is the MLP protocol version
 * itself (`mlp_core::media::pdu::MEDIA_PROTOCOL_VERSION`), so the header byte
 * and the handshake's `media_protocol_version` cannot drift apart.
 */
export const MEDIA_FRAGMENT_VERSION = MEDIA_PROTOCOL_VERSION;

/** Fixed header bytes before the extension (`FRAGMENT_FIXED_HEADER`). */
export const FRAGMENT_FIXED_HEADER = 22;

/** `MAX_FRAGMENT_COUNT` (MLP spec §5.2). */
export const MAX_FRAGMENT_COUNT = 4_096;

/** `MAX_HEADER_EXT` (MLP spec §5.2). */
export const MAX_HEADER_EXT = 256;

/** `MAX_OPEN_OBJECTS` (MLP spec §5.4). */
export const MAX_OPEN_OBJECTS = 4;

/** `MAX_ASSEMBLY_BYTES` (MLP spec §5.4). */
export const MAX_ASSEMBLY_BYTES = 1024 * 1024;

/** The `(object_id, fragment_index)` dedupe window depth (`DEDUP_WINDOW`). */
export const DEDUP_WINDOW = 4_096;

/** The fragment classes (`class`, MLP spec §5.2). */
export const MediaFragmentClass = {
  CONTROL: 0,
  CURSOR: 1,
  MEDIA: 2,
  FEEDBACK: 3,
  PATH: 4,
} as const;

export type MediaFragmentClassValue = (typeof MediaFragmentClass)[keyof typeof MediaFragmentClass];

/** Fragment flags, bits 0..6 (`flags`, MLP spec §5.2). */
export const MediaFragmentFlags = {
  NONE: 0x00,
  FIN: 0x01,
  ANCHOR: 0x02,
  RETRANSMIT: 0x04,
  DUP: 0x08,
  ECHO_REQUESTED: 0x10,
  PROBE: 0x20,
  URGENT: 0x40,
  RESERVED: 0x80,
} as const;

/** Priorities reserved for control/cursor/feedback (`§5.2`). */
export const MEDIA_RESERVED_PRIORITIES = [0, 1] as const;

/** The header-extension TLV registry (`§5.3`). */
export const MediaTlv = {
  UPDATE_ID: 0x01,
  UPDATE_BASE: 0x02,
  PART: 0x03,
  UPDATE_BYTES: 0x04,
  CHAIN_EPOCH: 0x05,
  REFLECTS_INPUT_SEQ: 0x06,
  SEND_EPOCH_MS: 0x07,
  DEADLINE_EPOCH_MS: 0x08,
  ECHO_OF_OBJECT_ID: 0x09,
  BUDGET_BYTES: 0x0a,
  PACE_BPS: 0x0b,
  PATH_HINT: 0x0c,
  INPUT_SEQ: 0x0d,
  CELL_COUNT: 0x0e,
  COST_MS: 0x0f,
} as const;

/** Carrier kind: the message boundary differs, the bytes do not (`§5.1`). */
export type MediaCarrier = "stream" | "datagram";

export function carrierFragmentPayloadMax(carrier: MediaCarrier): number {
  return carrier === "datagram" ? TARGET_FRAGMENT_PAYLOAD : MAX_WS_FRAGMENT;
}

/**
 * Every way a fragment or an object can be rejected (`MediaError.code`).
 * The names are the wire vocabulary; the codes are what the lane reports.
 */
export type MediaRejectReason =
  | "BAD_MAGIC"
  | "UNSUPPORTED_VERSION"
  | "BAD_CLASS"
  | "BAD_FLAGS"
  | "BAD_PRIORITY"
  | "BAD_FRAGMENT"
  | "BAD_LENGTH"
  | "BAD_EXT"
  | "MULTI_FRAGMENT_ON_DATAGRAM"
  | "META_MISMATCH"
  | "FRAGMENT_MISMATCH"
  | "ASSEMBLY_TIMEOUT"
  | "ASSEMBLY_EVICTED"
  | "OBJECT_ID_WRAP"
  | "BODY_INVALID"
  | "ACK_BAD_BITMAP"
  | "ACK_BAD_COUNT";

export function mediaRejectCode(reason: MediaRejectReason): number {
  switch (reason) {
    case "BAD_MAGIC":
      return MediaLaneErrorCode.BAD_MAGIC;
    case "UNSUPPORTED_VERSION":
      return MediaLaneErrorCode.UNSUPPORTED_VERSION;
    case "BAD_CLASS":
    case "MULTI_FRAGMENT_ON_DATAGRAM":
      return MediaLaneErrorCode.BAD_CLASS;
    case "BAD_FLAGS":
      return MediaLaneErrorCode.BAD_FLAGS;
    case "BAD_PRIORITY":
      return MediaLaneErrorCode.BAD_PRIORITY;
    case "BAD_FRAGMENT":
    case "FRAGMENT_MISMATCH":
    case "ACK_BAD_BITMAP":
    case "ACK_BAD_COUNT":
      return MediaLaneErrorCode.BAD_FRAGMENT;
    case "BAD_LENGTH":
      return MediaLaneErrorCode.BAD_LENGTH;
    case "BAD_EXT":
      return MediaLaneErrorCode.BAD_EXT;
    case "META_MISMATCH":
      return MediaLaneErrorCode.META_MISMATCH;
    case "ASSEMBLY_TIMEOUT":
      return MediaLaneErrorCode.ASSEMBLY_TIMEOUT;
    case "ASSEMBLY_EVICTED":
      return MediaLaneErrorCode.ASSEMBLY_EVICTED;
    case "OBJECT_ID_WRAP":
      return MediaLaneErrorCode.OBJECT_ID_WRAP;
    case "BODY_INVALID":
      return MediaLaneErrorCode.BODY_INVALID;
    default:
      return MediaLaneErrorCode.BODY_INVALID;
  }
}

/** A parsed header-extension entry; unknown types are kept, never an error. */
export type MediaTlvEntry = {
  type: number;
  value: Uint8Array;
};

/** A fully parsed fragment. */
export type MediaFragment = {
  classValue: number;
  flags: number;
  priority: number;
  objectId: number;
  fragmentIndex: number;
  fragmentCount: number;
  payload: Uint8Array;
  headerExt: MediaTlvEntry[];
  /** Payload length declared by the header; equal to `payload.byteLength`. */
  payloadLength: number;
  /** The whole fragment's wire size, for byte accounting. */
  wireBytes: number;
};

export type MediaFragmentVerdict =
  | { ok: true; fragment: MediaFragment }
  | { ok: false; reason: MediaRejectReason };

export type MediaMessageVerdict =
  | { ok: true; fragments: MediaFragment[] }
  | { ok: false; reason: MediaRejectReason };

/** Whether a binary WebSocket message is an MLP fragment (single-lane mode). */
export function hasMediaFragmentMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === MEDIA_FRAGMENT_MAGIC[0] &&
    bytes[1] === MEDIA_FRAGMENT_MAGIC[1] &&
    bytes[2] === MEDIA_FRAGMENT_MAGIC[2] &&
    bytes[3] === MEDIA_FRAGMENT_MAGIC[3]
  );
}

function isMediaClass(classValue: number): boolean {
  return classValue === MediaFragmentClass.MEDIA;
}

function fragmentClassIsKnown(classValue: number): boolean {
  return classValue >= MediaFragmentClass.CONTROL && classValue <= MediaFragmentClass.PATH;
}

/**
 * Parse one fragment from the front of `bytes`.
 *
 * Returns the fragment and the number of bytes it consumed, or a typed
 * reject. The validation order is the specification's §5.2 order: identity, then
 * class/flags/priority, then ids and lengths, then the extension, then the
 * payload bound.
 */
export function decodeMediaFragmentFrom(
  bytes: Uint8Array,
  carrier: MediaCarrier,
): { ok: true; fragment: MediaFragment; consumed: number } | { ok: false; reason: MediaRejectReason } {
  if (bytes.length < FRAGMENT_FIXED_HEADER) {
    return { ok: false, reason: "BAD_LENGTH" };
  }

  if (!hasMediaFragmentMagic(bytes)) {
    return { ok: false, reason: "BAD_MAGIC" };
  }

  if (bytes[4] !== MEDIA_FRAGMENT_VERSION) {
    return { ok: false, reason: "UNSUPPORTED_VERSION" };
  }

  const classValue = bytes[5];
  if (!fragmentClassIsKnown(classValue)) {
    return { ok: false, reason: "BAD_CLASS" };
  }

  const flags = bytes[6];
  if ((flags & MediaFragmentFlags.RESERVED) !== 0) {
    return { ok: false, reason: "BAD_FLAGS" };
  }

  const priority = bytes[7];
  if (priority > 7) {
    return { ok: false, reason: "BAD_PRIORITY" };
  }

  if (isMediaClass(classValue) && (priority === 0 || priority === 1)) {
    return { ok: false, reason: "BAD_PRIORITY" };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const objectId = view.getUint32(8, true);
  const fragmentIndex = view.getUint16(12, true);
  const fragmentCount = view.getUint16(14, true);
  const payloadLength = view.getUint32(16, true);
  const headerExtLength = view.getUint16(20, true);

  if (fragmentCount === 0 || fragmentCount > MAX_FRAGMENT_COUNT || fragmentIndex >= fragmentCount) {
    return { ok: false, reason: "BAD_FRAGMENT" };
  }

  if (payloadLength > carrierFragmentPayloadMax(carrier)) {
    return { ok: false, reason: "BAD_LENGTH" };
  }

  if (headerExtLength !== 0 && (headerExtLength < 2 || headerExtLength > MAX_HEADER_EXT)) {
    return { ok: false, reason: "BAD_EXT" };
  }

  const extensionEnd = FRAGMENT_FIXED_HEADER + headerExtLength;
  const payloadEnd = extensionEnd + payloadLength;
  if (bytes.length < payloadEnd) {
    return { ok: false, reason: "BAD_LENGTH" };
  }

  const headerExt: MediaTlvEntry[] = [];
  let offset = FRAGMENT_FIXED_HEADER;
  while (offset < extensionEnd) {
    if (offset + 2 > extensionEnd) {
      return { ok: false, reason: "BAD_EXT" };
    }
    const type = bytes[offset];
    const length = bytes[offset + 1];
    offset += 2;
    if (offset + length > extensionEnd) {
      return { ok: false, reason: "BAD_EXT" };
    }
    headerExt.push({ type, value: bytes.slice(offset, offset + length) });
    offset += length;
  }

  return {
    ok: true,
    consumed: payloadEnd,
    fragment: {
      classValue,
      flags,
      priority,
      objectId,
      fragmentIndex,
      fragmentCount,
      payload: bytes.slice(extensionEnd, payloadEnd),
      headerExt,
      payloadLength,
      wireBytes: payloadEnd,
    },
  };
}

/** Parse exactly one fragment (the datagram rule, and the WS message rule). */
export function decodeMediaFragment(bytes: Uint8Array, carrier: MediaCarrier): MediaFragmentVerdict {
  const parsed = decodeMediaFragmentFrom(bytes, carrier);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  if (parsed.consumed !== bytes.length) {
    // Trailing bytes after a complete fragment: a re-cut object can never be
    // assembled, so this is a framing reject, not a warning.
    return { ok: false, reason: "BAD_LENGTH" };
  }
  return { ok: true, fragment: parsed.fragment };
}

/**
 * Parse a whole transport message.
 *
 * Stream carriers accept 1..N concatenated fragments; a datagram carrier
 * accepts exactly one and rejects a multi-fragment object with
 * `MULTI_FRAGMENT_ON_DATAGRAM` (§§5.4 step 3).
 */
export function decodeMediaMessage(bytes: Uint8Array, carrier: MediaCarrier): MediaMessageVerdict {
  const fragments: MediaFragment[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const parsed = decodeMediaFragmentFrom(bytes.subarray(offset), carrier);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason };
    }
    fragments.push(parsed.fragment);
    offset += parsed.consumed;
  }

  if (fragments.length === 0) {
    return { ok: false, reason: "BAD_LENGTH" };
  }

  if (carrier === "datagram") {
    if (fragments.length !== 1 || fragments[0].fragmentCount !== 1) {
      return { ok: false, reason: "MULTI_FRAGMENT_ON_DATAGRAM" };
    }
  }

  return { ok: true, fragments };
}

export type MediaFragmentInput = {
  classValue: number;
  flags?: number;
  priority?: number;
  objectId: number;
  fragmentIndex: number;
  fragmentCount: number;
  headerExt?: MediaTlvEntry[];
  payload: Uint8Array;
};

/**
 * Encode one fragment.
 *
 * Every field is validated the way the parser would validate it, so the
 * receiver can never emit a fragment a peer must reject; a violation throws
 * (an encoder invariant breach is a programming error, not a wire event).
 */
export function encodeMediaFragment(input: MediaFragmentInput): Uint8Array {
  if (!fragmentClassIsKnown(input.classValue)) {
    throw new Error(`MLP: unknown fragment class ${input.classValue}`);
  }

  const flags = input.flags ?? MediaFragmentFlags.NONE;
  if ((flags & MediaFragmentFlags.RESERVED) !== 0) {
    throw new Error("MLP: reserved flag bit set");
  }

  const priority = input.priority ?? defaultPriorityFor(input.classValue);
  if (priority > 7) {
    throw new Error(`MLP: invalid priority ${priority}`);
  }
  if (isMediaClass(input.classValue) && (priority === 0 || priority === 1)) {
    throw new Error("MLP: media fragments may not use the reserved priorities");
  }

  if (
    input.fragmentCount < 1 ||
    input.fragmentCount > MAX_FRAGMENT_COUNT ||
    input.fragmentIndex >= input.fragmentCount
  ) {
    throw new Error("MLP: fragment index/count out of range");
  }

  if (input.payload.byteLength > MAX_WS_FRAGMENT) {
    throw new Error("MLP: payload exceeds the fragment cap");
  }

  const extension = encodeHeaderExt(input.headerExt ?? []);
  if (extension.byteLength !== 0 && (extension.byteLength < 2 || extension.byteLength > MAX_HEADER_EXT)) {
    throw new Error("MLP: header extension length out of range");
  }

  const total = FRAGMENT_FIXED_HEADER + extension.byteLength + input.payload.byteLength;
  const out = new Uint8Array(total);
  out[0] = MEDIA_FRAGMENT_MAGIC[0];
  out[1] = MEDIA_FRAGMENT_MAGIC[1];
  out[2] = MEDIA_FRAGMENT_MAGIC[2];
  out[3] = MEDIA_FRAGMENT_MAGIC[3];
  out[4] = MEDIA_FRAGMENT_VERSION;
  out[5] = input.classValue;
  out[6] = flags;
  out[7] = priority;

  const view = new DataView(out.buffer);
  view.setUint32(8, input.objectId, true);
  view.setUint16(12, input.fragmentIndex, true);
  view.setUint16(14, input.fragmentCount, true);
  view.setUint32(16, input.payload.byteLength, true);
  view.setUint16(20, extension.byteLength, true);

  out.set(extension, FRAGMENT_FIXED_HEADER);
  out.set(input.payload, FRAGMENT_FIXED_HEADER + extension.byteLength);
  return out;
}

/** The class's default priority (`TrafficClass::default_priority`). */
export function defaultPriorityFor(classValue: number): number {
  switch (classValue) {
    case MediaFragmentClass.CONTROL:
      return 0;
    case MediaFragmentClass.CURSOR:
      return 5;
    case MediaFragmentClass.FEEDBACK:
      return 2;
    case MediaFragmentClass.PATH:
      return 2;
    default:
      return 6;
  }
}

function encodeHeaderExt(entries: MediaTlvEntry[]): Uint8Array {
  let size = 0;
  for (const entry of entries) {
    if (entry.value.byteLength > 255) {
      throw new Error("MLP: TLV value exceeds 255 bytes");
    }
    size += 2 + entry.value.byteLength;
  }

  const out = new Uint8Array(size);
  let offset = 0;
  for (const entry of entries) {
    out[offset] = entry.type;
    out[offset + 1] = entry.value.byteLength;
    out.set(entry.value, offset + 2);
    offset += 2 + entry.value.byteLength;
  }
  return out;
}

// ── TLV helpers (little-endian values, MLP spec §5.3) ─────────────────────────

export function tlvU8(type: number, value: number): MediaTlvEntry {
  return { type, value: new Uint8Array([value & 0xff]) };
}

export function tlvU16(type: number, value: number): MediaTlvEntry {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value & 0xffff, true);
  return { type, value: out };
}

export function tlvU16Pair(type: number, first: number, second: number): MediaTlvEntry {
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint16(0, first & 0xffff, true);
  view.setUint16(2, second & 0xffff, true);
  return { type, value: out };
}

export function tlvU32(type: number, value: number): MediaTlvEntry {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return { type, value: out };
}

export function tlvU64(type: number, value: number): MediaTlvEntry {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, value >>> 0, true);
  view.setUint32(4, Math.floor(value / 2 ** 32) >>> 0, true);
  return { type, value: out };
}

/** Anything carrying a parsed header extension (a fragment or an object). */
export type MediaTlvCarrier = { headerExt: MediaTlvEntry[] };

/** Read a TLV value; an unknown type returns `null` (never an error). */
export function readTlvValue(carrier: MediaTlvCarrier, type: number): Uint8Array | null {
  for (const entry of carrier.headerExt) {
    if (entry.type === type) {
      return entry.value;
    }
  }
  return null;
}

export function readTlvU8(carrier: MediaTlvCarrier, type: number): number | null {
  const value = readTlvValue(carrier, type);
  return value && value.byteLength === 1 ? value[0] : null;
}

export function readTlvU16(carrier: MediaTlvCarrier, type: number): number | null {
  const value = readTlvValue(carrier, type);
  if (!value || value.byteLength !== 2) {
    return null;
  }
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint16(0, true);
}

export function readTlvU32(carrier: MediaTlvCarrier, type: number): number | null {
  const value = readTlvValue(carrier, type);
  if (!value || value.byteLength !== 4) {
    return null;
  }
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0, true);
}

export function readTlvU64(carrier: MediaTlvCarrier, type: number): number | null {
  const value = readTlvValue(carrier, type);
  if (!value || value.byteLength !== 8) {
    return null;
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return view.getUint32(0, true) + view.getUint32(4, true) * 2 ** 32;
}

// ── Object assembly (MLP spec §5.4) ──────────────────────────────────────────

/** A complete MLP object. */
export type MediaObject = {
  objectId: number;
  classValue: number;
  flags: number;
  priority: number;
  headerExt: MediaTlvEntry[];
  payload: Uint8Array;
  receivedAtMs: number;
};

/** Why an inbound object was dropped instead of assembled. */
export type MediaObjectDrop =
  | "expired"
  | "duplicate"
  | "evicted"
  | "rejected";

export type MediaObjectOutcome =
  | { kind: "incomplete" }
  | { kind: "object"; object: MediaObject }
  | { kind: "drop"; reason: MediaObjectDrop }
  | { kind: "reject"; reason: MediaRejectReason };

type OpenObject = {
  objectId: number;
  classValue: number;
  flags: number;
  priority: number;
  fragmentCount: number;
  parts: Array<Uint8Array | undefined>;
  bytes: number;
  received: number;
  seenFin: boolean;
  firstSeenMs: number;
  /** The header extension of fragment 0: the sender stamps its meta there. */
  firstExt: MediaTlvEntry[] | null;
};

export type ObjectAssemblerConfig = {
  maxOpenObjects: number;
  maxAssemblyBytes: number;
  dedupeWindow: number;
  /** `3 × RTT + 500 ms` (MLP spec §5.4 step 7). */
  assemblyTimeoutMs: number;
};

export function defaultObjectAssemblerConfig(rttMs: number): ObjectAssemblerConfig {
  return {
    maxOpenObjects: MAX_OPEN_OBJECTS,
    maxAssemblyBytes: MAX_ASSEMBLY_BYTES,
    dedupeWindow: DEDUP_WINDOW,
    assemblyTimeoutMs: 3 * Math.max(1, rttMs) + 500,
  };
}

/**
 * Assemble MLP objects from fragments.
 *
 * The assembler owns the per-lane object state the specification bounds: at most
 * `MAX_OPEN_OBJECTS` incomplete objects and `MAX_ASSEMBLY_BYTES` open bytes,
 * with the oldest incomplete object evicted (`ASSEMBLY_EVICTED`) when either
 * is exceeded. Duplicate `(object_id, fragment_index)` pairs inside the dedupe
 * window are dropped, never re-applied.
 */
export class MediaObjectAssembler {
  private config: ObjectAssemblerConfig;
  private readonly open = new Map<number, OpenObject>();
  private readonly seen = new Map<number, Set<number>>();
  private readonly seenOrder: number[] = [];
  private openBytes = 0;
  private expiredTotal = 0;
  private evictedTotal = 0;
  private duplicatesTotal = 0;
  /** Highest `object_id` observed, for the receiver's gap accounting. */
  private highestObjectId = 0;

  constructor(config: ObjectAssemblerConfig) {
    this.config = config;
  }

  setAssemblyTimeout(rttMs: number): void {
    this.config = { ...this.config, assemblyTimeoutMs: 3 * Math.max(1, rttMs) + 500 };
  }

  get openObjects(): number {
    return this.open.size;
  }

  get openObjectBytes(): number {
    return this.openBytes;
  }

  get expiredObjects(): number {
    return this.expiredTotal;
  }

  get evictedObjects(): number {
    return this.evictedTotal;
  }

  get duplicateFragments(): number {
    return this.duplicatesTotal;
  }

  /** Discard every partial object (a new carrier, or a resume). */
  clear(): void {
    this.open.clear();
    this.openBytes = 0;
  }

  /** Drop expired partial objects; returns the evicted object ids. */
  expire(nowMs: number): number[] {
    const evicted: number[] = [];
    for (const [objectId, entry] of this.open) {
      if (nowMs - entry.firstSeenMs > this.config.assemblyTimeoutMs) {
        this.open.delete(objectId);
        this.openBytes -= entry.bytes;
        this.expiredTotal += 1;
        evicted.push(objectId);
      }
    }
    return evicted;
  }

  /** The next expiry wake-up, or `null` when nothing is open. */
  nextExpiryInMs(nowMs: number): number | null {
    let soonest: number | null = null;
    for (const entry of this.open.values()) {
      const remaining = entry.firstSeenMs + this.config.assemblyTimeoutMs - nowMs;
      if (soonest === null || remaining < soonest) {
        soonest = remaining;
      }
    }
    return soonest === null ? null : Math.max(0, soonest);
  }

  /**
   * Accept one fragment.
   *
   * Steps 4–7 of the specification's §5.4: deadline check, dedupe, fragment-set
   * join, completeness. The class-specific body validation (step 8) is the
   * caller's, because only it can decode a protobuf.
   */
  accept(fragment: MediaFragment, nowMs: number, sessionMs: number): MediaObjectOutcome {
    const deadlineMs = readTlvU64(fragment, MediaTlv.DEADLINE_EPOCH_MS);
    if (deadlineMs !== null && deadlineMs !== 0 && sessionMs > deadlineMs) {
      return { kind: "drop", reason: "expired" };
    }

    if (this.isDuplicate(fragment.objectId, fragment.fragmentIndex)) {
      this.duplicatesTotal += 1;
      return { kind: "drop", reason: "duplicate" };
    }

    let entry = this.open.get(fragment.objectId);
    if (!entry) {
      const ok = this.evictForRoom(fragment.payload.byteLength);
      if (!ok) {
        return { kind: "drop", reason: "evicted" };
      }
      entry = {
        objectId: fragment.objectId,
        classValue: fragment.classValue,
        flags: fragment.flags,
        priority: fragment.priority,
        fragmentCount: fragment.fragmentCount,
        parts: new Array<Uint8Array | undefined>(fragment.fragmentCount),
        bytes: 0,
        received: 0,
        seenFin: false,
        firstSeenMs: nowMs,
        firstExt: fragment.fragmentIndex === 0 ? fragment.headerExt : null,
      };
      this.open.set(fragment.objectId, entry);
    } else if (
      fragment.fragmentCount !== entry.fragmentCount ||
      fragment.classValue !== entry.classValue
    ) {
      // Step 6's `else reject(FRAGMENT_MISMATCH)`: the *fragment* is refused;
      // the open object keeps its state (MLP spec §5.4). A partial object is
      // released by step 7's `ASSEMBLY_TIMEOUT` — or by the bounded eviction
      // rule — and never by one stray fragment, so a corrupting link cannot
      // destroy an in-flight object and the already-arrived parts stay usable.
      // The reference implementation is
      // `mlp_core::media::object::ObjectAssembler::accept`, whose mismatch
      // arm returns `Dropped { reason: FragmentMismatch }` without touching
      // `self.open`.
      return { kind: "reject", reason: "FRAGMENT_MISMATCH" };
    }

    if (entry.parts[fragment.fragmentIndex]) {
      this.duplicatesTotal += 1;
      return { kind: "drop", reason: "duplicate" };
    }

    entry.parts[fragment.fragmentIndex] = fragment.payload;
    entry.bytes += fragment.payload.byteLength;
    entry.received += 1;
    this.openBytes += fragment.payload.byteLength;
    if ((fragment.flags & MediaFragmentFlags.FIN) !== 0) {
      entry.seenFin = true;
    }

    if (entry.received < entry.fragmentCount || !entry.seenFin) {
      return { kind: "incomplete" };
    }

    const payload = new Uint8Array(entry.bytes);
    let offset = 0;
    for (const part of entry.parts) {
      if (part) {
        payload.set(part, offset);
        offset += part.byteLength;
      }
    }

    this.releaseObject(entry);
    this.noteObjectId(entry.objectId);

    return {
      kind: "object",
      object: {
        objectId: entry.objectId,
        classValue: entry.classValue,
        flags: entry.flags,
        priority: entry.priority,
        headerExt: entry.firstExt ?? fragment.headerExt,
        payload,
        receivedAtMs: nowMs,
      },
    };
  }

  /** Note the highest object id seen, for the receiver's loss accounting. */
  noteObjectId(objectId: number): void {
    if (objectId > this.highestObjectId) {
      this.highestObjectId = objectId;
    }
  }

  get highestSeenObjectId(): number {
    return this.highestObjectId;
  }

  private releaseObject(entry: OpenObject): void {
    this.open.delete(entry.objectId);
    this.openBytes -= entry.bytes;
  }

  private evictForRoom(incomingBytes: number): boolean {
    while (
      this.open.size >= this.config.maxOpenObjects ||
      this.openBytes + incomingBytes > this.config.maxAssemblyBytes
    ) {
      let oldest: OpenObject | null = null;
      for (const entry of this.open.values()) {
        if (!oldest || entry.firstSeenMs < oldest.firstSeenMs) {
          oldest = entry;
        }
      }
      if (!oldest) {
        return this.openBytes + incomingBytes <= this.config.maxAssemblyBytes;
      }
      this.releaseObject(oldest);
      this.evictedTotal += 1;
    }
    return true;
  }

  private isDuplicate(objectId: number, fragmentIndex: number): boolean {
    const fragments = this.seen.get(objectId);
    if (fragments?.has(fragmentIndex)) {
      return true;
    }

    if (!fragments) {
      this.seen.set(objectId, new Set([fragmentIndex]));
      this.seenOrder.push(objectId);
      while (this.seenOrder.length > this.config.dedupeWindow) {
        const dropped = this.seenOrder.shift();
        if (dropped !== undefined) {
          this.seen.delete(dropped);
        }
      }
      return false;
    }

    fragments.add(fragmentIndex);
    return false;
  }
}

// ── The 64-id ack grid (MLP spec §6.2, §§7.5.1) ────────────────────────────────

/**
 * The receiver's applied-update window.
 *
 * `bit i` means update `highestAppliedUpdateId - i` was applied. The wire field
 * is a `uint64`; the generated decoder/encoder represents 64-bit values as a
 * JavaScript number, so the window keeps the low 53 bits exactly and reports
 * when it had to truncate (the sender then re-sends those cells, which is the
 * conservative direction).
 */
export class MediaAckWindow {
  private highest = 0;
  /** Bits 0..31 of the window (bit 0 = the highest applied update). */
  private lo = 0;
  /** Bits 32..63 of the window. */
  private hi = 0;
  private truncated = 0;

  get highestAppliedUpdateId(): number {
    return this.highest;
  }

  /** Bitmap bits that could not be expressed as a JS number (diagnostics). */
  get truncatedBits(): number {
    return this.truncated;
  }

  reset(): void {
    this.highest = 0;
    this.lo = 0;
    this.hi = 0;
    this.truncated = 0;
  }

  /**
   * The bitmap value for the next ack.
   *
   * `ack_bitmap` is a `uint64`, and the generated codec moves 64-bit values
   * through a JavaScript number, so bits 53..63 cannot be transported: they
   * are counted here and left clear. The sender then treats those updates as
   * unacked and re-sends their cells, which is the conservative direction
   * (§§7.5.2's ring-miss rule applies the same reasoning and counts it).
   */
  bitmapNumber(): number {
    const lowBits = this.lo >>> 0;
    const highBits = this.hi & 0x1f_ffff;
    this.truncated += popcount32(this.hi >>> 21);
    return lowBits + highBits * 2 ** 32;
  }

  /** Whether a update id inside the window is marked applied. */
  has(updateId: number): boolean {
    if (updateId < 1 || updateId > this.highest) {
      return false;
    }
    const distance = this.highest - updateId;
    if (distance < 32) {
      return ((this.lo >>> distance) & 1) === 1;
    }
    if (distance < 64) {
      return ((this.hi >>> (distance - 32)) & 1) === 1;
    }
    return false;
  }

  /** Mark a update applied; older ids than the window are ignored. */
  mark(updateId: number): void {
    if (updateId < 1) {
      return;
    }

    if (updateId > this.highest) {
      const shift = Math.min(64, updateId - this.highest);
      const nextLo = shift === 0 ? this.lo : shift >= 64 ? 0 : (this.lo << shift) >>> 0;
      const nextHi = shift === 0
        ? this.hi
        : shift >= 64
          ? 0
          : shift === 32
            ? this.lo
            : shift > 32
              ? (this.lo << (shift - 32)) >>> 0
              : ((this.hi << shift) | (this.lo >>> (32 - shift))) >>> 0;
      this.lo = (nextLo | 1) >>> 0;
      this.hi = nextHi >>> 0;
      this.highest = updateId;
      return;
    }

    const distance = this.highest - updateId;
    if (distance < 32) {
      this.lo = (this.lo | (1 << distance)) >>> 0;
    } else if (distance < 64) {
      this.hi = (this.hi | (1 << (distance - 32))) >>> 0;
    }
  }

  /** Seed the window from a resume ack (`next_update_id` is exclusive). */
  seedFromResume(highestAppliedUpdateId: number): void {
    this.reset();
    this.highest = Math.max(0, highestAppliedUpdateId);
    if (this.highest > 0) {
      this.lo = 1;
    }
  }
}

function popcount32(value: number): number {
  let remaining = value >>> 0;
  let count = 0;
  while (remaining !== 0) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

