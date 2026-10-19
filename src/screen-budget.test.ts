// @vitest-environment jsdom
/**
 * The receiver-side screen-stream state machine.
 *
 * One instance drives one session's updates into one surface. It has two
 * entry points and they are deliberately different:
 *
 * - {@link ScreenStream.applyMediaPart} — one MLP v1 MEDIA object (MLP spec
 *   §5): one codec part with its transport metadata (`ANCHOR`, `DUP`,
 *   `chain_epoch`, `reflects_input_seq`). The ack is a `MediaAck` carrying the
 *   64-id grid, and the repair request is a *repair plan request* (MLP spec
 *   §6.6), never a reset request.
 * - {@link ScreenStream.applyMediaEpoch} — the chain epoch advanced, which
 *   marks the surface stale without clearing it (MLP spec §6.6).
 *
 * What does not change between the two: an update is assembled whole,
 * validated whole, and applied whole; the surface never sees a partial
 * update, and a `chain_epoch` bump marks the surface stale without clearing
 * the cells (MLP spec §6.6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SurfaceCanvasRenderer } from "@tessellio/ts";
import { parseUpdatePart } from "@tessellio/ts";
import { ScreenStream, type MediaPartMeta } from "./screen-stream";

class TestImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

/** A recording canvas double: no cell copies, so the DOM write is excluded. */
function createRecordingCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement;
  draws: Array<{ x: number; y: number; width: number; height: number }>;
} {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const draws: Array<{ x: number; y: number; width: number; height: number }> = [];

  const context = {
    fillStyle: "#000000",
    fillRect: (): void => undefined,
    putImageData: (
      _image: unknown,
      _dx: number,
      _dy: number,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
    ): void => {
      draws.push({ x: sx, y: sy, width: sw, height: sh });
    },
  };

  Object.defineProperty(canvas, "getContext", { value: () => context, configurable: true });
  return { canvas, draws };
}

/** Deterministic LCG so every generated update is byte-stable across runs. */
function lcg(seed: number): () => number {
  let state = seed | 1;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
    return (state >>> 8) & 0xffffff;
  };
}

const PALETTE = [0x0000, 0xffff, 0x1084, 0xdef7, 0x2104, 0x001f];

type Band = { rows: number; ops: Uint8Array<ArrayBuffer> };

/**
 * A 1080p office-like reset in 256-row bands: per row a mix of background
 * FILL runs and short literal SPANs, ~7 px per run. This is the dense end of
 * the real encoder's reset op counts (the bench scene emits ~46 ops/row with
 * long runs, the budget scene ~7); ~200 k ops over 2.07 M px.
 */
/** A fixed-size op-stream builder: writing past the buffer is a test bug. */
function opWriter(capacity: number): { push: (byte: number) => void; bytes: () => Uint8Array<ArrayBuffer> } {
  const scratch = new Uint8Array(capacity);
  let length = 0;
  return {
    push: (byte) => {
      if (length >= capacity) {
        throw new Error(`op stream overflowed its ${capacity} byte buffer`);
      }
      scratch[length] = byte;
      length += 1;
    },
    bytes: () => scratch.slice(0, length),
  };
}

function resetBands(width: number, height: number, seed: number): Band[] {
  const random = lcg(seed);
  const bandRows = 256;
  const bands: Band[] = [];

  for (let band = 0; band * bandRows < height; band += 1) {
    const rows = Math.min(bandRows, height - band * bandRows);
    const writer = opWriter(2 * 1024 * 1024);
    const push = writer.push;

    for (let row = 0; row < rows; row += 1) {
      push(0x01);
      push(row & 0xff);
      push((row >> 8) & 0xff);
      let x = 0;
      while (x < width) {
        const run = Math.min(4 + (random() % 13), width - x);
        if (run >= 8) {
          const value = PALETTE[random() % PALETTE.length];
          push(0x03);
          push(x & 0xff);
          push((x >> 8) & 0xff);
          push(run & 0xff);
          push((run >> 8) & 0xff);
          push(value & 0xff);
          push(value >> 8);
        } else {
          push(0x02);
          push(x & 0xff);
          push((x >> 8) & 0xff);
          push(run & 0xff);
          push((run >> 8) & 0xff);
          for (let index = 0; index < run; index += 1) {
            const value = PALETTE[random() % PALETTE.length];
            push(value & 0xff);
            push(value >> 8);
          }
        }
        x += run;
      }
    }
    push(0x00);
    bands.push({ rows, ops: writer.bytes() });
  }

  return bands;
}

/** A scroll-class delta: one 1680×40 strip, ~13 k literal-heavy ops. */
function scrollOps(width: number, height: number, seed: number): Uint8Array<ArrayBuffer> {
  const random = lcg(seed);
  const writer = opWriter(512 * 1024);
  const push = writer.push;

  for (let row = 0; row < height; row += 1) {
    push(0x01);
    push(row & 0xff);
    push((row >> 8) & 0xff);
    for (let x = 0; x < width; ) {
      const run = Math.min(1 + (random() % 4), width - x);
      push(0x02);
      push(x & 0xff);
      push((x >> 8) & 0xff);
      push(run & 0xff);
      push((run >> 8) & 0xff);
      for (let index = 0; index < run; index += 1) {
        const value = PALETTE[random() % PALETTE.length];
        push(value & 0xff);
        push(value >> 8);
      }
      x += run;
    }
  }
  push(0x00);
  return writer.bytes();
}

/** A typing-class delta: a 600×40 text block, ~4 k ops. */
function typingOps(width: number, height: number, seed: number): Uint8Array<ArrayBuffer> {
  const random = lcg(seed);
  const writer = opWriter(256 * 1024);
  const push = writer.push;

  for (let row = 0; row < height; row += 1) {
    push(0x01);
    push(row & 0xff);
    push((row >> 8) & 0xff);
    for (let x = 0; x < width; ) {
      if (random() % 3 === 0) {
        const run = Math.min(1 + (random() % 5), width - x);
        push(0x02);
        push(x & 0xff);
        push((x >> 8) & 0xff);
        push(run & 0xff);
        push((run >> 8) & 0xff);
        for (let index = 0; index < run; index += 1) {
          const value = PALETTE[random() % PALETTE.length];
          push(value & 0xff);
          push(value >> 8);
        }
        x += run;
      } else {
        const run = Math.min(1 + (random() % 3), width - x);
        const value = PALETTE[0];
        push(0x03);
        push(x & 0xff);
        push((x >> 8) & 0xff);
        push(run & 0xff);
        push((run >> 8) & 0xff);
        push(value & 0xff);
        push(value >> 8);
        x += run;
      }
    }
  }
  push(0x00);
  return writer.bytes();
}

/** Compress with the codec's own envelope: raw DEFLATE, browser-native encoder. */
async function deflateRaw(raw: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(raw);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new CompressionStream("deflate-raw"));
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      parts.push(value);
    }
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const compressed = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    compressed.set(part, offset);
    offset += part.byteLength;
  }
  return compressed;
}

type WireRegion = { x: number; y: number; width: number; height: number; payload: Uint8Array<ArrayBuffer> };
type PartTemplate = {
  baseUpdateId: number;
  width: number;
  height: number;
  regions: WireRegion[];
};

function partTemplate(baseUpdateId: number, width: number, height: number, regions: WireRegion[]): PartTemplate {
  return { baseUpdateId, width, height, regions };
}

function partOf(template: PartTemplate, updateId: number, baseUpdateId: number): Record<string, unknown> {
  return {
    updateId,
    baseUpdateId,
    width: template.width,
    height: template.height,
    partIndex: 0,
    partCount: 1,
    updateBytes: template.regions.reduce((sum, region) => sum + region.payload.byteLength, 0),
    codec: 8,
    regions: template.regions,
  };
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

beforeEach(() => {
  vi.stubGlobal("ImageData", TestImageData);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("receiver decode+apply budgets", () => {
  it(
    "decodes a full-screen 1080p reset and scroll/typing deltas inside budget",
    async () => {
      const bands = resetBands(1920, 1080, 12345);
      let y = 0;
      const resetRegions: WireRegion[] = [];
      for (const band of bands) {
        resetRegions.push({ x: 0, y, width: 1920, height: band.rows, payload: await deflateRaw(band.ops) });
        y += band.rows;
      }
      const scrollPayload = await deflateRaw(scrollOps(1680, 40, 999));
      const typingPayload = await deflateRaw(typingOps(600, 40, 777));

      const harness = createRecordingCanvas(1920, 1080);
      const renderer = new SurfaceCanvasRenderer(harness.canvas);
      let resolveApplied: (() => void) | null = null;
      const acks: Array<{ updateId: number; renderLatencyMs: number }> = [];
      const stream = new ScreenStream({
        renderer,
        onAck: (ack) => {
          acks.push({ updateId: ack.highestAppliedUpdateId, renderLatencyMs: ack.renderLatencyMs });
        },
        onUpdateApplied: () => {
          resolveApplied?.();
        },
      });

      const reset = partTemplate(0, 1920, 1080, resetRegions);
      const scroll = partTemplate(1, 1920, 1080, [
        { x: 120, y: 940, width: 1680, height: 40, payload: scrollPayload },
      ]);
      const typing = partTemplate(1, 1920, 1080, [
        { x: 600, y: 498, width: 600, height: 40, payload: typingPayload },
      ]);

      let nextUpdateId = 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const runUpdates = async (template: PartTemplate, iterations: number): Promise<number[]> => {
        const latencies: number[] = [];
        for (let iteration = 0; iteration < iterations; iteration += 1) {
          const base = template.baseUpdateId === 0 ? 0 : stream.appliedUpdateId;
          const updateId = nextUpdateId;
          nextUpdateId += 1;
          const applied = new Promise<void>((resolve, reject) => {
            resolveApplied = resolve;
            timer = setTimeout(() => {
              reject(
                new Error(
                  `update ${updateId} (base ${base}) did not apply within 30s; applied=${stream.appliedUpdateId} stats=${JSON.stringify(stream.stats)}`,
                ),
              );
            }, 30_000);
          });
          const started = performance.now();
          const part = parseUpdatePart(partOf(template, updateId, base));
          if (!part) {
            throw new Error(`test part ${updateId} did not parse`);
          }
          const meta: MediaPartMeta = {
            updateId: part.updateId,
            baseUpdateId: part.baseUpdateId,
            chainEpoch: 0,
            reflectsInputSeq: 0,
            anchor: part.baseUpdateId === 0,
            duplicate: false,
            objectId: 0,
            flags: 0,
          };
          stream.applyMediaPart(part, meta);
          await applied;
          clearTimeout(timer);
          latencies.push(performance.now() - started);
          resolveApplied = null;
        }
        return latencies;
      };

      // Warm-up: JIT, the LUT, the scratch buffers, the reusable region pool.
      await runUpdates(reset, 2);
      await runUpdates(scroll, 2);
      await runUpdates(typing, 2);
      const warmApplied = stream.stats.updatesApplied;
      const warmAcks = acks.length;
      const warmDraws = harness.draws.length;
      expect(warmApplied).toBe(6);

      const resetLatencies = await runUpdates(reset, 21);
      const scrollLatencies = await runUpdates(scroll, 21);
      const typingLatencies = await runUpdates(typing, 21);

      expect(stream.stats.updatesApplied).toBe(warmApplied + 63);
      expect(stream.stats.updatesDropped).toBe(0);

      // The reset's five bands cover the record-merged canvas: one write per
      // reset update, spanning the whole canvas.
      const resetUpdateDraws = harness.draws.slice(warmDraws, warmDraws + 21);
      expect(resetUpdateDraws).toHaveLength(21);
      expect(
        resetUpdateDraws.every((rect) => rect.x === 0 && rect.y === 0 && rect.width === 1920 && rect.height === 1080),
      ).toBe(true);

      const reported = acks.slice(warmAcks).map((ack) => ack.renderLatencyMs);
      const resetMedian = median(resetLatencies);
      const scrollMedian = median(scrollLatencies);
      const typingMedian = median(typingLatencies);
      const reportedMedian = median(reported);

      // eslint-disable-next-line no-console
      console.log(
        `MEASURE_JS budgets: reset med=${resetMedian.toFixed(2)} p95=${[...resetLatencies].sort((a, b) => a - b)[19].toFixed(2)} scroll med=${scrollMedian.toFixed(2)} typing med=${typingMedian.toFixed(2)} reported med=${reportedMedian.toFixed(2)}`,
      );

      expect(resetMedian).toBeLessThanOrEqual(45);
      expect(scrollMedian).toBeLessThanOrEqual(9);
      expect(typingMedian).toBeLessThanOrEqual(5);
    },
    120_000,
  );
});
