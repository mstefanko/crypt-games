import { describe, expect, it } from "vitest";
import { createCryptballSession } from "../sim/session";
// The same runner consumes the archived baseline bundle and current session.
import { SlideTracker } from "../lab/slides.mjs";
import { runMatch } from "../lab/metrics.mjs";
describe("headless lab evidence", () => {
  it("repeats paired seeded measurements exactly and conserves sampled occupancy", () => {
    const options = {
      seed: 71,
      ticks: 360,
      config: { slideLaunchSpeed: 240, slideEndSpeed: 120 },
    };
    const a = runMatch(createCryptballSession, options);
    expect(runMatch(createCryptballSession, options)).toEqual(a);
    expect(a.roster).toHaveLength(4);
    expect(
      a.heatmap.counts.reduce((sum: number, n: number) => sum + n, 0),
    ).toBe(a.playTicks);
    expect(a.raw.thirds.reduce((sum: number, n: number) => sum + n, 0)).toBe(
      a.playTicks,
    );
    expect(a.raw.emptyTicks).toBeLessThanOrEqual(a.playTicks);
    expect(a.shotsOnTarget).toBeNull();
    expect(a.savePercentage).toBeNull();
    expect(a.slideOutcomes.attempts).toBe(a.slides);
    expect(
      a.slideOutcomes.intercepts +
        a.slideWhiffs +
        a.slideOutcomes.pendingAttempts,
    ).toBe(a.slides);
  });
  it("counts one intercept per slide and censors incomplete whiff penalty windows", () => {
    const tracker = new SlideTracker();
    const before = createCryptballSession().observe();
    const active = structuredClone(before);
    active.phase = "play";
    active.tick = 1;
    active.players[0].slideTicks = 18;
    tracker.observe(before, active, [
      { type: "slide", tick: 1, playerId: "player-0", team: 0 },
      { type: "slide-contact", tick: 1, playerId: "player-0" },
      { type: "slide-contact", tick: 1, playerId: "player-0" },
    ]);
    expect(tracker.result(1).pendingAttempts).toBe(1);
    const ended = structuredClone(active);
    ended.tick = 19;
    ended.players[0].slideTicks = 0;
    tracker.observe(active, ended, []);
    expect(tracker.result(19).intercepts).toBe(1);
    expect(tracker.result(19).contacts).toBe(2);
    const next = structuredClone(ended);
    next.tick = 90;
    next.players[0].slideTicks = 18;
    tracker.observe(ended, next, [
      { type: "slide", tick: 90, playerId: "player-0", team: 0 },
    ]);
    const whiff = structuredClone(next);
    whiff.tick = 108;
    whiff.players[0].slideTicks = 0;
    tracker.observe(next, whiff, []);
    expect(tracker.result(108).censoredWhiffWindows).toBe(1);
    const goal = structuredClone(whiff);
    goal.tick = 150;
    goal.score[1]++;
    tracker.observe(whiff, goal, []);
    expect(tracker.result(228)).toMatchObject({
      attempts: 2,
      intercepts: 1,
      whiffs: 1,
      whiffsWithFullTwoSecondWindow: 1,
      whiffsConcedingWithinTwoSeconds: 1,
      whiffPenaltyFraction: 1,
    });
  });
});
