import { afterEach, beforeEach, it, expect, vi } from "vitest";
const fake = vi.hoisted(() => ({
  messages: new Map<string, (v: unknown) => void>(),
  signals: new Map<string, () => void>(),
  sent: [] as [string, unknown][],
  joins: [] as Record<string, unknown>[],
  reconnects: [] as string[],
}));
vi.mock("@colyseus/sdk", () => {
  const room = {
    roomId: "room",
    sessionId: "p0",
    reconnectionToken: "room:secret",
    reconnection: { enabled: true, minUptime: 0 },
    onMessage: (type: string, cb: (v: unknown) => void) =>
      fake.messages.set(type, cb),
    onDrop: (cb: () => void) => fake.signals.set("drop", cb),
    onReconnect: (cb: () => void) => fake.signals.set("reconnect", cb),
    onLeave: () => {},
    onError: () => {},
    send: (type: string, data: unknown) => fake.sent.push([type, data]),
    leave: async () => {},
    connection: { close: () => {} },
  };
  return {
    Client: class {
      async joinOrCreate(_name: string, options: Record<string, unknown>) {
        fake.joins.push(options);
        return room;
      }
      async reconnect(token: string) {
        fake.reconnects.push(token);
        return room;
      }
      async joinById(_code: string, options: Record<string, unknown>) {
        fake.joins.push(options);
        return room;
      }
    },
  };
});
import { createOnlineSession } from "../src/online/session";
import { MatchAuthority } from "../../cryptball-server/src/model";
import { encodeSnapshot, PROTOCOL } from "../protocol";
import { createCryptballSession, SPORT_IDS } from "../sim/session";
let now = 0;
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  fake.messages.clear();
  fake.signals.clear();
  fake.sent.length = 0;
  fake.joins.length = 0;
  fake.reconnects.length = 0;
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
it("corrects and replays an in-flight hockey carry turn and dash from canonical pocket state", async () => {
  const authority = new MatchAuthority("room", true, "cryptcheck");
  for (const id of ["p0", "p1", "p2", "p3"]) {
    authority.join(id, "Guest");
    authority.ready(id);
  }
  authority.start();
  for (let tick = 0; tick < 180; tick++) authority.advance();
  const cp = authority.session.capture();
  cp.state.phase = "play";
  cp.state.phaseTicks = 0;
  for (const [i, p] of cp.state.players.entries()) {
    p.x = (i < 2 ? -130 : 130) * 256;
    p.y = (i % 2 ? -65 : 65) * 256;
  }
  const p = cp.state.players[0];
  p.x = p.y = 0;
  p.heading = 0;
  cp.state.possessionId = p.id;
  cp.state.ball.lastTouch = p.id;
  cp.state.ball.x = 14 * 256;
  cp.state.ball.y = 0;
  cp.state.hockey!.skaters[p.id].carryHeading = 0;
  authority.session.restore(cp);
  const client = createOnlineSession({
    endpoint: "ws://test",
    sportId: "cryptcheck",
  });
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  client.step({}); // Clear the neutral latch and establish held-input history.
  now += 1000 / 60;
  client.step({ aim: 128, moveY: 1, dash: true });
  const packets = fake.sent
    .filter(([type]) => type === "input")
    .map(([, packet]) => packet as import("../protocol").InputPacket);
  const pending = packets.at(-1)!;
  expect(client.rawObserve().players[0].dashTicks).toBeGreaterThan(0);
  expect(client.rawObserve().possessionId).toBe(p.id);
  while (authority.session.observe().tick < pending.tick - 1) {
    const next = packets.find(
      (packet) => packet.tick === authority.session.observe().tick + 1,
    );
    authority.session.stepParticipants({ p0: next?.command ?? {} });
  }
  // Simulate a small authoritative correction while preserving the real pocket.
  const corrected = authority.session.capture();
  corrected.state.ball.y += 256;
  authority.session.restore(corrected);
  const expected = createCryptballSession({ sportId: "cryptcheck" });
  expected.restore(corrected);
  expected.stepParticipants({
    p0: {
      ...pending.command,
      origin: {
        epoch: pending.epoch,
        generation: pending.generation,
        participantId: "p0",
        seq: pending.seq,
      },
    },
  });
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  expect(client.diagnostics.replayedTicks).toBeGreaterThan(0);
  expect(client.rawObserve()).toEqual(expected.observeFor("p0"));
  expect(client.rawObserve().hockey!.skaters[p.id].carryHeading).not.toBe(
    p.heading,
  );
  expect(client.rawObserve().possessionId).toBe(p.id);
});
it("predicts and corrects an actual check through victim knockdown and recovery", async () => {
  const authority = new MatchAuthority("room", true, "cryptcheck");
  for (const id of ["p0", "p1", "p2", "p3"]) {
    authority.join(id, "Guest");
    authority.ready(id);
  }
  authority.start();
  for (let t = 0; t < 180; t++) authority.advance();
  const cp = authority.session.capture();
  cp.state.phase = "play";
  cp.state.phaseTicks = 0;
  for (const [i, p] of cp.state.players.entries()) {
    p.x = (i < 2 ? -130 : 130) * 256;
    p.y = (i % 2 ? -65 : 65) * 256;
  }
  cp.state.players[0].x = cp.state.players[0].y = 0;
  cp.state.players[0].heading = 0;
  cp.state.players[2].x = 28 * 256;
  cp.state.players[2].y = 0;
  cp.state.ball.x = -80 * 256;
  cp.state.ball.y = 0;
  authority.session.restore(cp);
  authority.session.stepParticipants({ p0: { check: true } });
  const client = createOnlineSession({
    endpoint: "ws://test",
    sportId: "cryptcheck",
  });
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  let knockedDown = false,
    restoredControl = false;
  for (let t = 0; t < 45; t++) {
    now += 1000 / 60;
    client.step({});
    const pending = fake.sent
      .filter(([type]) => type === "input")
      .at(-1)![1] as import("../protocol").InputPacket;
    while (authority.session.observe().tick < pending.tick - 1)
      authority.session.stepParticipants({ p0: {} });
    const checkpoint = authority.session.capture();
    const expected = createCryptballSession({ sportId: "cryptcheck" });
    expected.restore(checkpoint);
    expected.stepParticipants({
      p0: {
        ...pending.command,
        origin: {
          epoch: pending.epoch,
          generation: pending.generation,
          participantId: "p0",
          seq: pending.seq,
        },
      },
    });
    fake.messages.get("snapshot")!(
      encodeSnapshot(authority.snapshot("p0", [])),
    );
    expect(client.rawObserve()).toEqual(expected.observeFor("p0"));
    knockedDown ||=
      client.rawObserve().hockey!.skaters["player-2"].downTicks > 0;
    restoredControl ||=
      knockedDown &&
      client.rawObserve().hockey!.skaters["player-2"].downTicks === 0;
  }
  expect(knockedDown).toBe(true);
  expect(restoredControl).toBe(true);
});
it("keeps bot takeover when a suspended client receives a reconnect checkpoint", async () => {
  const authority = new MatchAuthority("room");
  authority.join("p0", "Guest");
  const client = createOnlineSession({ endpoint: "ws://test" });
  await client.connect("quick");
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  expect(client.status).toBe("joined");
  client.suspend();
  fake.signals.get("drop")!();
  authority.drop("p0");
  authority.reconnect("p0");
  fake.signals.get("reconnect")!();
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  expect(fake.sent.at(-1)?.[0]).toBe("suspend");
  const count = fake.sent.length;
  client.step({ strikeHeld: true });
  expect(fake.sent).toHaveLength(count);
  client.resume();
  expect(fake.sent.at(-1)?.[0]).toBe("resume");
});

it.each(SPORT_IDS)(
  "hydrates %s prediction and reconnect checkpoints without losing bot takeover",
  async (sportId) => {
    const authority = new MatchAuthority("room", false, sportId);
    authority.join("p0", "Guest");
    const client = createOnlineSession({ endpoint: "ws://test", sportId });
    await client.connect("quick");
    expect(fake.joins.at(-1)?.sportId).toBe(sportId);
    fake.messages.get("lobby")!(authority.lobby());
    fake.messages.get("snapshot")!(
      encodeSnapshot(authority.snapshot("p0", [])),
    );
    expect(client.observe().sportId).toBe(sportId);
    client.suspend();
    authority.drop("p0");
    authority.reconnect("p0");
    fake.signals.get("drop")!();
    fake.signals.get("reconnect")!();
    fake.messages.get("snapshot")!(
      encodeSnapshot(authority.snapshot("p0", [])),
    );
    expect(client.observe().sportId).toBe(sportId);
    expect(fake.sent.at(-1)?.[0]).toBe("suspend");
  },
);
it.each(SPORT_IDS)(
  "discovers %s from a bare code and rejects later mode changes",
  async (sportId) => {
    const authority = new MatchAuthority("room", true, sportId);
    authority.join("p0", "Guest");
    const client = createOnlineSession({
      endpoint: "ws://test",
      sportId: "cryptball",
    });
    await client.connect("join", "room");
    expect(fake.joins.at(-1)).not.toHaveProperty("sportId");
    fake.messages.get("lobby")!(authority.lobby());
    fake.messages.get("snapshot")!(
      encodeSnapshot(authority.snapshot("p0", [])),
    );
    expect(client.observe().sportId).toBe(sportId);
    const wrong = new MatchAuthority(
      "other",
      false,
      sportId === "cryptball" ? "cryptkick" : "cryptball",
    );
    wrong.join("p0", "Guest");
    fake.messages.get("snapshot")!(encodeSnapshot(wrong.snapshot("p0", [])));
    expect(client.status).toBe("interrupted");
    expect(client.observe().sportId).toBe(sportId);
  },
);

it("waits for authoritative rally confirmation before displaying a predicted point or serve", async () => {
  const authority = new MatchAuthority("room", true, "rift-volley");
  for (const id of ["p0", "p1"]) {
    authority.join(id, "Guest");
    authority.ready(id);
  }
  authority.start();
  for (let tick = 0; tick < 180; tick++) authority.advance();
  const checkpoint = authority.session.capture();
  checkpoint.state.ball.x = -100 * 256;
  checkpoint.state.ball.y = 0;
  checkpoint.state.ball.z = 6 * 256;
  checkpoint.state.ball.vx = 0;
  checkpoint.state.ball.vy = 0;
  checkpoint.state.ball.vz = -240 * 256;
  checkpoint.state.volley!.serving = false;
  authority.session.restore(checkpoint);
  const client = createOnlineSession({
    endpoint: "ws://test",
    sportId: "rift-volley",
  });
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  client.step({});
  expect(client.rawObserve().phase).toBe("goal");
  expect(client.observe().phase).toBe("play");
  expect(client.observe().score).toEqual(checkpoint.state.score);
  expect(client.observe().ball.x).toBe(checkpoint.state.ball.x);
  expect(client.observe().ball.z).toBe(checkpoint.state.ball.z);
});

it("snaps a new authoritative rally into place and keeps visual height nonnegative", async () => {
  const authority = new MatchAuthority("room", true, "rift-volley");
  authority.join("p0", "Guest");
  const initial = authority.session.capture();
  initial.state.phase = "play";
  initial.state.phaseTicks = 0;
  authority.session.restore(initial);
  const client = createOnlineSession({
    endpoint: "ws://test",
    sportId: "rift-volley",
  });
  await client.connect("quick");
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  const next = authority.session.capture();
  next.state.tick++;
  next.state.volley!.rally++;
  next.state.ball.x += 10 * 256;
  next.state.ball.z = 0;
  authority.session.restore(next);
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  expect(client.observe().ball.x).toBe(next.state.ball.x);
  expect(client.observe().ball.z).toBeGreaterThanOrEqual(0);
  expect(client.observe().volley!.rally).toBe(next.state.volley!.rally);
});

it.each(SPORT_IDS)(
  "keeps %s Quick Play reconnect tokens scoped to the selected sport",
  async (sportId) => {
    const otherSport = SPORT_IDS.find((id) => id !== sportId)!;
    const authority = new MatchAuthority("room", false, sportId);
    authority.join("p0", "Guest");
    const original = createOnlineSession({
      endpoint: "ws://test",
      sportId,
    });
    await original.connect("quick");
    fake.messages.get("snapshot")!(
      encodeSnapshot(authority.snapshot("p0", [])),
    );
    const differentSport = createOnlineSession({
      endpoint: "ws://test",
      sportId: otherSport,
    });
    await differentSport.connect("quick");
    expect(fake.reconnects).toEqual([]);
    expect(fake.joins.at(-1)?.sportId).toBe(otherSport);
    const sameSport = createOnlineSession({
      endpoint: "ws://test",
      sportId,
    });
    await sameSport.connect("quick");
    expect(fake.reconnects).toEqual(["room:secret"]);
  },
);

it("clamps height correction while a falling ball is still above the floor", async () => {
  const authority = new MatchAuthority("room", true, "rift-volley");
  authority.join("p0", "Guest");
  authority.phase = "playing";
  const initial = authority.session.capture();
  initial.state.phase = "play";
  initial.state.phaseTicks = 0;
  initial.state.volley!.serving = false;
  initial.state.ball.z = 0;
  initial.state.ball.vz = 0;
  authority.session.restore(initial);
  const client = createOnlineSession({
    endpoint: "ws://test",
    sportId: "rift-volley",
  });
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  client.observe(); // Establish the last actually drawn pose before correction.
  const next = authority.session.capture();
  next.state.tick++;
  next.state.ball.z = 9 * 256;
  next.state.ball.vz = -10 * 256;
  authority.session.restore(next);
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  client.step({});
  expect(client.rawObserve().phase).toBe("play");
  expect(client.rawObserve().ball.z).toBeGreaterThan(0);
  expect(client.rawObserve().ball.z).toBeLessThan(next.state.ball.z);
  // Presentation corrections cannot pull a center-height volleyball below its
  // radius, including when an older corrected position was below the floor.
  expect(client.observe().ball.z).toBe(6 * 256);
});

it("sends a team preference and restricts team changes to waiting lobbies", async () => {
  const authority = new MatchAuthority("room");
  authority.join("p0", "Guest");
  const client = createOnlineSession({
    endpoint: "ws://test",
    preferredTeamId: "owls",
  });
  await client.connect("quick");
  expect(fake.joins.at(-1)?.preferredTeamId).toBe("owls");
  expect(client.participantId).toBe("p0");
  client.selectTeam("bats");
  expect(fake.sent.some(([type]) => type === "team")).toBe(false);
  fake.messages.get("lobby")!(authority.lobby());
  client.selectTeam("bats");
  expect(fake.sent.at(-1)).toEqual(["team", { teamId: "bats" }]);
  fake.messages.get("lobby")!({ ...authority.lobby(), phase: "playing" });
  const sent = fake.sent.length;
  client.selectTeam("gators");
  expect(fake.sent).toHaveLength(sent);
});

it("reports rejected team choices without interrupting the connection", async () => {
  const onTeamError = vi.fn();
  const client = createOnlineSession({ endpoint: "ws://test", onTeamError });
  await client.connect("quick");
  fake.messages.get("team-error")!("Choose a different team");
  expect(onTeamError).toHaveBeenCalledWith("Choose a different team");
  expect(client.status).toBe("connecting");
});

it.each([
  "faceoff",
  "coasting",
  "charging",
  "checking",
  "controlled puck",
] as const)(
  "hydrates hockey %s through a generation change and clears stale event delivery",
  async (scenario) => {
    const authority = new MatchAuthority("room", true, "cryptcheck");
    authority.join("p0", "Guest");
    const checkpoint = authority.session.capture();
    const player = checkpoint.state.players[0];
    if (scenario !== "faceoff") {
      checkpoint.state.phase = "play";
      checkpoint.state.phaseTicks = 0;
    }
    if (scenario === "coasting") {
      player.vx = 80 * 256;
      player.vy = -30 * 256;
      player.rx = -117;
      player.ry = 57;
    } else if (scenario === "charging") {
      player.charging = true;
      player.chargeTicks = 12;
    } else if (scenario === "checking") {
      player.slideTicks = 4;
      player.slideHeading = 0;
      checkpoint.state.hockey!.pokeActions[player.id] = checkpoint.state
        .nextAction++;
    } else if (scenario === "controlled puck") {
      checkpoint.state.possessionId = player.id;
      checkpoint.state.ball.lastTouch = player.id;
      checkpoint.state.ball.x = player.x + 14 * 256;
      checkpoint.state.ball.y = player.y;
    }
    authority.session.restore(checkpoint);
    const client = createOnlineSession({
      endpoint: "ws://test",
      sportId: "cryptcheck",
    });
    await client.connect("quick");
    fake.messages.get("snapshot")!(
      encodeSnapshot(
        authority.snapshot("p0", [
          { type: "stick-contact", tick: 0, counter: 10 },
        ]),
      ),
    );
    expect(client.status).toBe("joined");
    expect(client.rawObserve().players[0]).toEqual(player);
    expect(client.rawObserve().hockey).toEqual(checkpoint.state.hockey);
    expect(client.rawObserve().possessionId).toBe(
      checkpoint.state.possessionId,
    );
    fake.signals.get("drop")!();
    authority.drop("p0");
    authority.reconnect("p0");
    fake.signals.get("reconnect")!();
    const event = { type: "stick-contact", tick: 0, counter: 11 };
    const bytes = encodeSnapshot(authority.snapshot("p0", [event]));
    fake.messages.get("snapshot")!(bytes);
    expect(client.rawObserve().players[0]).toEqual(
      authority.session.observeFor("p0").players[0],
    );
    expect(client.rawObserve().hockey).toEqual(
      authority.session.observe().hockey,
    );
    expect(client.rawObserve().possessionId).toBe(
      authority.session.observe().possessionId,
    );
    expect(client.diagnostics.replayedTicks).toBe(0);
    expect(client.drainEvents()).toEqual([event]);
    fake.messages.get("snapshot")!(bytes);
    expect(client.drainEvents()).toEqual([]);
    const sent = fake.sent.filter(([type]) => type === "input").length;
    client.step({ strikeHeld: true, slide: true, check: true });
    expect(fake.sent.filter(([type]) => type === "input")).toHaveLength(sent);
  },
);

it("rejects the previous protocol and checkpoint without changing hockey prediction", async () => {
  const authority = new MatchAuthority("room", true, "cryptcheck");
  authority.join("p0", "Guest");
  const client = createOnlineSession({
    endpoint: "ws://test",
    sportId: "cryptcheck",
  });
  await client.connect("quick");
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  const before = client.rawObserve();
  const stale = authority.snapshot("p0", []);
  stale.version = PROTOCOL - 1;
  fake.messages.get("snapshot")!(encodeSnapshot(stale));
  expect(client.status).toBe("interrupted");
  expect(client.rawObserve()).toEqual(before);
  const checkpoint = authority.snapshot("p0", []);
  (checkpoint.checkpoint as { version: number }).version--;
  fake.messages.get("snapshot")!(encodeSnapshot(checkpoint));
  expect(client.status).toBe("interrupted");
  expect(client.rawObserve()).toEqual(before);
});

it("ignores reload credentials stored before protocol/build scoping", async () => {
  sessionStorage.setItem(
    "cryptball-reconnect:ws://test:cryptcheck",
    "room:old-version",
  );
  sessionStorage.setItem(
    "cryptball-reconnect:ws://test:room:room",
    "room:old-version",
  );
  const client = createOnlineSession({
    endpoint: "ws://test",
    sportId: "cryptcheck",
  });
  await client.connect("quick");
  expect(fake.reconnects).toEqual([]);
  expect(fake.joins.at(-1)?.protocol).toBe(PROTOCOL);
});

it("predicts local dash once and confirms only the server action origin", async () => {
  const authority = new MatchAuthority("room", true, "cryptcheck");
  authority.join("p0", "Guest");
  authority.join("p1", "Guest");
  authority.ready("p0");
  authority.ready("p1");
  authority.start();
  for (let t = 0; t < 180; t++) authority.advance();
  const playable=authority.session.capture(); playable.state.phase="play"; playable.state.phaseTicks=0; authority.session.restore(playable);
  const client = createOnlineSession({
    endpoint: "ws://test",
    sportId: "cryptcheck",
  });
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  client.step({});
  now += 1000 / 60;
  client.step({ dash: true, moveX: 1 });
  const predicted = client
    .drainEvents()
    .filter((event) => event.type === "dash");
  expect(predicted).toHaveLength(1);
  const packets = fake.sent
    .filter(([type]) => type === "input")
    .map(([, packet]) => packet as import("../protocol").InputPacket);
  for (const packet of packets)
    expect(authority.receive("p0", packet)).toBe(true);
  while (authority.session.getTick() < packets.at(-1)!.tick)
    authority.advance();
  const authorityEvents = authority.session.drainEvents();
  expect(
    authorityEvents.some(
      (event) =>
        event.type === "dash" && event.origin?.seq === packets.at(-1)!.seq,
    ),
  ).toBe(true);
  fake.messages.get("snapshot")!(
    encodeSnapshot(authority.snapshot("p0", authorityEvents)),
  );
  expect(
    client.drainEvents().filter((event) => event.type === "dash"),
  ).toHaveLength(0);
  expect(client.diagnostics.cosmeticConfirmed).toBe(1);
  expect(packets.at(-1)!.command).not.toHaveProperty("origin");
});

it("uses restored neutral controls when a lead correction creates prediction gaps", async () => {
  const authority = new MatchAuthority("room", true);
  authority.join("p0", "Guest");
  authority.join("p1", "Guest");
  authority.ready("p0");
  authority.ready("p1");
  authority.start();
  for (let t = 0; t < 180; t++) authority.advance();
  const client = createOnlineSession({ endpoint: "ws://test" });
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  client.step({});
  now += 1000 / 60;
  client.step({ moveX: 1 });
  const packet = fake.sent
    .filter(([type]) => type === "input")
    .at(-1)![1] as import("../protocol").InputPacket;
  const snapshot = authority.snapshot("p0", []);
  snapshot.terminalSeq = snapshot.ack = snapshot.receivedSeq = packet.seq;
  snapshot.dispositions = [];
  snapshot.remote.p0 = { cancel: true };
  snapshot.feedback = {
    ...snapshot.feedback,
    sampleSeq: packet.seq,
    sampleCount: 1,
    minimumMargin: -4,
    lowMargin: -4,
  };
  fake.messages.get("snapshot")!(encodeSnapshot(snapshot));
  const before = client.rawObserve().players[0].x;
  now += 1000 / 60;
  client.step({});
  expect(client.rawObserve().players[0].x).toBe(before);
});

it('adopts the authoritative next shuffle activity across a new match epoch',async()=>{
 const authority=new MatchAuthority('shuffle',true,'cryptball',true);
 authority.join('p0','Ada');authority.join('p1','Bea');
 const client=createOnlineSession({endpoint:'ws://test',sportId:'cryptball',shuffle:true,name:'Ada'});
 await client.connect('quick');
 expect(fake.joins[0].name).toBe('Ada');
 fake.messages.get('lobby')!(authority.lobby());
 fake.messages.get('snapshot')!(encodeSnapshot(authority.snapshot('p0',[])));
 authority.phase='results';authority.rematch('p0');authority.rematch('p1');
 fake.messages.get('lobby')!(authority.lobby());
 fake.messages.get('snapshot')!(encodeSnapshot(authority.snapshot('p0',[])));
 expect(client.rawObserve().sportId).toBe(authority.sportId);
 expect(client.rawObserve().sportId).not.toBe('cryptball');
});
