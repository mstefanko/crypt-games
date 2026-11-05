import { describe, it, expect } from "vitest";
import { MatchAuthority } from "../../cryptball-server/src/model";
import { createCryptballSession, SPORT_IDS } from "../sim/session";
import { MAX_PACKET_BYTES, encodeSnapshot, decodeSnapshot } from "../protocol";
import type { CommandFrame } from "../sim/contract";
import { aimHeading } from "../sim/rules";

describe("full regulation multiplayer authority", () => {
  for (const sportId of SPORT_IDS) {
    for (const humans of (sportId === "crypt-guardian" ? [1, 2] : [2, 3, 4])) {
      it(`${sportId}: ${humans} humans play a complete seeded match with coherent replicas and bot ownership`, () => {
        const authority = new MatchAuthority(
          `full-${sportId}-${humans}`,
          true,
          sportId,
        );
        for (let i = 0; i < humans; i++) {
          authority.join(`p${i}`, `Player ${i}`);
          authority.ready(`p${i}`);
        }
        if (humans < authority.capacity) expect(authority.start()).toBe(true);
        for (let tick = 0; tick < 180; tick++) authority.advance();
        expect(authority.phase).toBe("playing");
        const replica = createCryptballSession({ seed: 999 });
        const sequences = Array(humans).fill(0);
        let lastTick = 0,
          samples = 0,
          maximumBytes = 0;
        for (
          let tick = 0;
          tick < (sportId === "rift-volley" || sportId === "crypt-dodge" ? 40000 : 11000) &&
          authority.phase === "playing";
          tick++
        ) {
          const checkpoint = authority.session.capture();
          for (let i = 0; i < humans; i++) {
            const peer = authority.peers.get(`p${i}`)!;
            const controller = checkpoint.state.controllers.find(
              (c) => c.id === peer.id,
            )!;
            const cycle = tick % 90;
            const athlete = checkpoint.state.players.find(p => p.id === controller.playerId)!;
            const opponent = checkpoint.state.players.find(p => p.team !== athlete.team &&
              (!checkpoint.state.dodge || checkpoint.state.dodge.athletes[p.id].lives > 0));
            let dodgeCommand: CommandFrame = {};
            if (sportId === "crypt-dodge") {
              const d = checkpoint.state.dodge!;
              const held = d.balls.find(b => !b.retired && b.mode.holderId === athlete.id);
              const reachable = d.balls.filter(b => !b.retired && !b.mode.holderId &&
                ((b.mode.state === "dead-loose" || b.mode.state === "reset") &&
                  (b.physical.x < 0 ? 0 : 1) === athlete.team ||
                  b.mode.state === "friendly-pass" && b.mode.passTarget === athlete.id))
                .sort((a,b) => Math.hypot(a.physical.x-athlete.x,a.physical.y-athlete.y) -
                  Math.hypot(b.physical.x-athlete.x,b.physical.y-athlete.y) ||
                  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
              const target = held ? opponent : reachable?.physical;
              const a = d.athletes[athlete.id];
              dodgeCommand = {
                moveX: held ? athlete.team === 0 ? 1 : -1 : target ? Math.sign(target.x-athlete.x) : 0,
                moveY: target ? Math.sign(target.y-athlete.y) : 0,
                aim: opponent ? aimHeading(opponent.x-athlete.x,opponent.y-athlete.y) : athlete.heading,
                strikePressed: !!held && !athlete.charging && !a.pendingThrow && !a.needsRelease,
                strikeHeld: !!held && !a.pendingThrow && !a.needsRelease && athlete.chargeTicks < 12,
                strikeReleased: !!held && athlete.charging && athlete.chargeTicks >= 12,
              };
            }
            expect(
              authority.receive(peer.id, {
                epoch: authority.epoch,
                generation: peer.generation,
                seq: ++sequences[i],
                tick: checkpoint.state.tick + 1,
                revision: controller.revision,
                // Empty Dodge players retrieve a legal free ball before aiming
                // at opponents; possession drives charge/release decisions.
                command: sportId === "crypt-dodge" ? dodgeCommand : {
                  moveX: Math.floor(tick / 90 + i) % 2 ? -1 : 1,
                  moveY: Math.floor(tick / 120 + i) % 2 ? 1 : -1,
                  aim: (tick * 3 + i * 64) % 256,
                  strikePressed: cycle === 0,
                  strikeHeld: cycle < 30,
                  strikeReleased: cycle === 30,
                  pass: tick % 101 === i,
                  dash: tick % 179 === i,
                  special: tick % 181 === i,
                  slide: tick % 130 === 111,
                  switch: tick > 0 && tick % 500 === i,
                },
              }),
            ).toBe(true);
          }
          authority.advance();
          expect(authority.session.observe().tick).toBe(lastTick + 2); // countdown completion already applies tick one
          lastTick++;
          const events = authority.session.drainEvents();
          if (tick % 120 === 0 || authority.lobby().phase === "results") {
            const bytes = encodeSnapshot(authority.snapshot("p0", events));
            maximumBytes = Math.max(maximumBytes, bytes.byteLength);
            const decoded = decodeSnapshot(bytes);
            replica.restore(decoded.checkpoint);
            expect(replica.capture()).toEqual(decoded.checkpoint);
            expect(decoded.tick).toBe(authority.session.observe().tick);
            expect(decoded.sportId).toBe(sportId);
            expect(replica.observe().sportId).toBe(sportId);
            expect(
              new Set(
                decoded.checkpoint.state.controllers.map((c) => c.playerId),
              ).size,
            ).toBe(humans);
            expect(
              decoded.checkpoint.state.controllers.filter((c) => c.active),
            ).toHaveLength(humans);
            samples++;
          }
        }
        expect(authority.phase).toBe("results");
        expect(samples).toBeGreaterThan(["rift-volley", "crypt-dodge", "crypt-guardian"].includes(sportId) ? 2 : 40);
        expect(maximumBytes).toBeLessThanOrEqual(MAX_PACKET_BYTES);
        const final = authority.session.observe();
        if (sportId === "rift-volley") {
          const winning = Math.max(...final.score),
            losing = Math.min(...final.score);
          expect(
            winning >= 11 && (winning - losing >= 2 || winning === 15),
          ).toBe(true);
        } else if (sportId === "crypt-dodge") {
          expect(Math.max(...final.score)).toBe(2);
        } else if (sportId === "crypt-guardian") {
          expect(final.guardian).not.toBeNull();
          expect(final.winner === 0 || final.winner === 1).toBe(true);
        } else {
          expect(final.overtime || final.remainingTicks === 0).toBe(true);
        }
      }, 60000);
    }
  }
});
