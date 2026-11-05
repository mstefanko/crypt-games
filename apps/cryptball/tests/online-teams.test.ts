import { describe, it, expect } from "vitest";
import { MatchAuthority } from "../../cryptball-server/src/model";
import { decodeSnapshot, encodeSnapshot } from "../protocol";
import { SPORT_IDS } from "../sim/session";
describe("authoritative club choice", () => {
  it("honors Foxes over an unclaimed default and preserves readiness for unchanged fallback", () => {
    const m = new MatchAuthority("foxes");
    // Exercise an unclaimed opposing default explicitly; room defaults are seeded.
    const cp = m.session.capture(); cp.state.teamIds = ["rams", "foxes"]; m.session.restore(cp);
    m.join("a", "a", "foxes");
    expect(m.teamIds).toEqual(["foxes", "rams"]);
    m.ready("a");
    m.join("b", "b", "foxes");
    expect(m.teamIds).toEqual(["foxes", "rams"]);
    expect(m.peers.get("a")!.ready).toBe(true);
    m.join("c", "c", "hornets");
    expect(m.teamIds).toEqual(["foxes", "rams"]);
    expect(m.peers.get("a")!.ready).toBe(true);
  });
  it("honors first side preference and resolves duplicate join preferences deterministically", () => {
    const m = new MatchAuthority("teams");
    m.join("a", "a", "bats"); m.join("b", "b", "bats"); m.join("c", "c", "owls");
    expect(m.teamIds).toEqual(["bats", "rams"]);
    expect(m.lobby().seats.map(p=>p.team)).toEqual([0,1,0]);
    expect(()=>m.join("bad", "bad", "unknown")).toThrow();
    expect(m.peers.size).toBe(3);
    m.remove("a"); m.remove("c");
    m.join("d", "d", "hornets");
    expect(m.teamIds).toEqual(["bats", "rams"]);
  });
  it.each(SPORT_IDS)("validates %s waiting selections and persists teams into snapshots and rematches", (sportId) => {
    const m = new MatchAuthority("teams", false, sportId);
    const cp = m.session.capture(); cp.state.teamIds = ["rams", "foxes"]; m.session.restore(cp);
    m.join("a", "a"); m.join("b", "b");
    m.ready("a");
    expect(m.selectTeam("a", "foxes")).toBe(false);
    expect(m.peers.get("a")!.ready).toBe(true);
    expect(m.selectTeam("a", "owls")).toBe(true);
    expect(m.peers.get("a")!.ready).toBe(false);
    expect(m.selectTeam("missing", "bats")).toBe(false);
    m.drop("a"); expect(m.selectTeam("a", "bats")).toBe(false);
    m.reconnect("a"); expect(m.teamIds).toEqual(["owls", "foxes"]);
    m.ready("a"); m.ready("b"); m.start();
    expect(m.selectTeam("a", "bats")).toBe(false);
    for(let i=0;i<180;i++) m.advance();
    expect(decodeSnapshot(encodeSnapshot(m.snapshot("a", []))).checkpoint.state.teamIds).toEqual(["owls", "foxes"]);
    m.phase="results";m.rematch("a");m.rematch("b");
    expect(m.lobby().teamIds).toEqual(["owls", "foxes"]);
    expect(m.session.capture().state.teamIds).toEqual(["owls", "foxes"]);
  });
});
