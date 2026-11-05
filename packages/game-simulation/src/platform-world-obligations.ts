/** Trusted courier policy. Labels never substitute for production observations. */
import { canonical } from "@onepage/game-project/runtime";
import {
  BURST_RETURN_GATE,
  validateBurstReturnGate,
} from "./platform-burst-gate";
import { platformTemplate } from "./platform-room-library";
import { enumeratePlatformWaitPhases } from "./platform-timed-traversal";
import type { PlatformReplayStep } from "./platform-traversal";
import type {
  PlatformWorldRealization,
  PlatformTraversalCertificate,
} from "./platform-world-types";
const U = 256;
export const PLATFORM_OBLIGATION_POLICY = "courier-obligations-v1";
export type PlatformObligationId =
  | "static-completion"
  | "physical-shortcut"
  | "timed-route";
export interface PlatformWorldObligations {
  policy: typeof PLATFORM_OBLIGATION_POLICY;
  required: PlatformObligationId[];
  spine: string[];
  gateRoom: string | null;
  timedRoom: string | null;
  destination: PlatformTraversalCertificate["destination"];
}
/** Supported topology and capabilities are pinned, while ordinary geometry may be edited. */
export function platformWorldObligations(
  content: PlatformWorldRealization,
): PlatformWorldObligations {
  const { rooms, campaign, definitions, recipe } = content;
  if (
    rooms.length < 2 ||
    rooms.length === 3 ||
    rooms.length > 8 ||
    campaign.initialRoom !== "depot" ||
    campaign.initialAnchor !== "west" ||
    rooms[0]?.roomId !== "depot" ||
    rooms.at(-1)?.roomId !== "relay" ||
    campaign.rooms.length !== rooms.length ||
    definitions.levels.length !== rooms.length
  )
    throw Error("courier-policy-topology");
  if (
    canonical(campaign.traversal) !==
    canonical({ flag: "burst", distance: BURST_RETURN_GATE.burstDistance })
  )
    throw Error("courier-policy-traversal-contract");
  const ledger = campaign.transactions;
  if (
    canonical(ledger.resources) !==
      canonical([{ id: "shards", initial: 0, capacity: 100 }]) ||
    ledger.stats.length !== 0 ||
    canonical(ledger.flags) !== canonical(["burst", "delivered", "complete"]) ||
    canonical(ledger.outcomes) !==
      canonical([
        "burst-earned",
        "parcel-delivered",
        "courier-complete",
        "express-shard",
      ])
  )
    throw Error("courier-policy-transaction-contract");
  const gateRoom = rooms.length >= 4 ? rooms[rooms.length - 2].roomId : null;
  const spine = rooms.map((r) => r.roomId).filter((id) => id !== gateRoom);
  const unlockRoom = rooms[Math.min(2, rooms.length - 3)]?.roomId;
  let timedRoom: string | null = null;
  for (const selection of rooms) {
    const room = campaign.rooms.find((r) => r.id === selection.roomId);
    const level = definitions.levels.find((l) => l.id === selection.roomId);
    if (!room || !level) throw Error("courier-policy-room-missing");
    const template = platformTemplate(selection.templateId);
    if ((selection.roomId === gateRoom) !== (template.id === "burst-gap"))
      throw Error("courier-policy-gate-declaration");
    if (
      Boolean(level.platforms.length) !== template.timed ||
      level.platforms.length > 1
    )
      throw Error("courier-policy-timed-declaration");
    if (template.timed) {
      if (timedRoom) throw Error("courier-policy-one-timed-room");
      timedRoom = room.id;
      const p = level.platforms[0];
      if (
        p.endX <= p.x ||
        p.y <= 0 ||
        p.x < 48 * U ||
        p.endX + p.width + 12 * U >= level.width * U
      )
        throw Error("courier-policy-timed-geometry");
      enumeratePlatformWaitPhases(p.endX - p.x, p.speed);
    }
    const expected: [string, string, string][] = [];
    if (room.id === gateRoom) {
      expected.push(
        ["shortcut", "depot", "east"],
        ["retreat", unlockRoom!, "west"],
      );
      validateBurstReturnGate(
        level,
        definitions.archetypes.find(
          (a) => a.id === level.spawns[0].archetypeId,
        )!,
        room,
      );
    } else {
      const i = spine.indexOf(room.id);
      if (i < spine.length - 1) expected.push(["onward", spine[i + 1], "west"]);
      if (i > 0) expected.push(["return", spine[i - 1], "east"]);
      if (i === 0 && rooms.length > 4)
        expected.push(["express", rooms[2].roomId, "west"]);
      if (gateRoom && room.id === unlockRoom)
        expected.push(["burst-return", gateRoom, "approach"]);
    }
    const links = room.exits.map((e) => [e.id, e.to, e.destinationAnchor]);
    const sort = (a: unknown[]) =>
      [...a].sort((x, y) =>
        canonical(x) < canonical(y) ? -1 : canonical(x) > canonical(y) ? 1 : 0,
      );
    if (canonical(sort(links)) !== canonical(sort(expected)))
      throw Error("courier-policy-boundary");
    for (const exit of room.exits) {
      if (
        exit.id !== "express" &&
        (exit.requires != null || exit.outcome != null)
      )
        throw Error("courier-policy-exit-obligation");
      if (
        exit.id === "express" &&
        (exit.requires != null ||
          canonical(exit.outcome) !==
            canonical({
              id: "express-shard",
              operations: [{ kind: "grant", resource: "shards", amount: 1 }],
            }))
      )
        throw Error("courier-policy-express-obligation");
    }
    const expectedPickups =
      room.id === "depot"
        ? ["complete"]
        : room.id === "relay"
          ? rooms.length === 2
            ? ["burst", "delivery"]
            : ["delivery"]
          : room.id === unlockRoom
            ? ["burst"]
            : [];
    if (
      canonical(room.pickups.map((p) => p.id).sort()) !==
      canonical(expectedPickups.sort())
    )
      throw Error("courier-policy-pickups");
    for (const pickup of room.pickups) {
      const [outcome, flag] =
        pickup.id === "burst"
          ? ["burst-earned", "burst"]
          : pickup.id === "delivery"
            ? ["parcel-delivered", "delivered"]
            : ["courier-complete", "complete"];
      if (
        pickup.outcome.id !== outcome ||
        canonical(pickup.outcome.operations) !==
          canonical([{ kind: "flag", flag, value: true }]) ||
        (pickup.requires ?? null) !==
          (pickup.id === "complete" ? "delivered" : null)
      )
        throw Error("courier-policy-pickup-obligation");
    }
  }
  // An authored two-room motif adapter predates recipe timed selection. It must
  // declare the actual capability too; the adapter now sets it explicitly.
  if (recipe.includeTimed !== Boolean(timedRoom))
    throw Error("courier-policy-timed-selection");
  const complete = campaign.rooms
    .find((r) => r.id === "depot")!
    .pickups.find((p) => p.id === "complete")!;
  return {
    policy: PLATFORM_OBLIGATION_POLICY,
    required: [
      "static-completion",
      ...(gateRoom ? ["physical-shortcut" as const] : []),
      ...(timedRoom ? ["timed-route" as const] : []),
    ],
    spine,
    gateRoom,
    timedRoom,
    destination: {
      roomId: "depot",
      region: {
        x: complete.area.x - 8 * U,
        y: complete.area.y - 16 * U,
        width: complete.area.width + 40 * U,
        height: complete.area.height + 16 * U,
      },
      requiredOutcomes: [
        "burst-earned",
        "parcel-delivered",
        "courier-complete",
      ],
    },
  };
}
/** Stateful, bounded observer attached to the fresh production replay. */
export function createPlatformObligationObserver(
  content: PlatformWorldRealization,
  policy = platformWorldObligations(content),
) {
  const transitions: string[] = [];
  let invalid = false,
    movingSupport = false,
    gateEntered = false,
    gateBurst = false,
    gateCrossed = false,
    shortcut = false;
  let timedEntry = false,
    timedTicks = 0,
    waitTicks = 0,
    boarded = false,
    rideDisplacement = 0,
    reachedEnd = false,
    dismounted = false,
    timedInvalid = false;
  const timedLevel = content.definitions.levels.find(
    (l) => l.id === policy.timedRoom,
  );
  const mover = timedLevel?.platforms[0];
  const support = mover ? `platform:${mover.id}` : "";
  const observe = ({ command, before, after }: PlatformReplayStep) => {
    if (command.kind === "reset" || command.kind === "recover") invalid = true;
    if (command.kind === "exit") {
      transitions.push(`${before.roomId}:${command.id}:${after.roomId}`);
      if (transitions.length > 32) invalid = true;
      if (command.id === "burst-return")
        gateEntered =
          after.roomId === policy.gateRoom &&
          before.transactions.outcomes.includes("burst-earned");
      if (command.id === "shortcut")
        shortcut =
          gateEntered &&
          gateBurst &&
          gateCrossed &&
          before.roomId === policy.gateRoom;
    }
    if (command.kind !== "frame") return;
    const a = before.platform.actors.find((a) => a.slot === 0)!,
      b = after.platform.actors.find((a) => a.slot === 0)!;
    if (b.platformMotion?.supportId?.startsWith("platform:"))
      movingSupport = true;
    if (before.roomId === policy.gateRoom && gateEntered) {
      const input = command.input.slots.find((s) => s.slot === 0);
      if (
        input?.edges.some(
          (e) => e.action === "heavy" && e.kind === "pressed",
        ) &&
        after.transactions.outcomes.includes("burst-earned") &&
        b.x - a.x > content.definitions.archetypes[0].speed
      )
        gateBurst = true;
      if (gateBurst && b.x >= BURST_RETURN_GATE.rightStart * U && b.grounded)
        gateCrossed = true;
    }
    if (before.roomId !== policy.timedRoom || !mover || dismounted) return;
    const p = before.platform.platforms.find((p) => p.id === mover.id),
      q = after.platform.platforms.find((p) => p.id === mover.id);
    if (!timedEntry) {
      timedEntry =
        before.anchorId === "west" &&
        a.grounded &&
        a.x + a.width / 2 <= mover.x;
      if (!timedEntry) timedInvalid = true;
    }
    if (++timedTicks > 1800 || !p || !q || p.blocked || q.blocked)
      timedInvalid = true;
    const riding = b.platformMotion?.supportId === support;
    if (!boarded && riding) boarded = true;
    if (!boarded) {
      const input = command.input.slots.find((s) => s.slot === 0);
      if (
        b.grounded &&
        input?.axes.moveX === 0 &&
        !input.edges.some((e) => e.kind === "pressed")
      )
        waitTicks++;
      if (
        waitTicks >
        enumeratePlatformWaitPhases(mover.endX - mover.x, mover.speed)
          .periodTicks
      )
        timedInvalid = true;
    } else if (riding) {
      rideDisplacement += Math.max(0, (q?.x ?? 0) - (p?.x ?? 0));
      if (q?.x === mover.endX) reachedEnd = true;
    } else if (!reachedEnd) timedInvalid = true;
    else if (
      b.grounded &&
      b.x + b.width / 2 >= mover.endX + mover.width + 12 * U
    )
      dismounted = true;
  };
  const finish = (): PlatformObligationId[] => {
    if (invalid) return [];
    const forward = policy.spine
      .slice(0, -1)
      .map((id, i) => `${id}:onward:${policy.spine[i + 1]}`);
    const backward = policy.spine
      .slice(1)
      .reverse()
      .map(
        (id, i) => `${id}:return:${policy.spine[policy.spine.length - 2 - i]}`,
      );
    const ordinary =
      canonical(transitions) === canonical([...forward, ...backward]);
    const ids: PlatformObligationId[] = [];
    if (ordinary && !movingSupport) ids.push("static-completion");
    if (
      shortcut &&
      !transitions.some(
        (t) => t.includes(":express:") || t.includes(":retreat:"),
      )
    )
      ids.push("physical-shortcut");
    if (
      ordinary &&
      timedEntry &&
      !timedInvalid &&
      boarded &&
      rideDisplacement > 0 &&
      reachedEnd &&
      dismounted
    )
      ids.push("timed-route");
    return ids;
  };
  return { onStep: observe, finish };
}
