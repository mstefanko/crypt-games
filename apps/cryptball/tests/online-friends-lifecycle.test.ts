import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { Client, type Room } from "@colyseus/sdk";
let server: ChildProcess,
  endpoint = "",
  output = "",
  BUILD: string,
  PROTOCOL: number;
let rooms: Room[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(test: () => boolean | Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!(await test())) {
    if (Date.now() > end) throw Error(`Timed out: ${output}`);
    await pause(20);
  }
}
async function start(viewersPerCourt = 8) {
  endpoint = "";
  output = "";
  server = spawn(process.execPath, ["dist/cryptball-server/main.mjs"], {
    env: {
      ...process.env,
      PORT: "0",
      CRYPTBALL_FRIENDS_VIEWERS_PER_COURT: String(viewersPerCourt),
      CRYPTBALL_GROUP_SECRET: "persistent-lifecycle-test-secret",
      CRYPTBALL_METRICS_TOKEN: "lifecycle",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (c) => {
    output += c;
    const m = output.match(/"port":(\d+)/);
    if (m) endpoint = `http://127.0.0.1:${m[1]}`;
  });
  server.stderr!.on("data", (c) => (output += c));
  await until(() => !!endpoint);
}
async function stop() {
  const old = server;
  if (old?.exitCode === null) {
    const done = new Promise((r) => old.once("exit", r));
    old.kill("SIGKILL");
    await done;
  }
  rooms = [];
}
beforeAll(async () => {
  await promisify(execFile)(process.execPath, [
    "apps/cryptball-server/build.mjs",
  ]);
  vi.resetModules();
  ({ BUILD, PROTOCOL } = await import("../protocol"));
  await start();
}, 12000);
afterAll(stop);
async function directory(groupKey?: string, name = "Sam") {
  const client = new Client(endpoint),
    options = {
      build: BUILD,
      protocol: PROTOCOL,
      name,
      ...(groupKey ? { groupKey } : { foundingKey: crypto.randomUUID() }),
    };
  const room = groupKey
    ? await client.joinOrCreate("friends", options)
    : await client.create("friends", options);
  rooms.push(room);
  let state: any;
  room.onMessage("directory", (v) => (state = v));
  room.send("refresh");
  await until(() => !!state);
  return {
    client,
    room,
    get state() {
      return state;
    },
  };
}
async function reserve(
  group: Awaited<ReturnType<typeof directory>>,
  extra: Record<string, unknown> = {},
) {
  const requestId = crypto.randomUUID();
  return await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("court request timed out")),
      8000,
    );
    group.room.onMessage("court-reservation", (v) => {
      if (v.requestId === requestId) {
        clearTimeout(timer);
        resolve(v.reservation);
      }
    });
    group.room.onMessage("directory-error", (v) => {
      if (v.requestId === requestId) {
        clearTimeout(timer);
        reject(Error(v.message));
      }
    });
    group.room.send("court", {
      requestId,
      sportId: "cryptball",
      intent: "play",
      ...extra,
    });
  });
}
async function join(
  group: Awaited<ReturnType<typeof directory>>,
  extra: Record<string, unknown> = {},
) {
  const room = await group.client.consumeSeatReservation(
    await reserve(group, extra),
  );
  rooms.push(room);
  room.onMessage("snapshot", () => {});
  room.onMessage("lobby", () => {});
  return room;
}
async function metrics() {
  return await (
    await fetch(`${endpoint}/metrics`, {
      headers: { authorization: "Bearer lifecycle" },
    })
  ).json();
}
it.skipIf(process.platform === "win32")(
  "keeps discovery and existing admission available during real event-loop overload, then recovers",
  async () => {
    const host = await directory(),
      court = await join(host),
      second = await directory(host.state.groupKey);
    await join(second, { courtId: court.roomId });
    court.send("start");
    server.kill("SIGSTOP");
    await pause(420);
    server.kill("SIGCONT");
    await until(async () => (await metrics()).simulationOverloaded === true);
    expect((await fetch(`${endpoint}/readyz`)).status).toBe(200);
    const newcomer = await directory(host.state.groupKey);
    expect(newcomer.room.roomId).toBe(host.room.roomId);
    await join(newcomer, { courtId: court.roomId, intent: "watch" });
    const fresh = await directory();
    expect(fresh.state.courts).toHaveLength(0);
    await expect(reserve(fresh, { newCourt: true })).rejects.toThrow(
      /busy|unavailable/i,
    );
    await until(
      async () => (await metrics()).simulationOverloaded === false,
      10000,
    );
    await reserve(fresh, { newCourt: true });
  },
  20000,
);
it.skipIf(process.platform === "win32")(
  "reopens the same signed link across process restart and clears overload when the final court retires",
  async () => {
    const old = await directory(),
      key = old.state.groupKey;
    await stop();
    await start();
    const reopened = await directory(key);
    expect(reopened.state.groupKey).toBe(key);
    expect(reopened.state.courts).toHaveLength(0);
    const court = await join(reopened);
    court.onMessage("interrupted", () => {});
    server.kill("SIGSTOP");
    await pause(1200);
    server.kill("SIGCONT");
    await until(async () => {
      const m = await metrics();
      return m.rooms === 0 && m.simulationOverloaded === false;
    });
    await reserve(reopened, { newCourt: true });
  },
  15000,
);
it("uses all twelve transport seats with a full-court reconnect and releases directed departures without grace", async () => {
  await stop();
  await start();
  const host = await directory(),
    court = await join(host),
    groupKey = host.state.groupKey;
  const players = [court];
  for (let i = 1; i < 12; i++) {
    const member = await directory(groupKey);
    players.push(await join(member, { courtId: court.roomId }));
  }
  const extra = await directory(groupKey);
  expect(new Set(extra.state.members.map((m: any) => m.name)).size).toBe(13);
  await expect(reserve(extra, { courtId: court.roomId })).rejects.toThrow();
  const token = players[0]!.reconnectionToken;
  players[0]!.connection.close(4010, "reload");
  await pause(80);
  await expect(reserve(extra, { courtId: court.roomId })).rejects.toThrow();
  const restored = await host.client.reconnect(token);
  rooms.push(restored);
  restored.onMessage("snapshot", () => {});
  restored.onMessage("lobby", () => {});
  restored.connection.close(4001, "server-directed departure");
  await pause(80);
  const replacement = await join(extra, { courtId: court.roomId });
  expect(replacement.roomId).toBe(court.roomId);
  await expect(
    host.client.reconnect(restored.reconnectionToken),
  ).rejects.toThrow();
}, 20000);

it("rejects superseded transfers and tickets issued to members who explicitly left", async () => {
  const member = await directory(),
    source = await join(member);
  let sourceLeft = false;
  source.onLeave(() => (sourceLeft = true));
  const stale = await reserve(member, { newCourt: true }),
    latest = await reserve(member, { newCourt: true });
  await expect(member.client.consumeSeatReservation(stale)).rejects.toThrow();
  expect(sourceLeft).toBe(false);
  const destination = await member.client.consumeSeatReservation(latest);
  rooms.push(destination);
  destination.onMessage("snapshot", () => {});
  destination.onMessage("lobby", () => {});
  await until(() => sourceLeft);
  let destinationLeft = false;
  destination.onLeave(() => (destinationLeft = true));
  const abandoned = await reserve(member, { newCourt: true });
  await member.room.leave();
  await expect(
    member.client.consumeSeatReservation(abandoned),
  ).rejects.toThrow();
  expect(destinationLeft).toBe(false);
});

it("can roll out the directory and manual starts with viewing disabled", async () => {
  await stop();
  await start(0);
  const mike = await directory(),
    jeff = await directory(mike.state.groupKey);
  const a = await join(mike);
  const b = await join(jeff, { courtId: a.roomId });
  expect(b.roomId).toBe(a.roomId);
  await until(() =>
    mike.state.courts.some(
      (c: { watcherCapacity: number }) => c.watcherCapacity === 0,
    ),
  );
  const viewer = await directory(mike.state.groupKey);
  await expect(
    join(viewer, { courtId: a.roomId, intent: "watch" }),
  ).rejects.toThrow();
  let started = false;
  a.onMessage("lobby", (lobby: { phase: string }) => {
    if (lobby.phase === "countdown") started = true;
  });
  a.send("start");
  await until(() => started);
});
