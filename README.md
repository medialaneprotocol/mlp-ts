# mlp-ts

The browser-side reference implementation of the **Media Lane Protocol (MLP)**,
in TypeScript.

MLP is a transport for real-time interactive media over links that are slow,
lossy, or both. This package is the receiver's half of it: the fragment
codec, the object assembler, the lane client, the resume machinery, and the
carrier selection.

The Rust implementation in [`mlp-core`](../mlp-core) is the source of truth
for every number and every rule. This package is its mirror; where the two
disagree, that is a bug in one of them.

## What the protocol does

A *lane* carries three kinds of traffic and keeps them apart:

- **control** — the handshake, the session's continuity, and its teardown;
- **media** — the updates a sender produces, moved whole and in order;
- **feedback** — what the receiver applied, how fast the link is, and what an
  intermediary dropped.

The design goal is that a receiver never holds a state it cannot verify, and
a sender always knows what to re-send, under a rate it measured.

## What this package is not

It does not define what an update's bytes *mean*. That is a codec's business.
The protocol moves the bytes, accounts for them, and paces them, and it never
interprets their content — so a codec plugs in without the protocol learning
anything about it.

## Layout

| Module | Responsibility |
|---|---|
| `media-pdu` | the fragment header, the TLV registry, the validation order, the object assembler |
| `media-client` | the lane client: the handshake, the feedback loop, the reconnect ladder |
| `media-resume` | parking, resume, and close classification |
| `media-path` | carrier selection and hysteresis |
| `protocol-constants` | the shared constants and the RTT-relative timeouts |

## The two rules that are load-bearing

- A malformed fragment is a *typed* reject that never touches the canvas:
  `decodeMediaMessage` returns a verdict, and a rejected fragment can never
  reach the object assembler.
- A body is classified by its class, so a media-class payload is handed to
  the codec only after the objection layer says it is complete.

## Using it

```ts
import { decodeMediaMessage, Carrier } from "@medialaneprotocol/mlp";

const verdict = decodeMediaMessage(bytes, Carrier.Ws);
if (verdict.ok) {
  // A complete object; hand its media-class payload to the codec.
}
```

## Building and testing

```bash
npm install
npm test
npm run typecheck
```

## License

PolyForm Noncommercial 1.0.0 — free for non-commercial use. Commercial use
requires a separate license. See [LICENSE](LICENSE).

The [specification](../mlp) and the [wire schemas](../mlp-proto) are under
Apache-2.0, so any implementation may interoperate with this one.
