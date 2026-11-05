import { describe, expect, it } from "vitest";
import {
  createKartRaceSession,
  finishDecay,
  type KartRaceInput,
} from "./kart-race-session";
const drive: KartRaceInput = {
  kind: "drive",
  throttle: true,
  brake: false,
  steer: 0,
  drift: false,
};
describe("Rally race authority", () => {
  it("continues countdown, AI, item RNG, pending commands and events across JSON checkpoints", () => {
    for (const seed of [1, 2, 419]) {
      const a = createKartRaceSession(seed),
        b = createKartRaceSession(seed);
      for (let tick = 0; tick < 1200; tick++) {
        const input = {
          ...drive,
          steer: tick % 200 < 80 ? -1 : tick % 200 < 160 ? 1 : 0,
          drift: tick % 100 < 50,
          useItem: tick % 71 === 0,
          rescue: tick % 300 === 0,
          profile: tick < 3 ? tick : undefined,
        };
        a.command(input);
        b.restore(JSON.parse(JSON.stringify(a.snapshot())));
        a.step(0.05);
        b.step(0.05);
        expect(b.snapshot()).toEqual(a.snapshot());
        if (tick % 10 === 0) expect(b.drainEvents()).toEqual(a.drainEvents());
      }
    }
  }, 20000);
  it("rejects malformed restore and commands without owner changes; reads are detached", () => {
    const owner = createKartRaceSession(1);
    owner.command(drive);
    owner.step(0.05);
    const before = owner.snapshot();
    const edits: ((v: typeof before) => void)[] = [
      (v) => {
        v.seed++;
      },
      (v) => {
        v.karts[0]!.profile = 9;
      },
      (v) => {
        v.karts[0]!.x = NaN;
      },
      (v) => {
        v.progress[0]!.nextGate = 500;
      },
      (v) => {
        v.items.boxes[0]!.x++;
      },
      (v) => {
        v.items.rng = -1;
      },
      (v) => {
        v.items.inventory["intruder"] = "boost";
      },
      (v) => {
        v.events.push({
          sequence: 100,
          tick: 0,
          sourceId: "kart-0",
          kind: "box",
        });
      },
      (v) => {
        v.items.projectiles.push({
          id: "bad",
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          gravity: 0,
          radius: 1,
          life: 0,
          damage: 1,
          originX: 0,
        });
      },
      (v) => {
        delete v.karts[0];
      },
      (v) => {
        v.pending.steer = 20;
      },
      (v) => {
        v.progress[0]!.finishTime = 100;
      },
    ];
    for (const edit of edits) {
      const v = structuredClone(before);
      edit(v);
      expect(() => owner.restore(v)).toThrow();
      expect(owner.snapshot()).toEqual(before);
    }
    expect(owner.command({ ...drive, steer: NaN })).toBe(false);
    expect(() => owner.step(Infinity)).toThrow();
    expect(owner.snapshot()).toEqual(before);
    const observed = owner.observe() as unknown as {
      karts: { x: number }[];
      track: { points: { x: number }[] };
    };
    observed.karts[0]!.x = 0;
    observed.track.points[0]!.x = 0;
    expect(owner.snapshot()).toEqual(before);
  });
  it("continues finish coasting, DNF grace and retry with a new event cursor", () => {
    const a = createKartRaceSession(1),
      b = createKartRaceSession(1);
    for (let i = 0; i < 81; i++) a.step(0.05);
    const finish = a.snapshot();
    finish.phase = "finish";
    finish.progress[0]!.lap = 3;
    finish.progress[0]!.splits = [0, 0, finish.time];
    finish.progress[0]!.finishTime = finish.time;
    a.restore(finish);
    b.restore(finish);
    for (let i = 0; i < 200; i++) {
      a.step(0.05);
      b.step(0.05);
      expect(b.snapshot()).toEqual(a.snapshot());
      if (i % 10 === 0) b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    }
    expect(
      a
        .observe()
        .progress.slice(1)
        .every((r) => r.dnf || r.finishTime !== null),
    ).toBe(true);
    a.command({ ...drive, retry: true });
    a.step(0.05);
    expect(a.observe()).toMatchObject({
      phase: "grid",
      time: 0,
      tick: 0,
      sequence: 0,
      events: [],
    });
  });
  it("preserves the finish coasting curve to floating point precision", () => {
    for (const dt of [0, 1 / 120, 1 / 60, 0.025, 0.05])
      expect(Math.abs(finishDecay(dt) - Math.exp(-dt * 2))).toBeLessThan(1e-15);
  });
});
