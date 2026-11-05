import { expect, it } from "vitest";
import { createCryptballSession } from "../sim/session";

for (const sportId of ["cryptkick", "rift-volley", "crypt-dodge", "crypt-guardian"] as const) {
  it(`${sportId} produces restorable checkpoints throughout mixed actions and takeover`, () => {
    const session = createCryptballSession({ sportId, seed: 9182 });
    const replica = createCryptballSession();
    session.setParticipants([
      { id: "a", team: 0, playerId: "player-0" },
      { id: "b", team: sportId === "crypt-guardian" ? 0 : 1, playerId: sportId === "crypt-guardian" ? "player-1" : "player-2" },
    ]);
    for (let tick = 0; tick < 2200; tick++) {
      if (tick === 500) session.setParticipantActive("a", false);
      if (tick === 700) session.setParticipantActive("a", true);
      session.stepParticipants({
        a: {
          moveX: tick % 160 < 80 ? 1 : -1,
          moveY: tick % 100 < 50 ? 1 : -1,
          aim: (tick * 11) % 256,
          strikePressed: tick % 67 === 0,
          strikeHeld: tick % 67 < 30,
          strikeReleased: tick % 67 === 30,
          pass: tick % 109 === 0,
          slide: tick % 131 === 0,
          dash: tick % 181 === 0,
          switch: tick % 383 === 0,
          cancel: tick % 419 === 0,
        },
        b: {
          moveX: tick % 90 < 45 ? -1 : 1,
          moveY: 0,
          aim: 128,
          strikePressed: tick % 71 === 0,
          pass: tick % 163 === 0,
          slide: tick % 193 === 0,
        },
      });
      session.drainEvents();
      const checkpoint = session.capture();
      // A snapshot can be sent on any tick, including during a slide or possession transition.
      replica.restore(checkpoint);
      expect(replica.capture(), `${sportId} tick ${tick}`).toEqual(checkpoint);
      if (sportId === "rift-volley") {
        expect(checkpoint.state.ball.z).toBeGreaterThanOrEqual(0);
        for (const player of checkpoint.state.players) {
          expect(
            player.team === 0 ? player.x <= -10 * 256 : player.x >= 10 * 256,
          ).toBe(true);
        }
      }
    }
  });
}
