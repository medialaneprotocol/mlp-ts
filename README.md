# mlp-ts

The browser-side reference implementation of the **Media Lane Protocol (MLP)**,
in TypeScript.

MLP is a transport for real-time interactive media over links that are slow,
lossy, or both. This package is the receiver's half of it: the fragment
codec, the object assembler, the lane client, the receiver machine, the
resume machinery, and the carrier selection.

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
anything about it (MLP spec §5.1).

The receiver machine in `receiver` is the protocol's own half of that
separation: it holds the applied-update window, the chain epoch, the
acknowledgement and the repair request, and it never looks inside a media
body. An application wires the two together — it hands the machine the
transport's metadata of every media object, and tells the machine what it
applied.

## Layout

| Module | Responsibility |
|---|---|
| `media-pdu` | the fragment header, the TLV registry, the validation order, the object assembler |
| `media-client` | the lane client: the handshake, the feedback loop, the reconnect ladder |
| `media-resume` | parking, resume, and close classification |
| `media-path` | carrier selection and hysteresis |
| `protocol-constants` | the shared constants and the RTT-relative timeouts |
| `receiver` | the receiver machine: the applied window, the acknowledgement, the chain epoch, the repair request |
| `fifo-set` | the bounded windows: a set and a FIFO order over the same keys |
| `conformance` | the corpus reader and the receiver's replay of it — the gate's half, not the package's API |

## The two rules that are load-bearing

- A malformed fragment is a *typed* reject that never touches the surface:
  `decodeMediaMessage` returns a verdict, and a rejected fragment can never
  reach the object assembler.
- A body is classified by its class, so a media-class payload is handed to
  the codec only after the objection layer says it is complete.

## The conformance corpus

The corpus in [`mlp-conformance`](../mlp-conformance) is the protocol's
shared, executable description of what it promises: the tier profiles, the
acceptance scenarios, and the golden decision traces the reference runner
produces. The reference implementation regenerates those traces and the
corpus's own gate compares the bytes; this package is the browser's half of
the same gate.

`src/conformance.ts` reads the corpus and replays each scenario through this
package's receiver machine: the corpus's media objects travel as MLP
fragments, they are parsed and assembled, the application reports what it
applied, and the machine's decisions are compared with the published ones —
the applied window's progression, the acknowledgements the window reports,
the chain epoch, and the validity of every acknowledgement.

The corpus is a sibling repository and a data file; it is never copied into
this one. The reader resolves it from `MLP_CONFORMANCE_DIR` or from the
sibling directory, and a corpus that is absent fails the suite: a gate that
compared nothing would pass.

```bash
MLP_CONFORMANCE_DIR=../mlp-conformance npm test
```

## The receiver's per-update budget

The transport has to work fast even on a poor link, and on a poor link the
receiver's own work is the only part of the path the browser controls. The
budget suite measures it over the corpus's own scenarios — replayed often
enough that the dedupe window and the applied-part record are full, which is
the steady state of a real lane — and holds it to a budget:

```
MEASURE_JS receiver budget: updates=4608 assembly=7.9us machine=1.5us ack=0.1us repair=0.4us total=10.2us
```

The numbers are the medians over the corpus's updates; the budgets are those
medians plus a margin, so a real growth in the receiver's cost fails the
suite and the run-to-run spread does not.

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
npm run lint
```

## Status

In development. One moving version, `v0.1.0`, naming the current commit:
there is exactly one tag, and a change moves it.

## License

PolyForm Noncommercial 1.0.0 — free for non-commercial use. Commercial use
requires a separate license. See [LICENSE](LICENSE).

The [specification](../mlp) and the [wire schemas](../mlp-proto) are under
Apache-2.0, so any implementation may interoperate with this one.

## The sibling repositories

One of this package's dependencies is a link to a sibling repository rather
than a published package:

| Dependency | Where it is expected |
|---|---|
| `@medialaneprotocol/proto` | `../mlp-proto` |

The protocol's own repositories are siblings of this one; a codec lives in its
own organisation's repository, one level further out. A checkout that lays
the two organisations out side by side installs this package unchanged.

The conformance corpus is a sibling as well (`../mlp-conformance`), and the
gate reads it from there.
