// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SurfaceCanvasRenderer } from "@tessellio/ts";
import { parseUpdatePart, type UpdatePart } from "@tessellio/ts";
import { ScreenStream, type MediaPartMeta } from "./screen-stream";

/**
 * jsdom has no `ImageData` and no 2D context; the double below records
 * `putImageData` into an RGBA buffer so the stream tests can read the canvas
 * back. The production renderer is used unmodified.
 */
class TestImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

type TestCanvas = {
  canvas: HTMLCanvasElement;
  cells: Uint8ClampedArray;
  draws: Array<{ x: number; y: number; width: number; height: number }>;
  readCell: (x: number, y: number) => number[];
};

function createTestCanvas(width: number, height: number): TestCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  // The double keeps a generous buffer so a later canvas.resize stays readable.
  const cells = new Uint8ClampedArray(256 * 256 * 4);
  const draws: TestCanvas["draws"] = [];

  const context = {
    fillStyle: "#000000",
    fillRect: (x: number, y: number, w: number, h: number): void => {
      for (let row = y; row < y + h; row += 1) {
        for (let column = x; column < x + w; column += 1) {
          const offset = (row * canvas.width + column) * 4;
          cells[offset] = 0;
          cells[offset + 1] = 0;
          cells[offset + 2] = 0;
          cells[offset + 3] = 255;
        }
      }
    },
    putImageData: (
      image: { data: Uint8ClampedArray; width: number },
      dx: number,
      dy: number,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
    ): void => {
      draws.push({ x: sx, y: sy, width: sw, height: sh });
      for (let row = 0; row < sh; row += 1) {
        for (let column = 0; column < sw; column += 1) {
          const source = ((sy + row) * image.width + sx + column) * 4;
          const target = ((dy + sy + row) * canvas.width + dx + sx + column) * 4;
          cells[target] = image.data[source];
          cells[target + 1] = image.data[source + 1];
          cells[target + 2] = image.data[source + 2];
          cells[target + 3] = image.data[source + 3];
        }
      }
    },
  };

  Object.defineProperty(canvas, "getContext", { value: () => context, configurable: true });

  return {
    canvas,
    cells,
    draws,
    readCell: (x: number, y: number) =>
      Array.from(cells.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)),
  };
}

/** One stored-DEFLATE block; the vectors' envelope, hand-verifiable. */
function storedDeflate(raw: Uint8Array): Uint8Array {
  const payload = new Uint8Array(raw.length + 5);
  payload[0] = 0x01;
  payload[1] = raw.length & 0xff;
  payload[2] = (raw.length >> 8) & 0xff;
  const inverted = ~raw.length & 0xffff;
  payload[3] = inverted & 0xff;
  payload[4] = (inverted >> 8) & 0xff;
  payload.set(raw, 5);
  return payload;
}

type Patch = { row: number; x: number; values: number[] };

/**
 * A one-row region's ops are region-local: the patch's absolute row and
 * column live in the region box the update declares, not in the op stream.
 */
function patchOps(patch: Patch): Uint8Array {
  const ops: number[] = [0x01, 0x00, 0x00, 0x02, 0x00, 0x00];
  ops.push(patch.values.length & 0xff, (patch.values.length >> 8) & 0xff);
  for (const value of patch.values) {
    ops.push(value & 0xff, (value >> 8) & 0xff);
  }
  ops.push(0x00);
  return storedDeflate(Uint8Array.from(ops));
}

/** A full-coverage region: one `FILL` per row. */
function fullCoverageOps(width: number, height: number, valueFor: (row: number) => number): Uint8Array {
  const ops: number[] = [];
  for (let row = 0; row < height; row += 1) {
    const value = valueFor(row);
    ops.push(0x01, row & 0xff, (row >> 8) & 0xff);
    ops.push(0x03, 0x00, 0x00, width & 0xff, (width >> 8) & 0xff, value & 0xff, (value >> 8) & 0xff);
  }
  ops.push(0x00);
  return storedDeflate(Uint8Array.from(ops));
}

function writePatch(reference: Uint16Array, width: number, patch: Patch): void {
  patch.values.forEach((value, index) => {
    reference[patch.row * width + patch.x + index] = value;
  });
}

type UpdateOptions = {
  updateId: number;
  baseUpdateId: number;
  width: number;
  height: number;
  regions: Array<{ x: number; y: number; width: number; height: number; payload: Uint8Array }>;
  partIndex?: number;
  partCount?: number;
  codec?: number;
};

function updatePart(options: UpdateOptions): Record<string, unknown> {
  const updateBytes = options.regions.reduce((total, region) => total + region.payload.byteLength, 0);
  return {
    updateId: options.updateId,
    baseUpdateId: options.baseUpdateId,
    width: options.width,
    height: options.height,
    partIndex: options.partIndex ?? 0,
    partCount: options.partCount ?? 1,
    updateBytes,
    codec: options.codec ?? 8,
    regions: options.regions,
  };
}

function resetUpdate(
  updateId: number,
  width: number,
  height: number,
  valueFor: (row: number) => number,
): Record<string, unknown> {
  return updatePart({
    updateId,
    baseUpdateId: 0,
    width,
    height,
    regions: [{ x: 0, y: 0, width, height, payload: fullCoverageOps(width, height, valueFor) }],
  });
}

function deltaUpdate(
  updateId: number,
  baseUpdateId: number,
  width: number,
  height: number,
  patches: Patch[],
): Record<string, unknown> {
  return updatePart({
    updateId,
    baseUpdateId,
    width,
    height,
    regions: patches.map((patch) => ({
      x: patch.x,
      y: patch.row,
      width: patch.values.length,
      height: 1,
      payload: patchOps(patch),
    })),
  });
}

type Send = { command: string; payload?: unknown };

/** The MLP metadata a synthesized part carries in this suite. */
function metaFor(part: UpdatePart): MediaPartMeta {
  return {
    updateId: part.updateId,
    baseUpdateId: part.baseUpdateId,
    chainEpoch: 0,
    reflectsInputSeq: 0,
    anchor: part.baseUpdateId === 0,
    duplicate: false,
    objectId: 0,
    flags: 0,
  };
}

/** Feed one raw codec part the way the media lane does: parse, then apply. */
function applyPart(stream: ScreenStream, raw: unknown): void {
  const part = parseUpdatePart(raw);
  if (!part) {
    throw new Error("test part did not parse");
  }
  stream.applyMediaPart(part, metaFor(part));
}

/**
 * A valid part that cannot apply: it is the second part of a two-part
 * update, so its first part never arrived. The assembler reports the gap and
 * the stream asks for a repair — the same path the removed raw-parse failure
 * used to take, now expressed with a part the lane can actually deliver.
 */
function gapPart(updateId = 9): Record<string, unknown> {
  return updatePart({
    updateId,
    baseUpdateId: 0,
    width: 4,
    height: 1,
    regions: [],
    partIndex: 1,
    partCount: 2,
  });
}

function createStream(options?: {
  resyncIntervalMs?: number;
  now?: () => number;
  onUpdateApplied?: (updateId: number) => void;
}): { stream: ScreenStream; sends: Send[]; harness: TestCanvas } {
  const harness = createTestCanvas(1, 1);
  const renderer = new SurfaceCanvasRenderer(harness.canvas);
  const sends: Send[] = [];
  const stream = new ScreenStream({
    renderer,
    onAck: (ack) => {
      sends.push({
        command: "screen.update.ack",
        payload: { updateId: ack.highestAppliedUpdateId, renderLatencyMs: ack.renderLatencyMs },
      });
    },
    onResync: (heldUpdateId, reason) => {
      sends.push({ command: "screen.update.resync", payload: { heldUpdateId, reason } });
    },
    now: options?.now,
    resyncIntervalMs: options?.resyncIntervalMs,
    onUpdateApplied: options?.onUpdateApplied,
  });
  return { stream, sends, harness };
}

async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function acks(sends: Send[]): Send[] {
  return sends.filter((send) => send.command === "screen.update.ack");
}

function resyncs(sends: Send[]): Send[] {
  return sends.filter((send) => send.command === "screen.update.resync");
}

beforeEach(() => {
  vi.stubGlobal("ImageData", TestImageData);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ScreenStream rendering and acks", () => {
  it("acks a reset update only after its cells reach the canvas", async () => {
    const { stream, sends, harness } = createStream();
    applyPart(stream, resetUpdate(1, 4, 2, (row) => (row === 0 ? 0xf800 : 0x07e0)));

    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));

    expect(acks(sends)[0].payload).toMatchObject({ updateId: 1 });
    expect(typeof (acks(sends)[0].payload as { renderLatencyMs: number }).renderLatencyMs).toBe("number");
    expect(stream.appliedUpdateId).toBe(1);
    expect(harness.draws).toHaveLength(1);
    expect(harness.readCell(0, 0)).toEqual([255, 0, 0, 255]);
    expect(harness.readCell(0, 1)).toEqual([0, 255, 0, 255]);
    expect(stream.stats.updatesApplied).toBe(1);
  });

  it("applies a delta onto the update it names and acks it", async () => {
    const { stream, sends, harness } = createStream();
    applyPart(stream, resetUpdate(1, 4, 2, () => 0x0000));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));

    applyPart(stream, deltaUpdate(2, 1, 4, 2, [{ row: 1, x: 1, values: [0xffff, 0xf81f] }]));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(2));

    expect(acks(sends)[1].payload).toMatchObject({ updateId: 2 });
    expect(harness.readCell(1, 1)).toEqual([255, 255, 255, 255]);
    expect(harness.readCell(2, 1)).toEqual([255, 0, 255, 255]);
    expect(harness.readCell(0, 1)).toEqual([0, 0, 0, 255]);
    expect(stream.appliedUpdateId).toBe(2);
  });

  it("advances the ack timeline for an idle update without a canvas write", async () => {
    const { stream, sends, harness } = createStream();
    applyPart(stream, resetUpdate(1, 4, 2, () => 0x0000));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));
    const drawsAfterReset = harness.draws.length;

    applyPart(stream, updatePart({ updateId: 2, baseUpdateId: 1, width: 4, height: 2, regions: [] }));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(2));

    expect(acks(sends)[1].payload).toMatchObject({ updateId: 2 });
    expect(stream.appliedUpdateId).toBe(2);
    expect(harness.draws).toHaveLength(drawsAfterReset);
    expect(harness.readCell(1, 1)).toEqual([0, 0, 0, 255]);
  });

  it("notifies the UI once a update is applied", async () => {
    const applied: number[] = [];
    const { stream, sends } = createStream({ onUpdateApplied: (updateId) => applied.push(updateId) });

    applyPart(stream, resetUpdate(3, 2, 2, () => 0xffff));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));

    expect(applied).toEqual([3]);
  });
});

describe("ScreenStream rejections and resync", () => {
  it("rejects a delta whose base is not the applied update and keeps the canvas", async () => {
    const { stream, sends, harness } = createStream();
    applyPart(stream, resetUpdate(1, 4, 2, () => 0xf800));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));

    applyPart(stream, deltaUpdate(5, 2, 4, 2, [{ row: 0, x: 0, values: [0x0000] }]));
    await vi.waitFor(() => expect(resyncs(sends)).toHaveLength(1));

    expect(resyncs(sends)[0].payload).toEqual({ heldUpdateId: 1, reason: "BASE_MISMATCH" });
    expect(stream.appliedUpdateId).toBe(1);
    expect(harness.readCell(0, 0)).toEqual([255, 0, 0, 255]);
    expect(acks(sends)).toHaveLength(1);
  });

  it("rejects a delta with different geometry and keeps the canvas size", async () => {
    const { stream, sends, harness } = createStream();
    applyPart(stream, resetUpdate(1, 4, 2, () => 0x07e0));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));

    applyPart(stream, deltaUpdate(2, 1, 8, 8, [{ row: 0, x: 0, values: [0x0000] }]));
    await vi.waitFor(() => expect(resyncs(sends)).toHaveLength(1));

    expect(resyncs(sends)[0].payload).toEqual({ heldUpdateId: 1, reason: "GEOMETRY_MISMATCH" });
    expect(harness.canvas.width).toBe(4);
    expect(harness.canvas.height).toBe(2);
    expect(stream.appliedUpdateId).toBe(1);
  });

  it("rejects a malformed payload without writing a cell", async () => {
    const { stream, sends, harness } = createStream();
    applyPart(stream, resetUpdate(1, 4, 2, () => 0x001f));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));

    const malformed = deltaUpdate(2, 1, 4, 2, [{ row: 0, x: 0, values: [0xffff] }]);
    const region = (malformed.regions as Array<{ payload: Uint8Array }>)[0];
    // Same declared size, garbage bytes: the update decodes to a decode error.
    region.payload = new Uint8Array(region.payload.byteLength).fill(0xff);
    applyPart(stream, malformed);
    await vi.waitFor(() => expect(resyncs(sends)).toHaveLength(1));

    expect(resyncs(sends)[0].payload).toEqual({ heldUpdateId: 1, reason: "DECODE_ERROR" });
    expect(stream.appliedUpdateId).toBe(1);
    expect(harness.readCell(0, 0)).toEqual([0, 0, 255, 255]);
    expect(acks(sends)).toHaveLength(1);
  });

  it("rejects a reset update whose coverage is incomplete", async () => {
    const gapOps = storedDeflate(new Uint8Array([0x01, 0x00, 0x00, 0x03, 0x01, 0x00, 0x02, 0x00, 0xff, 0xff, 0x00]));
    const { stream, sends } = createStream();

    applyPart(stream, 
      updatePart({
        updateId: 1,
        baseUpdateId: 0,
        width: 4,
        height: 1,
        regions: [{ x: 0, y: 0, width: 4, height: 1, payload: gapOps }],
      }),
    );

    await vi.waitFor(() => expect(resyncs(sends)).toHaveLength(1));
    expect(resyncs(sends)[0].payload).toEqual({ heldUpdateId: 0, reason: "COVERAGE_INVALID" });
    expect(stream.appliedUpdateId).toBe(0);
    expect(acks(sends)).toHaveLength(0);
  });

  it("drops a stale delta without a resync", async () => {
    const { stream, sends, harness } = createStream();
    applyPart(stream, resetUpdate(5, 2, 2, () => 0x0000));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));

    applyPart(stream, deltaUpdate(4, 3, 2, 2, [{ row: 0, x: 0, values: [0xffff] }]));
    await settle(2);

    expect(resyncs(sends)).toHaveLength(0);
    expect(acks(sends)).toHaveLength(1);
    expect(stream.appliedUpdateId).toBe(5);
    expect(stream.stats.updatesDropped).toBe(1);
    expect(harness.readCell(0, 0)).toEqual([0, 0, 0, 255]);
  });

  it("rejects an unknown codec", async () => {
    const { stream, sends } = createStream();
    applyPart(stream, updatePart({ updateId: 1, baseUpdateId: 0, width: 2, height: 2, regions: [], codec: 3 }));

    await vi.waitFor(() => expect(resyncs(sends)).toHaveLength(1));
    await settle(3);

    expect(sends[0].payload).toEqual({ heldUpdateId: 0, reason: "UNKNOWN_CODEC" });
    expect(resyncs(sends)).toHaveLength(1);
    expect(stream.appliedUpdateId).toBe(0);
  });

  it("asks for a repair when the first part of a update is missing", async () => {
    const { stream, sends } = createStream();
    applyPart(stream, gapPart());
    await vi.waitFor(() => expect(resyncs(sends)).toHaveLength(1));
    expect(resyncs(sends)[0].payload).toEqual({ heldUpdateId: 0, reason: "PART_GAP" });
    expect(stream.appliedUpdateId).toBe(0);
  });

  it("clears the ready queue and asks once when the receiver cannot keep up", async () => {
    const { stream, sends } = createStream();
    applyPart(stream, resetUpdate(1, 2, 2, () => 0x0000));
    applyPart(stream, resetUpdate(2, 2, 2, () => 0x1111));
    applyPart(stream, resetUpdate(3, 2, 2, () => 0x2222));
    applyPart(stream, resetUpdate(4, 2, 2, () => 0x3333));

    await vi.waitFor(() => expect(resyncs(sends)).toHaveLength(1));

    expect(resyncs(sends)[0].payload).toEqual({ heldUpdateId: 0, reason: "QUEUE_OVERFLOW" });
    expect(stream.stats.updatesDropped).toBeGreaterThanOrEqual(1);
  });
});

describe("ScreenStream resync policy", () => {
  it("rate-limits repeated resyncs and coalesces them into one", async () => {
    let clock = 0;
    const { stream, sends } = createStream({ now: () => clock, resyncIntervalMs: 30 });

    applyPart(stream, gapPart());
    await settle(2);
    expect(resyncs(sends)).toHaveLength(1);

    clock = 5;
    applyPart(stream, gapPart(10));
    await settle(2);
    expect(resyncs(sends)).toHaveLength(1);

    clock = 40;
    await vi.waitFor(() => expect(resyncs(sends)).toHaveLength(2));
    expect(resyncs(sends)[1].payload).toEqual({ heldUpdateId: 0, reason: "PART_GAP" });
    expect(stream.stats.resyncs).toHaveLength(2);
  });

  it("asks again when a receiver kept waiting for an applicable update", async () => {
    vi.useFakeTimers();
    const { stream, sends } = createStream();

    applyPart(stream, gapPart());
    await Promise.resolve();
    expect(resyncs(sends)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(resyncs(sends)).toHaveLength(2);
    expect(resyncs(sends)[1].payload).toEqual({ heldUpdateId: 0, reason: "INCOMPLETE_UPDATE" });
  });

  it("does not keep waiting once a update is applied", async () => {
    vi.useFakeTimers();
    const { stream, sends } = createStream();

    applyPart(stream, gapPart());
    await Promise.resolve();
    applyPart(stream, resetUpdate(1, 2, 2, () => 0x0000));

    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(resyncs(sends)).toHaveLength(1);
  });
});

describe("ScreenStream WebRTC and lifecycle", () => {
  it("drops relay updates while WebRTC media flows, without ack or resync", async () => {
    const { stream, sends, harness } = createStream();
    stream.onWebRtcFlowing(true);

    applyPart(stream, resetUpdate(1, 2, 2, () => 0xffff));
    await settle(3);

    expect(sends).toHaveLength(0);
    expect(harness.draws).toHaveLength(0);
    expect(stream.appliedUpdateId).toBe(0);

    stream.onWebRtcFlowing(false);
    applyPart(stream, resetUpdate(1, 2, 2, () => 0xffff));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));
    expect(harness.readCell(0, 0)).toEqual([255, 255, 255, 255]);
  });

  it("stops rendering and forgets the applied update on stop", async () => {
    const { stream, sends } = createStream();
    applyPart(stream, resetUpdate(1, 2, 2, () => 0x0000));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));

    stream.stop();
    applyPart(stream, resetUpdate(2, 2, 2, () => 0xffff));
    await settle(3);

    expect(stream.appliedUpdateId).toBe(0);
    expect(acks(sends)).toHaveLength(1);
  });
});

describe("INV-R: the canvas equals the sender's reference for the applied update", () => {
  it("stays exact through dropped updates and a healing reset update", async () => {
    const width = 4;
    const height = 3;
    const { stream, sends, harness } = createStream();
    const reference = new Uint16Array(width * height);

    const expectCanvas = (): void => {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const value = reference[y * width + x];
          const red = (value >> 11) & 0x1f;
          const green = (value >> 5) & 0x3f;
          const blue = value & 0x1f;
          expect(harness.readCell(x, y)).toEqual([
            (red << 3) | (red >> 2),
            (green << 2) | (green >> 4),
            (blue << 3) | (blue >> 2),
            255,
          ]);
        }
      }
    };

    // Update 1: reset, all black.
    applyPart(stream, resetUpdate(1, width, height, () => 0x0000));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(1));
    expectCanvas();

    // Update 2: a delta painting a row.
    const patch2 = { row: 1, x: 0, values: [0xf800, 0x07e0, 0x001f, 0xffff] };
    applyPart(stream, deltaUpdate(2, 1, width, height, [patch2]));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(2));
    writePatch(reference, width, patch2);
    expectCanvas();

    // Update 3 is lost on the wire entirely.
    // Update 4 bases on the lost update: the receiver must refuse and resync.
    applyPart(stream, deltaUpdate(4, 3, width, height, [{ row: 2, x: 0, values: [0x8410, 0x8410, 0x8410, 0x8410] }]));
    await vi.waitFor(() => expect(resyncs(sends)).toHaveLength(1));
    expect(resyncs(sends)[0].payload).toEqual({ heldUpdateId: 2, reason: "BASE_MISMATCH" });
    expectCanvas();

    // the sender heals with a reset update; the receiver re-anchors exactly.
    const resetValues = [0x0000, 0xffff, 0x8410];
    applyPart(stream, resetUpdate(5, width, height, (row) => resetValues[row] ?? 0x0000));
    await vi.waitFor(() => expect(acks(sends)).toHaveLength(3));
    for (let row = 0; row < height; row += 1) {
      const value = resetValues[row] ?? 0x0000;
      for (let x = 0; x < width; x += 1) {
        reference[row * width + x] = value;
      }
    }
    expectCanvas();
    expect(stream.appliedUpdateId).toBe(5);
    expect(stream.stats.updatesApplied).toBe(3);
  });
});
