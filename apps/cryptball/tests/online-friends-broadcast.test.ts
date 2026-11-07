import { expect, it, vi } from "vitest";
import { CryptballRoom, service } from "../../cryptball-server/src/room";
import { MatchAuthority } from "../../cryptball-server/src/model";
import { work } from "../../cryptball-server/src/metrics";
import { decodeSnapshot, encodeSnapshot } from "../protocol";

it("reuses observer bytes only for observers while players retain individual checkpoints", () => {
  const room = new CryptballRoom();
  room.authority = new MatchAuthority(
    "broadcast",
    true,
    "cryptball",
    false,
    true,
  );
  room.authority.admit("player", "Player");
  room.authority.admit("viewer", "Viewer", undefined, "watch");
  const checkpoint = room.authority.session.capture();
  const shared = encodeSnapshot(
    room.authority.observerSnapshot([], checkpoint),
  );
  const before = work.encodeMs.read().count;
  const send = (id: string) => {
    const client = {
      sessionId: id,
      ref: { bufferedAmount: 0 },
      sendBytes: vi.fn(),
    };
    (
      room as unknown as {
        sendSnapshot(
          client: unknown,
          events: never[],
          checkpoint: unknown,
          bytes: Uint8Array,
        ): void;
      }
    ).sendSnapshot(client, [], checkpoint, shared);
    return client.sendBytes.mock.calls[0][1] as Uint8Array;
  };
  const player = decodeSnapshot(send("player"));
  expect(player.observer).not.toBe(true);
  expect(player.participantId).toBe("player");
  const viewerBytes = send("viewer");
  expect(viewerBytes).toBe(shared);
  expect(decodeSnapshot(viewerBytes).observer).toBe(true);
  expect(work.encodeMs.read().count - before).toBe(1);
  service.peerOutbound.clear();
});

it("drops a slow observer once while its close handshake is pending", () => {
  const room = new CryptballRoom();
  room.authority = new MatchAuthority("slow", true, "cryptball", false, true);
  room.authority.admit("viewer", "Viewer", undefined, "watch");
  const client = {
    sessionId: "viewer",
    ref: { bufferedAmount: 65537 },
    leave: vi.fn(),
  };
  const before = service.droppedSlow;
  const transport = room as unknown as {
    sendSnapshot(client: unknown, events: never[]): void;
  };
  transport.sendSnapshot(client, []);
  transport.sendSnapshot(client, []);
  expect(client.leave).toHaveBeenCalledOnce();
  expect(client.leave).toHaveBeenCalledWith(
    4001,
    expect.stringContaining("Connection too slow"),
  );
  expect(service.droppedSlow - before).toBe(1);
});
