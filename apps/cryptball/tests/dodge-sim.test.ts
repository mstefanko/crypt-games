import { describe, it, expect } from "vitest";
import {
  createInitialState,
  createCryptballSession,
  stepState,
} from "../sim/session";
import type { State, CommandFrame } from "../sim/contract";
import { DeterministicRandom } from "@onepage/game-simulation/random";
import {
  DODGE,
  dodgeAI,
  dodgeAIResponse,
} from "../sim/modes/crypt-dodge/index";
const F = 256;
function fixture(mode: "match" | "practice" = "practice") {
  const s = createInitialState(mode, {}, "crypt-dodge", undefined, 2);
  s.phase = "play";
  s.phaseTicks = 0;
  s.dodge!.subphase = "live";
  s.controllers = s.players.map((p) => ({
    id: p.id,
    playerId: p.id,
    team: p.team,
    active: true,
    canSwitch: false,
    pendingSwitch: null,
    switchReady: 0,
    revision: 0,
  }));
  s.participantStats = Object.fromEntries(
    s.controllers.map((c) => [c.id, { shots: 0, passes: 0, goals: 0 }]),
  );
  const rng = new DeterministicRandom([
    { owner: "cryptball", name: "ai", seed: 1 },
  ]);
  const tick = (commands: Record<string, CommandFrame> = {}) =>
    stepState(s, {}, rng, commands);
  s.ball.x = s.players[0].x;
  s.ball.y = s.players[0].y;
  tick();
  return { s, tick };
}
function flight(s: State, x: number, y: number, vx: number, vy = 0) {
  Object.assign(s.dodge!.ball, {
    state: "hostile-flight",
    holderId: null,
    attackingTeam: 0,
    receivingTeam: 1,
    throwId: s.dodge!.ball.throwId + 1,
    releaseTick: s.tick,
    hitClaim: null,
    passTarget: null,
    passerId: "player-0",
  });
  s.possessionId = null;
  Object.assign(s.ball, {
    x: x * F,
    y: y * F,
    z: 12 * F,
    vx: vx * F,
    vy: vy * F,
    vz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
  });
}
function armed(
  s: State,
  id: string,
  kind: "standing" | "dive" = "standing",
  heading = 128,
) {
  const p = s.players.find((p) => p.id === id)!;
  p.heading = heading;
  p.slideHeading = heading;
  Object.assign(s.dodge!.athletes[id], {
    catchStart: s.tick - 3,
    catchKind: kind,
    catchReady: s.tick + 30,
  });
}
describe("Crypt Dodge deterministic contacts", () => {
  it("a legal standing catch claims before that athlete's hurtbox", () => {
    const { s, tick } = fixture();
    s.players[2].x = 48 * F;
    s.players[2].y = 0;
    armed(s, "player-2");
    flight(s, 28, 0, 260);
    tick();
    expect(s.dodge!.ball.state).toBe("held");
    expect(s.possessionId).toBe("player-2");
    expect(s.dodge!.athletes["player-2"].lives).toBe(3);
    expect(s.events.filter((e) => e.type === "dodge-catch")).toHaveLength(1);
  });
  it("an earlier body hit beats a later teammate catch even at tunneling speed", () => {
    const { s, tick } = fixture();
    s.players[2].x = 40 * F;
    s.players[2].y = 0;
    s.players[3].x = 80 * F;
    s.players[3].y = 0;
    armed(s, "player-3");
    flight(s, 20, 0, 7500);
    tick();
    expect(s.dodge!.athletes["player-2"].lives).toBe(2);
    expect(s.dodge!.athletes["player-3"].lives).toBe(3);
    expect(s.dodge!.ball.state).toBe("dead-loose");
  });
  it("wrong-facing and recovered catches cannot protect a body", () => {
    for (const expired of [false, true]) {
      const { s, tick } = fixture();
      s.players[2].x = 44 * F;
      s.players[2].y = 0;
      armed(s, "player-2", "standing", expired ? 128 : 0);
      if (expired) s.dodge!.athletes["player-2"].catchStart = s.tick - 20;
      flight(s, 30, 0, 260);
      tick();
      expect(s.dodge!.athletes["player-2"].lives).toBe(2);
    }
  });
  it("simultaneous legal catches use stable athlete ID", () => {
    const { s, tick } = fixture();
    s.players[2].x = s.players[3].x = 48 * F;
    s.players[2].y = -7 * F;
    s.players[3].y = 7 * F;
    armed(s, "player-2");
    armed(s, "player-3");
    flight(s, 28, 0, 2000);
    tick();
    expect(s.possessionId).toBe("player-2");
  });
  it("dive contact uses its committed active window and extended reach", () => {
    const { s, tick } = fixture();
    s.players[2].x = 52 * F;
    s.players[2].y = 0;
    armed(s, "player-2", "dive");
    s.players[2].slideTicks = 14;
    flight(s, 27, 0, 260);
    tick();
    expect(s.possessionId).toBe("player-2");
    expect(s.players[2].slideTicks).toBe(13);
    expect(s.dodge!.athletes["player-2"].lives).toBe(3);
  });
  it("one throw loses at most one life and never pierces", () => {
    const { s, tick } = fixture();
    s.players[2].x = 40 * F;
    s.players[2].y = 0;
    s.players[3].x = 80 * F;
    s.players[3].y = 0;
    flight(s, 26, 0, 7500);
    tick();
    for (let i = 0; i < 20; i++) tick();
    expect(
      s.dodge!.athletes["player-2"].lives + s.dodge!.athletes["player-3"].lives,
    ).toBe(5);
  });
  it("friendly bodies are harmless; wall and floor remove hostility", () => {
    const { s, tick } = fixture();
    s.players[0].x = -40 * F;
    s.players[0].y = 0;
    flight(s, -54, 0, 260);
    tick();
    expect(s.dodge!.athletes["player-0"].lives).toBe(3);
    flight(s, 159, 70, 260);
    tick();
    expect(s.dodge!.ball.state).toBe("dead-loose");
    flight(s, 0, 70, 260);
    s.ball.z = 5 * F;
    s.ball.vz = -20 * F;
    tick();
    expect(s.dodge!.ball.state).toBe("dead-loose");
  });
  it("immune contact kills the throw without winning sudden death", () => {
    const { s, tick } = fixture("match");
    s.dodge!.subphase = "sudden-death";
    s.dodge!.suddenDeathTicks = 100;
    s.players[2].x = 40 * F;
    s.players[2].y = 0;
    s.players[2].immunityTicks = 30;
    flight(s, 26, 0, 260);
    tick();
    expect(s.dodge!.athletes["player-2"].lives).toBe(3);
    expect(s.phase).toBe("play");
    expect(s.dodge!.ball.state).not.toBe("hostile-flight");
  });
});

describe("Crypt Dodge bot fairness", () => {
  const reflectedId = (id: string | null) =>
    id === null ? null : `player-${(Number(id.slice(-1)) + 2) % 4}`;
  function mirror(source: State): State {
    const s = structuredClone(source),
      d = s.dodge!;
    s.players = s.players.map((p) => ({
      ...p,
      id: reflectedId(p.id)!,
      team: p.team === 0 ? 1 : 0,
      x: -p.x,
      vx: -p.vx,
      rx: -p.rx,
      heading: (128 - p.heading + 256) % 256,
      slideHeading: (128 - p.slideHeading + 256) % 256,
      dashHeading: (128 - p.dashHeading + 256) % 256,
    }));
    d.athletes = Object.fromEntries(
      Object.entries(d.athletes).map(([id, a]) => [reflectedId(id), a]),
    );
    d.openingTeam = d.openingTeam === 0 ? 1 : 0;
    d.possessionTeam =
      d.possessionTeam === null ? null : d.possessionTeam === 0 ? 1 : 0;
    for (const record of d.balls) {
    const b = record.mode;
    record.possessionTeam = record.possessionTeam === null ? null : record.possessionTeam === 0 ? 1 : 0;
    b.holderId = reflectedId(b.holderId);
    b.attackingTeam =
      b.attackingTeam === null ? null : b.attackingTeam === 0 ? 1 : 0;
    b.receivingTeam = b.receivingTeam === 0 ? 1 : 0;
    b.passerId = reflectedId(b.passerId);
    b.passTarget = reflectedId(b.passTarget);
    b.hitClaim = reflectedId(b.hitClaim);
    s.possessionId = reflectedId(s.possessionId);
    record.physical.x = -record.physical.x;
    record.physical.vx = -record.physical.vx;
    record.physical.rx = -record.physical.rx;
    }
    return s;
  }
  it("mirrors bot movement, aim and defensive choices across either side", () => {
    for (const seed of [1, 2, 3, 7, 19])
      for (const hostile of [false, true]) {
        const { s } = fixture();
        s.dodge!.aiSeed = seed;
        if (hostile) {
          s.tick = 20;
          s.players[2].x = 48 * F;
          s.players[2].y = 0;
          flight(s, 12, 0, 210);
          s.dodge!.ball.releaseTick = 0;
        }
        const mirrored = mirror(s),
          a = dodgeAI(s, new Map()),
          b = dodgeAI(mirrored, new Map());
        for (const [id, c] of a) {
          const other = b.get(reflectedId(id)!);
          expect(other).toEqual({
            ...c,
            moveX: c.moveX ? -c.moveX : 0,
            ...(c.aim === undefined ? {} : { aim: (128 - c.aim + 256) % 256 }),
          });
        }
      }
  });
  it("fixes one seeded catch opportunity per throw without a repeated reroll", () => {
    let opportunities = 0;
    for (let seed = 0; seed < 200; seed++)
      if (dodgeAIResponse(seed, 1, 0).catch) opportunities++;
    expect(opportunities).toBeGreaterThan(0);
    expect(opportunities).toBeLessThan(200);
    const { s } = fixture();
    const seed = Array.from({ length: 100 }, (_, i) => i).find(
      (i) => dodgeAIResponse(i, 1, 0).catch,
    )!;
    s.dodge!.aiSeed = seed;
    s.tick = 25;
    s.players[2].x = 48 * F;
    s.players[2].y = 0;
    flight(s, 12, 0, 210);
    s.dodge!.ball.releaseTick = 0;
    const first = dodgeAI(s, new Map()).get("player-2")!;
    expect(first.strikePressed || first.slide).toBe(true);
    s.tick += 6;
    const second = dodgeAI(s, new Map()).get("player-2")!;
    expect(second.strikePressed || second.slide).not.toBe(true);
    expect(s.dodge!.athletes["player-2"].aiThrowId).toBe(1);
  });
  it("both sides can win a twelve-seed sample with moderate catches and complete matches", () => {
    let throws = 0,
      catches = 0;
    const winners = new Set();
    for (let seed = 1; seed <= 12; seed++) {
      const session = createCryptballSession({ sportId: "crypt-dodge", seed });
      session.setParticipants([]);
      let ticks = 0;
      while (session.getPhase() !== "results" && ticks < 32000) {
        session.step();
        ticks++;
        for (const e of session.drainEvents()) {
          if (e.type === "dodge-throw") throws++;
          if (e.type === "dodge-catch") catches++;
        }
      }
      expect(session.getPhase()).toBe("results");
      winners.add(session.observe().winner);
    }
    expect(winners).toEqual(new Set([0, 1]));
    expect(catches / throws).toBeGreaterThanOrEqual(0.2);
    expect(catches / throws).toBeLessThanOrEqual(0.6);
  }, 30000);
});
describe("Crypt Dodge possession and rounds", () => {
  it("same-side stuck recovery preserves the six-second possession deadline", () => {
    const { s, tick } = fixture();
    const deadline = s.dodge!.possessionDeadline;
    flight(s, -1, 0, 0);
    s.dodge!.ball.state = "dead-loose";
    s.dodge!.ball.attackingTeam = null;
    s.ball.z = 0;
    for (let i = 0; i < 90; i++) tick();
    expect(s.dodge!.ball.state).toBe("reset");
    expect(s.dodge!.possessionDeadline).toBe(deadline);
    expect(s.events.some((e) => e.type === "dodge-possession-transfer")).toBe(
      false,
    );
  });
  it("the floor kills hostility before a later body contact in the same substep", () => {
    const { s, tick } = fixture();
    s.players[2].x = 40 * F;
    s.players[2].y = 0;
    flight(s, 24, 0, 2600);
    s.ball.z = 5 * F + 1;
    s.ball.vz = -60 * F;
    tick();
    expect(s.dodge!.athletes["player-2"].lives).toBe(3);
    expect(s.events.some((e) => e.type === "dodge-ding")).toBe(false);
  });
  it("a held ball released outward cannot escape a closed wall", () => {
    const { s, tick } = fixture();
    s.players[0].x = -159 * F;
    s.players[0].y = 0;
    tick({ "player-0": { strikePressed: true, aim: 128 } });
    for (let i = 0; i < 7; i++) tick();
    expect(s.dodge!.ball.state).not.toBe("hostile-flight");
    expect(Math.abs(s.ball.x)).toBeLessThanOrEqual(161 * F);
  });
  it("hit collection lockout also prevents automatic friendly-pass reception", () => {
    const { s, tick } = fixture();
    s.players[0].x = -100 * F;
    s.players[0].y = 0;
    s.players[1].x = -70 * F;
    s.players[1].y = 0;
    s.dodge!.athletes["player-1"].collectAfter = 50;
    tick({ "player-0": { pass: true } });
    for (let i = 0; i < 20; i++) tick();
    expect(s.possessionId).not.toBe("player-1");
  });
  it("cancel preserves committed dive motion while suppressing simultaneous attack flags", () => {
    const { s, tick } = fixture();
    tick({ "player-2": { slide: true, aim: 128 } });
    tick({
      "player-2": {
        cancel: true,
        strikePressed: true,
        strikeHeld: true,
        pass: true,
      },
    });
    expect(s.players[2].slideTicks).toBe(16);
    expect(s.players[2].charging).toBe(false);
  });

  it("a catch held through primary cannot turn into an unintended throw", () => {
    const { s, tick } = fixture();
    s.players[2].x = 48 * F;
    s.players[2].y = 0;
    armed(s, "player-2");
    flight(s, 28, 0, 260);
    tick({ "player-2": { strikeHeld: true } });
    for (let i = 0; i < 40; i++) tick({ "player-2": { strikeHeld: true } });
    expect(s.possessionId).toBe("player-2");
    expect(s.players[2].charging).toBe(false);
    tick();
    tick({ "player-2": { strikePressed: true, strikeHeld: true } });
    expect(s.players[2].charging).toBe(true);
  });
  it("throws respect six ticks of visible release preparation and charge speed", () => {
    const { s, tick } = fixture();
    tick({ "player-0": { strikePressed: true, strikeHeld: true, aim: 0 } });
    for (let i = 0; i < 29; i++)
      tick({ "player-0": { strikeHeld: true, aim: 0 } });
    tick({ "player-0": { strikeReleased: true, aim: 0 } });
    expect(s.possessionId).toBe("player-0");
    for (let i = 0; i < 5; i++) tick();
    expect(s.possessionId).toBe("player-0");
    tick();
    expect(s.dodge!.ball.state).toBe("hostile-flight");
    expect(s.ball.vx).toBe(DODGE.chargedSpeed);
  });
  it("pass reception preserves the team deadline and grants an assisted release", () => {
    const { s, tick } = fixture();
    s.players[0].x = -100 * F;
    s.players[0].y = 0;
    s.players[1].x = -70 * F;
    s.players[1].y = 0;
    const deadline = s.dodge!.possessionDeadline;
    tick({ "player-0": { pass: true } });
    for (let i = 0; i < 30 && s.possessionId !== "player-1"; i++) tick();
    expect(s.possessionId).toBe("player-1");
    expect(s.dodge!.possessionDeadline).toBe(deadline);
    expect(s.dodge!.athletes["player-1"].passAssistUntil).toBeGreaterThan(
      s.tick,
    );
    tick({ "player-1": { strikePressed: true } });
    expect(s.dodge!.athletes["player-1"].pendingThrow!.releaseTick).toBe(
      s.tick + 4,
    );
  });
  it("an unavailable pass receiver turns the same ball safely loose", () => {
    const { s, tick } = fixture();
    tick({ "player-0": { pass: true } });
    s.dodge!.athletes["player-1"].lives = 0;
    tick();
    expect(s.dodge!.ball.state).toBe("dead-loose");
    expect(s.possessionId).toBe(null);
    expect(s.ball.x).toBeLessThan(0);
  });
  it("diving while holding drops one safe ball and cannot instantly collect it", () => {
    const { s, tick } = fixture();
    tick({ "player-0": { slide: true, aim: 0 } });
    expect(s.dodge!.ball.state).toBe("dead-loose");
    expect(s.possessionId).toBe(null);
    expect(s.players[0].slideTicks).toBe(17);
    expect(s.dodge!.athletes["player-0"].collectAfter).toBe(s.tick + 33);
  });
  it("standing catch from a touch press may be replaced by a committed flick dive", () => {
    const { s, tick } = fixture();
    tick({ "player-2": { strikePressed: true, strikeHeld: true } });
    tick({ "player-2": { slide: true } });
    expect(s.dodge!.athletes["player-2"].catchKind).toBe("dive");
    expect(s.players[2].slideTicks).toBe(17);
  });
  it("movement, dash and dives cannot cross the center strip", () => {
    const { s, tick } = fixture();
    s.players[0].x = -21 * F;
    s.players[2].x = 21 * F;
    for (let i = 0; i < 80; i++)
      tick({
        "player-0": { moveX: 1, dash: i === 0, slide: i === 20 },
        "player-2": { moveX: -1, dash: i === 0, slide: i === 20 },
      });
    expect(s.players[0].x).toBeLessThanOrEqual(-20 * F);
    expect(s.players[2].x).toBeGreaterThanOrEqual(20 * F);
  });
  it("possession gives a warning then transfers exactly at six seconds", () => {
    const { s, tick } = fixture();
    const deadline = s.dodge!.possessionDeadline;
    while (s.tick < deadline - 1) tick();
    expect(
      s.events.filter((e) => e.type === "dodge-possession-warning"),
    ).toHaveLength(1);
    expect(s.dodge!.ball.holderId).toBe("player-0");
    tick();
    expect(s.tick).toBe(deadline);
    expect(s.dodge!.ball.state).toBe("reset");
    expect(s.dodge!.ball.receivingTeam).toBe(1);
  });
  it("an unreachable center dead ball resets into the last receiving half", () => {
    const { s, tick } = fixture();
    flight(s, 0, 0, 0);
    s.dodge!.ball.state = "dead-loose";
    s.dodge!.ball.attackingTeam = null;
    s.ball.z = 0;
    for (let i = 0; i < 90; i++) tick();
    expect(s.dodge!.ball.state).toBe("reset");
    expect(s.ball.x).toBe(116 * F);
  });
  it("round elimination awards a round then reverses opening possession", () => {
    const { s, tick } = fixture("match");
    s.dodge!.athletes["player-2"].lives = s.dodge!.athletes["player-3"].lives =
      0;
    tick();
    expect(s.score).toEqual([1, 0]);
    expect(s.phase).toBe("goal");
    for (let i = 0; i < 90; i++) tick();
    expect(s.phase).toBe("ready");
    expect(s.dodge!.round).toBe(2);
    expect(s.dodge!.openingTeam).toBe(1);
    expect(s.dodge!.athletes["player-2"].lives).toBe(3);
  });
  it("tied regulation enters sudden death and a timed draw replays without awarding a win", () => {
    const { s, tick } = fixture("match");
    s.remainingTicks = 1;
    tick();
    expect(s.dodge!.subphase).toBe("sudden-death");
    s.dodge!.suddenDeathTicks = 1;
    tick();
    expect(s.score).toEqual([0, 0]);
    expect(s.dodge!.roundWinner).toBe("draw");
    for (let i = 0; i < 90; i++) tick();
    expect(s.dodge!.round).toBe(1);
    expect(s.dodge!.openingTeam).toBe(1);
  });
  it("two round wins create exactly one terminal event", () => {
    const { s, tick } = fixture("match");
    s.score = [1, 0];
    s.dodge!.athletes["player-2"].lives = s.dodge!.athletes["player-3"].lives =
      0;
    tick();
    for (let i = 0; i < 100; i++) tick();
    expect(s.phase).toBe("results");
    expect(s.winner).toBe(0);
    expect(s.events.filter((e) => e.type === "match-end")).toHaveLength(1);
  });
  it("restores exact held, flight, catch and round state and rejects cross-half/lifecycle edits", () => {
    const session = createCryptballSession({ sportId: "crypt-dodge", seed: 2 });
    for (let i = 0; i < 95; i++) session.step();
    const checkpoint = session.capture();
    session.restore(checkpoint);
    expect(session.capture()).toEqual(checkpoint);
    const crossing = structuredClone(checkpoint);
    crossing.state.players[0].x = 0;
    expect(() => session.restore(crossing)).toThrow();
    const lifecycle = structuredClone(checkpoint);
    lifecycle.state.dodge!.ball.holderId = "player-1";
    expect(() => session.restore(lifecycle)).toThrow();
  });

  it("solo elimination switches to a living bot once and disarms the old attack edge", () => {
    const session = createCryptballSession({ sportId: "crypt-dodge", seed: 1 });
    const cp = session.capture();
    cp.state.dodge!.athletes["player-0"].lives = 0;
    session.restore(cp);
    session.step({ strikePressed: true, strikeHeld: true });
    expect(session.observe().controlledId).toBe("player-1");
    expect(session.observe().players[1].charging).toBe(false);
    const changes = session.drainEvents().filter((e) => e.type === "switch");
    expect(changes).toHaveLength(1);
    expect(changes[0].automatic).toBe(true);
  });
  it("an eliminated online seat never steals its human-owned surviving teammate", () => {
    const session = createCryptballSession({ sportId: "crypt-dodge", seed: 1 });
    session.setParticipants([
      { id: "a", team: 0, playerId: "player-0" },
      { id: "b", team: 0, playerId: "player-1" },
    ]);
    const cp = session.capture();
    cp.state.dodge!.athletes["player-0"].lives = 0;
    session.restore(cp);
    session.stepParticipants({ a: { switch: true, switchTarget: "player-1" } });
    expect(session.observeFor("a").controlledId).toBe("player-0");
    expect(session.observeFor("b").controlledId).toBe("player-1");
  });
  it("new modes cannot activate mascot specials", () => {
    const { s, tick } = fixture();
    s.specials[0].cooldownTicks = 0;
    tick({ "player-0": { special: true } });
    expect(s.specials.every((t) => t.active === null)).toBe(true);
  });
  it("seeded bots finish full best-of-three matches deterministically", () => {
    const outcomes = [];
    for (const seed of [1, 2, 3]) {
      const a = createCryptballSession({ sportId: "crypt-dodge", seed });
      a.setParticipants([]);
      let steps = 0;
      while (a.getPhase() !== "results" && steps < 32000) {
        a.step();
        a.drainEvents();
        steps++;
      }
      expect(a.getPhase(), `seed ${seed}, score ${a.observe().score}`).toBe(
        "results",
      );
      const cp = a.capture();
      const b = createCryptballSession({ sportId: "crypt-dodge", seed });
      b.restore(cp);
      expect(b.capture()).toEqual(cp);
      outcomes.push({ steps, score: a.observe().score });
    }
    expect(outcomes.every((o) => o.steps < 32000)).toBe(true);
  }, 30000);
});

describe("Crypt Dodge two-ball rules", () => {
  it("opens with two separated dead balls on legal inner boundaries and no countdown pickup", () => {
    const s = createInitialState("match", {}, "crypt-dodge", undefined, 2);
    expect(s.dodge!.balls.map(b => b.mode.state)).toEqual(["dead-loose", "dead-loose"]);
    expect(s.dodge!.balls.map(b => b.mode.holderId)).toEqual([null,null]);
    expect(s.dodge!.balls.map(b => b.possessionDeadline)).toEqual([0,0]);
    expect(s.dodge!.balls.map(b => [b.physical.x,b.physical.y])).toEqual([[-20*F,-18*F],[20*F,18*F]]);
    const rng = new DeterministicRandom([{owner:"cryptball",name:"ai",seed:1}]);
    s.players[0].x = -20*F; s.players[0].y = -18*F;
    stepState(s,{},rng,{});
    expect(s.dodge!.balls.every(b => b.mode.holderId === null)).toBe(true);
  });
  it("lets both teams independently collect and prevents either holder collecting twice", () => {
    const {s,tick} = fixture();
    const second = s.dodge!.balls[1];
    second.physical.x = s.players[2].x; second.physical.y = s.players[2].y;
    tick();
    expect(s.dodge!.balls.map(b => b.mode.holderId)).toEqual(["player-0","player-2"]);
    expect(s.dodge!.balls.every(b => b.possessionDeadline > s.tick)).toBe(true);
    second.mode.state = "dead-loose"; second.mode.holderId = null; second.physical.vx = second.physical.vy = 0;
    second.physical.x = s.players[0].x; second.physical.y = s.players[0].y;
    tick();
    expect(second.mode.holderId).toBe(null);
  });
  it("consumes a catch once when both balls arrive together", () => {
    const {s,tick} = fixture();
    s.players[2].x = 48*F; s.players[2].y = 0;
    armed(s,"player-2"); flight(s,28,0,350);
    const second = s.dodge!.balls[1];
    Object.assign(second.mode,{...s.dodge!.ball,throwId:s.dodge!.ball.throwId+1});
    Object.assign(second.physical,{...s.ball});
    tick();
    expect(s.events.filter(e => e.type === "dodge-catch")).toHaveLength(1);
    expect(s.dodge!.balls.filter(b => b.mode.holderId === "player-2")).toHaveLength(1);
    expect(s.events.find(e => e.type === "dodge-catch")!.ballId).toBe("dodge-0");
  });
  it("retires a dead ball at 1v1 while preserving a live shot", () => {
    const {s,tick} = fixture();
    s.dodge!.athletes["player-1"].lives = 0; s.dodge!.athletes["player-3"].lives = 0;
    flight(s,-50,0,210); tick();
    expect(s.dodge!.balls[0].retired).toBe(false);
    expect(s.dodge!.balls[0].mode.state).toBe("hostile-flight");
    expect(s.dodge!.balls[1].retired).toBe(true);
  });
  it("a pass empowers a quick release to full speed without restarting the ball deadline", () => {
    const {s,tick} = fixture();
    s.players[0].x=-100*F; s.players[0].y=0; s.players[1].x=-70*F; s.players[1].y=0;
    const deadline=s.dodge!.balls[0].possessionDeadline;
    tick({"player-0":{pass:true}});
    while(s.dodge!.ball.holderId !== "player-1" && s.tick < 40) tick();
    expect(s.dodge!.athletes["player-1"].passAssistUntil).toBe(s.tick+48);
    tick({"player-1":{strikePressed:true,aim:0}});
    for(let i=0;i<4;i++) tick();
    expect(s.ball.vx).toBe(DODGE.chargedSpeed);
    expect(s.dodge!.ball.powered).toBe(true);
    expect(s.dodge!.balls[0].possessionDeadline).toBe(deadline);
  });
  it("one ball reset preserves another holder's prepared release", () => {
    const {s,tick}=fixture();
    const second=s.dodge!.balls[1];
    second.physical.x=s.players[2].x; second.physical.y=s.players[2].y;
    tick();
    tick({"player-2":{strikePressed:true,aim:128}});
    const pending=s.dodge!.athletes["player-2"].pendingThrow;
    expect(pending).not.toBe(null);
    s.dodge!.balls[0].possessionDeadline=s.tick+1;
    s.dodge!.balls[0].transferAt=s.tick+1;
    tick();
    expect(s.dodge!.balls[0].mode.state).toBe("reset");
    expect(s.dodge!.athletes["player-2"].pendingThrow).toEqual(pending);
  });
  it("powered shots reject catch timing outside the central three ticks", () => {
    const {s,tick}=fixture();
    s.players[2].x=48*F; s.players[2].y=0;
    armed(s,"player-2");
    s.dodge!.athletes["player-2"].catchStart=s.tick-8;
    flight(s,28,0,350); s.dodge!.ball.powered=true;
    tick();
    expect(s.dodge!.ball.holderId).not.toBe("player-2");
    expect(s.events.filter(e => e.type === "dodge-catch")).toHaveLength(0);
  });
  it("held teammates cannot receive a pass or start a catch", () => {
    const {s,tick}=fixture();
    const second=s.dodge!.balls[1];
    second.physical.x=s.players[1].x; second.physical.y=s.players[1].y;
    tick();
    expect(second.mode.holderId).toBe("player-1");
    tick({"player-0":{pass:true},"player-1":{strikePressed:true,strikeHeld:true}});
    expect(s.dodge!.athletes["player-1"].catchKind).toBe(null);
    expect(s.dodge!.ball.state).toBe("dead-loose");
    expect(second.mode.holderId).toBe("player-1");
  });
  it("replays both balls across reconnect and rejects duplicate possession", () => {
    const a=createCryptballSession({sportId:"crypt-dodge",seed:21});
    for(let i=0;i<150;i++) a.step({});
    const saved=a.capture();
    const b=createCryptballSession({sportId:"crypt-dodge",seed:21}); b.restore(JSON.parse(JSON.stringify(saved)));
    for(let i=0;i<150;i++) { a.step({}); b.step({}); }
    expect(b.capture()).toEqual(a.capture());
    const corrupt=structuredClone(saved);
    const state=corrupt.state;
    const first=state.dodge!.balls[0], second=state.dodge!.balls[1];
    second.mode.holderId=first.mode.holderId ?? "player-0"; second.mode.state="held";
    first.mode.holderId=second.mode.holderId; first.mode.state="held";
    state.dodge!.ball=first.mode; state.possessionId=first.mode.holderId;
    expect(() => b.restore(corrupt)).toThrow();
  });
});


describe("powered catch commitment", () => {
  it.each([2,3,4,5,6,7,8])("standing catch at elapsed %i admits only the precision window", elapsed => {
    const {s,tick}=fixture();
    s.players[2].x=48*F;s.players[2].y=0;
    armed(s,"player-2");
    // stepState advances the tick before resolving contact.
    s.dodge!.athletes["player-2"].catchStart=s.tick+1-elapsed;
    flight(s,28,0,350);s.dodge!.ball.powered=true;
    tick();
    expect(s.events.some(e=>e.type==="dodge-catch")).toBe(elapsed>=4 && elapsed<7);
  });
  it("a fully charged shot cannot be dive caught",()=>{
    const {s,tick}=fixture();
    s.players[2].x=48*F;s.players[2].y=0;
    armed(s,"player-2","dive");
    flight(s,28,0,350);s.dodge!.ball.powered=true;
    tick();
    expect(s.events.some(e=>e.type==="dodge-catch")).toBe(false);
  });
});

it("duel bots commit to full power on two of three throw identities",()=>{
  for(const throwId of [0,1,2]) {
    const {s}=fixture();s.tick=100;
    s.dodge!.athletes["player-1"].lives=0;s.dodge!.athletes["player-3"].lives=0;
    const p=s.players[0];p.charging=true;p.chargeTicks=29;
    const b=s.dodge!.balls[0].mode;b.state="held";b.holderId=p.id;b.throwId=throwId;b.releaseTick=0;
    const c=dodgeAI(s,new Map()).get(p.id)!;
    expect(c.strikeHeld).toBe(throwId!==1);
    p.chargeTicks=30;
    expect(dodgeAI(s,new Map()).get(p.id)!.strikeReleased).toBe(true);
  }
});

it('separates two holders aiming at the same opponent instead of converging on one lane',()=>{
 const {s}=fixture();
 const holders=s.players.filter(p=>p.team===0);
 for(const p of holders){p.x=-60*F;p.y=0;}
 for(const p of s.players.filter(p=>p.team===1)){p.x=60*F;p.y=0;}
 for(const [i,b] of s.dodge!.balls.entries()){
   b.retired=false;b.mode.state='held';b.mode.holderId=holders[i].id;
   b.mode.receivingTeam=0;b.possessionTeam=0;
 }
 const commands=dodgeAI(s,new Map());
 expect(commands.get(holders[0].id)!.moveY).toBeLessThan(0);
 expect(commands.get(holders[1].id)!.moveY).toBeGreaterThan(0);
});
