import { describe, expect, it } from "vitest";

import {
  MediaAck,
  MediaClose,
  MediaControlObject,
  MediaFeedback,
  MediaHello,
  MediaHelloAck,
  MediaPathChange,
  MediaProbe,
} from "@medialaneprotocol/proto";
import {
  ControlLaneMediaTransport,
  MediaLaneClient,
  type MediaLaneTransport,
} from "./media-client";
import {
  MediaFragmentClass,
  MediaFragmentFlags,
  MediaTlv,
  decodeMediaFragment,
  encodeMediaFragment,
  readTlvU64,
  tlvU64,
} from "./media-pdu";
import { emptyResumeSnapshot } from "./media-resume";
import { MediaPathSelector } from "./media-path";
import { MEDIA_PROTOCOL_VERSION, MediaPathKind } from "./protocol-constants";

/** Let the client's attach microtasks run without waiting on its probe timer. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeTransport implements MediaLaneTransport {
  readonly carrier = "websocket" as const;
  onClose?: (code: number, reason: string) => void;
  readonly sent: Uint8Array[] = [];
  open = true;
  closed: { code: number; reason: string } | null = null;

  get isOpen(): boolean {
    return this.open;
  }

  sendFragment(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  bufferedAmount(): number {
    return 0;
  }

  close(code: number, reason: string): void {
    this.open = false;
    this.closed = { code, reason };
    this.onClose?.(code, reason);
  }

  /** Decode every control object the client sent. */
  controlObjects(): MediaControlObject[] {
    return this.sent
      .map((bytes) => decodeMediaFragment(bytes, "stream"))
      .filter((verdict) => verdict.ok)
      .map((verdict) => (verdict.ok ? verdict.fragment : null))
      .filter((fragment): fragment is NonNullable<typeof fragment> => fragment !== null)
      .filter((fragment) => fragment.classValue === MediaFragmentClass.CONTROL)
      .map((fragment) => MediaControlObject.decode(fragment.payload));
  }

  feedbackObjects(): MediaFeedback[] {
    return this.sent
      .map((bytes) => decodeMediaFragment(bytes, "stream"))
      .filter((verdict) => verdict.ok)
      .map((verdict) => (verdict.ok ? verdict.fragment : null))
      .filter((fragment): fragment is NonNullable<typeof fragment> => fragment !== null)
      .filter((fragment) => fragment.classValue === MediaFragmentClass.FEEDBACK)
      .filter((fragment) => fragment.priority === 2)
      .map((fragment) => MediaFeedback.decode(fragment.payload));
  }

  /** Acks travel at priority 0; reports at priority 2 (MLP spec §4.1). */
  ackObjects(): MediaAck[] {
    return this.sent
      .map((bytes) => decodeMediaFragment(bytes, "stream"))
      .filter((verdict) => verdict.ok && verdict.fragment.classValue === MediaFragmentClass.FEEDBACK)
      .map((verdict) => (verdict.ok ? verdict.fragment : null))
      .filter((fragment): fragment is NonNullable<typeof fragment> => fragment !== null)
      .filter((fragment) => fragment.priority === 0)
      .map((fragment) => MediaAck.decode(fragment.payload));
  }
}

type Harness = {
  client: MediaLaneClient;
  transport: FakeTransport;
  events: string[];
  rejects: string[];
  objects: number[];
  now: { value: number };
  sessionMs: { value: number };
};

function harness(options: { resumeToken?: string | null; mediaSessionId?: string; pathSelector?: MediaPathSelector } = {}): Harness {
  const transport = new FakeTransport();
  const events: string[] = [];
  const rejects: string[] = [];
  const objects: number[] = [];
  const now = { value: 1_000 };
  const sessionMs = { value: 0 };

  const client = new MediaLaneClient({
    openTransport: async () => transport,
    sessionId: () => "control-session-1",
    mediaSessionId: () => options.mediaSessionId ?? "",
    resumeToken: () => options.resumeToken ?? null,
    resumeSnapshot: () => ({
      ...emptyResumeSnapshot(),
      appliedUpdateId: 12,
      chainEpoch: 3,
      ackBitmap: 5,
      inputSeqNext: 44,
      pressedKeys: [65],
      pressedButtons: [0],
    }),
    feedbackSource: () => ({
      ack: {
        highestAppliedUpdateId: 12,
        ackBitmap: 5,
        chainEpoch: 3,
        appliedCellCount: 64,
        staleCells: 0,
        converged: true,
        renderLatencyMs: 7,
        hasRenderLatencyMs: true,
        echoOfInputSeq: 44,
        ackEpochMs: 0,
      },
      fps: 15,
      renderMsP50: 4,
      renderMsP95: 9,
      inputQueueDepth: 2,
      inputSubmitted: 10,
      inputExpired: 1,
    }),
    now: () => now.value,
    sessionMs: () => sessionMs.value,
    rttMs: () => 200,
    random: () => 0,
    pathSelector: options.pathSelector,
    onControl: (control) => {
      if (control.helloAck) {
        events.push(`helloAck:${control.helloAck.mediaSupported}`);
      }
      if (control.laneState) {
        events.push(`laneState:${control.laneState.state}`);
      }
    },
    onStateChange: (state) => events.push(`state:${state}`),
    onReject: (reason) => rejects.push(reason),
    onObject: (object) => objects.push(object.objectId),
    onAttached: (ack) => events.push(`attached:${ack.mediaSupported}`),
    onClose: (disposition) => events.push(`close:${disposition.kind}`),
  });

  // The client owns the transport's close hook (production wires it in
  // `tryAttach`); the harness only exposes the transport for assertions.
  return { client, transport, events, rejects, objects, now, sessionMs };
}

/** A MEDIA object from the sender: one chunk, one fragment. */
function mediaObject(options: {
  objectId: number;
  updateId: number;
  updateBase?: number;
  payload?: Uint8Array;
  flags?: number;
  chainEpoch?: number;
  sendEpochMs?: number;
}): Uint8Array {
  return encodeMediaFragment({
    classValue: MediaFragmentClass.MEDIA,
    flags: MediaFragmentFlags.FIN | (options.flags ?? 0),
    objectId: options.objectId,
    fragmentIndex: 0,
    fragmentCount: 1,
    headerExt: [
      tlvU64(MediaTlv.UPDATE_ID, options.updateId),
      tlvU64(MediaTlv.UPDATE_BASE, options.updateBase ?? 0),
      ...(typeof options.chainEpoch === "number" ? [tlvU64(MediaTlv.CHAIN_EPOCH, options.chainEpoch)] : []),
      ...(typeof options.sendEpochMs === "number" ? [tlvU64(MediaTlv.SEND_EPOCH_MS, options.sendEpochMs)] : []),
    ],
    payload: options.payload ?? new Uint8Array([1, 2, 3]),
  });
}

function controlObject(body: MediaControlObject): Uint8Array {
  return encodeMediaFragment({
    classValue: MediaFragmentClass.CONTROL,
    flags: MediaFragmentFlags.FIN | MediaFragmentFlags.URGENT,
    objectId: 900,
    fragmentIndex: 0,
    fragmentCount: 1,
    payload: MediaControlObject.encode(body).finish(),
  });
}

describe("the media-lane client (MLP spec §6.3, §§7.2)", () => {
  it("marks a receiver's single-fragment object FIN so a hop can assemble it", async () => {
    const { client, transport } = harness();
    void client.attachDual();
    await flush();

    const hello = transport.sent.find((bytes) => bytes[5] === MediaFragmentClass.CONTROL);
    expect(hello, "the hello fragment was sent").toBeDefined();
    if (!hello) {
      throw new Error("the hello fragment was not sent");
    }
    expect(hello[6] & MediaFragmentFlags.FIN, "FIN is set").toBe(MediaFragmentFlags.FIN);
    client.stop();
  });

  it("sends the media hello with the receiver's capabilities on attach", async () => {
    const { client, transport } = harness();
    void client.attachDual();
    await flush();

    const hello = transport.controlObjects().find((control) => control.hello)?.hello as MediaHello;
    expect(hello.protocolVersion).toBe(MEDIA_PROTOCOL_VERSION);
    expect(hello.sessionId).toBe("control-session-1");
    expect(hello.mediaSessionId).toBe("");
    expect(hello.capabilities).toEqual(["anchor", "patch", "dc", "cursor", "dupe"]);
    expect(hello.maxFragmentPayload).toBe(65_536);
    client.stop();
  });

  it("sends the resume when a token is held, with the receiver's held state", async () => {
    const { client, transport } = harness({ resumeToken: "tok.abc", mediaSessionId: "media-1" });
    void client.attachDual();
    await flush();
    const resume = transport.controlObjects().find((control) => control.resume)?.resume;
    expect(resume?.resumeToken).toBe("tok.abc");
    expect(resume?.appliedUpdateId).toBe(12);
    expect(resume?.chainEpoch).toBe(3);
    expect(resume?.ackBitmap).toBe(5);
    expect(resume?.inputSeqNext).toBe(44);
    expect(resume?.pressedKeys).toEqual([65]);
    expect(resume?.pressedButtons).toEqual([0]);
    client.stop();
  });

  it("attaches on a supported hello ack and reports the lane attached", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    await flush();
    test.transport.sent.length = 0;
    test.client.handleFragment(controlObject({
      helloAck: MediaHelloAck.create({
        protocolVersion: MEDIA_PROTOCOL_VERSION,
        mediaSessionId: "media-7",
        acceptedFragmentPayload: 65_536,
        cellSize: 64,
        cellCols: 30,
        cellRows: 17,
        capabilities: ["anchor"],
        resumeTtlSeconds: 900,
        mediaSupported: true,
        mediaUnsupportedReason: "",
      }),
    }));

    expect(test.client.state).toBe("attached");
    expect(test.client.mediaSessionId).toBe("media-7");
    expect(test.events).toContain("attached:true");
    void test;
  });

  it("degrades to `unsupported` when the sender cannot carry media (D-4)", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    await flush();
    test.client.handleFragment(controlObject({
      helloAck: MediaHelloAck.create({
        protocolVersion: MEDIA_PROTOCOL_VERSION,
        mediaSessionId: "",
        acceptedFragmentPayload: 0,
        cellSize: 0,
        cellCols: 0,
        cellRows: 0,
        capabilities: [],
        resumeTtlSeconds: 0,
        mediaSupported: false,
        mediaUnsupportedReason: "no_sender_capability",
      }),
    }));

    expect(test.client.state).toBe("unsupported");
    expect(test.events).toContain("attached:false");
  });

  it("accepts one object and counts its bytes and objects", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    test.client.handleFragment(mediaObject({ objectId: 1, updateId: 10, chainEpoch: 1 }));

    expect(test.objects).toEqual([1]);
    expect(test.client.stats.receivedObjects).toBe(1);
    expect(test.client.stats.receivedBytes).toBe(3);
  });

  it("counts object-id gaps as loss and repeats as duplicates", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    test.client.handleFragment(mediaObject({ objectId: 1, updateId: 10 }));
    test.client.handleFragment(mediaObject({ objectId: 5, updateId: 11 }));
    test.client.handleFragment(mediaObject({ objectId: 5, updateId: 11 }));

    expect(test.client.stats.lostObjects).toBe(3);
    expect(test.client.stats.duplicatedObjects).toBe(1);
    expect(test.client.stats.reorderedObjects).toBe(0);
  });

  it("answers a sender probe with an echo in the next report", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    test.sessionMs.value = 250;
    const probe = encodeMediaFragment({
      classValue: MediaFragmentClass.FEEDBACK,
      flags: MediaFragmentFlags.FIN | MediaFragmentFlags.PROBE | MediaFragmentFlags.ECHO_REQUESTED,
      priority: 2,
      objectId: 77,
      fragmentIndex: 0,
      fragmentCount: 1,
      headerExt: [tlvU64(MediaTlv.SEND_EPOCH_MS, 100)],
      payload: MediaProbe.encode({ probeId: 77, payloadBytes: 0, sendEpochMs: 100 }).finish(),
    });
    test.transport.sent.length = 0;
    test.client.handleFragment(probe);
    test.client.sendFeedbackNow();

    const report = test.transport.feedbackObjects()[0];
    expect(report.probes).toHaveLength(1);
    expect(report.probes[0].objectId).toBe(77);
    expect(report.probes[0].sendEpochMs).toBe(100);
    expect(report.probes[0].echoEpochMs).toBe(250);
  });

  it("reports the receiver's counters, the ack grid and the cadence window", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    test.sessionMs.value = 1_000;
    test.client.handleFragment(mediaObject({ objectId: 1, updateId: 10, payload: new Uint8Array(500) }));
    test.client.sendAck({
      highestAppliedUpdateId: 10,
      ackBitmap: 1,
      chainEpoch: 3,
      appliedCellCount: 64,
      staleCells: 0,
      converged: true,
      renderLatencyMs: 7,
      hasRenderLatencyMs: true,
      echoOfInputSeq: 44,
      ackEpochMs: 1_000,
    });
    const acks = test.transport.ackObjects();
    test.transport.sent.length = 0;
    test.client.sendFeedbackNow();

    const report = test.transport.feedbackObjects()[0];
    expect(report.receivedBytes).toBe(500);
    expect(report.receivedObjects).toBe(1);
    expect(report.windowMs).toBe(1_000);
    // The report carries the live ack source; `sendAck` sent its own object.
    expect(report.ack?.highestAppliedUpdateId).toBe(12);
    expect(acks[0].highestAppliedUpdateId).toBe(10);
    expect(report.displayFps).toBe(15);
    expect(report.inputQueueDepth).toBe(2);
    expect(report.inputSubmitted).toBe(10);
    expect(report.inputExpired).toBe(1);
    expect(report.activePath).toBe(1);
    expect(report.appVersion).toBe("mlp-receiver-v1");
    expect(test.client.stats.goodputBps).toBe(4_000);
  });

  it("carries the active carrier path in the report (the §7.8 `path` seam)", async () => {
    /** A selector pinned to one carrier: the S2 seam W10 will drive for real. */
    class PinnedPathSelector extends MediaPathSelector {
      constructor(private readonly pinned: number) {
        super();
      }

      override get activePathValue(): number {
        return this.pinned;
      }
    }

    const test = harness({ pathSelector: new PinnedPathSelector(MediaPathKind.DC_DIRECT) });
    void test.client.attachDual();
    await flush();
    test.client.sendFeedbackNow();

    const report = test.transport.feedbackObjects()[0];
    // The report's `active_path` is the carrier the receiver is on, not a
    // constant: S1 reports `ws` (1), and a datagram carrier reports its own
    // value (2/3) through the same field — the edge maps it to the
    // `path` label, so W10 needs no wire change.
    expect(report.activePath).toBe(MediaPathKind.DC_DIRECT);
    expect(report.activePath).toBe(2);
  });

  it("rejects a malformed fragment with a typed reason and reports it once", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    const broken = mediaObject({ objectId: 1, updateId: 10 });
    broken[0] = 0x00;
    test.transport.sent.length = 0;
    test.client.handleFragment(broken);
    test.client.handleFragment(broken);

    expect(test.rejects).toEqual(["BAD_MAGIC", "BAD_MAGIC"]);
    expect(test.client.stats.rejectedFragments).toBe(2);
    expect(test.transport.controlObjects().filter((control) => control.error)).toHaveLength(1);
  });

  it("rejects an unsupported fragment version and names it", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    const foreign = mediaObject({ objectId: 3, updateId: 11 });
    foreign[4] = 7;
    test.client.handleFragment(foreign);
    expect(test.rejects).toEqual(["UNSUPPORTED_VERSION"]);
  });

  it("treats a park close as `come back`, never as failure", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    test.client.handleFragment(controlObject({
      close: MediaClose.create({ code: 0, reason: "parked", park: true }),
    }));
    expect(test.events).toContain("close:park");
    expect(test.client.state).not.toBe("failed");
  });

  it("treats an unsupported-media-version close as terminal", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    await flush();
    test.transport.close(4415, "unsupported_media_version");
    expect(test.client.state).toBe("failed");
    expect(test.events).toContain("close:terminal");
  });

  it("runs the lane over the control connection in single-lane mode", async () => {
    const test = harness();
    const controlSent: Uint8Array[] = [];
    test.client.useControlLane(new ControlLaneMediaTransport((bytes) => controlSent.push(bytes)));

    expect(test.client.laneMode).toBe("single");
    const hello = controlSent
      .map((bytes) => decodeMediaFragment(bytes, "stream"))
      .map((verdict) => (verdict.ok ? MediaControlObject.decode(verdict.fragment.payload) : null))
      .find((control) => control?.hello);
    expect(hello?.hello?.sessionId).toBe("control-session-1");
    expect(test.transport.sent).toHaveLength(0);
  });

  it("ignores a fragment's duplicate fragment index inside the dedupe window", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    const fragment = mediaObject({ objectId: 4, updateId: 12 });
    test.client.handleFragment(fragment);
    test.client.handleFragment(fragment);
    expect(test.objects).toEqual([4]);
    expect(test.client.stats.droppedDuplicates).toBe(1);
  });

  it("takes a real round-trip sample from the control lane (§§8.4)", async () => {
    const test = harness();
    expect(test.client.stats.rttMs).toBe(200);
    test.client.noteRttSample(1_200);
    expect(test.client.stats.rttMs).toBe(1_200);
    // The running minimum starts at the first real sample, not at the
    // configured placeholder.
    expect(test.client.stats.rttMinMs).toBe(1_200);
    test.client.noteRttSample(900);
    expect(test.client.stats.rttMs).toBe(900);
    expect(test.client.stats.rttMinMs).toBe(900);
    test.client.stop();
  });

  it("reports the update epoch TLV it saw on an object", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    const bytes = mediaObject({ objectId: 6, updateId: 13, chainEpoch: 9, sendEpochMs: 42 });
    const fragment = decodeMediaFragment(bytes, "stream");
    expect(fragment.ok).toBe(true);
    if (fragment.ok) {
      expect(readTlvU64(fragment.fragment, MediaTlv.CHAIN_EPOCH)).toBe(9);
    }
    test.client.handleFragment(bytes);
    expect(test.objects).toEqual([6]);
  });

  it("accepts datagram messages under the one-fragment rule and rejects a cut object", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    test.client.handleDatagramMessage(mediaObject({ objectId: 21, updateId: 4 }));
    expect(test.objects).toEqual([21]);
    expect(test.rejects).toEqual([]);

    // §5.4 step 3: a datagram message carrying two fragments is a framing
    // breach, never a partial object.
    const twoFragments = new Uint8Array([
      ...mediaObject({ objectId: 22, updateId: 5 }),
      ...mediaObject({ objectId: 23, updateId: 5 }),
    ]);
    test.client.handleDatagramMessage(twoFragments);
    expect(test.objects).toEqual([21]);
    expect(test.rejects).toEqual(["MULTI_FRAGMENT_ON_DATAGRAM"]);
    test.client.stop();
  });

  it("switches carriers without touching the lane and reports the change on the wire", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    const datagram = new FakeTransport();
    Object.defineProperty(datagram, "carrier", { value: "datagram" });

    const change = {
      fromPath: "WS" as const,
      toPath: "DC_DIRECT" as const,
      from: MediaPathKind.WS,
      to: MediaPathKind.DC_DIRECT,
      reason: "goodput_promotion",
      atEpochMs: 4_242,
    };
    expect(test.client.switchTransport(datagram, change)).toBe(true);
    expect(test.client.activePathIsDatagram).toBe(true);
    expect(test.client.hasFallbackTransport).toBe(true);
    // The `MediaPathChange` object went out on the new carrier as a PATH
    // object (§§7.8), with the switch time recorded.
    const path = datagram.sent
      .map((bytes) => decodeMediaFragment(bytes, "stream"))
      .filter((verdict) => verdict.ok && verdict.fragment.classValue === MediaFragmentClass.PATH)
      .map((verdict) => (verdict.ok ? MediaPathChange.decode(verdict.fragment.payload) : null));
    expect(path).toHaveLength(1);
    expect(path[0]?.toPath).toBe(MediaPathKind.DC_DIRECT);
    expect(path[0]?.atEpochMs).toBe(4_242);
    expect(test.transport.sent.every((bytes) => decodeMediaFragment(bytes, "stream").ok)).toBe(true);

    // A demotion adopts the carrier the switch left open: no reattach, no
    // new hello, the same lane.
    expect(
      test.client.switchBackToFallback({
        fromPath: "DC_DIRECT",
        toPath: "WS",
        from: MediaPathKind.DC_DIRECT,
        to: MediaPathKind.WS,
        reason: "goodput_demotion",
        atEpochMs: 9_000,
      }),
    ).toBe(true);
    expect(test.client.activePathIsDatagram).toBe(false);
    expect(test.transport.closed).toBeNull();
    test.client.stop();
  });

  it("demotes to the standby carrier when the datagram channel closes", async () => {
    const test = harness();
    void test.client.attachDual();
    await flush();
    const datagram = new FakeTransport();
    Object.defineProperty(datagram, "carrier", { value: "datagram" });
    test.client.switchTransport(datagram, {
      fromPath: "WS",
      toPath: "DC_TURN",
      from: MediaPathKind.WS,
      to: MediaPathKind.DC_TURN,
      reason: "goodput_promotion",
      atEpochMs: 1,
    });
    datagram.close(1_006, "sctp_reset");
    expect(test.client.activePathIsDatagram).toBe(false);
    expect(test.client.state).toBe("attached");
    expect(test.transport.closed).toBeNull();
    test.client.stop();
  });
});
