import { expect, it } from "vitest";
import { createKartRaceSession } from "./kart-race-session";
import { PlatformJourneySession } from "./platform-journey-session";
import { skylineContent } from "../../../apps/audio-arcade/src/games/skyline/content";
import { canonicalJson } from "./session-protocol";
it("keeps fixed-step Rally traces invariant under different presentation inspection schedules", () => {
  const a = createKartRaceSession(419),
    b = createKartRaceSession(419);
  for (let tick = 0; tick < 2400; tick++) {
    const input = {
      kind: "drive" as const,
      throttle: true,
      brake: false,
      steer: tick % 160 < 80 ? -1 : 1,
      drift: tick % 80 < 40,
      useItem: tick % 71 === 0,
      rescue: tick % 400 === 0,
    };
    a.command(input);
    b.command(input);
    a.step(1 / 60);
    b.step(1 / 60);
    a.observe(); // One presentation per simulation step.
    if (tick % 5 === 0) for (let frame = 0; frame < 3; frame++) b.observe(); // Skipped and repeated presentations.
    expect(b.drainEvents()).toEqual(a.drainEvents());
  }
  expect(canonicalJson(b.snapshot())).toBe(canonicalJson(a.snapshot()));
});
it("accumulates half-sized Skyline host deltas to the same fixed-tick state and events", () => {
  const a = new PlatformJourneySession(skylineContent, 311),
    b = new PlatformJourneySession(skylineContent, 311);
  for (let tick = 0; tick < 600; tick++) {
    const input = {
      kind: "input" as const,
      left: false,
      right: tick % 120 < 100,
      jump: tick % 90 < 8,
    };
    a.command(input);
    b.command(input);
    a.step(1 / 60);
    b.step(1 / 120);
    b.observe();
    b.step(1 / 120);
    expect(b.drainEvents()).toEqual(a.drainEvents());
    expect(b.observe()).toEqual(a.observe());
  }
  expect(b.snapshot()).toEqual(a.snapshot());
});

import { SettlementSession } from "./settlement-session";
import { winterContent } from "../../../apps/audio-arcade/src/games/winter/content";
it("runs Settlement at 1x and 4x to identical simulation time, jobs, events and navigation", () => {
  const a = new SettlementSession(winterContent, 419),
    b = new SettlementSession(winterContent, 419);
  for (const owner of [a, b])
    for (const building of owner.state.buildings.filter((b) =>
      ["gatherer", "logging"].includes(b.type),
    )) {
      owner.command(`select:${building.id}`);
      owner.command("staff:1");
    }
  b.command("speed:4");
  for (let i = 0; i < 1200; i++) {
    a.step(0.1);
    b.step(0.025);
    expect(b.drainEvents()).toEqual(a.drainEvents());
    if (i % 20 === 0) {
      const before = a.snapshot();
      a.state;
      a.definition;
      a.snapshot();
      expect(a.snapshot()).toEqual(before);
      expect({ ...b.snapshot(), speed: 1 }).toEqual(a.snapshot());
    }
  }
  expect({ ...b.snapshot(), speed: 1 }).toEqual(a.snapshot());
  expect(a.state.time).toBeGreaterThan(100);
});
