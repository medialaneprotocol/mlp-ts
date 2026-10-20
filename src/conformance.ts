/**
 * The conformance corpus reader and the receiver's replay of it
 * (MLP spec §11.1, layer L3).
 *
 * The corpus is the protocol's shared, executable description of what it
 * promises. It lives in its own repository — `mlp-conformance` — beside this
 * one, and it holds three things:
 *
 * - `profiles/` — the link profiles, one JSON document per profile;
 * - `scenarios/` — the acceptance stories, as step scripts;
 * - `decisions/` — the golden decision traces the reference runner produces.
 *
 * This module reads that corpus and replays the *receiver's* half of it
 * through this package's machine. It is the browser's end of the L3 gate: the
 * reference implementation regenerates the traces and the gate compares the
 * bytes; the browser replays the same corpus and its machine must decide the
 * same way.
 *
 * WHAT THE CORPUS PUBLISHES, AND WHAT THE BROWSER CHECKS
 * ========================================================
 *
 * A decision trace is the *simulator's* record: it holds the updates the
 * sender emitted, the acknowledgements the lane carried, the plans, the lane
 * states, the counters and the link's statistics. The receiver's own
 * decisions inside it are:
 *
 * - the acknowledgement timeline — the highest applied update id the receiver
 *   reported, at every acknowledgement the lane carried;
 * - the applied count;
 * - the chain epoch the receiver held at the end.
 *
 * The replay drives this package's machine with the published progression and
 * requires:
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

/** One link profile (`profiles/<id>.json`). */
export type CorpusProfile = {
  schema: number;
  id: string;
  kind: string;
  tier: string;
  rtt_ms: number;
  jitter_ms: number;
  jitter_dist: string;
  loss_permille: number;
  burst_loss: number | null;
  reorder_permille: number;
  duplicate_permille: number;
  rate_bps_down: number;
  rate_bps_up: number;
  mtu_bytes: number;
  outage_schedule: { start_ms: number; dur_ms: number }[];
  ack_delay_ms: number;
  seed: number;
};

/** One step of a scenario (`scenarios/<id>.json`). */
export type CorpusStep =
  | { Link: { profile: string } }
  | { Advance: number }
  | { CaptureChange: { x: number; y: number; width: number; height: number } }
  | { ViewerInput: { PointerMove?: { x: number; y: number } } }
  | { Assert: string }
  | { PathSwitch: string }
  | "ViewerDisconnect"
  | "ViewerReconnect"
  | "HostReconnect";

/** One acceptance story (`scenarios/<id>.json`). */
export type CorpusScenario = {
  schema: number;
  id: string;
  tiers: string[];
  story: string;
  tier: string;
  stage: string;
  intent: string;
  simulator_cases: string[];
  receivers: number;
  steps: CorpusStep[];
};

/** One emitted update in a trace. */
export type CorpusUpdate = {
  at_ms: number;
  update_id: number;
  kind: string;
  cells: number;
  bytes: number;
};

/** One acknowledgement in a trace. */
export type CorpusAck = {
  at_ms: number;
  highest_applied_update_id: number;
  pending_cells: number;
  converged: boolean;
};

/** One plan event in a trace. */
export type CorpusPlan = { at_ms: number; plan_id: number; event: string; cells: number };

/** One lane-state change in a trace. */
export type CorpusState = { at_ms: number; state: string };

/** The trace's counters. */
export type CorpusCounters = {
  updates_sent: number;
  updates_applied: number;
  updates_acked: number;
  updates_gapped: number;
  fragments_sent: number;
  bytes_sent: number;
  objects_delivered: number;
  objects_dropped: number;
  acks: number;
  feedback: number;
  plans_started: number;
  converged_observations: number;
  pending_cells: number;
  last_converge_ms: number | null;
  echoes: [number, number][];
  input_submitted: number;
  input_applied: number;
  input_expired: number;
  input_dropped: number;
  park_cycles: number;
  parks: number;
  echo_outliers: number;
  stale_applies_skipped: number;
  canvas_behind_cells: number;
  pacer_waits: number;
  max_pacer_wait_ms: number;
  state_changes: number;
  hop_dropped: number;
  probes_lost: number;
  viewer_lost_objects: number;
  final_state: string;
  cells: number;
  epoch: number;
};

/** The golden decision trace of one scenario (`decisions/<id>.json`). */
export type CorpusTrace = {
  name: string;
  tier: string;
  duration_ms: number;
  updates: CorpusUpdate[];
  acks: CorpusAck[];
  plans: CorpusPlan[];
  states: CorpusState[];
  violations: { at_ms: number; invariant: string; detail: string }[];
  counters: CorpusCounters;
  link: Record<string, number>;
};

/** The wrapper the corpus's generator writes around a trace. */
export type CorpusDecision = {
  schema: number;
  scenario: string;
  story: string;
  tier: string;
  runner: string;
  digest: string;
  trace: CorpusTrace;
};

/** The corpus, as this package reads it. */
export type ConformanceCorpus = {
  /** The corpus directory the documents came from. */
  root: string;
  profiles: Map<string, CorpusProfile>;
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
    profiles: readJsonDirectory<CorpusProfile>(join(root, "profiles"), "profiles"),
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
 * the updates it applied that moved the window. The timeline carries two
 * kinds of acknowledgement — the receiver's own reports and the sender's view
 * of them — and the two are interleaved, so the progression is their running
 * maximum.
 */
export function publishedReceiverDecisions(trace: CorpusTrace): PublishedReceiverDecisions {
  const highestApplied: number[] = [];
  let mark = 0;
  for (const ack of trace.acks) {
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
    appliedCount: trace.counters.updates_applied,
    chainEpoch: trace.counters.epoch,
    cells: trace.counters.cells,
    acks: trace.acks,
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

/** The carrier a profile's MTU selects (the reference implementation's rule). */
export function carrierForProfile(profile: CorpusProfile): MediaCarrier {
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
  const profile = scenarioProfile(corpus, scenarioId);
  const carrier = carrierForProfile(profile);
  const payloadCap = fragmentPayloadCap(carrier);
  const published = publishedReceiverDecisions(trace);
  const emitted = new Map<number, CorpusUpdate>();
  for (const update of trace.updates) {
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

/** The link profile a scenario names. */
function scenarioProfile(corpus: ConformanceCorpus, scenarioId: string): CorpusProfile {
  const scenario = corpus.scenarios.get(scenarioId);
  if (!scenario) {
    throw new Error(`the corpus has no scenario named ${scenarioId}`);
  }
  let profile: CorpusProfile | undefined;
  for (const step of scenario.steps) {
    if (typeof step === "object" && "Link" in step) {
      profile = corpus.profiles.get(step.Link.profile);
    }
  }
  if (!profile) {
    throw new Error(`the scenario ${scenarioId} names no link profile`);
  }
  return profile;
}

/**
 * Replay one corpus scenario through this package's receiver machine.
 *
 * The machine is driven the way a receiver is driven: the corpus's media
 * objects travel as MLP fragments, they are parsed and assembled, and the
 * application reports what it applied. The scenario's steps drive the clock
 * and the link profile, and the published progression is what the machine's
 * acknowledgements are compared against.
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
  const profile = scenarioProfile(corpus, scenarioId);
  const published = publishedReceiverDecisions(trace);
  const scene = buildScenarioFragments(corpus, scenarioId);
  const emitted = new Map<number, CorpusUpdate>();
  for (const update of trace.updates) {
    emitted.set(update.update_id, update);
  }

  let clockMs = 0;
  const machine = new MediaReceiverMachine({
    now: () => clockMs,
    rttMs: () => profile.rtt_ms,
    appliedCellCount: () => published.cells,
  });
  const assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(profile.rtt_ms));

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
    clockMs = update.at_ms;

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
 * decided the way the corpus's reference runner decided.
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
