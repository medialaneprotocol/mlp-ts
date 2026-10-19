import { describe, expect, it } from "vitest";

import {
  PATH_OSCILLATION_LIMIT,
  MediaPathSelector,
  pathSwitchCostMs,
  probeWindowMs,
  sustainedWindowMs,
} from "./media-path";

/** A datagram candidate the selector may promote — the W10 seam in a test. */
function datagramCandidate(options: {
  goodputBps: () => number;
  available?: () => boolean;
  probe?: () => number;
}) {
  return {
    path: "DC_DIRECT" as const,
    available: options.available ?? (() => true),
    goodputBps: options.goodputBps,
    probeDeliveredRatio: options.probe ?? (() => 0.9),
  };
}

describe("path selection, the S1 half (MLP spec §7.8)", () => {
  it("stays on ws with one candidate and never switches", () => {
    const selector = new MediaPathSelector({ now: () => 0 });
    selector.registerWebSocket(() => 1_000_000);
    expect(selector.activePath).toBe("WS");
    expect(selector.tick()).toBeNull();
    expect(selector.pathSwitches).toBe(0);
  });

  it("keeps the window arithmetic RTT-relative", () => {
    expect(sustainedWindowMs(400)).toBe(1_200);
    expect(probeWindowMs(400)).toBe(800);
    expect(pathSwitchCostMs(400)).toBe(400);
    expect(sustainedWindowMs(1)).toBe(3);
  });

  it("promotes only after the goodput is sustained for 3 × RTT", () => {
    let now = 0;
    const dcGoodput = 2_000_000;
    const selector = new MediaPathSelector({ rtt: () => 400, now: () => now });
    selector.registerWebSocket(() => 1_000_000);
    selector.register(datagramCandidate({ goodputBps: () => dcGoodput }));
    selector.noteProbeWindow("DC_DIRECT", 0.9);

    expect(selector.tick()).toBeNull();
    now += 1_000;
    expect(selector.tick()).toBeNull();
    now += 1_200;
    const change = selector.tick();
    expect(change?.toPath).toBe("DC_DIRECT");
    expect(change?.reason).toBe("goodput_promotion");
    expect(selector.activePath).toBe("DC_DIRECT");
    expect(selector.activePathValue).toBe(2);
    // S2: the switch records the time it happened, so the wire
    // `MediaPathChange.at_epoch_ms` is a real instant (§§6.3).
    expect(change?.atEpochMs).toBe(now);
  });

  it("demotes below 0.8 × the ws goodput after the sustained window", () => {
    let now = 0;
    const dcGoodput = { value: 2_000_000 };
    const selector = new MediaPathSelector({ rtt: () => 400, now: () => now });
    selector.registerWebSocket(() => 1_000_000);
    selector.register(datagramCandidate({ goodputBps: () => dcGoodput.value }));
    selector.noteProbeWindow("DC_DIRECT", 0.9);
    now += 1_000;
    selector.tick();
    now += 1_300;
    selector.tick();
    expect(selector.activePath).toBe("DC_DIRECT");

    dcGoodput.value = 100_000;
    expect(selector.tick()).toBeNull();
    now += 1_200;
    expect(selector.tick()?.toPath).toBe("WS");
    expect(selector.activePath).toBe("WS");
  });

  it("demotes immediately on a rejected probe window or a closed channel", () => {
    let now = 0;
    const selector = new MediaPathSelector({ rtt: () => 100, now: () => now });
    selector.registerWebSocket(() => 1_000_000);
    selector.register(datagramCandidate({ goodputBps: () => 5_000_000 }));
    selector.noteProbeWindow("DC_DIRECT", 0.9);
    now += 100;
    selector.tick();
    now += 300;
    selector.tick();
    expect(selector.activePath).toBe("DC_DIRECT");

    selector.noteProbeWindow("DC_DIRECT", 0.1);
    expect(selector.activePath).toBe("WS");

    selector.noteChannelClosed("DC_DIRECT");
    expect(selector.activePath).toBe("WS");
  });

  it("never refuses a candidate whose probe window has not passed", () => {
    let now = 0;
    const selector = new MediaPathSelector({ rtt: () => 100, now: () => now });
    selector.registerWebSocket(() => 1_000_000);
    selector.register(datagramCandidate({
      goodputBps: () => 5_000_000,
      probe: () => -1,
    }));
    for (let step = 0; step < 10; step += 1) {
      now += 1_000;
      expect(selector.tick()).toBeNull();
    }
    expect(selector.activePath).toBe("WS");
  });

  it("never switches during a plan or an input pulse", () => {
    let now = 0;
    const selector = new MediaPathSelector({ rtt: () => 100, now: () => now });
    selector.registerWebSocket(() => 1_000_000);
    selector.register(datagramCandidate({ goodputBps: () => 5_000_000 }));
    selector.noteProbeWindow("DC_DIRECT", 0.9);
    selector.notePlanActive(true);
    for (let step = 0; step < 10; step += 1) {
      now += 1_000;
      expect(selector.tick()).toBeNull();
    }
    selector.notePlanActive(false);
    selector.noteInputPulse(true);
    for (let step = 0; step < 10; step += 1) {
      now += 1_000;
      expect(selector.tick()).toBeNull();
    }
    selector.noteInputPulse(false);
    now += 300;
    expect(selector.tick()).toBeNull();
    now += 1_300;
    expect(selector.tick()?.toPath).toBe("DC_DIRECT");
  });

  it("disables datagram switching for the session after repeated demotions", () => {
    let now = 0;
    const dcGoodput = { value: 5_000_000 };
    const selector = new MediaPathSelector({ rtt: () => 100, now: () => now });
    selector.registerWebSocket(() => 1_000_000);
    selector.register(datagramCandidate({ goodputBps: () => dcGoodput.value }));

    const promote = () => {
      selector.noteProbeWindow("DC_DIRECT", 0.9);
      now += 1_000;
      selector.tick();
      now += 1_300;
      selector.tick();
      return selector.activePath;
    };

    expect(promote()).toBe("DC_DIRECT");
    for (let cycle = 1; cycle < PATH_OSCILLATION_LIMIT; cycle += 1) {
      selector.noteProbeWindow("DC_DIRECT", 0.1);
      expect(selector.activePath).toBe("WS");
      expect(promote()).toBe("DC_DIRECT");
    }
    selector.noteProbeWindow("DC_DIRECT", 0.1);
    expect(selector.activePath).toBe("WS");
    expect(selector.pathSwitchingDisabledUntilMs).toBeGreaterThan(now);
    expect(promote()).toBe("WS");
  });

  it("honours the the corresponding deployment setting=off kill switch (§§13)", () => {
    let now = 0;
    const selector = new MediaPathSelector({ selection: "off", rtt: () => 100, now: () => now });
    selector.registerWebSocket(() => 1_000_000);
    selector.register(datagramCandidate({ goodputBps: () => 5_000_000 }));
    selector.noteProbeWindow("DC_DIRECT", 0.9);
    for (let step = 0; step < 10; step += 1) {
      now += 1_000;
      expect(selector.tick()).toBeNull();
    }
    expect(selector.pathSelectionEnabled).toBe(false);
    expect(selector.activePath).toBe("WS");
  });
});
