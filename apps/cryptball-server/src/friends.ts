import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Room, matchMaker, type Client } from "@colyseus/core";
import { BUILD, PROTOCOL, resolveSportId } from "@onepage/cryptball/protocol";
import { service } from "./room";
import type {
  CourtIntent,
  CourtMember,
  FriendsDirectory,
} from "../../cryptball/friends-protocol";
export type { CourtIntent } from "../../cryptball/friends-protocol";

const secret =
  process.env.CRYPTBALL_GROUP_SECRET || randomBytes(32).toString("hex");
if (!process.env.CRYPTBALL_GROUP_SECRET)
  console.warn(
    "CRYPTBALL_GROUP_SECRET is unset; friends links expire on restart",
  );
const signature = (id: string) =>
  createHmac("sha256", secret).update(id).digest("base64url");
export function issueGroupKey() {
  const id = randomBytes(24).toString("base64url");
  return `${id}.${signature(id)}`;
}
export function validGroupKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[\w-]{32}\.[\w-]{43}$/.test(value))
    return false;
  const [id, signed] = value.split(".");
  return timingSafeEqual(Buffer.from(signed!), Buffer.from(signature(id!)));
}
const creationKey = randomBytes(32).toString("hex");
export function authorizeFriendsCreation(options: {
  friendsCreationKey?: string;
}) {
  return options.friendsCreationKey === creationKey;
}
type Ticket = {
  groupKey: string;
  memberId: string;
  courtId: string;
  intent: CourtIntent;
  expires: number;
  name: string;
};
const tickets = new Map<string, Ticket>();
function revokeMemberTickets(memberId: string) {
  for (const [id, ticket] of tickets)
    if (ticket.memberId === memberId) tickets.delete(id);
}
export function consumeCourtTicket(
  options: { admissionTicket?: string; groupKey?: string; memberId?: string },
  courtId: string,
): Ticket | undefined {
  const ticket = tickets.get(options.admissionTicket ?? "");
  if (
    !ticket ||
    ticket.expires < Date.now() ||
    ticket.courtId !== courtId ||
    ticket.groupKey !== options.groupKey ||
    ticket.memberId !== options.memberId
  )
    return;
  tickets.delete(options.admissionTicket!);
  return ticket;
}
export const FRIENDS_LIMITS = {
  groups: 100,
  members: 64,
  courtsPerGroup: 10,
  courts: 15,
  publicCourts: 25,
};
// Friends may use 15 of 25 global simulations; public games can borrow all
// unused capacity. Ten slots therefore remain available to public games.
export function canCreateCourt(friends: boolean) {
  const count = [...service.rooms].filter(
    (r) => Boolean(r.groupKey) === friends,
  ).length;
  return (
    !service.draining &&
    !service.overloaded &&
    service.rooms.size < service.maxRooms &&
    count < (friends ? FRIENDS_LIMITS.courts : FRIENDS_LIMITS.publicCourts)
  );
}
const groups = new Map<string, FriendsLobbyRoom>();
export class FriendsLobbyRoom extends Room {
  maxClients = FRIENDS_LIMITS.members;
  maxMessagesPerSecond = 20;
  groupKey = "";
  private revision = 0;
  private foundingKey?: string;
  private requests = new Map<string, Promise<void>>();
  private transferVersions = new Map<string, number>();
  private results = new Map<
    string,
    { at: number; message: string; value: unknown }
  >();
  private lastSnapshot = "";
  private members = new Map<
    string,
    {
      memberId: string;
      name: string;
      client: Client;
      at: number;
      count: number;
    }
  >();
  private pending = new Map<string, Promise<string>>();
  private courts = new Map<string, number>();
  private lastCourtNumber = new Map<string, number>();
  async onCreate(options: {
    groupKey?: unknown;
    build?: string;
    protocol?: number;
    foundingKey?: unknown;
  }) {
    if (service.draining || groups.size >= FRIENDS_LIMITS.groups)
      throw Error("Friends lobby is busy. Please retry shortly.");
    if (options.build !== BUILD || options.protocol !== PROTOCOL)
      throw Error("Refresh to update Crypt Games");
    if (options.groupKey !== undefined && !validGroupKey(options.groupKey))
      throw Error("Invalid friends link");
    if (
      options.groupKey === undefined &&
      (typeof options.foundingKey !== "string" ||
        options.foundingKey.length < 16 ||
        options.foundingKey.length > 100)
    )
      throw Error("Invalid group creation request");
    this.foundingKey =
      typeof options.foundingKey === "string" ? options.foundingKey : undefined;
    this.groupKey = (options.groupKey as string) || issueGroupKey();
    if (groups.has(this.groupKey))
      throw Error("Friends lobby is opening. Please retry.");
    groups.set(this.groupKey, this);
    // Unlisted directories resolve only through the signed key filter.
    await this.setMatchmaking({
      private: false,
      unlisted: true,
      groupKey: this.groupKey,
    });
    this.autoDispose = false;
    this.onMessage("refresh", (c) => this.publish(c));
    this.onMessage("court", (c, request) => {
      if (
        typeof request?.requestId !== "string" ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(request.requestId)
      ) {
        c.send("directory-error", { message: "Invalid request ID" });
        return;
      }
      const id = `${c.sessionId}:${request.requestId}`;
      if (this.requests.has(id)) {
        void this.requests.get(id)!.then(() => {
          const result = this.results.get(id);
          if (result && Date.now() - result.at < 10000)
            c.send(result.message, result.value);
          else
            c.send("directory-error", {
              requestId: request.requestId,
              message: "This request expired. Please choose again.",
            });
        });
        return;
      }
      const pending = this.requestCourt(c, request);
      this.requests.set(id, pending);
      if (this.requests.size > 1024) {
        const oldest = this.requests.keys().next().value!;
        this.requests.delete(oldest);
        this.results.delete(oldest);
      }
    });
    this.setSimulationInterval(() => {
      this.publish();
      if (
        !this.clients.length &&
        !this.members.size &&
        ![...service.rooms].some((r) => this.courts.has(r.roomId)) &&
        !this.pending.size
      )
        void this.disconnect();
      for (const [id, ticket] of tickets)
        if (ticket.expires < Date.now()) tickets.delete(id);
    }, 1000);
  }
  onAuth(
    _client: Client,
    options: {
      build?: string;
      protocol?: number;
      groupKey?: unknown;
      foundingKey?: unknown;
    },
  ) {
    if (
      options.groupKey !== this.groupKey &&
      (!this.foundingKey || options.foundingKey !== this.foundingKey)
    )
      throw Error("Invalid friends link");
    if (
      service.draining ||
      options.build !== BUILD ||
      options.protocol !== PROTOCOL
    )
      throw Error("Refresh or retry");
    return true;
  }
  onJoin(client: Client, options: { name?: unknown }) {
    const requestedName =
      typeof options.name === "string"
        ? options.name.trim().slice(0, 24)
        : "Guest";
    const baseName = requestedName || "Guest";
    const names = new Set(
      [...this.members.values()].map((member) => member.name),
    );
    for (const room of service.rooms)
      if (this.courts.has(room.roomId)) {
        for (const peer of [
          ...room.authority.peers.values(),
          ...room.authority.observers.values(),
        ])
          names.add(peer.name);
      }
    let name = baseName,
      suffix = 2;
    while (names.has(name)) {
      const tag = ` #${suffix++}`;
      name = baseName.slice(0, 24 - tag.length) + tag;
    }
    this.foundingKey = undefined;
    this.members.set(client.sessionId, {
      memberId: randomBytes(16).toString("hex"),
      name: name || "Guest",
      client,
      at: Date.now(),
      count: 0,
    });
    this.publish(client);
  }
  async onDrop(client: Client, code?: number) {
    if (code === 4000 || code === 4001 || code === 4002) return;
    try {
      await this.allowReconnection(client, 15);
    } catch {
      /* final onLeave owns cleanup */
    }
  }
  onReconnect(client: Client) {
    const member = this.members.get(client.sessionId);
    if (member) member.client = client;
    this.publish(client);
  }
  onLeave(client: Client) {
    const member = this.members.get(client.sessionId);
    if (member) {
      revokeMemberTickets(member.memberId);
      this.transferVersions.delete(member.memberId);
    }
    this.members.delete(client.sessionId);
    this.publish();
  }
  onDispose() {
    for (const member of this.members.values())
      revokeMemberTickets(member.memberId);
    if (groups.get(this.groupKey) === this) groups.delete(this.groupKey);
  }
  interrupt() {
    this.broadcast(
      "interrupted",
      "The server is restarting. Reopen this friends link shortly.",
    );
    void this.disconnect();
  }
  private publish(client?: Client) {
    const rooms = [...service.rooms].filter((r) => this.courts.has(r.roomId));
    const members = new Map(
      [...this.members.values()].map(({ memberId, name }) => [
        memberId,
        { memberId, name },
      ]),
    );
    for (const id of this.courts.keys())
      if (!rooms.some((room) => room.roomId === id)) this.courts.delete(id);
    const courts = rooms.map((room) => {
      const participants: CourtMember[] = [];
      const watchers: CourtMember[] = [];
      for (const { memberId, sessionId } of room.membersInCourt()) {
        const player = room.authority.peers.get(sessionId);
        const person = player ?? room.authority.observers.get(sessionId);
        if (!person) continue;
        // A court connection can outlive its directory connection.
        members.set(memberId, { memberId, name: person.name });
        const roster = player ? participants : watchers;
        roster.push({
          memberId,
          name: person.name,
          connected: person.connected,
        });
      }
      return {
        courtId: room.roomId,
        number: this.courts.get(room.roomId)!,
        watcherCapacity: room.authority.watcherCapacity,
        sportId: room.authority.sportId,
        phase: room.authority.phase,
        capacity: room.authority.capacity,
        participants,
        watchers,
        spectators: watchers.length,
      };
    });
    const state: Omit<FriendsDirectory, "revision"> = {
      groupKey: this.groupKey,
      members: [...members.values()],
      courts,
    };
    const encoded = JSON.stringify(state);
    if (encoded !== this.lastSnapshot) {
      this.lastSnapshot = encoded;
      this.revision++;
      this.broadcast("directory", { ...state, revision: this.revision });
    } else if (client)
      client.send("directory", { ...state, revision: this.revision });
  }
  private async requestCourt(client: Client, request: unknown) {
    const value = request as {
      requestId?: unknown;
      sportId?: unknown;
      courtId?: unknown;
      intent?: unknown;
      newCourt?: unknown;
    };
    const requestId =
      typeof value?.requestId === "string" ? value.requestId : "";
    const send = (message: string, value: unknown) => {
      this.results.set(`${client.sessionId}:${requestId}`, {
        at: Date.now(),
        message,
        value,
      });
      client.send(message, value);
    };
    const fail = (message: string) =>
      send("directory-error", { requestId, message });
    const member = this.members.get(client.sessionId);
    if (!member || !requestId) return fail("Invalid request");
    if (Date.now() - member.at > 60000) {
      member.at = Date.now();
      member.count = 0;
    }
    if (++member.count > 30) return fail("Please retry shortly");
    const version = (this.transferVersions.get(member.memberId) ?? 0) + 1;
    this.transferVersions.set(member.memberId, version);
    revokeMemberTickets(member.memberId);
    try {
      const sportId = resolveSportId(value.sportId);
      if (sportId === "crypt-guardian") throw Error("Guardian is solo only");
      const intent: CourtIntent =
        value.intent === "watch" || value.intent === "queue"
          ? value.intent
          : "play";
      let courtId =
        typeof value.courtId === "string" ? value.courtId : undefined;
      if (intent !== "play" && (!courtId || value.newCourt === true))
        throw Error("Choose an existing court to watch.");
      if (courtId && !this.courts.has(courtId))
        throw Error("This court is no longer available");
      if (!courtId && value.newCourt !== true)
        courtId = [...service.rooms].find(
          (r) =>
            this.courts.has(r.roomId) &&
            r.authority.sportId === sportId &&
            r.authority.phase === "waiting" &&
            r.authority.peers.size < r.authority.capacity,
        )?.roomId;
      if (!courtId) {
        const pendingKey =
          value.newCourt === true
            ? `${member.memberId}:${sportId}:${requestId}`
            : sportId;
        let pending = this.pending.get(pendingKey);
        if (!pending) {
          if (
            !canCreateCourt(true) ||
            this.courts.size + this.pending.size >=
              FRIENDS_LIMITS.courtsPerGroup
          )
            throw Error(
              "New courts are busy. Join an existing court or retry shortly.",
            );
          pending = matchMaker
            .createRoom("friends-court", {
              build: BUILD,
              protocol: PROTOCOL,
              sportId,
              private: true,
              groupKey: this.groupKey,
              friendsCreationKey: creationKey,
            })
            .then((r) => {
              const number = (this.lastCourtNumber.get(sportId) ?? 0) + 1;
              this.lastCourtNumber.set(sportId, number);
              this.courts.set(r.roomId, number);
              return r.roomId;
            });
          this.pending.set(pendingKey, pending);
        }
        try {
          courtId = await pending;
        } finally {
          this.pending.delete(pendingKey);
        }
      }
      if (
        this.members.get(client.sessionId) !== member ||
        this.transferVersions.get(member.memberId) !== version
      )
        throw Error("This court choice was superseded. Choose again.");
      for (const [id, ticket] of tickets)
        if (ticket.expires < Date.now()) tickets.delete(id);
      if (tickets.size >= 1024)
        throw Error("Too many pending joins. Please retry shortly.");
      const admissionTicket = randomBytes(24).toString("base64url");
      tickets.set(admissionTicket, {
        groupKey: this.groupKey,
        memberId: member.memberId,
        courtId,
        intent,
        expires: Date.now() + 10000,
        name: member.name,
      });
      const reservation = await matchMaker.joinById(courtId, {
        build: BUILD,
        protocol: PROTOCOL,
        groupKey: this.groupKey,
        memberId: member.memberId,
        admissionTicket,
        intent,
        name: member.name,
      });
      send("court-reservation", { requestId, reservation });
    } catch (error) {
      fail(error instanceof Error ? error.message : "Court unavailable");
    }
  }
}

export function drainFriends() {
  for (const group of groups.values()) group.interrupt();
}
