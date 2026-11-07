import { multiplayerEndpoint, reconnectAfterReload } from "./connection";
import { Client, type Room } from "@colyseus/sdk";
import { BUILD, PROTOCOL } from "../../protocol";
import type { SportId } from "../session";
import type {
  FriendsDirectory,
  FriendsCourtRequest,
  FriendsDirectoryError,
  CourtIntent,
} from "../../friends-protocol";
export type { FriendsDirectory } from "../../friends-protocol";
export function createFriendsSession(
  onDirectory: (value: FriendsDirectory) => void,
  onError: (message: string) => void,
) {
  const client = new Client(multiplayerEndpoint());
  let room: Room | undefined;
  let activeGroup = "";
  const pending = new Map<
    string,
    {
      resolve: (value: Parameters<Client["consumeSeatReservation"]>[0]) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function clear(message: string) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(Error(message));
    }
    pending.clear();
  }
  return {
    async connect(name: string, groupKey?: string) {
      const storageKey = `cryptball-friends:${BUILD}:${PROTOCOL}:${groupKey ?? "new"}`;
      const persist = (key: string) => {
        try {
          if (room)
            sessionStorage.setItem(
              `cryptball-friends:${BUILD}:${PROTOCOL}:${key}`,
              room.reconnectionToken,
            );
        } catch {}
      };
      const options = {
        build: BUILD,
        protocol: PROTOCOL,
        name,
        ...(groupKey ? { groupKey } : { foundingKey: crypto.randomUUID() }),
      };
      if (groupKey) {
        let token: string | null = null;
        try {
          token = sessionStorage.getItem(storageKey);
        } catch {}
        if (token) {
          try {
            room = await reconnectAfterReload(client, token);
          } catch {
            try {
              sessionStorage.removeItem(storageKey);
            } catch {}
            throw Error(
              "Your group session expired. Please enter your name again.",
            );
          }
        }
      }
      room ??= groupKey
        ? await client.joinOrCreate("friends", options)
        : await client.create("friends", options);
      room.reconnection.minUptime = 0;
      room.onMessage("directory", (value: FriendsDirectory) => {
        activeGroup = value.groupKey;
        persist(value.groupKey);
        onDirectory(value);
      });
      room.onReconnect(() => {
        if (groupKey) persist(groupKey);
      });
      room.onMessage(
        "court-reservation",
        (value: {
          requestId: string;
          reservation: Parameters<Client["consumeSeatReservation"]>[0];
        }) => {
          const item = pending.get(value.requestId);
          if (!item) return;
          clearTimeout(item.timer);
          pending.delete(value.requestId);
          item.resolve(value.reservation);
        },
      );
      room.onMessage("directory-error", (value: FriendsDirectoryError) => {
        const item =
          value.requestId === undefined
            ? undefined
            : pending.get(value.requestId);
        if (item) {
          clearTimeout(item.timer);
          pending.delete(value.requestId!);
          item.reject(Error(value.message));
        } else onError(value.message);
      });
      room.onError((_code, message) =>
        onError(message ?? "Friends lobby connection failed."),
      );
      room.onLeave(() => {
        clear("Friends lobby disconnected.");
        onError(
          "Friends lobby disconnected. Open the invite again to reconnect.",
        );
      });
    },
    court(
      sportId: SportId,
      courtId?: string,
      intent: CourtIntent = "play",
      newCourt = false,
    ) {
      const requestId = crypto.randomUUID();
      return new Promise<Parameters<Client["consumeSeatReservation"]>[0]>(
        (resolve, reject) => {
          if (!room) {
            reject(Error("Friends lobby is disconnected."));
            return;
          }
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(Error("The court did not respond. Try again."));
          }, 15000);
          pending.set(requestId, { resolve, reject, timer });
          const request: FriendsCourtRequest = {
            requestId,
            sportId,
            courtId,
            intent,
            ...(newCourt ? { newCourt: true } : {}),
          };
          room.send("court", request);
        },
      );
    },
    disconnectForReload() {
      if (room) {
        room.reconnection.enabled = false;
        room.connection.close(4010, "reload");
      }
    },
    async leave() {
      try {
        sessionStorage.removeItem(
          `cryptball-friends:${BUILD}:${PROTOCOL}:${activeGroup}`,
        );
      } catch {}
      clear("Left friends lobby.");
      const old = room;
      room = undefined;
      if (old) {
        old.onLeave.clear();
        await old.leave();
      }
    },
  };
}
export type FriendsSession = ReturnType<typeof createFriendsSession>;
