/** Bounded M9 source contract. Preparation is shared by tools and production. */
import {
  BEHAVIOR_DESCRIPTORS,
  BEHAVIOR_PARAMETER_FIELDS,
  validateBehaviorParameters,
  type BehaviorParameters,
  type BehaviorRole,
} from "./behavior";
import type { CampaignPlatformDefinition } from "./campaign-platform";
export const CAMPAIGN_BEHAVIOR_SLOTS = Object.freeze([
  { room: "gallery", spawnId: "sentinel", role: "bruiser" as BehaviorRole },
  { room: "crossing", spawnId: "sentinel", role: "ranger" as BehaviorRole },
  { room: "beacon", spawnId: "keeper", role: "bruiser" as BehaviorRole },
]);
export interface CampaignBehaviorDocument {
  readonly version: 1;
  readonly rooms: Readonly<
    Record<string, Readonly<Record<string, BehaviorParameters>>>
  >;
}
export function prepareCampaignBehaviorDocument(
  value: unknown,
  file = "behaviors.json",
): CampaignBehaviorDocument {
  const fail = (pointer: string, message: string): never => {
    throw Object.assign(Error(message), {
      diagnostics: [
        {
          code: "GAME_BEHAVIOR_PARAMETER",
          severity: "error",
          file,
          jsonPointer: pointer,
          message,
          repair:
            "Inspect behavior fields and supply bounded integer parameters for the declared placement.",
        },
      ],
    });
  };
  const shape = (
    v: unknown,
    keys: string[],
    pointer: string,
  ): Record<string, unknown> => {
    if (
      !v ||
      typeof v !== "object" ||
      Object.getPrototypeOf(v) !== Object.prototype
    )
      return fail(pointer, "Expected a plain object");
    for (const key of Reflect.ownKeys(v)) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!Object.hasOwn(descriptor, "value"))
        fail(pointer, "Accessor behavior fields are unsupported");
    }
    const record = v as Record<string, unknown>;
    for (const key of Reflect.ownKeys(record))
      if (typeof key !== "string" || !keys.includes(key))
        fail(`${pointer}/${String(key)}`, "Unknown behavior field");
    for (const key of keys)
      if (!Object.hasOwn(record, key))
        fail(`${pointer}/${key}`, "Missing behavior field");
    return record;
  };
  const root = shape(value, ["version", "rooms"], "");
  if (root.version !== 1)
    fail("/version", "Unsupported behavior document version");
  const rooms = shape(
    root.rooms,
    CAMPAIGN_BEHAVIOR_SLOTS.map((s) => s.room),
    "/rooms",
  );
  const accepted: Record<string, Record<string, BehaviorParameters>> = {};
  for (const slot of CAMPAIGN_BEHAVIOR_SLOTS) {
    const pointer = `/rooms/${slot.room}/${slot.spawnId}`;
    const room = shape(rooms[slot.room], [slot.spawnId], `/rooms/${slot.room}`);
    const params = shape(
      room[slot.spawnId],
      Object.keys(BEHAVIOR_PARAMETER_FIELDS),
      pointer,
    );
    for (const key of Object.keys(
      BEHAVIOR_PARAMETER_FIELDS,
    ) as (keyof BehaviorParameters)[]) {
      const bound = BEHAVIOR_PARAMETER_FIELDS[key],
        number = params[key];
      if (
        !Number.isSafeInteger(number) ||
        Object.is(number, -0) ||
        (number as number) < bound.minimum ||
        (number as number) > bound.maximum
      )
        fail(
          `${pointer}/${key}`,
          `Expected integer ${bound.minimum}..${bound.maximum}`,
        );
    }
    accepted[slot.room] = {
      [slot.spawnId]: validateBehaviorParameters(params),
    };
  }
  return { version: 1, rooms: accepted };
}
export function applyCampaignBehaviorDocument(
  definition: CampaignPlatformDefinition,
  value: unknown,
): CampaignPlatformDefinition {
  const prepared = prepareCampaignBehaviorDocument(value);
  return {
    ...definition,
    rooms: definition.rooms.map((room) => ({
      ...room,
      ...(room.behaviors
        ? {
            behaviors: room.behaviors.map((placement) => {
              const parameters = prepared.rooms[room.id]?.[placement.spawnId];
              if (!parameters) return placement;
              const defaults = BEHAVIOR_DESCRIPTORS[placement.role];
              const differs = (
                Object.keys(
                  BEHAVIOR_PARAMETER_FIELDS,
                ) as (keyof BehaviorParameters)[]
              ).some((key) => parameters[key] !== defaults[key]);
              const { parameters: _old, ...base } = placement;
              return differs ? { ...base, parameters } : base;
            }),
          }
        : {}),
    })),
  };
}

export { BEHAVIOR_PARAMETER_FIELDS } from "./behavior";

export const DEFAULT_CAMPAIGN_BEHAVIOR_DOCUMENT: CampaignBehaviorDocument = {
  version: 1,
  rooms: Object.fromEntries(
    CAMPAIGN_BEHAVIOR_SLOTS.map((slot) => {
      const defaults = BEHAVIOR_DESCRIPTORS[slot.role];
      return [
        slot.room,
        {
          [slot.spawnId]: {
            range: defaults.range,
            windup: defaults.windup,
            recovery: defaults.recovery,
            retreat: defaults.retreat,
          },
        },
      ];
    }),
  ),
};
