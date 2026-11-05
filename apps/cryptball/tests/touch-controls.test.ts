import { describe, expect, it } from "vitest";
import { CourtTouchControls } from "../src/touch-controls";

const setup = () => { const c = new CourtTouchControls(); c.down(10, 100, 100, 0); c.movePointer(10, 140, 100, 10); return c; };
describe("court touch pointer roles", () => {
  it("owns movement by ID, excludes extra contacts and passes once only after a short second tap", () => {
    const c = setup(); c.down(20, 400, 100, 20); c.down(30, 500, 100, 25);
    c.movePointer(30, 600, 100, 40); c.up(30, 600, 100, 50);
    expect(c.consume(60).edges).toEqual({});
    c.up(20, 405, 102, 90);
    expect(c.consume(100)).toMatchObject({ edges: { pass: true }, move: { x: .8, y: 0 }, strikeHeld: false });
    expect(c.consume(120).edges).toEqual({});
  });
  it("has no charge before recognition and independently aims a hold without changing movement", () => {
    const c = setup(); c.down(20, 400, 100, 20);
    expect(c.consume(179)).toMatchObject({ edges: {}, strikeHeld: false, aiming: true });
    expect(c.consume(180)).toMatchObject({ edges: { strikePressed: true }, strikeHeld: true });
    c.movePointer(20, 400, 150, 190);
    expect(c.consume(200)).toMatchObject({ edges: {}, move: { x: .8, y: 0 }, aim: { x: 0, y: 50 }, strikeHeld: true });
    c.up(20, 400, 150, 220);
    expect(c.consume(230)).toMatchObject({ edges: { strikeReleased: true }, aim: { x: 0, y: 50 }, strikeHeld: false });
  });
  it("flicks once in the action direction and never converts an established shot to a flick", () => {
    const c = setup(); c.down(20, 400, 100, 20); c.movePointer(20, 400, 135, 100);
    expect(c.consume(110)).toMatchObject({ edges: { slide: true }, aim: { x: 0, y: 35 } });
    c.movePointer(20, 400, 180, 140); c.up(20, 400, 180, 150);
    expect(c.consume(220).edges).toEqual({});
    c.down(21, 400, 100, 240); c.consume(400); c.movePointer(21, 450, 100, 410);
    expect(c.consume(420)).toMatchObject({ edges: {}, strikeHeld: true });
  });
  it("cancels a queued flick on interruption without replaying it on a new contact", () => {
    const c = setup(); c.down(20,400,100,20); c.movePointer(20,450,100,50);
    expect(c.visual.action?.phase).toBe("flick");
    c.cancel();
    expect(c.consume(60).edges).toEqual({});
    c.down(30,100,100,80);
    expect(c.consume(90).edges).toEqual({});
    c.down(40,400,100,100);c.movePointer(40,450,100,120);
    expect(c.consume(130).edges).toEqual({slide:true});
    expect(c.consume(140).edges).toEqual({});
  });
  it("disarms on movement lift, interruption and all-lift batches without phantom release or pass", () => {
    const c = setup(); c.down(20, 400, 100, 20); c.consume(180);
    c.up(10, 140, 100, 200); c.up(20, 400, 100, 210);
    expect(c.consume(220)).toMatchObject({ edges: { cancel: true }, strikeHeld: false, move: { x: 0, y: 0 } });
    const d = setup(); d.down(20, 400, 100, 20); d.consume(180); d.up(20, 400, 100, 200); d.up(10, 140, 100, 200);
    expect(d.consume(220).edges).toEqual({ cancel: true });
    const e = setup(); e.down(20, 400, 100, 20); e.up(20, 400, 100, 100); e.up(10, 140, 100, 100);
    expect(e.consume(120).edges).toEqual({});
    const f = setup(); f.down(20, 400, 100, 20); f.consume(180); f.cancel(); f.up(20, 400, 100, 210);
    expect(f.consume(220).edges).toEqual({ cancel: true });
    f.down(30, 100, 100, 230); expect(f.consume(250).edges).toEqual({});
  });
  it("supports neutral stationary shooting, bounded anchor following and one dash per near retouch", () => {
    const c = new CourtTouchControls(); c.down(10, 100, 100, 0); c.movePointer(10, 250, 100, 20);
    expect(c.visual.movement?.anchor).toEqual({ x: 202, y: 100 });
    expect(c.consume(30).edges).toEqual({});
    c.movePointer(10, 202, 100, 40); expect(c.consume(50).move).toEqual({ x: 0, y: 0 });
    c.up(10, 202, 100, 60); c.down(11, 210, 100, 100); c.movePointer(11, 245, 100, 130);
    expect(c.consume(140).edges).toEqual({ dash: true }); c.movePointer(11, 250, 100, 160);
    expect(c.consume(170).edges).toEqual({});
    c.up(11, 250, 100, 180); c.down(12, 400, 100, 200); c.movePointer(12, 450, 100, 220);
    expect(c.consume(230).edges).toEqual({});
  });
  it("only switches targeted teammate on an unambiguous action tap, never movement start", () => {
    const c = new CourtTouchControls(); c.down(10, 100, 100, 0, "player-1"); c.up(10, 100, 100, 20);
    expect(c.consume(30).edges).toEqual({});
    c.down(11, 100, 100, 50); c.down(20, 400, 100, 60, "player-1"); c.up(20, 400, 100, 120);
    expect(c.consume(130).edges).toEqual({ switch: true, switchTarget: "player-1" });
    c.disarmAction(); expect(c.visual.movement).toBeDefined();
  });
  it("rejects ambiguous drags as taps and late drags as flicks", () => {
    const c = setup(); c.down(20, 400, 100, 20); c.movePointer(20, 420, 100, 80); c.up(20, 400, 100, 100);
    expect(c.consume(120).edges).toEqual({});
    c.down(21, 400, 100, 140); c.movePointer(21, 450, 100, 310);
    expect(c.consume(320)).toMatchObject({ edges: { strikePressed: true }, strikeHeld: true });
  });
});
