import { describe, it, expect } from "vitest";
import { TEAM_IDS, TEAMS, createCryptballSession, resolveTeamSelection } from "../sim/session";
describe("team identities", () => {
  it("offers six cosmetic clubs without changing numeric sides", () => {
    expect(TEAM_IDS).toHaveLength(6);
    for (const team of TEAM_IDS) {
      expect(TEAMS[team].name).toBeTruthy();
      const session = createCryptballSession({teamIds: resolveTeamSelection(team)});
      expect(session.observe().teamIds[0]).toBe(team);
      expect(session.observe().players.map(p => p.team)).toEqual([0,0,1,1]);
    }
  });
  it("round trips identity and atomically rejects unknown or duplicate clubs", () => {
    const session = createCryptballSession({teamIds: ["owls", "bats"]});
    const checkpoint = session.capture();
    session.step(); session.restore(checkpoint);
    expect(session.capture()).toEqual(checkpoint);
    for (const ids of [["owls", "owls"], ["bogus", "bats"], ["owls"]]) {
      const bad = structuredClone(checkpoint); bad.state.teamIds = ids as never;
      expect(() => session.restore(bad)).toThrow();
      expect(session.capture()).toEqual(checkpoint);
    }
  });
});
