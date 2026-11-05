import { describe, expect, it } from "vitest";
import { MatchAuthority } from "../../cryptball-server/src/model";
import type { CommandFrame } from "../sim/contract";
import { createCryptballSession } from "../sim/session";
import {
  decodeSnapshot,
  encodeSnapshot,
  heldCommand,
  MAX_PACKET_BYTES,
  validateInput,
} from "../protocol";

function start(
  sport: "crypt-dodge" | "crypt-guardian",
  humans: number,
  room = "new-modes",
) {
  const authority = new MatchAuthority(room, true, sport);
  for (let i = 0; i < humans; i++) {
    authority.join(`p${i}`, `Player ${i}`);
    authority.ready(`p${i}`);
  }
  if (humans < authority.capacity) expect(authority.start()).toBe(true);
  for (let i = 0; i < 180; i++) authority.advance();
  return authority;
}

function rescueFixture() {
  const authority = start("crypt-guardian", 2, "guardian-rescue-network");
  const checkpoint = authority.session.capture(),
    state = checkpoint.state;
  state.phase = "play";
  state.phaseTicks = 0;
  state.guardian!.nextAttack = 1000000;
  const rescuer = state.players.find(
    (p) => p.id === authority.peers.get("p0")!.playerId,
  )!;
  const down = state.players.find(
    (p) => p.id === authority.peers.get("p1")!.playerId,
  )!;
  rescuer.x = 0;
  rescuer.y = 40 * 256;
  down.x = 10 * 256;
  down.y = 40 * 256;
  state.guardian!.athletes[down.id].hp = 0;
  state.guardian!.athletes[down.id].status = "down";
  authority.session.restore(checkpoint);
  const sequences = new Map([...authority.peers.keys()].map((id) => [id, 0]));
  function send(
    id: string,
    command: CommandFrame,
    tick = authority.session.getTick() + 1,
  ) {
    const peer = authority.peers.get(id)!;
    const seq = sequences.get(id)! + 1;
    sequences.set(id, seq);
    return authority.receive(id, {
      epoch: authority.epoch,
      generation: peer.generation,
      seq,
      tick,
      revision: authority.session.getControllerRevision(id)!,
      command,
    });
  }
  function advance(command: CommandFrame, sendHelper = true) {
    for (const id of authority.peers.keys())
      if (id !== "p0" || sendHelper)
        expect(send(id, id === "p0" ? command : {})).toBe(true);
    authority.advance();
  }
  return { authority, send, advance, downId: down.id, rescuerId: rescuer.id };
}

describe("new mode multiplayer contracts", () => {
  it("permits a ready solo guardian seat with one bot, retaining the wake tell", () => {
    const m = start("crypt-guardian", 1);
    expect(m.phase).toBe("playing");
    expect(m.session.observe().phase).toBe("ready");
    expect(m.session.observe().players).toHaveLength(2);
    expect(m.session.capture().state.controllers).toHaveLength(1);
    expect(m.session.observe().guardian?.hp).toBe(300);
  });

  it("retains dodge opening possession and excludes single-human competitive starts", () => {
    const solo = new MatchAuthority("solo-dodge", true, "crypt-dodge");
    solo.join("p", "Player");
    solo.ready("p");
    expect(solo.start()).toBe(false);
    const m = start("crypt-dodge", 2);
    expect(m.session.observe().phase).toBe("ready");
    expect(m.session.observe().dodge).not.toBeNull();
  });

  it("holds revive only in guardian and never repeats a dodge/dive edge", () => {
    const command = {
      pass: true,
      passHeld: true,
      slide: true,
      strikePressed: true,
      strikeHeld: false,
    };
    expect(heldCommand(command, "crypt-guardian")).toMatchObject({
      passHeld: true,
    });
    expect(heldCommand(command, "crypt-guardian").slide).toBeUndefined();
    expect(heldCommand(command, "crypt-dodge").slide).toBeUndefined();
    expect(heldCommand(command, "crypt-dodge").passHeld).toBeUndefined();
    expect(heldCommand(command, "crypt-guardian").pass).toBeUndefined();
    const packet = {
      epoch: 1,
      generation: 1,
      seq: 1,
      tick: 1,
      revision: 0,
      command: { passHeld: true },
    };
    expect(validateInput(packet)?.command.passHeld).toBe(true);
    expect(
      validateInput({ ...packet, command: { passHeld: "yes" } }),
    ).toBeNull();
  });

  it("retries the same guardian, while a different room selects its own descriptor", () => {
    const m = start("crypt-guardian", 1, "guardian-retry");
    const descriptor = structuredClone(
      m.session.observe().guardian!.descriptor,
    );
    m.phase = "results";
    m.rematch("p0");
    expect(m.session.observe().guardian!.descriptor).toEqual(descriptor);
    m.ready("p0");
    expect(m.start()).toBe(true);
    for (let i = 0; i < 180; i++) m.advance();
    expect(m.session.observe().guardian!.descriptor).toEqual(descriptor);
    const other = start("crypt-guardian", 1, "guardian-other");
    expect(other.session.observe().guardian!.descriptor.seed).not.toBe(
      descriptor.seed,
    );
  });

  for (const sport of ["crypt-dodge", "crypt-guardian"] as const) {
    it(`${sport} restores full mode state and retains distinct mode-sized seats across takeover`, () => {
      const count = sport === "crypt-guardian" ? 2 : 4;
      const m = start(sport, count);
      const seats = [...m.peers.values()].map((p) => p.playerId);
      expect(new Set(seats).size).toBe(count);
      // Bots cover every seat without reassigning or resurrecting an athlete.
      for (let i = 0; i < count; i++) m.suspend(`p${i}`, true);
      const replica = createCryptballSession();
      let maxBytes = 0;
      for (let tick = 0; tick < 1200 && m.phase === "playing"; tick++) {
        m.advance();
        const events = m.session.drainEvents();
        if (tick % 73 !== 0) continue;
        const bytes = encodeSnapshot(m.snapshot("p0", events));
        maxBytes = Math.max(maxBytes, bytes.length);
        const decoded = decodeSnapshot(bytes);
        replica.restore(decoded.checkpoint);
        expect(replica.capture()).toEqual(decoded.checkpoint);
        const restored = createCryptballSession();
        restored.restore(replica.capture());
        replica.stepParticipants({});
        restored.stepParticipants({});
        expect(restored.capture()).toEqual(replica.capture());
      }
      expect(maxBytes).toBeGreaterThan(0);
      expect(maxBytes).toBeLessThanOrEqual(MAX_PACKET_BYTES);
      const modeState = structuredClone(
        sport === "crypt-dodge"
          ? m.session.observe().dodge
          : m.session.observe().guardian,
      );
      m.drop("p0");
      m.reconnect("p0");
      m.suspend("p0", false);
      expect([...m.peers.values()].map((p) => p.playerId)).toEqual(seats);
      expect(
        sport === "crypt-dodge"
          ? m.session.observe().dodge
          : m.session.observe().guardian,
      ).toEqual(modeState);
    });
  }
  it("requires a continuous network revive hold and cancels it on release without passing", () => {
    const { authority, advance, downId } = rescueFixture();
    for (let tick = 0; tick < 45; tick++) advance({ passHeld: true });
    expect(
      authority.session.observe().guardian!.athletes[downId],
    ).toMatchObject({ status: "down", reviveTicks: 45 });
    advance({ passHeld: false });
    expect(
      authority.session.observe().guardian!.athletes[downId].reviveTicks,
    ).toBe(0);
    for (let tick = 0; tick < 89; tick++) advance({ passHeld: true });
    expect(authority.session.observe().guardian!.athletes[downId].status).toBe(
      "down",
    );
    advance({ passHeld: true });
    expect(
      authority.session.observe().guardian!.athletes[downId],
    ).toMatchObject({ status: "active", hp: 2, revives: 1 });
    expect(
      authority.session.drainEvents().filter((e) => e.type === "pass"),
    ).toEqual([]);
  });

  it("an expired revive release cancels held rescue immediately instead of completing it late", () => {
    const { authority, send, advance, downId } = rescueFixture();
    for (let tick = 0; tick < 82; tick++) advance({ passHeld: true });
    const lastRequested = authority.session.getTick();
    for (let tick = 0; tick < 4; tick++) advance({}, false);
    expect(
      authority.session.observe().guardian!.athletes[downId].reviveTicks,
    ).toBe(86);
    expect(send("p0", { passHeld: false }, lastRequested + 1)).toBe(false);
    advance({}, false);
    expect(
      authority.session.observe().guardian!.athletes[downId],
    ).toMatchObject({ status: "down", reviveTicks: 0, revives: 0 });
    for (let tick = 0; tick < 8; tick++) advance({ passHeld: false });
    expect(authority.session.observe().guardian!.athletes[downId].status).toBe(
      "down",
    );
  });

  it("downed reconnect keeps the same soul, health and once-per-encounter rescue budget", () => {
    const { authority, downId } = rescueFixture();
    const before = structuredClone(
      authority.session.observe().guardian!.athletes[downId],
    );
    authority.drop("p1");
    authority.reconnect("p1");
    authority.suspend("p1", false);
    expect(authority.session.observe().guardian!.athletes[downId]).toEqual(
      before,
    );
    expect(
      authority.session.capture().state.controllers.find((c) => c.id === "p1")!
        .playerId,
    ).toBe(downId);
    const replica = createCryptballSession();
    replica.restore(
      decodeSnapshot(encodeSnapshot(authority.snapshot("p1", []))).checkpoint,
    );
    expect(replica.observe().guardian!.athletes[downId]).toEqual(before);
  });
});
