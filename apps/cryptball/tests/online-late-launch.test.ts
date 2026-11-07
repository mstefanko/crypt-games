import { afterEach, beforeEach, it, expect, vi } from "vitest";
const fake = vi.hoisted(() => ({
  messages: new Map<string, (v: unknown) => void>(),
  signals: new Map<string, () => void>(),
  sent: [] as [string, unknown][],
  joins: [] as Record<string, unknown>[],
  reconnects: [] as string[],
  rejectReservation: false,
  reconnectFailures: 0,
  leaves: 0,
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
    leave: async () => {
      fake.leaves++;
    },
    connection: { close: () => {} },
  };
  return {
    Client: class {
      async consumeSeatReservation() {
        if (fake.rejectReservation)
          throw Error("Court filled while connecting");
        return room;
      }
      async joinOrCreate(_name: string, options: Record<string, unknown>) {
        fake.joins.push(options);
        return room;
      }
      async reconnect(token: string) {
        fake.reconnects.push(token);
        if (fake.reconnectFailures-- > 0)
          throw Error("seat reservation expired");
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
import { encodeSnapshot } from "../protocol";
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
  fake.rejectReservation = false;
  fake.reconnectFailures = 0;
  fake.leaves = 0;
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
it("replays a late authoritative restart launch without jumping to its replayed endpoint", async () => {
  const authority = new MatchAuthority("room", true, "cryptkick");
  for (const id of ["p0", "p1", "p2", "p3"]) {
    authority.join(id, "Guest");
    authority.ready(id);
  }
  authority.start();
  for (let t = 0; t < 180; t++) authority.advance();
  const cp = authority.session.capture();
  cp.state.phase = "play";
  cp.state.phaseTicks = 0;
  cp.state.restartTeam = 1;
  cp.state.restartProtection = 60;
  cp.state.ball.x = 70 * 256;
  cp.state.ball.y = 0;
  cp.state.ball.lastTouch = null;
  for (const p of cp.state.players) {
    p.x = (p.team === 0 ? -130 : 130) * 256;
    p.y = 70 * 256;
  }
  authority.session.restore(cp);
  const client = createOnlineSession({
    endpoint: "ws://test",
    sportId: "cryptkick",
  });
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  for (let i = 0; i < 10; i++) {
    now += 1000 / 60;
    client.step({});
    client.presentFrame(client.observe());
  }
  const drawnBefore = client.presentFrame(client.observe());
  expect(drawnBefore.ball.x).toBe(70 * 256);
  const correction = authority.session.capture();
  // The late checkpoint begins at the actual release position. Existing replay
  // supplies the remaining physical samples up to the client's predicted tick.
  correction.state.ball.vx = -240 * 256;
  correction.state.ball.lastTouch = "player-2";
  correction.state.restartProtection = 0;
  authority.session.restore(correction);
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  const raw = client.observe();
  expect(raw.ball.x).toBeLessThan(58 * 256);
  const drawn = client.presentFrame(raw);
  expect(drawn.ball.x).toBe(drawnBefore.ball.x);
  expect(client.ballCorrectionAlpha()).toBe(1);
  now += 1000 / 60;
  client.step({});
  const next = client.presentFrame(client.observe());
  expect(next.ball.x).toBeLessThan(drawn.ball.x);
  expect(drawn.ball.x - next.ball.x).toBeLessThanOrEqual(9 * 256);
  expect(client.rawObserve().ball.x).toBeLessThan(next.ball.x);
});
