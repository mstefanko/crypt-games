import { expect, it } from "vitest";
import { createSkylineDriver } from "../../../apps/audio-arcade/src/games/skyline/driver";
import {
  inspectOwner,
  stepOwner,
} from "../../../apps/audio-arcade/src/development-inspector";
import type { ArcadeGame } from "../../../apps/audio-arcade/src/types";

it("steps the production Skyline owner exactly once from fractional banks without changing event ownership", () => {
  for (const bank of [
    0,
    1 / 240,
    1 / 120,
    1 / 60 - 1e-10,
    0.000033883333333333335,
    0.000044983333333333334,
    0.00005053333333333333,
  ]) {
    const driver = createSkylineDriver(42);
    driver.step(bank);
    driver.command({ kind: "recover" });
    const before = driver.snapshot();
    const reference = createSkylineDriver(42);
    reference.restoreOwner(before);
    reference.command({ kind: "cancel" });
    reference.step(Math.min(1 / 60, 1 / 60 - bank + (2 * Number.EPSILON) / 60));
    const expectedEvents = reference.drainEvents();
    const game = driver as unknown as ArcadeGame;
    expect(inspectOwner(game).checkpoint).toEqual(before);
    expect(driver.snapshot()).toEqual(before);
    const report = stepOwner(game);
    expect(report.advancedTicks).toBe(1);
    expect(driver.snapshot().ticks).toBe(before.ticks + 1);
    expect(driver.snapshot().bank).toBeGreaterThanOrEqual(0);
    expect(driver.snapshot().bank).toBeLessThan((8 * Number.EPSILON) / 60);
    expect(driver.snapshot()).toEqual(reference.snapshot());
    expect(report.suppressedEvents).toEqual(expectedEvents);
    expect(report.suppressedEvents).not.toHaveLength(0);
    expect(driver.drainEvents()).toEqual([]);
    expect(driver.rawObservation()).toEqual(reference.rawObservation());
  }
});
it("reports unsupported owners without selecting a delta or mutating their state", () => {
  let updates = 0;
  const game = {
    id: "rally",
    snapshot: () => ({ identity: "recorded-delta", pending: [1] }),
    update: () => {
      updates++;
    },
  } as unknown as ArcadeGame;
  expect(inspectOwner(game)).toMatchObject({
    singleTick: false,
    checkpoint: { pending: [1] },
  });
  expect(() => stepOwner(game)).toThrow("unsupported");
  expect(updates).toBe(0);
});

it("rolls owner state and pending events back if a development step or drain fails", () => {
  for (const failure of ["step", "postcondition", "drain"] as const) {
    const driver = createSkylineDriver(42);
    driver.step(1 / 240);
    driver.command({ kind: "recover" });
    driver.command({ kind: "input", left: true, right: false, jump: true });
    const before = driver.snapshot();
    const originalStep = driver.step;
    const originalDrain = driver.drainEvents;
    if (failure === "step")
      driver.step = (dt) => {
        originalStep(dt);
        throw new Error("injected step failure");
      };
    if (failure === "postcondition") driver.step = () => {};
    if (failure === "drain")
      driver.drainEvents = () => {
        originalDrain();
        throw new Error("injected drain failure");
      };
    expect(() => stepOwner(driver as unknown as ArcadeGame)).toThrow();
    expect(driver.snapshot()).toEqual(before);
    driver.step = originalStep;
    driver.drainEvents = originalDrain;
    const reference = createSkylineDriver(42);
    reference.restoreOwner(before);
    expect(driver.drainEvents()).toEqual(reference.drainEvents());
  }
});
