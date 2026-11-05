import { describe, it, expect } from "vitest";
import { athleteAnimation, spriteHeading } from "../src/animation";
import { createCryptballSession } from "../sim/session";
describe("athlete presentation clips", () => {
  it("selects dedicated pass, power and slide poses without changing authority", () => {
    const observation = createCryptballSession().observe();
    const player = observation.players[0];
    player.slideTicks = 8;
    expect(athleteAnimation(player, observation).clip).toBe("slide");
    player.slideTicks = 0;
    player.charging = true;
    player.chargeTicks = 24;
    expect(athleteAnimation(player, observation).clip).toBe("power");
    player.charging = false;
    player.action = {
      kind: "pass",
      id: 1,
      elapsed: 1,
      charge: 0,
      timing: { tell: 3, active: 2, recover: 5 },
    } as typeof player.action;
    expect(athleteAnimation(player, observation).clip).toBe("pass");
    expect(player.action?.elapsed).toBe(1);
  });
  it("separates launch, recovery and keeper dive", () => {
    const state = createCryptballSession().observe();
    const player = state.players[0];
    player.slideTicks = 18;
    expect(athleteAnimation(player, state).clip).toBe("slide-launch");
    player.slideTicks = 0;
    player.slideRecovery = 10;
    expect(athleteAnimation(player, state).clip).toBe("slide-recover");
    player.slideRecovery = 0;
    player.role = "keeper";
    player.slideTicks = 14;
    expect(athleteAnimation(player, state).clip).toBe("keeper-dive");
  });
  it("selects the nearest of eight screen facings after projecting all world headings", () => {
    const clockwise = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
    for (let heading = 0; heading < 256; heading++) {
      const a = heading * Math.PI / 128;
      const u = Math.cos(a), v = Math.sin(a);
      const t = (v + 96) / 192;
      const left = 122 - 77 * t;
      const right = 518 + 78 * t;
      const x = left + ((u + 166) / 332) * (right - left) - 320.25;
      const y = 132 + t * 173 - 218.5;
      const index = (Math.round(Math.atan2(y, x) / (Math.PI / 4)) + 8) % 8;
      expect(spriteHeading(heading), `world heading ${heading}`).toBe(clockwise[index]);
    }
    expect(
      new Set(
        Array.from({ length: 256 }, (_, heading) => spriteHeading(heading)),
      ).size,
    ).toBe(8);
  });
});
