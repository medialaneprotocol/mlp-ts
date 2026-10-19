/**
 * The Media Lane Protocol (MLP) — the browser-side reference implementation.
 *
 * The protocol's byte grammar lives in {@link module:media-pdu}: the fragment
 * header, the TLV registry, and the validation order are defined there and
 * nowhere else. The other modules build on it:
 *
 * - {@link module:media-client} — the lane client: the handshake, the
 *   feedback loop, and the reconnect ladder;
 * - {@link module:media-resume} — parking, resume, and close classification;
 * - {@link module:media-path} — carrier selection and hysteresis;
 * - {@link module:screen-stream} — the receiver-side state machine that
 *   applies a codec's updates to a surface and reports what it applied. It
 *   reads the codec's own pieces from the codec's package, because the
 *   transport depends on the codec, not the other way round.
 *
 * The Rust implementation in `mlp-core` is the source of truth for every
 * number and every rule; this package is its browser-side mirror.
 */

export * from "./media-pdu";
export * from "./media-client";
export * from "./media-resume";
export * from "./media-path";
export * from "./protocol-constants";
export * from "./screen-stream";
