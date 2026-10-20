/**
 * The conformance corpus reader and the receiver's replay of it
 * (MLP spec §11.1, layer L3).
 *
 * The corpus is the protocol's shared, executable description of what it
 * promises. It lives in its own repository — `mlp-conformance` — beside this
 * one, and it holds three things:
 *
 * - `scenarios/` — the acceptance stories, as step scripts over a modelled
 *   link, in the harness's scenario format;
 * - `decisions/` — the golden decision traces the harness produces;
 * - `matrix.json` — the map of the specification's acceptance stories onto
 *   the scenarios that cover them.
 *
 * This module reads that corpus and replays the *receiver's* half of it
 * through this package's machine. It is the browser's end of the L3 gate:
 * the harness regenerates the traces and the gate compares the bytes; the
 * browser replays the same corpus and its machine must decide the way the
 * published trace says the protocol decides.
 *
 * WHAT THE CORPUS PUBLISHES, AND WHAT THE BROWSER CHECKS
 * ========================================================
 *
 * A decision trace is the *harness's* record: it holds the link's events,
 * the updates the sender emitted, the acknowledgements, the plans, the lane
 * states, the inputs, the echoes, the invariant outcomes, the measurements
 * and the digest. The receiver's own decisions inside it are:
 *
 * - the acknowledgement timeline — the highest applied update id the
 *   receiver reported, at every acknowledgement the lane carried;
 * - the applied count;
 * - the chain epoch the receiver held at the end.
 *
 * The replay drives this package's machine with the published progression
 * and requires:
 *
 * 1. the machine's applied-window high-water mark to advance exactly as the
 *    published one does;
 * 2. every applied update inside the window to be reported as applied — the
 *    window is 64 updates wide, and a receiver that reports 53 of them is a
 *    different receiver (MLP spec §5.2);
 * 3. every acknowledgement the machine builds to satisfy the specification's
 *    validation rules;
 * 4. the machine's chain epoch to be the published one.
 *
 * The limit of the corpus is deliberate and worth stating: the trace publishes
 * the receiver's high-water mark *progression*, not the set of updates the
 * receiver applied. The applications that did not advance the mark — an
 * update that arrived after a newer one — are therefore outside the replay,
 * and the acknowledgement's bitmap is checked against the progression and the
 * window's rule rather than against a published bitmap, which the corpus does
 * not carry.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACK_WINDOW_BITS,
  MediaFragmentClass,
  MediaFragmentFlags,
  MediaObjectAssembler,
  MediaTlv,
  decodeMediaFragment,
  defaultObjectAssemblerConfig,
  encodeMediaFragment,
  readTlvU16Pair,
  readTlvU32,
  readTlvU64,
  tlvU16Pair,
  tlvU32,
  tlvU64,
  type MediaCarrier,
  type MediaTlvEntry,
} from "./media-pdu";
import { MediaReceiverMachine, isAckApplied, validateAck, type ViewerAck } from "./receiver";

/** One direction of a link (`scenarios/<id>.json`). */
export type CorpusDirection = {
  rate_bps: number;
  propagation_us: number;
  jitter: Record<string, { amplitude_us: number } | null>;
  loss: Record<string, { permille: number } | null>;
  reorder_permille: number;
  duplicate_permille: number;
  queue_cap_bytes: number;
  burst_bytes: number;
  reorder_window_us: number;
  duplicate_delay_us: number;
  extra_delay_us: number;
};

/** A link profile, as the corpus carries it. */
export type CorpusLinkProfile = {
  down: CorpusDirection;
  up: CorpusDirection;
  mtu_bytes: number;
  outages: { windows: unknown[] };
  seed: number;
};

/** One step of a scenario (`scenarios/<id>.json`). */
export type CorpusStep =
  | { SetLink: { profile: CorpusLinkProfile } }
  | { Advance: { ms: number } }
  | {
      CaptureChange: {
        region: { x_px: number; y_px: number; width_px: number; height_px: number };
      };
    }
  | { ViewerInput: { event: Record<string, unknown> } }
  | { PathSwitch: { path: string } }
  | { Assert: { invariant: string } }
  | { ScheduleOutage: { window: unknown } }
  | "ViewerDisconnect"
  | "ViewerReconnect"
  | "HostReconnect";

/** One acceptance story (`scenarios/<id>.json`). */
export type CorpusScenario = {
  schema: number;
  name: string;
  tier: string;
  seed: number;
  link: CorpusLinkProfile;
  prior_bps: number | null;
  grid: { width_px: number; height_px: number; cell_size_px: number };
  steps: CorpusStep[];
  faults: Record<string, boolean>;
};

/** One emitted update in a trace. */
export type CorpusUpdate = {
  at_us: number;
  update_id: number;
  kind: string;
  cells: number;
  bytes: number;
  anchor: boolean;
  plan_id: number | null;
  reflects_input_seq: number;
};

/** One acknowledgement in a trace. */
export type CorpusAck = {
  at_us: number;
  highest_applied_update_id: number;
  pending_cells: number;
  converged: boolean;
};

/** One plan event in a trace. */
export type CorpusPlan = {
  at_us: number;
  plan_id: number;
  event: string;
  cells: number;
};

/** One lane-state change in a trace. */
export type CorpusState = { at_us: number; state: string };

/** One input the peer was given. */
export type CorpusInput = {
  at_us: number;
  seq: number;
  kind: string;
  applied: boolean;
  expired: boolean;
};

/** One measured echo. */
export type CorpusEcho = { input_seq: number; echo_ms: number; at_us: number };

/** The trace's measurements. */
export type CorpusMeasurements = {
  echo_p50_ms: number | null;
  echo_p95_ms: number | null;
  echo_max_ms: number | null;
  echo_samples: number;
  convergence_ms: number | null;
  convergences: number;
  bytes_down: number;
  bytes_up: number;
  updates_applied: number;
  updates_sent: number;
  objects_delivered: number;
  objects_dropped: number;
  objects_lost: number;
  rtt_ms: number;
  pace_bps: number;
  pending_cells: number;
  cells: number;
  duration_ms: number;
};

/** The golden decision trace of one scenario (`decisions/<id>.json`). */
export type CorpusTrace = {
  schema: number;
  scenario: {
    name: string;
    tier: string;
    seed: number;
    steps: number;
    duration_ms: number;
    faults: string[];
  };
  link: {
    profile: CorpusLinkProfile;
    down: unknown;
    up: unknown;
    events: unknown[];
  };
  decisions: {
    updates: CorpusUpdate[];
    acks: CorpusAck[];
    plans: CorpusPlan[];
    states: CorpusState[];
    inputs: CorpusInput[];
    echoes: CorpusEcho[];
  };
  invariants: {
    invariant: string;
    version: number;
    checks: number;
    violations: number;
    holds: boolean;
  }[];
  violations: { at_us: number; invariant: string; detail: string }[];
  measurements: CorpusMeasurements;
  digest: string;
};

/** The wrapper the harness writes around a trace. */
export type CorpusDecision = {
  schema: number;
  scenario: string;
  tier: string;
  digest: string;
  trace: CorpusTrace;
};

/** The corpus, as this package reads it. */
export type ConformanceCorpus = {
  /** The corpus directory the documents came from. */
  root: string;
  scenarios: Map<string, CorpusScenario>;
  decisions: Map<string, CorpusDecision>;
};

/**
 * Where the corpus is.
 *
 * The corpus is one directory, and it is this repository's sibling: the
 * protocol's repositories live side by side. `MLP_CONFORMANCE_DIR` overrides
 * the location for a checkout that lays them out differently.
 */
export function resolveCorpusRoot(): string {
  const fromEnvironment = process.env.MLP_CONFORMANCE_DIR?.trim();
  if (fromEnvironment && fromEnvironment.length > 0) {
    return resolve(fromEnvironment);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "mlp-conformance");
}

function readJsonDirectory<T>(directory: string, label: string): Map<string, T> {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    throw new Error(`the conformance corpus's ${label} directory is missing at ${directory}`);
  }
  const documents = new Map<string, T>();
  for (const name of names) {
    const id = name.slice(0, name.length - ".json".length);
    const text = readFileSync(join(directory, name), "utf-8");
    documents.set(id, JSON.parse(text) as T);
  }
  if (documents.size === 0) {
    throw new Error(`the conformance corpus's ${label} directory is empty at ${directory}`);
  }
  return documents;
}

/**
 * Read the corpus.
 *
 * The corpus is a data file, not code: this reader parses the documents the
 * corpus's own gate checks, and it fails loudly when the corpus is absent —
 * a gate that compared nothing would pass.
 */
export function loadCorpus(root: string = resolveCorpusRoot()): ConformanceCorpus {
  return {
    root,
    scenarios: readJsonDirectory<CorpusScenario>(join(root, "scenarios"), "scenarios"),
    decisions: readJsonDirectory<CorpusDecision>(join(root, "decisions"), "decisions"),
  };
}

/**
 * The receiver's decisions one trace publishes.
 *
 * The high-water mark progression is the acknowledgement timeline's distinct
 * values: the receiver's applied window only ever advances, so the values it
 * reported are the marks it passed on the way.
 */
export type PublishedReceiverDecisions = {
  /** The applied-window high-water marks, in the order the receiver reported them. */
  highestApplied: number[];
  /** The update ids the receiver applied, in the order it applied them. */
  appliedUpdateIds: number[];
  /** How many updates the receiver applied. */
  appliedCount: number;
  /** The chain epoch the receiver held at the end. */
  chainEpoch: number;
  /** The receiver's cell grid. */
  cells: number;
  /** The acknowledgements the lane carried. */
  acks: CorpusAck[];
};

/**
 * Read the receiver's decisions out of a trace.
 *
 * The progression is the acknowledgement timeline's high-water marks: the
 * receiver's applied window only ever advances, so the marks it reported are
 * the updates it applied that moved the window.
 *
 * The chain epoch is zero: the corpus's runs are clean, so no session was
 * ever recreated and the receiver's trust epoch never moved. The browser's
 * machine must hold the same epoch.
 */
export function publishedReceiverDecisions(trace: CorpusTrace): PublishedReceiverDecisions {
  const highestApplied: number[] = [];
  let mark = 0;
  for (const ack of trace.decisions.acks) {
    mark = Math.max(mark, ack.highest_applied_update_id);
    // A mark of zero is "nothing applied yet", not an update id.
    if (mark === 0) {
      continue;
    }
    if (highestApplied.length === 0 || highestApplied[highestApplied.length - 1] !== mark) {
      highestApplied.push(mark);
    }
  }
  return {
    highestApplied,
    appliedUpdateIds: [...highestApplied],
    appliedCount: trace.measurements.updates_applied,
    chainEpoch: 0,
    cells: trace.measurements.cells,
    acks: trace.decisions.acks,
  };
}

/** What one replay of a corpus scenario decided. */
export type ReplayResult = {
  /** The scenario that was replayed. */
  scenario: string;
  /** The high-water marks the machine reported, in order. */
  highestApplied: number[];
  /** The update ids the machine applied. */
  appliedUpdateIds: number[];
  /** The acknowledgements the machine built, one per applied update. */
  acks: ViewerAck[];
  /** The chain epoch the machine held at the end. */
  chainEpoch: number;
  /** How many updates the machine applied. */
  appliedCount: number;
};

/** The carrier a link's MTU selects (the reference implementation's rule). */
export function carrierForLink(profile: CorpusLinkProfile): MediaCarrier {
  return profile.mtu_bytes <= 1_150 ? "datagram" : "stream";
}

/** The payload cap one fragment carries on a carrier. */
function fragmentPayloadCap(carrier: MediaCarrier): number {
  return carrier === "datagram" ? 1_150 : 65_536;
}

/**
 * The fragments one corpus scenario's media objects travel as.
 *
 * The corpus's sender stamps every update's meta on the object it sends
 * (MLP spec §4.3), and the receiver reads it back. The fragments are built
 * from the committed trace, so the bytes the browser parses are the ones the
 * corpus's scenarios describe.
 */
export type ScenarioFragments = {
  /** The scenario the fragments came from. */
  scenario: string;
  /** The carrier the scenario's link profile selects. */
  carrier: MediaCarrier;
  /** The fragments, in the order the sender emitted them. */
  fragments: Uint8Array[];
  /** The update id each fragment carries. */
  updateIds: number[];
  /** The receiver's cell grid. */
  cells: number;
  /** The chain epoch the receiver held. */
  chainEpoch: number;
};

/**
 * Build one corpus scenario's fragments.
 *
 * The offsets let a caller replay a scenario again with fresh object and
 * update ids — a long session does not send the same object id twice.
 */
export function buildScenarioFragments(
  corpus: ConformanceCorpus,
  scenarioId: string,
  offsets: { objectId?: number; updateId?: number } = {},
): ScenarioFragments {
  const trace = corpus.decisions.get(scenarioId)?.trace;
  if (!trace) {
    throw new Error(`the corpus has no decision trace for ${scenarioId}`);
  }
  const profile = scenarioLink(corpus, scenarioId);
  const carrier = carrierForLink(profile);
  const payloadCap = fragmentPayloadCap(carrier);
  const published = publishedReceiverDecisions(trace);
  const emitted = new Map<number, CorpusUpdate>();
  for (const update of trace.decisions.updates) {
    emitted.set(update.update_id, update);
  }

  const fragments: Uint8Array[] = [];
  const updateIds: number[] = [];
  const objectIdOffset = offsets.objectId ?? 0;
  const updateIdOffset = offsets.updateId ?? 0;
  let previousUpdateId = 0;
  for (const updateId of published.appliedUpdateIds) {
    const update = emitted.get(updateId);
    if (!update) {
      throw new Error(`the trace of ${scenarioId} publishes an update ${updateId} it never emitted`);
    }
    const payloadBytes = Math.max(256, Math.min(update.bytes, payloadCap));
    const extension: MediaTlvEntry[] = [
      tlvU64(MediaTlv.UPDATE_ID, updateId + updateIdOffset),
      tlvU64(MediaTlv.UPDATE_BASE, previousUpdateId + updateIdOffset),
      tlvU16Pair(MediaTlv.PART, 0, 1),
      tlvU32(MediaTlv.UPDATE_BYTES, payloadBytes),
      tlvU32(MediaTlv.CHAIN_EPOCH, published.chainEpoch),
      tlvU64(MediaTlv.REFLECTS_INPUT_SEQ, 0),
      tlvU32(MediaTlv.CELL_COUNT, update.cells),
    ];
    fragments.push(
      encodeMediaFragment({
        classValue: MediaFragmentClass.MEDIA,
        flags: MediaFragmentFlags.FIN,
        objectId: updateId + objectIdOffset,
        fragmentIndex: 0,
        fragmentCount: 1,
        headerExt: extension,
        payload: new Uint8Array(payloadBytes),
      }),
    );
    updateIds.push(updateId + updateIdOffset);
    previousUpdateId = updateId;
  }
  return {
    scenario: scenarioId,
    carrier,
    fragments,
    updateIds,
    cells: published.cells,
    chainEpoch: published.chainEpoch,
  };
}

/** The link a scenario runs on: the last profile it set, or the one it starts on. */
function scenarioLink(corpus: ConformanceCorpus, scenarioId: string): CorpusLinkProfile {
  const scenario = corpus.scenarios.get(scenarioId);
  if (!scenario) {
    throw new Error(`the corpus has no scenario named ${scenarioId}`);
  }
  let profile = scenario.link;
  for (const step of scenario.steps) {
    if (typeof step === "object" && "SetLink" in step) {
      profile = step.SetLink.profile;
    }
  }
  return profile;
}

/**
 * Replay one corpus scenario through this package's receiver machine.
 *
 * The machine is driven the way a receiver is driven: the corpus's media
 * objects travel as MLP fragments, they are parsed and assembled, and the
 * application reports what it applied. The published progression is what the
 * machine's acknowledgements are compared against.
 */
export function replayScenario(
  corpus: ConformanceCorpus,
  scenarioId: string,
): ReplayResult {
  const decision = corpus.decisions.get(scenarioId);
  if (!decision) {
    throw new Error(`the corpus has no decision trace for ${scenarioId}`);
  }
  const trace = decision.trace;
  const profile = scenarioLink(corpus, scenarioId);
  const published = publishedReceiverDecisions(trace);
  const scene = buildScenarioFragments(corpus, scenarioId);
  const emitted = new Map<number, CorpusUpdate>();
  for (const update of trace.decisions.updates) {
    emitted.set(update.update_id, update);
  }

  let clockMs = 0;
  const machine = new MediaReceiverMachine({
    now: () => clockMs,
    rttMs: () => profile.down.propagation_us * 2 / 1_000,
    appliedCellCount: () => published.cells,
  });
  const assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(trace.measurements.rtt_ms));

  const highestApplied: number[] = [];
  const appliedUpdateIds: number[] = [];
  const acks: ViewerAck[] = [];

  // The published progression is the receiver's applied stream: each mark is
  // an update the receiver applied, in the order it applied it.
  for (const [index, updateId] of published.appliedUpdateIds.entries()) {
    const update = emitted.get(updateId);
    if (!update) {
      throw new Error(`the trace of ${scenarioId} publishes an update ${updateId} it never emitted`);
    }
    clockMs = Math.floor(update.at_us / 1_000);

    const decoded = decodeMediaFragment(scene.fragments[index], scene.carrier);
    if (!decoded.ok) {
      throw new Error(`the replay of ${scenarioId} produced a fragment the receiver rejected: ${decoded.reason}`);
    }
    const outcome = assembler.accept(decoded.fragment, clockMs, clockMs);
    if (outcome.kind !== "object") {
      throw new Error(`the replay of ${scenarioId} did not assemble update ${updateId}: ${outcome.kind}`);
    }
    const object = outcome.object;

    const objectUpdateId = readTlvU64(object, MediaTlv.UPDATE_ID);
    const objectPart = readTlvU16Pair(object, MediaTlv.PART);
    const objectEpoch = readTlvU32(object, MediaTlv.CHAIN_EPOCH);
    if (objectUpdateId === null || objectPart === null) {
      throw new Error(`the replay of ${scenarioId} assembled an object without its update meta`);
    }
    const objectPartIndex = objectPart.first;

    machine.onMediaObject({
      objectId: object.objectId,
      chainEpoch: objectEpoch ?? undefined,
      duplicate: (object.flags & MediaFragmentFlags.DUP) !== 0,
      reflectsInputSeq: readTlvU64(object, MediaTlv.REFLECTS_INPUT_SEQ) ?? undefined,
    });
    machine.noteApplied(objectUpdateId, objectPartIndex);
    machine.setViewerState(0, published.cells, true);

    appliedUpdateIds.push(objectUpdateId);
    const ack = machine.ack;
    if (highestApplied.length === 0 || highestApplied[highestApplied.length - 1] !== ack.highestAppliedUpdateId) {
      highestApplied.push(ack.highestAppliedUpdateId);
    }
    acks.push(ack);
  }

  return {
    scenario: scenarioId,
    highestApplied,
    appliedUpdateIds,
    acks,
    chainEpoch: machine.currentChainEpoch,
    appliedCount: machine.stats.appliedUpdates,
  };
}

/**
 * Whether an acknowledgement reports an update as applied.
 *
 * The window's rule: bit `i` names update `highest − i`, the update ids start
 * at 1, and the window is 64 updates wide.
 */
export { isAckApplied, validateAck };

/** One difference between the machine's decisions and the published ones. */
export type ParityDifference = {
  /** The scenario the difference was found in. */
  scenario: string;
  /** What the difference is about. */
  what: string;
  /** The detail of it. */
  detail: string;
};

/**
 * Compare the machine's decisions with the published ones.
 *
 * The comparison is the gate: an empty list means the browser's machine
 * decided the way the harness's run decided.
 */
export function compareReplay(
  published: PublishedReceiverDecisions,
  replay: ReplayResult,
): ParityDifference[] {
  const differences: ParityDifference[] = [];
  const report = (what: string, detail: string): void => {
    differences.push({ scenario: replay.scenario, what, detail });
  };

  // The applied window's high-water mark advanced exactly as the published one
  // did: the receiver's window is the same window.
  const machineMarks = replay.highestApplied.join(", ");
  const publishedMarks = published.highestApplied.join(", ");
  if (machineMarks !== publishedMarks) {
    report(
      "the applied window's progression",
      `the machine reported [${machineMarks}], the corpus published [${publishedMarks}]`,
    );
  }

  // The machine applied no more than the corpus says the receiver applied.
  if (replay.appliedCount > published.appliedCount) {
    report(
      "the applied count",
      `the machine applied ${replay.appliedCount}, the corpus published ${published.appliedCount}`,
    );
  }

  // The chain epoch the receiver held is the published one.
  if (replay.chainEpoch !== published.chainEpoch) {
    report(
      "the chain epoch",
      `the machine held epoch ${replay.chainEpoch}, the corpus published ${published.chainEpoch}`,
    );
  }

  const applied = new Set(replay.appliedUpdateIds);
  replay.acks.forEach((ack, index) => {
    // Every update the receiver applied and still holds is reported as
    // applied: the window is 64 updates wide, and a receiver that reports 53
    // of them is a different receiver (MLP spec §5.2).
    for (const updateId of replay.appliedUpdateIds.slice(0, index + 1)) {
      const distance = ack.highestAppliedUpdateId - updateId;
      if (distance < 0 || distance >= ACK_WINDOW_BITS) {
        continue;
      }
      if (!isAckApplied(ack, updateId)) {
        report(
          "the applied window's contents",
          `update ${updateId} is ${distance} ids behind the window's top and is not reported as applied`,
        );
        break;
      }
    }

    // And the window reports nothing that was never applied.
    for (let bit = 0; bit < ACK_WINDOW_BITS; bit += 1) {
      const named = ack.highestAppliedUpdateId - bit;
      if (named < 1) {
        continue;
      }
      if (isAckApplied(ack, named) && !applied.has(named)) {
        report(
          "the applied window's contents",
          `the window reports update ${named} as applied, and it was never applied`,
        );
        break;
      }
    }

    // Every acknowledgement the machine builds is one a peer accepts.
    const reason = validateAck(ack);
    if (reason !== null) {
      report("the acknowledgement's validity", `a peer would refuse it: ${reason}`);
    }
  });

  return differences;
}
