/** Bounded C1 recipes reference C0 archetypes/appearances; cosmetics own no stats. */
import { CharacterValidationError, type CharacterCatalog } from "./character";
import {
  characterFields as fields,
  characterId as id,
  characterInteger as integer,
  characterList as list,
  characterPlain,
  compareCharacterBuildId,
} from "./character-build-data";

export const CHARACTER_BUILD_LIMITS = Object.freeze({
  builds: 32,
  items: 8,
  stats: 6,
  slots: 8,
  appearances: 32,
  quantity: 99,
  stat: 1_000_000,
});
export interface CharacterBuildStat {
  readonly id: string;
  readonly min: number;
  readonly max: number;
}
export interface CharacterStatValue {
  readonly statId: string;
  readonly value: number;
}
export interface CharacterEquipment {
  readonly slotId: string;
  readonly itemId: string;
}
export interface CharacterBuildItem {
  readonly id: string;
  readonly slotId: string;
  readonly archetypeIds: readonly string[];
  /** Eligibility uses immutable base stats, never another item's bonuses. */
  readonly requirements: readonly {
    readonly statId: string;
    readonly min: number;
  }[];
  readonly modifiers: readonly {
    readonly statId: string;
    readonly delta: number;
  }[];
}
export interface CharacterBuild {
  readonly id: string;
  readonly archetypeId: string;
  readonly appearanceIds: readonly string[];
  readonly baseStats: readonly CharacterStatValue[];
  /** Total ownership granted exactly once at creation; equipped items leave the bag. */
  readonly grants: readonly {
    readonly itemId: string;
    readonly quantity: number;
  }[];
  readonly equipment: readonly CharacterEquipment[];
}
export interface CharacterBuildDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly stats: readonly CharacterBuildStat[];
  readonly slots: readonly string[];
  readonly items: readonly CharacterBuildItem[];
  readonly builds: readonly CharacterBuild[];
}
/** Requires a definition prepared by validateCharacterBuildDefinition.
 * Resolve in code-unit slot order. Full sums are checked once, so cancelling bonuses
 * are independent of author order. Intermediates are bounded to nine million. */
export function evaluateCharacterEquipment(
  definition: CharacterBuildDefinition,
  buildId: string,
  equipment: readonly CharacterEquipment[],
): CharacterStatValue[] {
  const build = definition.builds.find((b) => b.id === buildId);
  if (!build) throw Error("Unknown character build");
  if (equipment.length > CHARACTER_BUILD_LIMITS.slots)
    throw Error("Character equipment cap");
  const selected = equipment
    .map((e) => ({ ...e }))
    .sort((a, b) => compareCharacterBuildId(a.slotId, b.slotId));
  const values = build.baseStats.map((s) => ({ ...s }));
  selected.forEach((e, i) => {
    if (
      !definition.slots.includes(e.slotId) ||
      (i > 0 && selected[i - 1].slotId === e.slotId)
    )
      throw Error("Invalid or duplicate equipment slot");
    const item = definition.items.find((x) => x.id === e.itemId);
    if (
      !item ||
      item.slotId !== e.slotId ||
      !item.archetypeIds.includes(build.archetypeId)
    )
      throw Error("Ineligible character equipment");
    if (
      item.requirements.some(
        (r) =>
          build.baseStats.find((s) => s.statId === r.statId)!.value < r.min,
      )
    )
      throw Error("Character equipment requirement unmet");
    for (const modifier of item.modifiers)
      values.find((s) => s.statId === modifier.statId)!.value += modifier.delta;
  });
  values.forEach((s) => {
    const spec = definition.stats.find((x) => x.id === s.statId)!;
    integer(s.value, spec.min, spec.max);
  });
  return values;
}
/** Strict finite copying validator with source-linked diagnostics. C0 catalog must
 * already be prepared by validateCharacterCatalog against the selected game. */
export function validateCharacterBuildDefinition(
  value: unknown,
  catalog: CharacterCatalog,
  file = "character-builds.json",
): CharacterBuildDefinition {
  let pointer = "";
  const at = <T>(path: string, read: () => T): T => {
    const parent = pointer;
    pointer = path;
    const result = read();
    pointer = parent;
    return result;
  };
  const ordered = <T extends { readonly id: string }>(
    key: string,
    items: T[],
  ): T[] => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) {
        pointer += `/${index}${key ? `/${key}` : ""}`;
        throw Error("Duplicate character ID");
      }
      seen.add(item.id);
    });
    return items.sort((a, b) => compareCharacterBuildId(a.id, b.id));
  };
  const ref = (v: unknown, options: readonly string[], path: string) =>
    at(path, () => {
      const key = id(v);
      if (!options.includes(key)) throw Error(`Unknown reference ${key}`);
      return key;
    });
  const names = (
    v: unknown,
    cap: number,
    options: readonly string[],
    path: string,
  ) =>
    at(path, () =>
      ordered(
        "",
        list(v, cap).map((x, i) => ({ id: ref(x, options, `${path}/${i}`) })),
      ).map((x) => x.id),
    );
  try {
    const root = fields(characterPlain(value), [
      "schemaVersion",
      "id",
      "stats",
      "slots",
      "items",
      "builds",
    ]);
    at("/schemaVersion", () => integer(root.schemaVersion, 1, 1));
    const stats = at("/stats", () =>
      ordered(
        "id",
        list(root.stats, CHARACTER_BUILD_LIMITS.stats).map((v, i) =>
          at(`/stats/${i}`, () => {
            const s = fields(v, ["id", "min", "max"]);
            const min = integer(
              s.min,
              -CHARACTER_BUILD_LIMITS.stat,
              CHARACTER_BUILD_LIMITS.stat,
            );
            return {
              id: id(s.id),
              min,
              max: integer(s.max, min, CHARACTER_BUILD_LIMITS.stat),
            };
          }),
        ),
      ),
    );
    if (!stats.length)
      at("/stats", () => {
        throw Error("Character build requires a stat");
      });
    const statIds = stats.map((s) => s.id);
    const slots = at("/slots", () =>
      ordered(
        "",
        list(root.slots, CHARACTER_BUILD_LIMITS.slots).map((v, i) => ({
          id: at(`/slots/${i}`, () => id(v)),
        })),
      ).map((x) => x.id),
    );
    const archetypeIds = catalog.archetypes.map((x) => x.id);
    const items = at("/items", () =>
      ordered(
        "id",
        list(root.items, CHARACTER_BUILD_LIMITS.items).map(
          (v, i): CharacterBuildItem => {
            const p = `/items/${i}`;
            const s = at(p, () =>
              fields(v, [
                "id",
                "slotId",
                "archetypeIds",
                "requirements",
                "modifiers",
              ]),
            );
            const requirements = at(`${p}/requirements`, () =>
              ordered(
                "statId",
                list(s.requirements, CHARACTER_BUILD_LIMITS.stats).map(
                  (v, j) => {
                    const q = `${p}/requirements/${j}`;
                    const r = at(q, () => fields(v, ["statId", "min"]));
                    const statId = ref(r.statId, statIds, `${q}/statId`);
                    const spec = stats.find((x) => x.id === statId)!;
                    return {
                      id: statId,
                      min: at(`${q}/min`, () =>
                        integer(r.min, spec.min, spec.max),
                      ),
                    };
                  },
                ),
              ).map(({ id: statId, min }) => ({ statId, min })),
            );
            const modifiers = at(`${p}/modifiers`, () =>
              ordered(
                "statId",
                list(s.modifiers, CHARACTER_BUILD_LIMITS.stats).map((v, j) => {
                  const q = `${p}/modifiers/${j}`;
                  const r = at(q, () => fields(v, ["statId", "delta"]));
                  return {
                    id: ref(r.statId, statIds, `${q}/statId`),
                    delta: at(`${q}/delta`, () =>
                      integer(
                        r.delta,
                        -CHARACTER_BUILD_LIMITS.stat,
                        CHARACTER_BUILD_LIMITS.stat,
                      ),
                    ),
                  };
                }),
              ).map(({ id: statId, delta }) => ({ statId, delta })),
            );
            const allowed = names(
              s.archetypeIds,
              256,
              archetypeIds,
              `${p}/archetypeIds`,
            );
            if (!allowed.length)
              at(`${p}/archetypeIds`, () => {
                throw Error("Item requires eligible archetypes");
              });
            return {
              id: at(`${p}/id`, () => id(s.id)),
              slotId: ref(s.slotId, slots, `${p}/slotId`),
              archetypeIds: allowed,
              requirements,
              modifiers,
            };
          },
        ),
      ),
    );
    const itemIds = items.map((x) => x.id);
    const buildSourceIndices = new Map<string, number>();
    const builds = at("/builds", () =>
      ordered(
        "id",
        list(root.builds, CHARACTER_BUILD_LIMITS.builds).map(
          (v, i): CharacterBuild => {
            const p = `/builds/${i}`;
            const s = at(p, () =>
              fields(v, [
                "id",
                "archetypeId",
                "appearanceIds",
                "baseStats",
                "grants",
                "equipment",
              ]),
            );
            const archetypeId = ref(
              s.archetypeId,
              archetypeIds,
              `${p}/archetypeId`,
            );
            const controller = catalog.archetypes.find(
              (x) => x.id === archetypeId,
            )!.controller;
            const appearanceIds = names(
              s.appearanceIds,
              CHARACTER_BUILD_LIMITS.appearances,
              catalog.appearances
                .filter((a) => a.animations[controller])
                .map((a) => a.id),
              `${p}/appearanceIds`,
            );
            if (!appearanceIds.length)
              at(`${p}/appearanceIds`, () => {
                throw Error("Build requires an appearance");
              });
            const baseStats = at(`${p}/baseStats`, () =>
              ordered(
                "statId",
                list(s.baseStats, CHARACTER_BUILD_LIMITS.stats).map((v, j) => {
                  const q = `${p}/baseStats/${j}`;
                  const r = at(q, () => fields(v, ["statId", "value"]));
                  const statId = ref(r.statId, statIds, `${q}/statId`);
                  const spec = stats.find((x) => x.id === statId)!;
                  return {
                    id: statId,
                    value: at(`${q}/value`, () =>
                      integer(r.value, spec.min, spec.max),
                    ),
                  };
                }),
              ).map(({ id: statId, value }) => ({ statId, value })),
            );
            if (baseStats.length !== stats.length) {
              pointer = `${p}/baseStats`;
              throw Error("Build must specify every base stat");
            }
            const grants = at(`${p}/grants`, () =>
              ordered(
                "itemId",
                list(s.grants, CHARACTER_BUILD_LIMITS.items).map((v, j) => {
                  const q = `${p}/grants/${j}`;
                  const r = at(q, () => fields(v, ["itemId", "quantity"]));
                  return {
                    id: ref(r.itemId, itemIds, `${q}/itemId`),
                    quantity: at(`${q}/quantity`, () =>
                      integer(r.quantity, 1, CHARACTER_BUILD_LIMITS.quantity),
                    ),
                  };
                }),
              ).map(({ id: itemId, quantity }) => ({ itemId, quantity })),
            );
            const equipment = at(`${p}/equipment`, () =>
              ordered(
                "slotId",
                list(s.equipment, CHARACTER_BUILD_LIMITS.slots).map((v, j) => {
                  const q = `${p}/equipment/${j}`;
                  const r = at(q, () => fields(v, ["slotId", "itemId"]));
                  return {
                    id: ref(r.slotId, slots, `${q}/slotId`),
                    itemId: ref(r.itemId, itemIds, `${q}/itemId`),
                  };
                }),
              ).map(({ id: slotId, itemId }) => ({ slotId, itemId })),
            );
            equipment.forEach((e) => {
              if (
                !grants.some((g) => g.itemId === e.itemId && g.quantity >= 1)
              ) {
                pointer = `${p}/equipment`;
                throw Error("Initial equipment is not granted");
              }
            });
            const buildId = at(`${p}/id`, () => id(s.id));
            buildSourceIndices.set(buildId, i);
            return {
              id: buildId,
              archetypeId,
              appearanceIds,
              baseStats,
              grants,
              equipment,
            };
          },
        ),
      ),
    );
    if (!builds.length)
      at("/builds", () => {
        throw Error("Character definition requires a build");
      });
    const result: CharacterBuildDefinition = {
      schemaVersion: 1,
      id: at("/id", () => id(root.id)),
      stats,
      slots,
      items,
      builds,
    };
    builds.forEach((b) =>
      at(`/builds/${buildSourceIndices.get(b.id)}/equipment`, () =>
        evaluateCharacterEquipment(result, b.id, b.equipment),
      ),
    );
    return result;
  } catch (error) {
    throw new CharacterValidationError([
      {
        code: "character.build.invalid",
        severity: "error",
        file,
        jsonPointer: pointer,
        message:
          error instanceof Error ? error.message : "Invalid character build",
        repair:
          "Use bounded C1 fields and references from the prepared C0 catalog; ensure initial loadouts are granted and eligible.",
      },
    ]);
  }
}
