import { describe, expect, it } from "vitest";
import { createCryptballSession, SPECIALS } from "../sim/session";
import { TEAM_IDS } from "../sim/team-identities";
import {
  specialHud,
  specialPhase,
  specialPose,
} from "../src/special-presentation";

describe("snapshot-driven special presentation", () => {
  it("shows opening charge, shared ready state and authoritative activator", () => {
    const state = createCryptballSession().observe();
    expect(specialHud(state, 0)).toMatchObject({
      ready: false,
      progress: 0,
      text: "12s",
    });
    state.specials[0].cooldownTicks = 0;
    expect(specialHud(state, 0).text).toBe("READY");
    state.specials[0].active = {
      playerId: state.players[0].id,
      elapsedTicks: 10,
      remainingTicks: 26,
      heading: 0,
      burstStart: 6,
      secondBurstAvailable: false,
      contactUsed: false,
      receptionUsed: false,
      stoppedTicks: -1,
    };
    expect(specialHud(state, 0).text).toBe("ACTIVE 0.4s · YOU");
  });
  it("reconstructs all six pose phases without replaying events or changing state", () => {
    for (const id of TEAM_IDS) {
      const state = createCryptballSession({
        teamIds: [id, id === "rams" ? "foxes" : "rams"],
      }).observe();
      const p = state.players.find((p) => p.team === 0)!;
      const duration = SPECIALS[id].durationTicks;
      const fallback = { clip: "idle", phase: 0, instance: "idle" };
      for (const elapsed of [0, 7, duration - 2]) {
        state.specials[0].active = {
          playerId: p.id,
          elapsedTicks: elapsed,
          remainingTicks: duration - elapsed,
          heading: 0,
          burstStart: 6,
          secondBurstAvailable: id === "bats",
          contactUsed: false,
          receptionUsed: false,
          stoppedTicks: -1,
        };
        const before = JSON.stringify(state);
        const pose = specialPose(p, state, fallback);
        if (
          ((id === "owls" || id === "hornets") && elapsed >= 6) ||
          specialPhase(elapsed, duration, id) === "gap"
        )
          expect(pose).toBe(fallback);
        else
          expect(pose.instance).toContain(specialPhase(elapsed, duration, id));
        expect(specialPose(p, structuredClone(state), fallback)).toEqual(pose);
        expect(JSON.stringify(state)).toBe(before);
      }
      p.slideRecovery = 4;
      expect(specialPose(p, state, fallback)).toBe(fallback);
      p.slideRecovery = 0;
      state.specials[0].active!.playerId = "teammate";
      expect(specialPose(p, state, fallback)).toBe(fallback);
    }
  });
});
