import { expect, it } from "vitest";
import { createInitialState } from "../sim/session";
import { PresentationCorrections } from "../src/online/corrections";

it("corrects every player from the last drawn pose across repeated corrections", () => {
  const corrections = new PresentationCorrections();
  const state = createInitialState();
  state.phase = "play";
  corrections.correct(state, 0, "epoch:revision");
  corrections.draw(state, 0);
  const next = structuredClone(state);
  for (const player of next.players) player.x += 4 * 256;
  next.ball.x += 4 * 256;
  corrections.correct(next, 0, "epoch:revision");
  const drawn = corrections.draw(next, 30);
  for (const [index, player] of drawn.players.entries())
    expect(player.x).toBeLessThan(next.players[index]!.x);
  const again = structuredClone(next);
  for (const player of again.players) player.x += 256;
  again.ball.x += 256;
  corrections.correct(again, 30, "epoch:revision");
  expect(corrections.draw(again, 30)).toEqual({
    ...again,
    players: drawn.players,
    ball: drawn.ball,
  });
  expect(again.players[0]!.x).toBe(next.players[0]!.x + 256);
});

it("snaps on identity changes and teleports", () => {
  const corrections = new PresentationCorrections();
  const state = createInitialState();
  state.phase = "play";
  corrections.correct(state, 0, "a");
  corrections.draw(state, 0);
  state.players[0]!.x += 256;
  corrections.correct(state, 1, "b");
  expect(corrections.draw(state, 1)).toEqual(state);
  state.players[0]!.x += 30 * 256;
  corrections.correct(state, 2, "b");
  expect(corrections.draw(state, 2)).toEqual(state);
});

it("retains drawn pose metadata independently of caller mutations", () => {
  const corrections = new PresentationCorrections();
  const state = createInitialState();
  state.phase = "play";
  corrections.correct(state, 0, "a");
  const drawn = corrections.draw(state, 0);
  const originalX = state.players[0]!.x;
  drawn.players[0]!.x += 100 * 256;
  drawn.score[0]++;
  state.players[0]!.x += 256;
  corrections.correct(state, 1, "a");
  expect(corrections.draw(state, 1).players[0]!.x).toBe(originalX);
  expect(state.players[0]!.x).toBe(originalX + 256);
});
