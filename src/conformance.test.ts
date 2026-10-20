/**
 * The browser's end of the conformance gate (MLP spec §11.1, layer L3).
 *
 * The corpus in `mlp-conformance` is the protocol's shared, executable
 * description of what it promises: the acceptance scenarios, the matrix that
 * maps the specification's stories onto them, and the golden decision traces
 * the harness produces. The harness regenerates those traces and the corpus's
 * own gate compares the bytes. This suite is the browser's half: it replays
 * the same corpus through this package's receiver machine and requires the
 * machine to decide the way the published trace says the protocol decides.
 *
 * The corpus is a sibling repository — a data file, not code — and it is
 * never copied into this one. The reader resolves it from
 * `MLP_CONFORMANCE_DIR` or from the sibling directory, and a corpus that is
 * absent fails the suite: a gate that compared nothing would pass.
 */

import { describe, expect, it } from "vitest";

import {
  compareReplay,
  loadCorpus,
  publishedReceiverDecisions,
  replayScenario,
  resolveCorpusRoot,
  type CorpusLinkProfile,
  type CorpusStep,
  type ReplayResult,
} from "./conformance";
import type { ViewerAck } from "./receiver";

const corpus = loadCorpus();
const scenarioIds = [...corpus.scenarios.keys()].sort();

function publishedFor(scenarioId: string) {
  const trace = corpus.decisions.get(scenarioId)?.trace;
  if (!trace) {
    throw new Error(`the corpus has no decision trace for ${scenarioId}`);
  }
  return publishedReceiverDecisions(trace);
}

describe("the conformance corpus", () => {
  it("is the one corpus directory, with a trace for every scenario", () => {
    expect(resolveCorpusRoot()).toBe(corpus.root);
    expect(scenarioIds.length).toBeGreaterThan(0);
    for (const id of scenarioIds) {
      expect(corpus.decisions.has(id), `${id} has no decision trace`).toBe(true);
      expect(corpus.decisions.get(id)?.trace.violations).toEqual([]);
    }
  });

  it("carries a link profile every scenario can resolve", () => {
    for (const id of scenarioIds) {
      const scenario = corpus.scenarios.get(id);
      expect(scenario).toBeDefined();
      expect(scenario?.link.mtu_bytes).toBeGreaterThan(0);
      const profiles = (scenario?.steps ?? [])
        .filter(
          (step): step is Extract<CorpusStep, { SetLink: { profile: CorpusLinkProfile } }> =>
            typeof step === "object" && "SetLink" in step,
        )
        .map((step) => step.SetLink.profile);
      expect(profiles.length).toBeGreaterThan(0);
      for (const profile of profiles) {
        expect(profile.mtu_bytes).toBeGreaterThan(0);
      }
    }
  });
});

describe("the receiver machine against the published decisions", () => {
  it("decides every committed scenario the way the corpus published it", () => {
    for (const id of scenarioIds) {
      const differences = compareReplay(publishedFor(id), replayScenario(corpus, id));
      expect(differences, `${id}: the machine's decisions differ from the published ones`).toEqual([]);
    }
  });

  it("holds the whole 64-update window where the corpus exercises it", () => {
    // The widest progression the corpus publishes: the memory-bounded motion
    // scenario applies 97 updates over 115 ids, so the window slides past the
    // 53 bits a JavaScript number can hold.
    const replay = replayScenario(corpus, "s07-memory-bounded-motion");
    const last = replay.acks[replay.acks.length - 1];
    expect(last.highestAppliedUpdateId).toBeGreaterThan(64);
    expect(last.ackBitmap > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("has teeth: a corpus that published another progression is noticed", () => {
    const published = publishedFor("s01-t2-typing-echo");
    const replay = replayScenario(corpus, "s01-t2-typing-echo");
    expect(compareReplay(published, replay)).toEqual([]);

    // A corpus that published a mark the machine did not report.
    const moved = { ...published, highestApplied: published.highestApplied.slice(1) };
    expect(compareReplay(moved, replay)).not.toEqual([]);

    // A corpus that published another epoch.
    expect(compareReplay({ ...published, chainEpoch: published.chainEpoch + 1 }, replay)).not.toEqual([]);
  });

  it("has teeth: a window that reports 53 of the 64 bits is noticed", () => {
    // The acknowledgement a receiver that cannot hold the window's upper bits
    // would produce: the same updates, the same high-water mark, and a bitmap
    // that lost its top eleven bits.
    const published = publishedFor("s07-memory-bounded-motion");
    const replay = replayScenario(corpus, "s07-memory-bounded-motion");
    const truncated: ReplayResult = {
      ...replay,
      acks: replay.acks.map((ack): ViewerAck => ({
        ...ack,
        ackBitmap: ack.ackBitmap & ((1n << 53n) - 1n),
      })),
    };
    const differences = compareReplay(published, truncated);
    expect(differences).not.toEqual([]);
    expect(differences.some((difference) => difference.what === "the applied window's contents")).toBe(
      true,
    );
  });

  it("has teeth: an acknowledgement a peer would refuse is noticed", () => {
    const published = publishedFor("s14-t0-baseline");
    const replay = replayScenario(corpus, "s14-t0-baseline");
    const invalid: ReplayResult = {
      ...replay,
      acks: replay.acks.map((ack): ViewerAck => ({ ...ack, staleCells: ack.appliedCellCount + 1 })),
    };
    const differences = compareReplay(published, invalid);
    expect(differences).not.toEqual([]);
    expect(differences.some((difference) => difference.what === "the acknowledgement's validity")).toBe(
      true,
    );
  });
});
