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

it("hands height correction to the presentation owner without smoothing observation", async () => {
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
  expect(client.observe().ball.z).toBe(client.rawObserve().ball.z);
  const correction = client.takePresentationCorrection();
  expect(correction).not.toBeNull();
  expect(correction!.reset).toBe(true); // The checkpoint advanced the logical tick.
  expect(client.takePresentationCorrection()).toBeNull();
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

it("preserves intermediate prediction when host consumes an absent correction first", async () => {
  const authority = new MatchAuthority("room", true);
  authority.join("p0", "Guest");
  authority.phase = "playing";
  const client = createOnlineSession({endpoint:"ws://test"});
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  client.takePresentationCorrection();
  client.step({});
  expect(client.takePresentationCorrection()).toBeNull();
  const previous = client.takePreviousPrediction();
  expect(previous).not.toBeNull();
  expect(previous!.tick).toBe(client.simulationTick - 1);
  expect(client.takePreviousPrediction()).toBeNull();
  now += 1000/60;
  client.step({moveX:1});
  expect(client.takePreviousPrediction()).toBeNull();
});

it("composes multiple same-tick reconciliations against the earliest pending baseline", async () => {
  const authority = new MatchAuthority("room", true);
  authority.join("p0", "Guest");
  authority.phase = "playing";
  const client = createOnlineSession({endpoint:"ws://test"});
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  const send = () => fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  send();
  client.takePresentationCorrection();
  const baseline = client.rawObserve();
  for (let n = 0; n < 2; n++) {
    const checkpoint = authority.session.capture();
    checkpoint.state.players[0].x += 256;
    authority.session.restore(checkpoint);
    send();
  }
  const correction = client.takePresentationCorrection()!;
  expect(correction.reset).toBe(false);
  expect(correction.before.players[0].x).toBe(baseline.players[0].x);
  expect(correction.after.players[0].x).toBe(baseline.players[0].x + 512);
});

it.each(["manual", "pass", "forced"] as const)("preserves a predicted %s switch and following press/release across 150ms RTT checkpoints", async (kind) => {
  const sportId = kind === "pass" ? "cryptball" : "crypt-dodge";
  const switchFrame = kind === "pass" ? 30 : 180;
  const authority = new MatchAuthority("room", true, sportId);
  for (const id of ["p0", "p1"]) { authority.join(id, "Guest"); authority.ready(id); }
  authority.start();
  for (let n = 0; n < 180; n++) authority.advance();
  const initial = authority.session.capture(); initial.state.phase = "play"; initial.state.phaseTicks = 0;
  if (kind === "pass") {
    const controller = initial.state.controllers.find(c => c.id === "p0")!;
    const player = initial.state.players.find(p => p.id === controller.playerId)!;
    for (const other of initial.state.players) { other.x = (other.team === 0 ? -160 : 160) * 256; other.y = (Number(other.id.slice(-1)) % 3 - 1) * 90 * 256; }
    player.x = -80 * 256; player.y = 0;
    player.heading = 128;
    initial.state.ball.x = player.x - 16 * 256; initial.state.ball.y = player.y;
    initial.state.ball.vx = initial.state.ball.vy = 0;
  }
  authority.session.restore(initial);
  const client = createOnlineSession({endpoint:"ws://test", sportId});
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [], undefined, now)));
  const deliveries: {at:number;run:()=>void}[] = [];
  let sent = 0;
  const executed = new Set<number>();
  const originalTerminal = (authority as any).terminal.bind(authority);
  vi.spyOn(authority as any, "terminal").mockImplementation((...args:any[]) => {
    if (args[0].id === "p0" && args[2] === undefined) executed.add(args[1]);
    return originalTerminal(...args);
  });
  let switchSeq = 0, pressSeq = 0, releaseSeq = 0;
  let switchedId = "";
  const oldId = client.rawObserve().controlledId;
  for (let frame = 0; frame < 360; frame++) {
    now = frame * (1000 / 60);
    for (let i = 0; i < deliveries.length;) {
      if (deliveries[i]!.at <= now) deliveries.splice(i, 1)[0]!.run(); else i++;
    }
    if (kind === "forced" && frame === switchFrame) {
      const checkpoint = authority.session.capture();
      const controlled = checkpoint.state.controllers.find(c => c.id === "p0")!.playerId;
      checkpoint.state.dodge!.athletes[controlled].lives = 0;
      for (const ball of checkpoint.state.dodge!.balls) if (ball.mode.holderId === controlled) {
        ball.mode.holderId = null;
        ball.mode.state = "dead-loose";
      }
      checkpoint.state.dodge!.ball = checkpoint.state.dodge!.balls[0].mode;
      checkpoint.state.possessionId = checkpoint.state.dodge!.ball.holderId;
      authority.session.restore(checkpoint);
    }
    authority.advance();
    if (kind === "forced" && frame === switchFrame) {
      expect(authority.peers.get("p0")!.held).toEqual({});
      expect(authority.peers.get("p0")!.effective).toEqual({});
    }
    if (kind === "forced" && frame > switchFrame && frame < switchFrame+20) {
      const observation = authority.session.observeFor("p0");
      const replacement = observation.players.find(player => player.id === observation.controlledId)!;
      expect(replacement.charging).toBe(false);
      expect(replacement.action).toBeNull();
      expect(replacement.dashTicks).toBe(0);
    }
    // Keep the second human alive without adding another predictor to this test.
    if (frame % 6 === 0) authority.heartbeat("p1", {epoch:authority.epoch,generation:authority.peers.get("p1")!.generation,revision:authority.session.getControllerRevision("p1")!});
    if (frame % 3 === 0) {
      const bytes = encodeSnapshot(authority.snapshot("p0", [], undefined, now));
      deliveries.push({at:now+75,run:()=>fake.messages.get("snapshot")!(bytes)});
    }
    client.step({moveX:kind === "pass" && frame < switchFrame+19 ? 0 : 1,
      switch:kind === "manual" && frame===switchFrame,
      pass:kind === "pass" && frame===switchFrame,
      dash:kind === "forced" && frame===switchFrame,
      strikePressed:frame===switchFrame+20 || (kind === "forced" && frame===switchFrame-10),
      strikeHeld:frame===switchFrame+20 || (kind === "forced" && frame>=switchFrame-10 && frame<switchFrame+19),
      strikeReleased:frame===switchFrame+21});
    if (frame === switchFrame+19) switchedId = client.rawObserve().controlledId;
    while (sent < fake.sent.length) {
      const [type, value] = fake.sent[sent++]!;
      const packet = value as import("../protocol").InputPacket;
      if (type === "input") {
        if (packet.command.switch || packet.command.pass || (kind === "forced" && packet.command.dash)) switchSeq = packet.seq;
        if (packet.command.strikePressed) pressSeq = packet.seq;
        if (packet.command.strikeReleased) releaseSeq = packet.seq;
      }
      deliveries.push({at:now+75,run:()=>{
        if(type==="input") authority.receive("p0", packet);
        else if(type==="heartbeat") authority.heartbeat("p0", value);
        else if(type==="ping") {
          const pong = {...value as object,serverTime:now,tick:authority.session.getTick(),epoch:authority.epoch,phase:authority.phase};
          deliveries.push({at:now+75,run:()=>fake.messages.get("pong")!(pong)});
        }
      }});
    }
    if (frame > switchFrame+21 && frame < switchFrame+30) expect(client.rawObserve().controlledId).toBe(switchedId);
  }
  expect(switchedId).not.toBe(oldId);
  expect(authority.session.observeFor("p0").controlledId).toBe(switchedId);
  for (const seq of [pressSeq,releaseSeq]) { expect(seq).toBeGreaterThan(0); expect(executed.has(seq)).toBe(true); }
  expect(switchSeq).toBeGreaterThan(0);
  expect(executed.has(switchSeq)).toBe(kind !== "forced");
  expect(authority.peers.get("p0")!.feedback.rejectionReasons["sequence-gap"]).toBe(0);
  if (kind === "forced") expect(authority.peers.get("p0")!.feedback.rejectionReasons.revision).toBeGreaterThan(0);
  else expect(authority.peers.get("p0")!.feedback.rejectionReasons.revision).toBe(0);
});

it.each([false, true])("handles an intermediate revision with the second predicted switch rejected=%s", async (rejected) => {
  const authority = new MatchAuthority("room", true);
  for (const id of ["p0", "p1"]) { authority.join(id,"Guest"); authority.ready(id); }
  authority.start(); for (let n=0;n<180;n++) authority.advance();
  const client = createOnlineSession({endpoint:"ws://test"});
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0",[],undefined,now)));
  const originalId = client.rawObserve().controlledId;
  for (let frame=0;frame<21;frame++) {
    now=frame*1000/60;
    client.step({switch:frame===1||frame===19,moveX:1});
  }
  expect(client.rawObserve().controlledId).toBe(originalId);
  const packets=fake.sent.filter(([type])=>type==="input").map(([,p])=>p as import("../protocol").InputPacket);
  const firstSwitch=packets.find(p=>p.command.switch)!;
  expect(packets.filter(p=>p.command.switch)).toHaveLength(2);
  for(const packet of packets) expect(authority.receive("p0",packet)).toBe(true);
  while(authority.session.getTick()<firstSwitch.tick) authority.advance();
  expect(authority.session.getControllerRevision("p0")).toBe(1);
  expect(authority.session.observeFor("p0").controlledId).not.toBe(originalId);
  const snapshot = authority.snapshot("p0",[],undefined,now);
  if (rejected) {
    const secondSwitch = packets.filter(packet => packet.command.switch)[1]!;
    const disposition = snapshot.dispositions.find(d => d.seq === secondSwitch.seq)!;
    disposition.status = "rejected";
    disposition.reason = "revision";
    expect(secondSwitch.seq).toBeGreaterThan(snapshot.terminalSeq);
  }
  fake.messages.get("snapshot")!(encodeSnapshot(snapshot));
  expect(client.rawObserve().controlledId).toBe(rejected ? authority.session.observeFor("p0").controlledId : originalId);
  expect(client.rawObserve().tick).toBe(packets.at(-1)!.tick);
  if (rejected) {
    const before = fake.sent.filter(([type]) => type === "input").length;
    now += 1000/60;
    client.step({strikePressed:true,strikeHeld:true});
    expect(fake.sent.filter(([type]) => type === "input")).toHaveLength(before);
  }
});

it("neutralizes unmatched authoritative player identity even at equal controller revision", async () => {
  const authority = new MatchAuthority("room", true);
  for (const id of ["p0", "p1"]) { authority.join(id,"Guest"); authority.ready(id); }
  authority.start(); for(let n=0;n<180;n++) authority.advance();
  const client=createOnlineSession({endpoint:"ws://test"}); await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0",[])));
  client.step({});
  const checkpoint=authority.session.capture(), controller=checkpoint.state.controllers.find(c=>c.id==="p0")!;
  const replacement=checkpoint.state.players.find(p=>p.team===controller.team && p.role!=="keeper" && !checkpoint.state.controllers.some(c=>c.playerId===p.id))!;
  controller.playerId=replacement.id; checkpoint.state.controlledId=replacement.id;
  authority.session.restore(checkpoint);
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0",[])));
  const before=fake.sent.filter(([type])=>type==="input").length;
  now+=1000/60; client.step({strikePressed:true,strikeHeld:true});
  expect(client.rawObserve().controlledId).toBe(replacement.id);
  expect(fake.sent.filter(([type])=>type==="input")).toHaveLength(before);
});

it("neutralizes a rejected first predicted switch while confirmed revision remains unchanged", async () => {
  const authority = new MatchAuthority("room", true);
  for (const id of ["p0","p1"]) { authority.join(id,"Guest"); authority.ready(id); }
  authority.start(); for(let n=0;n<180;n++) authority.advance();
  const client=createOnlineSession({endpoint:"ws://test"}); await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0",[])));
  const owner=client.rawObserve().controlledId;
  client.step({}); now+=1000/60; client.step({switch:true,moveX:1});
  expect(client.rawObserve().controlledId).not.toBe(owner);
  const packets=fake.sent.filter(([type])=>type==="input").map(([,p])=>p as import("../protocol").InputPacket);
  for(const packet of packets) expect(authority.receive("p0",packet)).toBe(true);
  const snapshot=authority.snapshot("p0",[],undefined,now);
  const pendingSwitch=snapshot.dispositions.find(d=>d.seq===packets.at(-1)!.seq)!;
  pendingSwitch.status="rejected"; pendingSwitch.reason="revision";
  expect(snapshot.terminalSeq).toBe(0);
  fake.messages.get("snapshot")!(encodeSnapshot(snapshot));
  expect(client.rawObserve().controlledId).toBe(owner);
  const before=fake.sent.filter(([type])=>type==="input").length;
  now+=1000/60; client.step({strikePressed:true,strikeHeld:true});
  expect(fake.sent.filter(([type])=>type==="input")).toHaveLength(before);
});

it.each([false,true])("retains measured route lead across an unmatched handoff with rematch=%s", async (rematch) => {
  const authority=new MatchAuthority("room",true); authority.join("p0","Guest"); authority.phase="playing";
  const client=createOnlineSession({endpoint:"ws://test"}); await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0",[],undefined,now)));
  client.step({});
  const ping=fake.sent.find(([type])=>type==="ping")![1] as {id:number;sent:number};
  now=150;
  fake.messages.get("pong")!({...ping,epoch:authority.epoch,serverTime:75,tick:authority.session.getTick(),phase:"playing"});
  expect(client.diagnostics.rttMs).toBe(150);
  if (rematch) authority.epoch++;
  const checkpoint=authority.session.capture(); checkpoint.state.epoch=authority.epoch;
  checkpoint.state.controllers.find(c=>c.id==="p0")!.revision++;
  authority.session.restore(checkpoint);
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0",[],undefined,now)));
  client.step({});
  const packet=fake.sent.filter(([type])=>type==="input").at(-1)![1] as import("../protocol").InputPacket;
  expect(packet.epoch).toBe(authority.epoch);
  expect(packet.seq).toBe(rematch ? 1 : 2);
  expect(packet.tick-authority.session.getTick()).toBeGreaterThanOrEqual(7);
});

it("waits for a matching playing checkpoint before assigning the first input after countdown", async () => {
  const authority=new MatchAuthority("room",true); authority.join("p0","Guest");
  authority.phase="countdown";
  const client=createOnlineSession({endpoint:"ws://test"}); await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0",[],undefined,now)));
  client.update();
  const ping=fake.sent.find(([type])=>type==="ping")![1] as {id:number;sent:number};
  now=150;
  fake.messages.get("pong")!({...ping,epoch:authority.epoch,serverTime:75,tick:0,phase:"countdown"});
  expect(client.diagnostics.rttMs).toBe(150);
  now=3000; authority.countdown=1;
  for(let n=0;n<5;n++) authority.advance();
  fake.messages.get("lobby")!(authority.lobby());
  const liveSnapshot=encodeSnapshot(authority.snapshot("p0",[],undefined,now));
  client.step({moveX:1});
  expect(fake.sent.filter(([type])=>type==="input")).toHaveLength(0);
  // The first playing checkpoint spends 75ms on the downlink. The remaining
  // uplink delay must fit the target derived from its extrapolated server time.
  now+=75; for(let n=0;n<4;n++) authority.advance();
  fake.messages.get("snapshot")!(liveSnapshot);
  client.step({moveX:1});
  const packet=fake.sent.filter(([type])=>type==="input").at(-1)![1] as import("../protocol").InputPacket;
  expect(packet.seq).toBe(1);
  for(let n=0;n<5;n++) authority.advance();
  expect(authority.receive("p0",packet)).toBe(true);
  expect(authority.peers.get("p0")!.feedback.rejectionReasons.expired).toBe(0);
});

it.each(["cryptball","cryptkick","rift-volley","cryptcheck","crypt-dodge"] as const)("preserves connection clock offset across an aged %s rematch checkpoint without a fresh pong", async (sportId) => {
  const authority=new MatchAuthority("room",true,sportId);
  for(const id of ["p0","p1"]) { authority.join(id,"Guest"); authority.ready(id); }
  authority.start(); for(let n=0;n<180;n++) authority.advance();
  const client=createOnlineSession({endpoint:"ws://test",sportId}); await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0",[],undefined,now)));
  client.update();
  const ping=fake.sent.find(([type])=>type==="ping")![1] as {id:number;sent:number};
  now=150;
  fake.messages.get("pong")!({...ping,epoch:authority.epoch,serverTime:75,tick:0,phase:"playing"});
  expect(client.diagnostics.rttMs).toBe(150);
  authority.epoch++;
  const checkpoint=authority.session.capture(); checkpoint.state.epoch=authority.epoch; checkpoint.state.tick=0;
  authority.session.restore(checkpoint);
  const snapshot=encodeSnapshot(authority.snapshot("p0",[],undefined,now));
  // Both directions take ~five fixed ticks. No new pong is delivered after the
  // epoch changes, so admission depends on retaining the measured clock offset.
  now+=75; for(let n=0;n<5;n++) authority.advance();
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(snapshot);
  client.step({});
  const packet=fake.sent.filter(([type])=>type==="input").at(-1)![1] as import("../protocol").InputPacket;
  expect(packet.seq).toBe(1);
  expect(packet.tick).toBeGreaterThanOrEqual(11);
  for(let n=0;n<5;n++) authority.advance();
  expect(authority.receive("p0",packet)).toBe(true);
  expect(authority.peers.get("p0")!.feedback.rejectionReasons.expired).toBe(0);
});
