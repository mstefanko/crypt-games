import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { Client, type Room } from "@colyseus/sdk";
let server: ChildProcess,
  endpoint = "",
  output = "",
  BUILD: string,
  PROTOCOL: number;
const rooms: Room[] = [];
async function until(test: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!test()) {
    if (Date.now() > deadline) throw Error(output || "Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
beforeAll(async () => {
  await promisify(execFile)(process.execPath, [
    "apps/cryptball-server/build.mjs",
  ]);
  vi.resetModules();
  ({ BUILD, PROTOCOL } = await import("../protocol"));
  server = spawn(process.execPath, ["dist/cryptball-server/main.mjs"], {
    env: {
      ...process.env,
      PORT: "0",
      CRYPTBALL_IP_ADMISSIONS_PER_MINUTE: "40",
      CRYPTBALL_GROUP_SECRET: "directory-test-stable-key",
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
}, 12000);
afterAll(async () => {
  await Promise.allSettled(rooms.map((r) => r.leave()));
  server?.kill("SIGKILL");
});
async function directory(groupKey?: string) {
  const client = new Client(endpoint),
    room = groupKey
      ? await client.joinOrCreate("friends", {
          build: BUILD,
          protocol: PROTOCOL,
          groupKey,
          name: "Guest",
        })
      : await client.create("friends", {
          build: BUILD,
          protocol: PROTOCOL,
          name: "Host",
          foundingKey: crypto.randomUUID(),
        });
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
it("resolves private reusable groups, keeps empty sports virtual and serializes first court creation", async () => {
  const a = await directory(),
    b = await directory(a.state.groupKey),
    other = await directory();
  expect(b.room.roomId).toBe(a.room.roomId);
  expect(other.room.roomId).not.toBe(a.room.roomId);
  expect(a.state.courts).toHaveLength(0);
  let one: any, two: any;
  a.room.onMessage("court-reservation", (v) => (one = v));
  b.room.onMessage("court-reservation", (v) => (two = v));
  a.room.send("court", {
    requestId: "a",
    sportId: "cryptball",
    intent: "play",
  });
  b.room.send("court", {
    requestId: "b",
    sportId: "cryptball",
    intent: "play",
  });
  await until(() => !!one && !!two);
  expect(one.reservation.roomId).toBe(two.reservation.roomId);
  const p = await a.client.consumeSeatReservation(one.reservation),
    q = await b.client.consumeSeatReservation(two.reservation);
  rooms.push(p, q);
  for (const room of [p, q]) {
    room.onMessage("snapshot", () => {});
    room.onMessage("lobby", () => {});
  }
  await until(() => a.state.courts.length === 1);
  expect(other.state.courts).toHaveLength(0);
  await expect(
    new Client(endpoint).create("friends-court", {
      build: BUILD,
      protocol: PROTOCOL,
      private: true,
      groupKey: a.state.groupKey,
    }),
  ).rejects.toThrow();
  await expect(
    new Client(endpoint).joinById(p.roomId, {
      build: BUILD,
      protocol: PROTOCOL,
    }),
  ).rejects.toThrow();
  await expect(
    new Client(endpoint).joinOrCreate("friends", {
      build: BUILD,
      protocol: PROTOCOL,
      groupKey: "forged",
    }),
  ).rejects.toThrow();
  await expect(
    new Client(endpoint).joinById(a.room.roomId, {
      build: BUILD,
      protocol: PROTOCOL,
    }),
  ).rejects.toThrow();
  const recovery = await directory(a.state.groupKey);
  const memberIds = recovery.state.members
    .map((m: { memberId: string }) => m.memberId)
    .sort();
  const token = recovery.room.reconnectionToken;
  recovery.room.connection.close(4010, "reload");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const recovered = await recovery.client.reconnect(token);
  rooms.push(recovered);
  let recoveredState: any;
  recovered.onMessage("directory", (v) => (recoveredState = v));
  recovered.send("refresh");
  await until(() => !!recoveredState);
  expect(
    recoveredState.members.map((m: { memberId: string }) => m.memberId).sort(),
  ).toEqual(memberIds);
  const reusableKey = other.state.groupKey,
    oldId = other.room.roomId;
  await other.room.leave();
  await new Promise((r) => setTimeout(r, 1300));
  const reopened = await directory(reusableKey);
  expect(reopened.state.groupKey).toBe(reusableKey);
  expect(reopened.room.roomId).not.toBe(oldId);
  let overflow: any, secondOverflow: any;
  b.room.onMessage("court-reservation", (v) => {
    if (v.requestId === "overflow") secondOverflow = v;
  });
  a.room.onMessage("court-reservation", (v) => {
    if (v.requestId === "overflow") overflow = v;
  });
  a.room.send("court", {
    requestId: "overflow",
    sportId: "cryptball",
    newCourt: true,
    intent: "play",
  });
  b.room.send("court", {
    requestId: "overflow",
    sportId: "cryptball",
    newCourt: true,
    intent: "play",
  });
  await until(() => !!overflow && !!secondOverflow);
  expect(overflow.reservation.roomId).not.toBe(
    secondOverflow.reservation.roomId,
  );
  const prior = overflow;
  overflow = undefined;
  a.room.send("court", {
    requestId: "overflow",
    sportId: "cryptball",
    newCourt: true,
    intent: "play",
  });
  await until(() => !!overflow);
  expect(overflow.reservation.sessionId).toBe(prior.reservation.sessionId);
  expect(overflow.reservation.roomId).not.toBe(p.roomId);
  const courtToken = p.reconnectionToken;
  p.connection.close(4010, "reload");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const restoredCourt = await a.client.reconnect(courtToken);
  rooms.push(restoredCourt);
  restoredCourt.onMessage("snapshot", () => {});
  restoredCourt.onMessage("lobby", () => {});
  let switched = false;
  restoredCourt.onLeave(() => (switched = true));
  const destination = await a.client.consumeSeatReservation(
    overflow.reservation,
  );
  rooms.push(destination);
  destination.onMessage("snapshot", () => {});
  destination.onMessage("lobby", () => {});
  await until(() => switched);
  let invalid: any;
  a.room.onMessage("directory-error", (v) => (invalid = v));
  a.room.send("court", { requestId: "x".repeat(81), sportId: "cryptball" });
  await until(() => !!invalid);
  expect(invalid.message).toBe("Invalid request ID");
});

it("guards actual Colyseus matchmaking routing and admits shared-IP bursts", async () => {
  const denied = await fetch(`${endpoint}/matchmake/joinById/absent`, {
    method: "POST",
    headers: {
      origin: "https://untrusted.example",
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect(denied.status).toBe(403);
  const statuses: number[] = [];
  for (let i = 0; i < 45; i++)
    statuses.push(
      (
        await fetch(`${endpoint}/matchmake/joinById/absent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    );
  expect(statuses[0]).not.toBe(429);
  expect(statuses.at(-1)).toBe(429);
  expect((await fetch(`${endpoint}/healthz`)).status).toBe(200);
});
