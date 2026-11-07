import { describe, expect, it } from "vitest";
import { CourtTouchControls } from "../src/touch-controls";
import { resolveCourtAction } from "../src/court-intent";
import { createCryptballSession } from "../src/session";
const createControls = (reachable = true) => {
  const state = createCryptballSession().observe();
  const player = state.players.find((p) => p.id === state.controlledId)!;
  state.ball.x = player.x + (reachable ? 0 : 100 * 256);
  state.ball.y = player.y;
  return new CourtTouchControls(
    (intent) => resolveCourtAction(state, intent).press,
  );
};

const setup = () => {
  const c = createControls();
  c.down(10, 100, 100, 0);
  c.movePointer(10, 140, 100, 10);
  return c;
};
describe("court touch pointer roles", () => {
  it("owns movement by ID, excludes extra contacts and passes once only after a short second tap", () => {
    const c = setup();
    c.down(20, 400, 100, 20);
    c.down(30, 500, 100, 25);
    c.movePointer(30, 600, 100, 40);
    c.up(30, 600, 100, 50);
    expect(c.consume(60).edges).toEqual({});
    c.up(20, 405, 102, 90);
    expect(c.consume(100)).toMatchObject({
      edges: { pass: true },
      move: { x: 0.8, y: 0 },
      strikeHeld: false,
    });
    expect(c.consume(120).edges).toEqual({});
  });
  it("has no charge before recognition and independently aims a hold without changing movement", () => {
    const c = setup();
    c.down(20, 400, 100, 20);
    expect(c.consume(179)).toMatchObject({
      edges: {},
      strikeHeld: false,
      aiming: true,
    });
    expect(c.consume(180)).toMatchObject({
      edges: { strikePressed: true },
      strikeHeld: true,
    });
    c.movePointer(20, 400, 150, 190);
    expect(c.consume(200)).toMatchObject({
      edges: {},
      move: { x: 0.8, y: 0 },
      aim: { x: 0, y: 50 },
      strikeHeld: true,
    });
    c.up(20, 400, 150, 220);
    expect(c.consume(280)).toMatchObject({
      edges: { strikeReleased: true },
      aim: { x: 0, y: 50 },
      strikeHeld: false,
    });
  });
  it("flicks once in the action direction and never converts an established shot to a flick", () => {
    const c = setup();
    c.down(20, 400, 100, 20);
    c.movePointer(20, 400, 135, 100);
    expect(c.consume(110)).toMatchObject({
      edges: { slide: true },
      aim: { x: 0, y: 35 },
    });
    c.movePointer(20, 400, 180, 140);
    c.up(20, 400, 180, 150);
    expect(c.consume(220).edges).toEqual({});
    c.down(21, 400, 100, 240);
    c.consume(400);
    c.movePointer(21, 450, 100, 410);
    expect(c.consume(420)).toMatchObject({ edges: {}, strikeHeld: true });
  });
  it("cancels a queued flick on interruption without replaying it on a new contact", () => {
    const c = setup();
    c.down(20, 400, 100, 20);
    c.movePointer(20, 450, 100, 50);
    expect(c.visual.action?.phase).toBe("flick");
    c.cancel();
    expect(c.consume(60).edges).toEqual({});
    c.down(30, 100, 100, 80);
    expect(c.consume(90).edges).toEqual({});
    c.down(40, 400, 100, 100);
    c.movePointer(40, 450, 100, 120);
    expect(c.consume(130).edges).toEqual({ slide: true });
    expect(c.consume(140).edges).toEqual({});
  });
  it("disarms on movement lift, interruption and all-lift batches without phantom release or pass", () => {
    const c = setup();
    c.down(20, 400, 100, 20);
    c.consume(180);
    c.up(10, 140, 100, 200);
    c.up(20, 400, 100, 210);
    expect(c.consume(220)).toMatchObject({
      edges: { cancel: true },
      strikeHeld: false,
      move: { x: 0, y: 0 },
    });
    const d = setup();
    d.down(20, 400, 100, 20);
    d.consume(180);
    d.up(20, 400, 100, 200);
    d.up(10, 140, 100, 200);
    expect(d.consume(220).edges).toEqual({ cancel: true });
    const e = setup();
    e.down(20, 400, 100, 20);
    e.up(20, 400, 100, 100);
    e.up(10, 140, 100, 100);
    expect(e.consume(120).edges).toEqual({ pass: true });
    const f = setup();
    f.down(20, 400, 100, 20);
    f.consume(180);
    f.cancel();
    f.up(20, 400, 100, 210);
    expect(f.consume(220).edges).toEqual({ cancel: true });
    f.down(30, 100, 100, 230);
    expect(f.consume(250).edges).toEqual({});
  });
  it("supports neutral stationary shooting, bounded anchor following and one dash per near retouch", () => {
    const c = createControls();
    c.down(10, 100, 100, 0);
    c.movePointer(10, 250, 100, 20);
    expect(c.visual.movement?.anchor).toEqual({ x: 202, y: 100 });
    expect(c.consume(30).edges).toEqual({});
    c.movePointer(10, 202, 100, 40);
    expect(c.consume(50).move).toEqual({ x: 0, y: 0 });
    c.up(10, 202, 100, 60);
    c.down(11, 210, 100, 100);
    c.movePointer(11, 245, 100, 130);
    expect(c.consume(140).edges).toEqual({ dash: true });
    c.movePointer(11, 250, 100, 160);
    expect(c.consume(170).edges).toEqual({});
    c.up(11, 250, 100, 180);
    c.down(12, 400, 100, 200);
    c.movePointer(12, 450, 100, 220);
    expect(c.consume(230).edges).toEqual({});
  });
  it("only switches targeted teammate on an unambiguous action tap, never movement start", () => {
    const c = createControls(false);
    c.down(10, 100, 100, 0, "player-1");
    c.up(10, 100, 100, 20);
    expect(c.consume(30).edges).toEqual({});
    c.down(11, 100, 100, 50);
    c.down(20, 400, 100, 60, "player-1");
    c.up(20, 400, 100, 120);
    expect(c.consume(130).edges).toEqual({
      switch: true,
      switchTarget: "player-1",
    });
    c.disarmAction();
    expect(c.visual.movement).toBeDefined();
  });
  it("treats every short sub-flick gesture as a tap and late drags as holds", () => {
    const c = setup();
    c.down(20, 400, 100, 20);
    c.movePointer(20, 420, 100, 80);
    c.up(20, 400, 100, 100);
    expect(c.consume(120).edges).toEqual({ pass: true });
    c.down(21, 400, 100, 140);
    c.movePointer(21, 450, 100, 310);
    expect(c.consume(320)).toMatchObject({
      edges: { strikePressed: true },
      strikeHeld: true,
    });
  });
});

describe("independent court regions", () => {
  it("allows a lone action tap, hold, and targeted pass", () => {
    const c = createControls();
    c.down(1, 400, 100, 0, undefined, "action");
    c.up(1, 420, 100, 90);
    expect(c.consume(100).edges).toEqual({ pass: true });
    c.down(2, 400, 100, 120, undefined, "action");
    expect(c.consume(280).strikeHeld).toBe(true);
    c.up(2, 400, 100, 300);
    expect(c.consume(310).edges.strikeReleased).toBe(true);
    c.down(3, 400, 100, 400, "ally", "action");
    c.up(3, 400, 100, 440);
    expect(c.consume(450).edges).toEqual({ pass: true });
  });
  it("keeps a charge armed after movement lifts independently", () => {
    const c = setup();
    c.down(20, 400, 100, 20, undefined, "action");
    c.consume(180);
    c.up(10, 140, 100, 200);
    expect(c.consume(260).strikeHeld).toBe(true);
    c.up(20, 400, 100, 280);
    expect(c.consume(290).edges.strikeReleased).toBe(true);
  });
});

it("freezes a contextual command at the tap event before later state changes", () => {
  let carrying = true;
  const c = new CourtTouchControls(() =>
    carrying ? { pass: true } : { slide: true },
  );
  c.down(1, 400, 100, 0, undefined, "action");
  carrying = false;
  c.up(1, 400, 100, 50);
  expect(c.consume(60).edges).toEqual({ pass: true });
});

it("does not cancel a release when movement lifts after the grace deadline without a tick", () => {
  const c = setup();
  c.down(2, 400, 100, 20, undefined, "action");
  c.consume(180);
  c.up(2, 400, 100, 200);
  c.up(10, 140, 100, 270);
  expect(c.consume(280).edges).toEqual({ strikeReleased: true });
});

it("allows a revive hold to escape with a committed flick", () => {
  const c = createControls();
  c.setContext({ catch: false, revive: true });
  c.down(2, 400, 100, 0, undefined, "action");
  expect(c.consume(10).passHeld).toBe(true);
  c.movePointer(2, 450, 100, 40);
  expect(c.consume(50)).toMatchObject({
    edges: { slide: true },
    passHeld: false,
  });
});

it("closes an old release before an action retouch inside the grace window", () => {
  const c = setup();
  c.down(20, 400, 100, 20, undefined, "action");
  c.consume(180);
  c.movePointer(20, 400, 150, 190);
  c.up(20, 400, 150, 200);
  c.down(21, 400, 100, 220, undefined, "action");
  expect(c.consume(230)).toMatchObject({
    edges: { strikeReleased: true },
    aim: { x: 0, y: 50 },
    strikeHeld: false,
  });
  expect(c.consume(260)).toMatchObject({
    edges: {},
    aim: undefined,
    strikeHeld: false,
  });
  c.up(21, 400, 100, 270);
  expect(c.consume(280)).toMatchObject({
    edges: { pass: true },
    aim: undefined,
    strikeHeld: false,
  });
  expect(c.consume(300).edges).toEqual({});
});

describe("movement-side teammate arbitration", () => {
  it("freezes a reach-based pass instead of switching, on either court side", () => {
    for (const role of ["move", "action"] as const) {
      const state = createCryptballSession().observe(),
        p = state.players.find((p) => p.id === state.controlledId)!;
      state.ball.x = p.x;
      state.ball.y = p.y;
      const c = new CourtTouchControls(
        (intent) => resolveCourtAction(state, intent).press,
      );
      c.down(1, 100, 100, 0, "ally", role);
      state.ball.x += 100 * 256;
      c.up(1, 102, 100, 60);
      expect(c.consume(70).edges).toEqual({ pass: true });
    }
  });
  it("switches only a quick stationary target tap and steers immediately on drag", () => {
    const c = createControls(false);
    c.down(1, 100, 100, 0, "eligible-ally", "move");
    c.up(1, 102, 100, 60);
    expect(c.consume(70).edges).toEqual({
      switch: true,
      switchTarget: "eligible-ally",
    });
    c.down(2, 100, 100, 100, "eligible-ally", "move");
    c.movePointer(2, 140, 100, 120);
    expect(c.consume(130)).toMatchObject({
      move: { x: 0.8, y: 0 },
      edges: {},
      strikeHeld: false,
    });
    expect(c.consume(400)).toMatchObject({ edges: {}, strikeHeld: false });
    c.up(2, 100, 100, 410);
    expect(c.consume(420).edges).toEqual({});
    c.down(3, 100, 100, 500, "eligible-ally", "move");
    c.up(3, 100, 100, 700);
    expect(c.consume(710).edges).toEqual({});
  });
});
