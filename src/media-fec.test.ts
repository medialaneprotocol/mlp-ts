/**
 * The wire parity's receiver half (MLP spec §6.9): the parity answers a
 * single lost part on arrival, a lying parity recovers nothing, and a
 * group whose parts all arrived keeps nothing.
 */
import { describe, expect, it } from "vitest";
import {
  FEC_MAX_K,
  crc32,
  groupParity,
  recoverPart,
} from "./media-pdu";

function block(part: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + part.length);
  out[0] = part.length & 0xff;
  out[1] = (part.length >> 8) & 0xff;
  out.set(part, 2);
  return out;
}

function xorParity(parts: Uint8Array[]): { parity: Uint8Array; crc: number } {
  const blocks = parts.map(block);
  const width = blocks.reduce((wide, block) => Math.max(wide, block.length), 2);
  const parity = new Uint8Array(width);
  for (const block of blocks) {
    for (let at = 0; at < block.length; at += 1) {
      parity[at] ^= block[at];
    }
  }
  const joined = new Uint8Array(blocks.reduce((sum, b) => sum + b.length, 0));
  let at = 0;
  for (const block of blocks) {
    joined.set(block, at);
    at += block.length;
  }
  return { parity, crc: crc32(joined) };
}

describe("the wire parity (MLP spec §6.9)", () => {
  it("recovers the one missing part, whatever its length", () => {
    const parts = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6, 7, 8, 9]),
    ];
    const { parity, crc } = xorParity(parts);
    const full = new Uint8Array(parity.length + 4);
    full.set(parity);
    full[parity.length] = crc & 0xff;
    full[parity.length + 1] = (crc >>> 8) & 0xff;
    full[parity.length + 2] = (crc >>> 16) & 0xff;
    full[parity.length + 3] = (crc >>> 24) & 0xff;

    const recovered = recoverPart(
      full,
      [
        { partIndex: 0, payload: parts[0] },
        { partIndex: 2, payload: parts[2] },
      ],
      3,
    );
    expect(recovered).not.toBeNull();
    expect(recovered?.partIndex).toBe(1);
    expect([...(recovered?.payload ?? [])]).toEqual([...parts[1]]);

    // The longest part lost instead: lengths come back exact.
    const recovered2 = recoverPart(
      full,
      [
        { partIndex: 0, payload: parts[0] },
        { partIndex: 1, payload: parts[1] },
      ],
      3,
    );
    expect(recovered2?.partIndex).toBe(2);
    expect([...(recovered2?.payload ?? [])]).toEqual([...parts[2]]);
  });

  it("recovers an empty part as exactly empty", () => {
    const parts = [new Uint8Array([9, 9, 9]), new Uint8Array(0), new Uint8Array([7])];
    const groupParityBytes = groupParity(parts);
    const recovered = recoverPart(
      groupParityBytes,
      [
        { partIndex: 0, payload: parts[0] },
        { partIndex: 2, payload: parts[2] },
      ],
      3,
    );
    expect(recovered?.partIndex).toBe(1);
    expect(recovered?.payload.byteLength).toBe(0);
  });

  it("recovers nothing from a parity that lies", () => {
    const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6, 7, 8, 9])];
    const corrupted = groupParity(parts);
    corrupted[0] ^= 0x40;
    expect(
      recoverPart(
        corrupted,
        [
          { partIndex: 0, payload: parts[0] },
          { partIndex: 2, payload: parts[2] },
        ],
        3,
      ),
    ).toBeNull();
    // A corrupted stored CRC is the same lie.
    const corruptedCrc = groupParity(parts);
    corruptedCrc[corruptedCrc.length - 1] ^= 1;
    expect(
      recoverPart(
        corruptedCrc,
        [
          { partIndex: 0, payload: parts[0] },
          { partIndex: 2, payload: parts[2] },
        ],
        3,
      ),
    ).toBeNull();
  });

  it("answers nothing when two parts are missing", () => {
    const parts = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    const parity = groupParity(parts);
    expect(
      recoverPart(parity, [{ partIndex: 0, payload: parts[0] }], 3),
    ).toBeNull();
  });

  it("refuses a group larger than the wire's part cap", () => {
    const parts = Array.from({ length: FEC_MAX_K + 1 }, (_, i) => new Uint8Array([i]));
    const parity = groupParity(parts);
    expect(
      recoverPart(
        parity,
        parts.slice(1).map((payload, i) => ({ partIndex: i + 1, payload })),
        FEC_MAX_K + 1,
      ),
    ).toBeNull();
  });
});
