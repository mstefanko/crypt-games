import { expect, it } from "vitest";
import { CardRunSession } from "@onepage/game-simulation/card-run";
import { luckyContent } from "../../../../apps/audio-arcade/src/games/lucky/content";
import { CardRunPresenter } from "./card-run-presenter";
import { PresentationQueue } from "./event-queue";
function owner() {
  const session = new CardRunSession(luckyContent, 12);
  session.toggle(session.cards[0].id);
  session.play();
  return session;
}
// Exercise the real render method and queue callbacks through their cosmetic
// status boundary without constructing a GPU context or unrelated card sprites.
function cosmeticRender(session: CardRunSession) {
  const boundary = new Error("cosmetic status boundary"),
    p = Object.create(CardRunPresenter.prototype) as any;
  Object.assign(p, {
    clock: 0,
    felt: { update() {} },
    artwork() {},
    foil: { update() {} },
    session,
    queue: new PresentationQueue(),
    transaction: -1,
    reduced: false,
    visible: "",
    status: {
      set text(_v: string) {
        throw boundary;
      },
    },
  });
  return (dt: number) => {
    try {
      p.render(dt);
    } catch (error) {
      if (error !== boundary) throw error;
    }
  };
}
it("advances reveals from fixed simulation updates regardless of zero or repeated renderer calls", () => {
  const a = owner(),
    b = owner(),
    render = cosmeticRender(b),
    committed = a.state.lastResult;
  for (let i = 0; i < 240; i++) {
    a.stepReveal(1 / 60);
    b.stepReveal(1 / 60);
    if (i % 4 === 0) for (let frame = 0; frame < 5; frame++) render(0.05);
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(a.state.lastResult).toEqual(committed);
  }
  expect(a.state.phase).not.toBe("reveal");
});
it("retains partial reveal time on restore and skip changes phase only once", () => {
  const a = owner(),
    b = new CardRunSession(luckyContent, 12);
  a.stepReveal(0.15);
  expect(a.state.revealCursor).toBe(0);
  b.restore(JSON.parse(JSON.stringify(a.snapshot())));
  a.stepReveal(0.01);
  b.stepReveal(0.01);
  expect(a.state.revealCursor).toBe(1);
  expect(b.snapshot()).toEqual(a.snapshot());
  const result = a.state.lastResult;
  a.advanceReveal(0, true);
  const after = a.snapshot();
  a.advanceReveal(0, true);
  a.stepReveal(10);
  expect(a.snapshot()).toEqual(after);
  expect(a.state.lastResult).toEqual(result);
  const invalid = structuredClone(after) as any;
  invalid.state.revealDelay = 0.2;
  expect(() => a.restore(invalid)).toThrow();
  expect(a.snapshot()).toEqual(after);
});
