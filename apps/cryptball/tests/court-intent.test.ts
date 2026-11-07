import { describe, expect, it } from "vitest";
import { resolveCourtAction, COURT_ACTIONS } from "../src/court-intent";
import { createCryptballSession } from "../src/session";
import { InputScheduler } from "../src/online/input-scheduler";
import { RULES } from "../sim/rules";
import { volleyReach } from "../sim/modes/rift-volley";
import type { SportId } from "../src/contract";
const stateFor = (sportId: SportId) =>
  createCryptballSession({ sportId, mode: "match" }).observe();
describe("shared court action policy", () => {
  it("locks possession decisions and separates hockey commit from contextual poke", () => {
    for (const sport of ["cryptkick", "cryptcheck"] as const) {
      const s = stateFor(sport);
      s.possessionId = s.controlledId;
      const resolved = resolveCourtAction(s, "contextual");
      s.possessionId = null;
      expect(resolved).toEqual({ press: { pass: true }, held: {} });
      expect(resolveCourtAction(s, "contextual")).toEqual({
        press: { slide: true },
        held: sport === "cryptkick" ? { slide: true } : {},
      });
    }
    expect(resolveCourtAction(stateFor("cryptcheck"), "commit").press).toEqual({
      check: true,
    });
  });
  it("uses contact reach for possessionless Cryptball and actual Volley set geometry", () => {
    const s = stateFor("cryptball"),
      p = s.players.find((p) => p.id === s.controlledId)!;
    s.ball.x = p.x + RULES.reach;
    s.ball.y = p.y;
    expect(resolveCourtAction(s, "contextual").press).toEqual({ pass: true });
    s.ball.x++;
    expect(resolveCourtAction(s, "contextual").press).toEqual({ slide: true });
    const v = stateFor("rift-volley");
    v.volley!.serving = false;
    const q = v.players.find((p) => p.id === v.controlledId)!,
      reach = volleyReach("set");
    v.ball.x = q.x;
    v.ball.y = q.y;
    v.ball.z = reach.maxHeight;
    expect(resolveCourtAction(v, "contextual").press).toEqual({ pass: true });
    v.ball.z++;
    expect(resolveCourtAction(v, "contextual").press).toEqual({});
  });
  it("digs low descending balls, sets low rising balls, and serves with primary", () => {
    const s = stateFor("rift-volley"),
      p = s.players.find((p) => p.id === s.controlledId)!;
    s.volley!.serving = false;
    const dig = volleyReach("dig"),
      set = volleyReach("set"),
      serve = volleyReach("serve");
    s.ball.x = p.x + dig.radius;
    s.ball.y = p.y;
    s.ball.z = dig.maxHeight;
    s.ball.vz = -1;
    expect(resolveCourtAction(s, "contextual").press).toEqual({ slide: true });
    s.ball.x++;
    expect(resolveCourtAction(s, "contextual").press).toEqual({});
    s.ball.x = p.x;
    s.ball.z = dig.maxHeight + 1;
    expect(resolveCourtAction(s, "contextual").press).toEqual({ pass: true });
    s.ball.z = dig.maxHeight;
    s.ball.vz = 1;
    expect(resolveCourtAction(s, "contextual").press).toEqual({ pass: true });
    s.ball.vz = 0;
    expect(resolveCourtAction(s, "contextual").press).toEqual({ pass: true });
    s.ball.x = p.x + set.radius;
    s.ball.z = set.maxHeight;
    expect(resolveCourtAction(s, "contextual").press).toEqual({ pass: true });
    s.ball.x++;
    expect(resolveCourtAction(s, "contextual").press).toEqual({});
    s.volley!.serving = true;
    s.ball.x = p.x + serve.radius;
    s.ball.z = serve.maxHeight;
    expect(resolveCourtAction(s, "contextual").press).toEqual({
      strikePressed: true,
    });
    s.ball.z++;
    expect(resolveCourtAction(s, "contextual").press).toEqual({});
  });
  it("catches immediately empty-handed in dodge and escapes empty-handed in guardian", () => {
    const d = stateFor("crypt-dodge");
    for (const b of d.dodge!.balls) {
      b.mode.holderId = null;
      b.mode.state = "dead-loose";
    }
    expect(resolveCourtAction(d, "contextual").press).toEqual({
      strikePressed: true,
    });
    d.dodge!.balls[0]!.mode.holderId = d.controlledId;
    d.dodge!.balls[0]!.mode.state = "held";
    expect(resolveCourtAction(d, "contextual").press).toEqual({ pass: true });
    const g = stateFor("crypt-guardian");
    for (const b of g.guardian!.orbs) b.possessionId = null;
    expect(resolveCourtAction(g, "contextual").press).toEqual({ slide: true });
    const mine = g.players.find((p) => p.id === g.controlledId)!,
      ally = g.players.find((p) => p.id !== mine.id)!;
    ally.x = mine.x;
    ally.y = mine.y;
    g.guardian!.athletes[ally.id]!.status = "down";
    expect(resolveCourtAction(g, "contextual")).toEqual({
      press: {},
      held: { passHeld: true },
    });
    g.guardian!.orbs[0]!.possessionId = g.controlledId;
    expect(resolveCourtAction(g, "contextual").press).toEqual({ pass: true });
  });
  it("keeps concrete online commands ordered, including a short level slide while allocation is blocked", () => {
    for (const sport of Object.keys(COURT_ACTIONS) as SportId[]) {
      const s = stateFor(sport),
        action = resolveCourtAction(s, "commit"),
        scheduler = new InputScheduler();
      const edge = !COURT_ACTIONS[sport].level;
      scheduler.capture(action.press, 0, edge, sport);
      scheduler.capture({}, 1, edge, sport);
      expect(scheduler.allocate(10, 10, 2)?.command).toMatchObject(
        action.press,
      );
      expect(scheduler.allocate(11, 11, 3)?.command).not.toMatchObject(
        action.press,
      );
    }
  });
});
