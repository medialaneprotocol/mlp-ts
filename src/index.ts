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
 * - {@link module:receiver} — the receiver machine: the applied window, the
 *   acknowledgement, the chain epoch, and the repair request.
 *
 * The media class is opaque (MLP spec §5.1): the protocol moves the bytes and
 * never interprets them, so nothing here knows what a codec's content means.
 *
 * The Rust implementation in `mlp-core` is the source of truth for every
 * number and every rule; this package is its browser-side mirror.
 */

export * from "./media-pdu";
export * from "./media-client";
export * from "./media-resume";
export * from "./media-path";
export * from "./protocol-constants";
export * from "./receiver";
