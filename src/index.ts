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
 * - {@link module:media-path} — carrier selection and hysteresis.
 *
 * The Rust implementation in `mlp-core` is the source of truth for every
 * number and every rule; this package is its browser-side mirror.
 */

export * from "./media-pdu";
export * from "./media-client";
export * from "./media-resume";
export * from "./media-path";
export * from "./protocol-constants";
