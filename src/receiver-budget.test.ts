/**
 * The browser's per-update budget (MLP spec §6.7, §11.1).
 *
 * The transport has to work fast even on a poor link, and on a poor link the
 * receiver's own work is the only part of the path the browser controls. This
 * suite measures it over the conformance corpus's own scenarios — the
 * committed traces of the acceptance stories — and holds it to a budget.
 *
 * The scene is a long session: every scenario is replayed often enough that
 * the assembler's dedupe window (4096 `(object_id, fragment_index)` pairs)
 * and the receiver's applied-part record (512 pairs) are full, which is the
 * steady state of a real lane. A window that is not full is a window that
 * never evicts, and the eviction is what a long session pays on every
 * fragment.
 *
 * Four costs are measured, because they are the receiver's whole per-update
 * work:
 *
 * - the **assembly**: the fragment's parse and the object's assembly;
 * - the **machine**: the object's metadata, the applied window and the
 *   applied-part record;
 * - the **acknowledgement**: the ack the machine builds and hands over;
 * - the **repair**: the coalescing of a repair request into the one the
 *   interval allows.
 *
 * The budgets are the measured medians plus a margin, so a real growth in the
 * receiver's cost fails the suite while the run-to-run spread does not.
 */

import { describe, expect, it } from "vitest";

import {
  buildScenarioFragments,
  loadCorpus,
  publishedReceiverDecisions,
  resolveCorpusRoot,
  type ScenarioFragments,
} from "./conformance";
import {
  DEDUP_WINDOW,
  MediaObjectAssembler,
  decodeMediaFragment,
  defaultObjectAssemblerConfig,
} from "./media-pdu";
import { MediaReceiverMachine } from "./receiver";

const corpus = loadCorpus();
const scenarioIds = [...corpus.scenarios.keys()].sort();

/**
 * How many updates one pass over the corpus replays.
 *
 * The corpus publishes the receiver's own decisions, and the marks it
 * published are the updates the receiver applied: one fragment each. The
 * count is at least one, so a corpus that publishes no update at all still
 * replays a session instead of counting for ever.
 */
const publishedUpdates = Math.max(
  1,
  scenarioIds.reduce((count, id) => {
    const decision = corpus.decisions.get(id);
    if (!decision) {
      throw new Error(`the corpus has no decision trace for ${id}`);
    }
    return count + publishedReceiverDecisions(decision.trace).appliedUpdateIds.length;
  }, 0),
);

/**
 * How many times every scenario is replayed: enough to fill both windows.
 *
 * The assembler's dedupe window is `DEDUP_WINDOW` pairs deep and the
 * receiver's applied-part record is narrower, so the dedupe window is the
 * one that has to fill. The count of passes follows the corpus, because the
 * corpus is what the session replays: a corpus that publishes fewer updates
 * is replayed more often, and the window fills either way.
 */
const PASSES = Math.ceil(DEDUP_WINDOW / publishedUpdates);

type Scene = {
  fragments: Uint8Array[];
  updateIds: number[];
  cells: number;
  carrier: "stream" | "datagram";
};

/** Every scenario's fragments, replayed `PASSES` times with fresh ids. */
function buildScenes(base: number): Scene[] {
  const scenes: Scene[] = [];
  for (const [scenarioIndex, id] of scenarioIds.entries()) {
    const fragments: Uint8Array[] = [];
    const ids: number[] = [];
    let cells = 0;
    let carrier: "stream" | "datagram" = "stream";
    for (let pass = 0; pass < PASSES; pass += 1) {
      // A long session does not send the same object id twice: every pass
      // gets its own range, and the warm-up gets a range of its own. The
      // object id is a u32, so the ranges stay inside it.
      const range = base + scenarioIndex * 100_000_000 + pass * 1_000_000;
      const scene: ScenarioFragments = buildScenarioFragments(corpus, id, {
        objectId: range,
        updateId: range,
      });
      cells = scene.cells;
      carrier = scene.carrier;
      fragments.push(...scene.fragments);
      ids.push(...scene.updateIds);
    }
    scenes.push({ fragments, updateIds: ids, cells, carrier });
  }
  return scenes;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("the receiver's per-update budget", () => {
  it("does the receiver's own work per update inside the budget", () => {
    const warmScenes = buildScenes(0);
    const scenes = buildScenes(2_000_000_000);

    let clockMs = 0;
    const assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(400));
    const machine = new MediaReceiverMachine({
      now: () => clockMs,
      rttMs: () => 400,
      appliedCellCount: () => 510,
    });

    const assemblySamples: number[] = [];
    const machineSamples: number[] = [];
    const ackSamples: number[] = [];
    const repairSamples: number[] = [];
    const totalSamples: number[] = [];

    const run = (measure: boolean, runScenes: Scene[]): void => {
      for (const scene of runScenes) {
        for (const [index, bytes] of scene.fragments.entries()) {
          clockMs += 1;
          const started = performance.now();
          const decoded = decodeMediaFragment(bytes, scene.carrier);
          if (!decoded.ok) {
            throw new Error("the corpus's fragment was refused: " + decoded.reason);
          }
          const outcome = assembler.accept(decoded.fragment, clockMs, clockMs);
          if (outcome.kind !== "object") {
            throw new Error(
              "the corpus's object did not assemble: " + outcome.kind + " " + JSON.stringify(outcome),
            );
          }
          const assembled = performance.now();
          machine.onMediaObject({ objectId: scene.updateIds[index], chainEpoch: 0 });
          machine.noteApplied(scene.updateIds[index], 0);
          machine.setViewerState(0, scene.cells, true);
          const applied = performance.now();
          const ack = machine.ack;
          const acknowledged = performance.now();
          machine.requestRepair("REPORTED_INCOMPLETE", scene.updateIds[index]);
          const repaired = performance.now();
          if (ack.highestAppliedUpdateId < 0) {
            throw new Error("the machine reported no applied update");
          }
          if (!measure) {
            continue;
          }
          assemblySamples.push(assembled - started);
          machineSamples.push(applied - assembled);
          ackSamples.push(acknowledged - applied);
          repairSamples.push(repaired - acknowledged);
          totalSamples.push(repaired - started);
        }
      }
    };

    // Warm-up: the JIT, the shape of the hot loops.
    run(false, warmScenes);
    const warmUpdates = machine.stats.appliedUpdates;
    run(true, scenes);

    expect(machine.stats.appliedUpdates).toBeGreaterThan(warmUpdates);
    // The measurement is of the steady state: the dedupe window is full, so
    // every fragment pays the eviction a long session pays.
    expect(totalSamples.length).toBeGreaterThanOrEqual(DEDUP_WINDOW);

    // The clock is in milliseconds; the budgets are in microseconds.
    const assembly = median(assemblySamples) * 1_000;
    const applied = median(machineSamples) * 1_000;
    const ack = median(ackSamples) * 1_000;
    const repair = median(repairSamples) * 1_000;
    const total = median(totalSamples) * 1_000;

    console.log(
      `MEASURE_JS receiver budget: updates=${totalSamples.length} assembly=${assembly.toFixed(2)}us ` +
        `machine=${applied.toFixed(2)}us ack=${ack.toFixed(2)}us repair=${repair.toFixed(2)}us ` +
        `total=${total.toFixed(2)}us corpus=${resolveCorpusRoot()}`,
    );

    // The assembly: the fragment's parse and the object's assembly. The
    // measured median is 7–8 µs, and the budget is that plus a margin.
    expect(assembly).toBeLessThanOrEqual(14);
    // The machine: the metadata, the applied window and the applied-part
    // record. The measured median is 1.5 µs.
    expect(applied).toBeLessThanOrEqual(5);
    // The acknowledgement: the ack the machine builds. The measured median
    // is below a microsecond.
    expect(ack).toBeLessThanOrEqual(2);
    // The repair: the coalescing of a request into the one the interval
    // allows. The measured median is below half a microsecond.
    expect(repair).toBeLessThanOrEqual(2);
    // The whole of the receiver's own work per update. The measured median is
    // 9–10 µs.
    expect(total).toBeLessThanOrEqual(22);
  });

  it("keeps the applied-part record's window bounded", () => {
    // The record is bounded (MLP spec §5.1): a receiver that remembers every
    // part it ever applied is a receiver that grows for the whole session.
    const machine = new MediaReceiverMachine({ now: () => 0 });
    for (let update = 1; update <= 2_000; update += 1) {
      machine.noteApplied(update, 0);
    }
    expect(machine.isChunkApplied(2_000, 0)).toBe(true);
    expect(machine.isChunkApplied(1_488, 0)).toBe(false);
  });
});
