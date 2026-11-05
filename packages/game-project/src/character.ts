/** C0 selection contracts. Existing profile definitions remain the authoritative rules. */
import { array, integer, record, string } from "./runtime";
import type { Diagnostic } from "./types";

export const CHARACTER_LIMITS = Object.freeze({
  archetypes: 256,
  appearances: 256,
  bindings: 256,
  parts: 16,
  palettes: 16,
  displayName: 64,
});
export type CharacterController = "platform-combat-v1" | "arena-v1";
/** References owned by the selected profile, never synthesized from visual bounds. */
export interface CharacterArchetype {
  readonly id: string;
  readonly controller: CharacterController;
  readonly definitionId: string;
}
export interface CharacterAppearance {
  readonly id: string;
  readonly assetId: string;
  readonly partIds: readonly string[];
  readonly paletteIds: readonly string[];
  readonly portraitId: string | null;
  readonly displayName: string | null;
  readonly animations: Readonly<Partial<Record<CharacterController, string>>>;
}
/** Placement IDs are scoped by the referenced archetype controller. Runtime entity IDs remain simulation-owned. */
export interface CharacterBinding {
  readonly placementId: string;
  readonly archetypeId: string;
  readonly appearanceId: string;
}
export interface CharacterCatalog {
  readonly schemaVersion: 1;
  readonly archetypes: readonly CharacterArchetype[];
  readonly appearances: readonly CharacterAppearance[];
  readonly bindings: readonly CharacterBinding[];
}
/** Supply IDs from prepared profile/assets, rather than importing a presenter into pure contracts. */
export interface CharacterReferences {
  readonly definitions: Readonly<
    Record<CharacterController, readonly string[]>
  >;
  readonly placements: Readonly<Record<CharacterController, readonly string[]>>;
  readonly assets: readonly string[];
  readonly parts: readonly string[];
  readonly palettes: readonly string[];
  readonly portraits: readonly string[];
  readonly animationSets: Readonly<
    Record<CharacterController, readonly string[]>
  >;
}
export class CharacterValidationError extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics[0].message);
  }
}
const controllers: readonly CharacterController[] = [
  "platform-combat-v1",
  "arena-v1",
];
/** Strict, bounded, copying validation; failures address the original source document. */
export function validateCharacterCatalog(
  value: unknown,
  refs: CharacterReferences,
  file = "characters.json",
): CharacterCatalog {
  let pointer = "";
  const at = <T>(path: string, read: () => T): T => {
    pointer = path;
    return read();
  };
  const id = (v: unknown, path: string) => at(path, () => string(v));
  const reference = (v: unknown, options: readonly string[], path: string) => {
    const result = id(v, path);
    if (!options.includes(result)) throw Error(`Unknown reference ${result}`);
    return result;
  };
  const ids = (
    v: unknown,
    cap: number,
    options: readonly string[],
    path: string,
  ) => {
    const result = at(path, () => array(v, cap)).map((x, i) =>
      reference(x, options, `${path}/${i}`),
    );
    if (new Set(result).size !== result.length) {
      pointer = path;
      throw Error("Duplicate selection");
    }
    return result;
  };
  const unique = <T extends { readonly id: string }>(
    items: T[],
    path: string,
  ) => {
    const seen = new Set<string>();
    items.forEach((x, i) => {
      if (seen.has(x.id)) {
        pointer = `${path}/${i}/id`;
        throw Error("Duplicate ID");
      }
      seen.add(x.id);
    });
    return items;
  };
  try {
    const root = at("", () =>
      record(value, ["schemaVersion", "archetypes", "appearances", "bindings"]),
    );
    at("/schemaVersion", () => integer(root.schemaVersion, 1, 1));
    const archetypes = unique(
      at("/archetypes", () =>
        array(root.archetypes, CHARACTER_LIMITS.archetypes),
      ).map((v, i): CharacterArchetype => {
        const p = `/archetypes/${i}`;
        const o = at(p, () => record(v, ["id", "controller", "definitionId"]));
        const controller = at(`${p}/controller`, () => {
          if (!controllers.includes(o.controller as CharacterController))
            throw Error("Unsupported controller");
          return o.controller as CharacterController;
        });
        return {
          id: id(o.id, `${p}/id`),
          controller,
          definitionId: reference(
            o.definitionId,
            refs.definitions[controller],
            `${p}/definitionId`,
          ),
        };
      }),
      "/archetypes",
    );
    const appearances = unique(
      at("/appearances", () =>
        array(root.appearances, CHARACTER_LIMITS.appearances),
      ).map((v, i): CharacterAppearance => {
        const p = `/appearances/${i}`;
        const o = at(p, () =>
          record(v, [
            "id",
            "assetId",
            "partIds",
            "paletteIds",
            "portraitId",
            "displayName",
            "animations",
          ]),
        );
        const animations = at(`${p}/animations`, () => {
          if (
            !o.animations ||
            typeof o.animations !== "object" ||
            Array.isArray(o.animations)
          )
            throw Error("Expected animation mappings");
          const source = o.animations as Record<string, unknown>;
          const keys = Object.keys(source);
          if (
            !keys.length ||
            keys.some((k) => !controllers.includes(k as CharacterController))
          )
            throw Error("Expected nonempty supported controller mappings");
          const result: Partial<Record<CharacterController, string>> = {};
          for (const controller of controllers)
            if (Object.hasOwn(source, controller))
              result[controller] = reference(
                source[controller],
                refs.animationSets[controller],
                `${p}/animations/${controller}`,
              );
          return result;
        });
        const displayName = at(`${p}/displayName`, () => {
          if (o.displayName === null) return null;
          if (
            typeof o.displayName !== "string" ||
            o.displayName.length < 1 ||
            o.displayName.length > CHARACTER_LIMITS.displayName ||
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/.test(
              o.displayName,
            )
          )
            throw Error(
              "Expected display name of 1–64 characters without controls or bidi formatting",
            );
          return o.displayName;
        });
        return {
          id: id(o.id, `${p}/id`),
          assetId: reference(o.assetId, refs.assets, `${p}/assetId`),
          partIds: ids(
            o.partIds,
            CHARACTER_LIMITS.parts,
            refs.parts,
            `${p}/partIds`,
          ),
          paletteIds: ids(
            o.paletteIds,
            CHARACTER_LIMITS.palettes,
            refs.palettes,
            `${p}/paletteIds`,
          ),
          portraitId:
            o.portraitId === null
              ? null
              : reference(o.portraitId, refs.portraits, `${p}/portraitId`),
          displayName,
          animations,
        };
      }),
      "/appearances",
    );
    const bindings = at("/bindings", () =>
      array(root.bindings, CHARACTER_LIMITS.bindings),
    ).map((v, i): CharacterBinding => {
      const p = `/bindings/${i}`;
      const o = at(p, () =>
        record(v, ["placementId", "archetypeId", "appearanceId"]),
      );
      const archetypeId = reference(
        o.archetypeId,
        archetypes.map((x) => x.id),
        `${p}/archetypeId`,
      );
      const appearanceId = reference(
        o.appearanceId,
        appearances.map((x) => x.id),
        `${p}/appearanceId`,
      );
      const archetype = archetypes.find((x) => x.id === archetypeId)!;
      const appearanceIndex = appearances.findIndex(
        (x) => x.id === appearanceId,
      );
      if (!appearances[appearanceIndex].animations[archetype.controller]) {
        pointer = `/appearances/${appearanceIndex}/animations/${archetype.controller}`;
        throw Error("Appearance lacks the bound controller animation set");
      }
      return {
        placementId: reference(
          o.placementId,
          refs.placements[archetype.controller],
          `${p}/placementId`,
        ),
        archetypeId,
        appearanceId,
      };
    });
    const seen = new Set<string>();
    bindings.forEach((b, i) => {
      const controller = archetypes.find(
        (x) => x.id === b.archetypeId,
      )!.controller;
      const key = `${controller}:${b.placementId}`;
      if (seen.has(key)) {
        pointer = `/bindings/${i}/placementId`;
        throw Error("Placement has multiple character owners");
      }
      seen.add(key);
    });
    return { schemaVersion: 1, archetypes, appearances, bindings };
  } catch (error) {
    throw new CharacterValidationError([
      {
        code: "character.invalid",
        severity: "error",
        file,
        jsonPointer: pointer,
        message:
          error instanceof Error ? error.message : "Invalid character catalog",
        repair:
          "Use bounded fields and IDs from the selected prepared profile and asset catalog.",
      },
    ]);
  }
}
/** Code-unit ordering is independent of host locale; no cosmetic part ordering is changed. */
function compareCharacterId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Deterministically ordered authority projection. No new replay identity. */
export function characterAuthority(catalog: CharacterCatalog) {
  return {
    archetypes: catalog.archetypes
      .map((x) => ({ ...x }))
      .sort((a, b) => compareCharacterId(a.id, b.id)),
    bindings: catalog.bindings
      .map(({ placementId, archetypeId }) => ({
        controller: catalog.archetypes.find((x) => x.id === archetypeId)!
          .controller,
        placementId,
        archetypeId,
      }))
      .sort(
        (a, b) =>
          compareCharacterId(a.controller, b.controller) ||
          compareCharacterId(a.placementId, b.placementId),
      ),
  };
}
export function inspectCharacter(
  catalog: CharacterCatalog,
  controller: CharacterController,
  placementId: string,
) {
  const binding = catalog.bindings.find(
    (x) =>
      x.placementId === placementId &&
      catalog.archetypes.find((a) => a.id === x.archetypeId)?.controller ===
        controller,
  );
  if (!binding)
    throw Error(`Unknown character placement ${controller}:${placementId}`);
  const archetype = catalog.archetypes.find(
    (x) => x.id === binding.archetypeId,
  )!;
  const appearance = catalog.appearances.find(
    (x) => x.id === binding.appearanceId,
  )!;
  return {
    placementId,
    controller: archetype.controller,
    definitionId: archetype.definitionId,
    appearanceId: appearance.id,
    animationSetId: appearance.animations[archetype.controller],
    owners: CHARACTER_OWNERSHIP,
  };
}
export const CHARACTER_OWNERSHIP = Object.freeze({
  body: "profile-definition",
  hurt: "profile-definition",
  attacks: "profile-definition",
  attributes: "profile-definition",
  motion: "exact-checkpoint",
  health: "exact-checkpoint",
  cooldowns: "exact-checkpoint",
  appearance: "presentation-selection",
  displayName: "presentation-selection",
  progression: "campaign-policy",
  equipment: "future-C1-transaction",
} as const);
