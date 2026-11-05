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
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

it("publishes detached authoritative music state with its reconnect identity", async () => {
  const authority = new MatchAuthority("room", true, "cryptball");
  authority.join("p0", "Ada"); authority.join("p1", "Bea"); authority.ready("p0"); authority.ready("p1"); authority.start();
  for (let i = 0; i < 180; i++) authority.advance();
  const client = createOnlineSession({ endpoint: "ws://test" });
  await client.connect("quick");
  expect(client.musicObservation()).toBeNull();
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  const first = client.musicObservation()!;
  expect(first.state.tick).toBe(authority.session.getTick());
  expect(first.controlledTeam).toBe(first.state.players.find(p => p.id === first.state.controlledId)!.team);
  first.state.score[0] = 999;
  expect(client.musicObservation()!.state.score[0]).not.toBe(999);
  now += 1000 / 60; client.step({});
  expect(client.musicObservation()!.stamp).toEqual(first.stamp);
  expect(client.musicObservation()!.state.tick).toBe(first.state.tick);
  authority.reconnect("p0");
  fake.signals.get("reconnect")!();
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  const rejoined = client.musicObservation()!;
  expect(rejoined.stamp.matchId).toBe(first.stamp.matchId);
  expect(rejoined.stamp.generation).toBeGreaterThan(first.stamp.generation);
  expect(rejoined.stamp.snapshotSeq).toBeGreaterThan(first.stamp.snapshotSeq);
});

it("withholds the old soundtrack while a new Shuffle lobby awaits its checkpoint", async () => {
  const authority = new MatchAuthority("room", true, "cryptball", true);
  authority.join("p0", "Ada"); authority.join("p1", "Bea"); authority.ready("p0"); authority.ready("p1"); authority.start();
  for (let i = 0; i < 180; i++) authority.advance();
  const client = createOnlineSession({ endpoint: "ws://test", shuffle: true });
  await client.connect("quick");
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  const first = client.musicObservation()!;
  authority.phase = "results"; authority.rematch("p0"); authority.rematch("p1");
  fake.messages.get("lobby")!(authority.lobby());
  expect(client.musicObservation()).toBeNull();
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  expect(client.musicObservation()).toBeNull();
  authority.ready("p0"); authority.ready("p1"); authority.start();
  for (let i = 0; i < 180; i++) authority.advance();
  fake.messages.get("lobby")!(authority.lobby());
  fake.messages.get("snapshot")!(encodeSnapshot(authority.snapshot("p0", [])));
  const next = client.musicObservation()!;
  expect(next.stamp.matchId).not.toBe(first.stamp.matchId);
  expect(next.state.sportId).toBe(authority.sportId);
});
