import { describe, expect, it } from "vitest";
import { MatchAuthority } from "../../cryptball-server/src/model";
import { decodeSnapshot, encodeSnapshot } from "../protocol";
function court() {
  return new MatchAuthority("friends", true, "cryptball", false, true);
}
describe("friends match lifecycle", () => {
  it("starts manually with two connected players and never auto starts", () => {
    const m = court();
    for (let i = 0; i < 4; i++) {
      m.admit(`p${i}`, "Player");
      m.ready(`p${i}`);
    }
    expect(m.phase).toBe("waiting");
    m.admit("watch", "Viewer");
    expect(m.start("watch")).toBe(false);
    expect(m.start("p0")).toBe(true);
    m.drop("p1");
    expect(m.phase).toBe("countdown");
    m.drop("p2");
    m.drop("p3");
    expect(m.phase).toBe("waiting");
  });
  it("admits bounded read-only spectators and preserves reconnect identity", () => {
    const m = court();
    m.admit("a", "A");
    m.admit("b", "B");
    m.start("a");
    for (let i = 0; i < 8; i++) m.admit(`w${i}`, "Viewer");
    expect(() => m.admit("overflow", "Viewer")).toThrow();
    expect(m.playNext("w0")).toBe(true);
    expect(m.playNext("w0")).toBe(false);
    expect(m.receive("w0", {})).toBe(false);
    expect(m.selectTeam("w0", m.teamIds[0])).toBe(false);
    m.drop("w0");
    m.reconnect("w0");
    expect(m.observers.get("w0")?.generation).toBe(2);
    expect(m.queue).toEqual(["w0"]);
    const snapshot = decodeSnapshot(encodeSnapshot(m.observerSnapshot([])));
    expect(snapshot.observer).toBe(true);
    expect(
      snapshot.checkpoint.state.controllers.some((c) => c.id === "w0"),
    ).toBe(false);
  });
  it("removes spectators and repeated leaves safely during play", () => {
    const m = court();
    m.admit("a", "A");
    m.admit("b", "B");
    m.start("a");
    for (let i = 0; i < 180; i++) m.advance();
    m.admit("watch", "Viewer", undefined, "queue");
    expect(m.queue).toEqual(["watch"]);
    expect(() => {
      m.remove("watch");
      m.remove("watch");
      m.remove("a");
      m.remove("a");
    }).not.toThrow();
    expect(m.queue).toEqual([]);
  });
  it("fills vacancies before kickoff and keeps the next start manual", () => {
    const m = court();
    for (let i = 0; i < 4; i++) m.admit(`p${i}`, "Player");
    m.admit("viewer", "Watcher", undefined, "queue");
    expect(m.queue).toEqual(["viewer"]);
    m.drop("p3");
    expect(m.peers.has("viewer")).toBe(false);
    m.remove("p3");
    expect(m.peers.get("viewer")?.playerId).toBe("player-3");
    expect(m.queue).toEqual([]);
    expect(m.phase).toBe("waiting");
  });

  it("a full viewer pool has room for incumbents after four queued viewers are promoted", () => {
    const m = court();
    for (let i = 0; i < 4; i++) m.admit(`p${i}`, "Player");
    m.start("p0");
    for (let i = 0; i < 8; i++)
      m.admit(`w${i}`, "Viewer", undefined, i < 4 ? "queue" : "watch");
    m.phase = "results";
    for (let i = 0; i < 4; i++) m.rematch(`p${i}`);
    for (let i = 0; i < 600; i++) m.advance();
    expect([...m.peers.keys()]).toEqual(["w0", "w1", "w2", "w3"]);
    expect(m.observers.size).toBe(8);
    expect(m.observers.has("p3")).toBe(true);
  });
  it("queues only for the next match with FIFO priority over returning players", () => {
    const m = court();
    for (let i = 0; i < 4; i++) m.admit(`p${i}`, "Player");
    m.start("p0");
    m.admit("w1", "First");
    m.admit("w2", "Second");
    m.playNext("w2");
    m.playNext("w1");
    m.remove("p3");
    expect(m.peers.has("w2")).toBe(false);
    m.phase = "results";
    m.rematch("p0");
    m.rematch("p1");
    m.rematch("p2");
    expect(m.phase).toBe("results");
    expect(m.lobby().returning).toEqual(["p0", "p1", "p2"]);
    expect(m.lobby().resultsTicksRemaining).toBe(600);
    for (let i = 0; i < 600; i++) m.advance();
    expect(m.phase).toBe("waiting");
    expect([...m.peers.keys()]).toEqual(["w2", "w1", "p0", "p1"]);
    expect(m.observers.has("p2")).toBe(true);
    expect(m.epoch).toBe(2);
  });
});
