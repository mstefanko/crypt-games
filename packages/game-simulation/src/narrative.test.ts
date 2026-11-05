import { describe, expect, it } from "vitest";
import { NarrativeSession, type NarrativeDefinition } from "./narrative";
import { NarrativeProtocol } from "./narrative-protocol";
import { tuesdayContent } from "../../../apps/audio-arcade/src/games/tuesday/content";
function arrive(s: NarrativeSession, id: string) {
  const h = s.scene.hotspots.find((h) => h.id === id)!;
  s.walk(h.cell, h.id);
  for (
    let i = 0;
    i < 500 && (s.state.pendingHotspot || s.state.path.length);
    i++
  )
    s.update(1 / 60);
}
describe("Tuesday ownership and walking", () => {
  it("detaches all publicly exposed references", () => {
    const d = structuredClone(tuesdayContent),
      s = new NarrativeSession(d, 743),
      before = s.snapshot();
    d.scenes[0].walkable.fill(false);
    (s.state as any).player.x = 100;
    (s.state as any).history.length = 0;
    s.scene.walkable.fill(false);
    s.node.options![0].next = "failure";
    s.definition.nodes.length = 0;
    expect(s.snapshot()).toEqual(before);
    expect(() => {
      (s as any).state = {};
    }).toThrow();
  });
  it("enters dialogue only after arrival and refuses walls/forged hotspots", () => {
    const s = new NarrativeSession(tuesdayContent, 743);
    s.choose("begin");
    const h = s.scene.hotspots.find((h) => h.id === "mara")!;
    s.walk(h.cell, "mara");
    expect(s.state.node).toBe("street");
    s.walk(4 * 20 + 9, "mara");
    expect(s.state.pendingGoal).toBe(h.cell);
    for (let i = 0; i < 400; i++) s.update(1 / 60);
    expect(s.state.node).toBe("mara");
    s.leaveConversation();
    s.walk(10 * 20 + 3);
    for (let i = 0; i < 300; i++) s.update(1 / 60);
    expect(s.state.node).toBe("street");
  });
  it("restores active search, walking and reveal continuation exactly", () => {
    const s = new NarrativeSession(tuesdayContent, 743);
    s.choose("begin");
    s.walk(6 * 20 + 4, "mara");
    for (const steps of [0, 30, 60]) {
      for (let i = 0; i < steps; i++) s.update(1 / 60);
      const b = new NarrativeSession(tuesdayContent, 743);
      b.restore(JSON.parse(JSON.stringify(s.snapshot())));
      for (let i = 0; i < 20; i++) {
        s.update(1 / 60);
        b.update(1 / 60);
      }
      expect(b.snapshot()).toEqual(s.snapshot());
    }
    s.choose("listen");
    s.roll();
    expect(s.state.reveal).toBeDefined();
    const b = new NarrativeSession(tuesdayContent, 743);
    b.restore(s.snapshot());
    for (let i = 0; i < 61; i++) {
      s.update(1 / 60);
      b.update(1 / 60);
    }
    expect(s.state.reveal).toBeUndefined();
    expect(b.snapshot()).toEqual(s.snapshot());
  });
  it("rejects malformed checkpoint atomically", () => {
    const s = new NarrativeSession(tuesdayContent, 743);
    const baseline = s.snapshot();
    for (const mutate of [
      (v: any) => (v.state.scene = "missing"),
      (v: any) => (v.state.player.x = NaN),
      (v: any) => (v.state.path = [1]),
      (v: any) => (v.state.baseSkills.Logic = -3),
      (v: any) => (v.state.thoughts = [{ id: "missing", progress: 0 }]),
      (v: any) => (v.random.streams[0].seed = 77),
      (v: any) => (v.identity.seed = 55),
      (v: any) => (v.state.cues = [{ id: 999, kind: "bad" }]),
    ]) {
      const v = structuredClone(baseline);
      mutate(v);
      expect(() => s.restore(v)).toThrow();
      expect(s.snapshot()).toEqual(baseline);
    }
  });
  it("preserves the normal no-check compromise ending", () => {
    const s = new NarrativeSession(tuesdayContent, 743);
    s.choose("begin");
    arrive(s, "door");
    expect(s.state.scene).toBe("office");
    expect(s.state.node).toBe("oren");
    s.choose("compromise");
    s.choose("sign");
    expect(s.state.ending).toBe("compromise");
    expect(s.state.stats).toEqual({ health: 3, morale: 3 });
  });
  it("drives a bounded second narrative consumer through the shared protocol", () => {
    const d: NarrativeDefinition = {
      title: "Lost Letter",
      start: "start",
      failureNode: "end",
      skills: ["Notice"],
      profiles: [{ id: "reader", name: "Reader", skills: { Notice: 2 } }],
      clothing: [],
      thoughts: [],
      nodes: [
        {
          id: "start",
          kind: "choice",
          speaker: "Postmaster",
          text: "A letter awaits.",
          options: [{ id: "read", label: "Read", next: "street" }],
        },
        {
          id: "street",
          kind: "return",
          speaker: "Lane",
          text: "Walk to the box.",
        },
        {
          id: "end",
          kind: "end",
          speaker: "Letter",
          text: "Home.",
          ending: "delivered",
        },
      ],
      scenes: [
        {
          id: "lane",
          name: "Lane",
          width: 3,
          height: 1,
          walkable: [true, true, true],
          spawn: 0,
          hotspots: [
            {
              id: "box",
              name: "Mailbox",
              cell: 2,
              node: "end",
              kind: "object",
              color: 0,
            },
          ],
        },
      ],
    };
    const a = new NarrativeProtocol(d, 5);
    expect(
      a.command({ kind: "choose", id: "read", sequence: 1, revision: 0 }),
    ).toBe(true);
    expect(a.command({ kind: "choose", id: "read", sequence: 1 })).toBe(false);
    expect(
      a.command({ kind: "walk", cell: 2, hotspot: "box", sequence: 2 }),
    ).toBe(true);
    a.step(0.1);
    const b = new NarrativeProtocol(d, 5);
    b.restore(a.snapshot());
    for (let i = 0; i < 20; i++) {
      a.step(0.1);
      b.step(0.1);
    }
    expect(a.observe().ending).toBe("delivered");
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.drainEvents()).toEqual(a.drainEvents());
    expect(a.drainEvents()).toEqual([]);
  });
});

function walkTo(s: NarrativeSession, id: string) {
  const h = s.scene.hotspots.find((h) => h.id === id)!;
  s.walk(h.cell, h.id);
  for (let i = 0; i < 100; i++) s.update(0.1);
}
function settleRoll(s: NarrativeSession) {
  expect(s.canCheck).toBe(true);
  s.roll();
  for (let i = 0; i < 10; i++) s.update(0.1);
}
function alternateWitness(seed: number) {
  const s = new NarrativeSession(tuesdayContent, seed);
  s.choose("begin");
  walkTo(s, "vale");
  s.choose("command");
  settleRoll(s);
  expect(s.state.node).toBe("authority-failure");
  s.continue();
  s.continue();
  walkTo(s, "mara");
  s.choose("witness");
  s.continue();
  s.continue();
  expect(s.state.flags["delivery-slip"]).toBe(true);
  walkTo(s, "door");
  return s;
}
describe("Tuesday authored outcome qualification", () => {
  it("reaches the evidence ending through the alternate witness and preserves red permanence", () => {
    const s = alternateWitness(1);
    expect(s.state.checks["sealed-register"].success).toBe(false);
    s.choose("street");
    walkTo(s, "vale");
    s.choose("command");
    expect(s.canCheck).toBe(false);
    s.invest("Authority");
    s.wear("coat");
    expect(s.canCheck).toBe(false);
    const before = s.snapshot();
    s.roll();
    expect(s.snapshot()).toEqual(before);
    s.leaveConversation();
    walkTo(s, "door");
    s.choose("evidence");
    expect(s.state.ending).toBe("evidence");
  });
  it("reaches trust through the authored red check and restores deterministic dice", () => {
    const s = new NarrativeSession(tuesdayContent, 3);
    s.choose("begin");
    walkTo(s, "door");
    s.choose("persuade");
    const b = new NarrativeSession(tuesdayContent, 3);
    b.restore(s.snapshot());
    settleRoll(s);
    settleRoll(b);
    expect(s.state.checks["oren-trust"].dice).toEqual([3, 6]);
    expect(s.state.ending).toBe("persuasion");
    expect(b.snapshot()).toEqual(s.snapshot());
  });
  it("reaches exhaustion through legal white-check investments; clothing cannot retry", () => {
    const s = alternateWitness(19);
    for (let i = 0; i < 3; i++) {
      walkTo(s, "archive");
      settleRoll(s);
      expect(s.state.checks["archive-order"].success).toBe(false);
      if (i < 2) {
        walkTo(s, "archive");
        expect(s.canCheck).toBe(false);
        s.wear("coat");
        expect(s.canCheck).toBe(false);
        s.invest("Composure");
        expect(s.canCheck).toBe(true);
      }
    }
    expect(s.state.stats.health).toBe(0);
    expect(s.state.ending).toBe("exhaustion");
    expect(s.state.checks["archive-order"].attempts).toBe(3);
  });
  it("does not duplicate node rewards and completes thought modifiers after committed actions", () => {
    const s = new NarrativeSession(tuesdayContent, 1);
    s.choose("begin");
    walkTo(s, "mara");
    s.choose("invoices");
    s.continue();
    expect(s.state.inventory.receipt).toBe(1);
    s.continue();
    s.choose("invoices");
    s.continue();
    expect(s.state.inventory.receipt).toBe(1);
    s.continue();
    s.leaveConversation();
    const composure = s.skill("Composure"),
      perception = s.skill("Perception");
    walkTo(s, "ivo");
    s.choose("thought");
    expect(s.skill("Composure")).toBe(composure - 1);
    s.continue();
    walkTo(s, "mara");
    s.choose("invoices");
    expect(s.state.thoughts[0].progress).toBe(3);
    expect(s.skill("Composure")).toBe(composure);
    expect(s.skill("Perception")).toBe(perception + 2);
    const logic = s.skill("Logic");
    s.wear("glasses");
    expect(s.skill("Logic")).toBe(logic + 1);
  });
});
