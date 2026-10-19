import { describe, expect, it } from "vitest";

import {
  FRAGMENT_FIXED_HEADER,
  MediaAckWindow,
  MediaFragmentClass,
  MediaFragmentFlags,
  MediaObjectAssembler,
  MediaTlv,
  type MediaFragment,
  decodeMediaFragment,
  decodeMediaMessage,
  defaultObjectAssemblerConfig,
  encodeMediaFragment,
  hasMediaFragmentMagic,
  mediaRejectCode,
  readTlvU32,
  readTlvU64,
  tlvU16Pair,
  tlvU32,
  tlvU64,
  tlvU8,
} from "./media-pdu";

function mediaFragment(overrides: Partial<Parameters<typeof encodeMediaFragment>[0]> = {}): Uint8Array {
  return encodeMediaFragment({
    classValue: MediaFragmentClass.MEDIA,
    flags: MediaFragmentFlags.FIN,
    objectId: 7,
    fragmentIndex: 0,
    fragmentCount: 1,
    payload: new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  });
}

function parse(bytes: Uint8Array): MediaFragment {
  const verdict = decodeMediaFragment(bytes, "stream");
  if (!verdict.ok) {
    throw new Error(`expected a fragment, got ${verdict.reason}`);
  }
  return verdict.fragment;
}

describe("MLP fragment codec (MLP spec §5.2)", () => {
  it("round-trips every header field and the TLV registry", () => {
    const ext = [
      tlvU64(MediaTlv.UPDATE_ID, 0x1_0000_0002),
      tlvU64(MediaTlv.UPDATE_BASE, 0),
      tlvU16Pair(MediaTlv.PART, 3, 8),
      tlvU32(MediaTlv.UPDATE_BYTES, 1234),
      tlvU32(MediaTlv.CHAIN_EPOCH, 9),
      tlvU64(MediaTlv.REFLECTS_INPUT_SEQ, 42),
      tlvU64(MediaTlv.SEND_EPOCH_MS, 987_654),
      tlvU8(MediaTlv.PATH_HINT, 1),
    ];
    const bytes = encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      flags: MediaFragmentFlags.FIN | MediaFragmentFlags.ANCHOR,
      priority: 6,
      objectId: 0xdead_beef,
      fragmentIndex: 1,
      fragmentCount: 3,
      headerExt: ext,
      payload: new Uint8Array([9, 9, 9]),
    });

    const fragment = parse(bytes);
    expect(fragment.objectId).toBe(0xdead_beef);
    expect(fragment.fragmentIndex).toBe(1);
    expect(fragment.fragmentCount).toBe(3);
    expect(fragment.flags).toBe(MediaFragmentFlags.FIN | MediaFragmentFlags.ANCHOR);
    expect(Array.from(fragment.payload)).toEqual([9, 9, 9]);
    expect(readTlvU64(fragment, MediaTlv.UPDATE_ID)).toBe(0x1_0000_0002);
    expect(readTlvU32(fragment, MediaTlv.UPDATE_BYTES)).toBe(1234);
    expect(readTlvU64(fragment, MediaTlv.SEND_EPOCH_MS)).toBe(987_654);
    expect(fragment.wireBytes).toBe(bytes.byteLength);
    // 8 TLVs: 8+8+4+4+4+8+8+1 value bytes plus 2 bytes of headers each.
    expect(bytes.byteLength).toBe(FRAGMENT_FIXED_HEADER + 61 + 3);
  });

  it("recognizes the RMLP magic and rejects everything else", () => {
    const bytes = mediaFragment();
    expect(hasMediaFragmentMagic(bytes)).toBe(true);
    expect(hasMediaFragmentMagic(new Uint8Array([0x52, 0x4d, 0x4c]))).toBe(false);

    const broken = new Uint8Array(bytes);
    broken[0] = 0x00;
    expect(decodeMediaFragment(broken, "stream")).toEqual({ ok: false, reason: "BAD_MAGIC" });
  });

  it("rejects a foreign version with UNSUPPORTED_VERSION", () => {
    const bytes = mediaFragment();
    const broken = new Uint8Array(bytes);
    broken[4] = 3;
    expect(decodeMediaFragment(broken, "stream")).toEqual({
      ok: false,
      reason: "UNSUPPORTED_VERSION",
    });
    expect(mediaRejectCode("UNSUPPORTED_VERSION")).toBe(2);
  });

  it("rejects a reserved class and a reserved flag bit", () => {
    const bytes = mediaFragment();
    const badClass = new Uint8Array(bytes);
    badClass[5] = 9;
    expect(decodeMediaFragment(badClass, "stream")).toEqual({ ok: false, reason: "BAD_CLASS" });

    const badFlags = new Uint8Array(bytes);
    badFlags[6] = 0x80;
    expect(decodeMediaFragment(badFlags, "stream")).toEqual({ ok: false, reason: "BAD_FLAGS" });
  });

  it("reserves priorities 0 and 1 for control/cursor/feedback", () => {
    expect(() => encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      priority: 1,
      objectId: 1,
      fragmentIndex: 0,
      fragmentCount: 1,
      payload: new Uint8Array([1]),
    })).toThrow();

    const bytes = mediaFragment();
    const reserved = new Uint8Array(bytes);
    reserved[7] = 1;
    expect(decodeMediaFragment(reserved, "stream")).toEqual({ ok: false, reason: "BAD_PRIORITY" });
    const tooHigh = new Uint8Array(bytes);
    tooHigh[7] = 8;
    expect(decodeMediaFragment(tooHigh, "stream")).toEqual({ ok: false, reason: "BAD_PRIORITY" });
  });

  it("rejects a broken fragment identity", () => {
    const bytes = mediaFragment();
    const view = new DataView(bytes.buffer);
    view.setUint16(12, 4, true);
    view.setUint16(14, 2, true);
    expect(decodeMediaFragment(bytes, "stream")).toEqual({ ok: false, reason: "BAD_FRAGMENT" });
  });

  it("rejects a payload or extension that overruns the fragment", () => {
    const bytes = mediaFragment();
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 4096, true);
    expect(decodeMediaFragment(bytes, "stream")).toEqual({ ok: false, reason: "BAD_LENGTH" });

    const ext = new Uint8Array([MediaTlv.UPDATE_ID, 200]);
    expect(() => encodeMediaFragment({
      classValue: MediaFragmentClass.CONTROL,
      objectId: 1,
      fragmentIndex: 0,
      fragmentCount: 1,
      headerExt: [{ type: MediaTlv.UPDATE_ID, value: new Uint8Array(300) }],
      payload: new Uint8Array([1]),
    })).toThrow();

    // A TLV whose length runs past the extension is BAD_EXT, never a partial
    // read: [type 0x10, len 5, two bytes] with header_ext_len = 4.
    const truncated = mediaFragment();
    const broken = new Uint8Array(FRAGMENT_FIXED_HEADER + 4 + 4);
    broken.set(truncated.subarray(0, FRAGMENT_FIXED_HEADER));
    broken.set([0x10, 0x05, 0x01, 0x02], FRAGMENT_FIXED_HEADER);
    broken.set([1, 2, 3, 4], FRAGMENT_FIXED_HEADER + 4);
    new DataView(broken.buffer).setUint16(20, 4, true);
    new DataView(broken.buffer).setUint32(16, 4, true);
    expect(decodeMediaFragment(broken, "stream")).toEqual({ ok: false, reason: "BAD_EXT" });
    expect(ext.byteLength).toBe(2);
  });

  it("skips unknown TLVs and counts nothing as an error", () => {
    const bytes = encodeMediaFragment({
      classValue: MediaFragmentClass.CURSOR,
      objectId: 3,
      fragmentIndex: 0,
      fragmentCount: 1,
      headerExt: [
        { type: 0x10, value: new Uint8Array([1, 2, 3]) },
        { type: 0xf5, value: new Uint8Array([4]) },
        tlvU32(MediaTlv.PACE_BPS, 32_000),
      ],
      payload: new Uint8Array([1]),
    });
    const fragment = parse(bytes);
    expect(readTlvU32(fragment, MediaTlv.PACE_BPS)).toBe(32_000);
    expect(fragment.headerExt).toHaveLength(3);
  });

  it("accepts 1..N fragments on a stream carrier and exactly one on a datagram", () => {
    const first = mediaFragment({ objectId: 1 });
    const second = mediaFragment({ objectId: 2 });
    const concatenated = new Uint8Array(first.byteLength + second.byteLength);
    concatenated.set(first, 0);
    concatenated.set(second, first.byteLength);

    const stream = decodeMediaMessage(concatenated, "stream");
    expect(stream.ok).toBe(true);
    if (stream.ok) {
      expect(stream.fragments.map((fragment) => fragment.objectId)).toEqual([1, 2]);
    }

    const datagram = decodeMediaMessage(concatenated, "datagram");
    expect(datagram).toEqual({ ok: false, reason: "MULTI_FRAGMENT_ON_DATAGRAM" });

    const multiFragmentObject = mediaFragment({ objectId: 3, fragmentIndex: 0, fragmentCount: 2 });
    expect(decodeMediaMessage(multiFragmentObject, "datagram")).toEqual({
      ok: false,
      reason: "MULTI_FRAGMENT_ON_DATAGRAM",
    });
  });

  it("rejects trailing bytes after a complete fragment", () => {
    const bytes = mediaFragment();
    const trailing = new Uint8Array(bytes.byteLength + 1);
    trailing.set(bytes, 0);
    expect(decodeMediaFragment(trailing, "stream")).toEqual({ ok: false, reason: "BAD_LENGTH" });
  });
});

describe("MLP object assembly (MLP spec §5.4)", () => {
  it("assembles a multi-fragment object in any arrival order", () => {
    const assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(100));
    const part = new Uint8Array([1, 2]);
    const middle = encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      objectId: 11,
      fragmentIndex: 1,
      fragmentCount: 3,
      headerExt: [tlvU64(MediaTlv.UPDATE_ID, 5)],
      payload: new Uint8Array([3, 4]),
    });
    const last = encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      flags: MediaFragmentFlags.FIN,
      objectId: 11,
      fragmentIndex: 2,
      fragmentCount: 3,
      payload: part,
    });
    const first = encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      objectId: 11,
      fragmentIndex: 0,
      fragmentCount: 3,
      headerExt: [tlvU64(MediaTlv.UPDATE_ID, 5)],
      payload: part,
    });

    const fragments = [first, last, middle].map((bytes) => parse(bytes));
    expect(assembler.accept(fragments[0], 0, 0).kind).toBe("incomplete");
    expect(assembler.accept(fragments[1], 0, 0).kind).toBe("incomplete");
    const outcome = assembler.accept(fragments[2], 0, 0);
    expect(outcome.kind).toBe("object");
    if (outcome.kind === "object") {
      expect(Array.from(outcome.object.payload)).toEqual([1, 2, 3, 4, 1, 2]);
      // The extension of fragment 0 is the object's metadata (the sender
      // stamps UpdateMeta there and only there).
      expect(readTlvU64(outcome.object, MediaTlv.UPDATE_ID)).toBe(5);
    }
  });

  it("drops duplicate fragments inside the dedupe window", () => {
    const assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(100));
    const fragment = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.CONTROL,
      flags: MediaFragmentFlags.FIN | MediaFragmentFlags.DUP,
      objectId: 3,
      fragmentIndex: 0,
      fragmentCount: 1,
      payload: new Uint8Array([1]),
    }));

    expect(assembler.accept(fragment, 0, 0).kind).toBe("object");
    expect(assembler.accept(fragment, 0, 0)).toEqual({ kind: "drop", reason: "duplicate" });
    expect(assembler.duplicateFragments).toBe(1);
  });

  it("drops an expired object before it can reach the canvas", () => {
    const assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(100));
    const fragment = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      flags: MediaFragmentFlags.FIN,
      objectId: 4,
      fragmentIndex: 0,
      fragmentCount: 1,
      headerExt: [tlvU64(MediaTlv.DEADLINE_EPOCH_MS, 500)],
      payload: new Uint8Array([1]),
    }));

    expect(assembler.accept(fragment, 0, 600)).toEqual({ kind: "drop", reason: "expired" });
    expect(assembler.accept(fragment, 0, 499).kind).toBe("object");
  });

  it("rejects a fragment whose count contradicts the open object and keeps it open", () => {
    const assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(100));
    const first = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      objectId: 5,
      fragmentIndex: 0,
      fragmentCount: 2,
      payload: new Uint8Array([1]),
    }));
    const mismatched = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      objectId: 5,
      fragmentIndex: 1,
      fragmentCount: 3,
      payload: new Uint8Array([2]),
    }));

    assembler.accept(first, 0, 0);
    // Step 6's reject refuses the fragment, not the object: the reference
    // implementation returns `Dropped{FragmentMismatch}` with `self.open`
    // untouched (`rm_sans_io::media::object::ObjectAssembler::accept`).
    expect(assembler.accept(mismatched, 1, 0)).toEqual({
      kind: "reject",
      reason: "FRAGMENT_MISMATCH",
    });
    expect(assembler.openObjects).toBe(1);
    expect(assembler.openObjectBytes).toBe(1);
    expect(assembler.evictedObjects).toBe(0);

    // Step 5 ran before step 6, so the mismatching fragment already claimed
    // `(object_id, 1)` in the dedupe window: a well-formed fragment at the
    // same index is a duplicate (the reference records the pair in
    // `dedupe.check_and_insert` before the join). The object therefore cannot
    // complete and step 7 releases it.
    const repaired = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      flags: MediaFragmentFlags.FIN,
      objectId: 5,
      fragmentIndex: 1,
      fragmentCount: 2,
      payload: new Uint8Array([9]),
    }));
    expect(assembler.accept(repaired, 2, 0)).toEqual({ kind: "drop", reason: "duplicate" });
    expect(assembler.openObjects).toBe(1);
    expect(assembler.expire(1_801)).toEqual([5]);
    expect(assembler.openObjects).toBe(0);
  });

  it("keeps the class mismatch behaviour identical and lets the object time out", () => {
    const assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(100));
    const control = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.CONTROL,
      objectId: 6,
      fragmentIndex: 0,
      fragmentCount: 2,
      payload: new Uint8Array([1]),
    }));
    const foreignClass = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      objectId: 6,
      fragmentIndex: 1,
      fragmentCount: 2,
      payload: new Uint8Array([2]),
    }));

    assembler.accept(control, 0, 0);
    expect(assembler.accept(foreignClass, 1, 0)).toEqual({
      kind: "reject",
      reason: "FRAGMENT_MISMATCH",
    });
    expect(assembler.openObjects).toBe(1);

    // Step 7 releases it: the only rule that discards a partial object.
    expect(assembler.expire(1_801)).toEqual([6]);
    expect(assembler.expiredObjects).toBe(1);
    expect(assembler.openObjects).toBe(0);
  });

  it("treats a repeat of the mismatching fragment as a duplicate, not a second reject", () => {
    const assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(100));
    const first = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      objectId: 7,
      fragmentIndex: 0,
      fragmentCount: 2,
      payload: new Uint8Array([1]),
    }));
    const mismatched = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      objectId: 7,
      fragmentIndex: 1,
      fragmentCount: 3,
      payload: new Uint8Array([2]),
    }));

    assembler.accept(first, 0, 0);
    expect(assembler.accept(mismatched, 1, 0).kind).toBe("reject");
    // The dedupe window (step 5) is checked before the join, so the pair is
    // already recorded and the repeat is a duplicate in both implementations.
    expect(assembler.accept(mismatched, 2, 0)).toEqual({ kind: "drop", reason: "duplicate" });
    expect(assembler.openObjects).toBe(1);
    expect(assembler.duplicateFragments).toBe(1);
  });

  it("leaves other open objects untouched by one object's mismatch", () => {
    const assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(100));
    const other = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      objectId: 8,
      fragmentIndex: 0,
      fragmentCount: 2,
      payload: new Uint8Array([1]),
    }));
    const victim = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      objectId: 9,
      fragmentIndex: 0,
      fragmentCount: 2,
      payload: new Uint8Array([1]),
    }));
    const mismatched = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      objectId: 9,
      fragmentIndex: 1,
      fragmentCount: 4,
      payload: new Uint8Array([2]),
    }));

    assembler.accept(other, 0, 0);
    assembler.accept(victim, 1, 0);
    expect(assembler.accept(mismatched, 2, 0).kind).toBe("reject");
    expect(assembler.openObjects).toBe(2);
    expect(assembler.openObjectBytes).toBe(2);
  });

  it("bounds open objects and evicts the oldest with ASSEMBLY_EVICTED", () => {
    const assembler = new MediaObjectAssembler({
      ...defaultObjectAssemblerConfig(100),
      maxOpenObjects: 2,
    });
    for (let objectId = 1; objectId <= 3; objectId += 1) {
      const fragment = parse(encodeMediaFragment({
        classValue: MediaFragmentClass.MEDIA,
        objectId,
        fragmentIndex: 0,
        fragmentCount: 2,
        payload: new Uint8Array([1]),
      }));
      assembler.accept(fragment, objectId * 10, 0);
    }

    expect(assembler.openObjects).toBe(2);
    expect(assembler.evictedObjects).toBe(1);
  });

  it("expires an incomplete object after the assembly timeout", () => {
    const assembler = new MediaObjectAssembler(defaultObjectAssemblerConfig(100));
    const fragment = parse(encodeMediaFragment({
      classValue: MediaFragmentClass.MEDIA,
      objectId: 6,
      fragmentIndex: 0,
      fragmentCount: 2,
      payload: new Uint8Array([1]),
    }));
    assembler.accept(fragment, 1_000, 0);
    expect(assembler.nextExpiryInMs(1_000)).toBe(800);
    expect(assembler.expire(1_801)).toEqual([6]);
    expect(assembler.expiredObjects).toBe(1);
  });
});

describe("the 64-id ack grid (MLP spec §6.2)", () => {
  it("marks, shifts and reports the window", () => {
    const window = new MediaAckWindow();
    expect(window.highestAppliedUpdateId).toBe(0);
    expect(window.bitmapNumber()).toBe(0);

    window.mark(10);
    expect(window.highestAppliedUpdateId).toBe(10);
    expect(window.bitmapNumber()).toBe(1);
    expect(window.has(10)).toBe(true);
    expect(window.has(9)).toBe(false);

    window.mark(12);
    expect(window.highestAppliedUpdateId).toBe(12);
    // bit 0 = update 12, bit 1 = update 11 (not applied), bit 2 = update 10.
    expect(window.bitmapNumber()).toBe(0b101);
    expect(window.has(10)).toBe(true);
    expect(window.has(11)).toBe(false);

    window.mark(11);
    expect(window.bitmapNumber()).toBe(0b111);
  });

  it("keeps 64 ids and forgets anything older", () => {
    const window = new MediaAckWindow();
    window.mark(1);
    window.mark(100);
    expect(window.has(100)).toBe(true);
    expect(window.has(1)).toBe(false);

    window.mark(37);
    expect(window.has(37)).toBe(true);
    // Bit 63 cannot travel as a JS number; the clamp is counted and leaves the
    // sender's conservative re-send path in charge (§§7.5.2's ring-miss rule).
    expect(window.bitmapNumber()).toBe(1);
    expect(window.truncatedBits).toBe(1);
  });

  it("seeds from a resume ack", () => {
    const window = new MediaAckWindow();
    window.seedFromResume(42);
    expect(window.highestAppliedUpdateId).toBe(42);
    expect(window.bitmapNumber()).toBe(1);
  });
});
