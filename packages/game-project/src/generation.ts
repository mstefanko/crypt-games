/** Bounded selection of retained generation artifacts. This contract never runs a generator. */
import type { M3ProjectDefinitions } from "./m3-project";
export type GenerationJSON =
  | null
  | boolean
  | number
  | string
  | readonly GenerationJSON[]
  | { readonly [key: string]: GenerationJSON };
export type M3GenerationProfile = keyof M3ProjectDefinitions;
export interface M3GenerationCatalog {
  readonly format: "m3-generation-selection-v1";
  readonly generators: readonly {
    readonly id: string;
    readonly sourcePath: string;
  }[];
  readonly libraries: readonly {
    readonly id: string;
    readonly value: GenerationJSON;
  }[];
  readonly recipes: readonly {
    readonly id: string;
    readonly generatorId: string;
    readonly libraryId: string;
    readonly parameters: GenerationJSON;
  }[];
  readonly outputs: readonly {
    readonly id: string;
    readonly recipeId: string;
    readonly profile: M3GenerationProfile;
    readonly inputs: {
      readonly generatorBuildId: string;
      readonly libraryContentId: string;
      readonly recipeContentId: string;
    };
    readonly definition: M3ProjectDefinitions[M3GenerationProfile];
  }[];
  readonly selected: Readonly<Partial<Record<M3GenerationProfile, string>>>;
}
export const M3_GENERATION_LIMITS = Object.freeze({
  generators: 8,
  libraries: 16,
  recipes: 32,
  outputs: 16,
  bytes: 2_097_152,
  depth: 32,
  nodes: 100_000,
  string: 65_536,
});
export interface M3GenerationProvenance {
  readonly outputId: string;
  readonly recipeId: string;
  readonly generatorId: string;
  readonly libraryId: string;
  readonly generatorBuildId: string;
  readonly libraryContentId: string;
  readonly recipeContentId: string;
  readonly outputContentId: string;
}
const profiles = ["arena", "grid", "duel", "adventure"];
function exact(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw Error(`${path}: unknown or missing field`);
  return value as Record<string, unknown>;
}
function id(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)
  )
    throw Error(`${path}: invalid stable ID`);
}
/** Reject non-JSON values before cloning or hashing; bound work across the whole catalog. */
export function validateM3GenerationCatalog(
  value: unknown,
): M3GenerationCatalog {
  let nodes = 0,
    bytes = 0;
  const active = new Set<object>();
  function json(v: unknown, depth: number): void {
    if (
      ++nodes > M3_GENERATION_LIMITS.nodes ||
      depth > M3_GENERATION_LIMITS.depth
    )
      throw Error("generation: JSON complexity limit exceeded");
    if (v === null || typeof v === "boolean")
      bytes += v === null || v === true ? 4 : 5;
    else if (typeof v === "number" && Number.isFinite(v) && !Object.is(v, -0))
      bytes += String(v).length;
    else if (typeof v === "string") {
      if (v.length > M3_GENERATION_LIMITS.string)
        throw Error("generation: string limit exceeded");
      const encoded = JSON.stringify(v);
      for (let i = 0; i < encoded.length; i++) {
        const code = encoded.charCodeAt(i);
        bytes +=
          code < 128
            ? 1
            : code < 2048
              ? 2
              : code >= 0xd800 && code <= 0xdbff
                ? (i++, 4)
                : 3;
      }
    } else if (
      typeof v === "object" &&
      v &&
      (Array.isArray(v) ||
        Object.getPrototypeOf(v) === Object.prototype ||
        Object.getPrototypeOf(v) === null)
    ) {
      if (active.has(v)) throw Error("generation: cyclic JSON");
      active.add(v);
      bytes += 2;
      if (
        Reflect.ownKeys(v).some(
          (k) =>
            typeof k !== "string" ||
            (!Array.isArray(v) &&
              ["__proto__", "constructor", "prototype"].includes(k)),
        )
      )
        throw Error("generation: unsafe JSON key");
      if (Array.isArray(v)) {
        if (
          Reflect.ownKeys(v).length !== v.length + 1 ||
          Object.keys(v).length !== v.length
        )
          throw Error("generation: sparse or extended array");
        for (let i = 0; i < v.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
          if (
            !descriptor ||
            !descriptor.enumerable ||
            !Object.hasOwn(descriptor, "value")
          )
            throw Error("generation: accessor JSON field");
          if (i) bytes++;
          json(descriptor.value, depth + 1);
        }
      } else {
        const keys = Reflect.ownKeys(v) as string[];
        for (const [i, key] of keys.entries()) {
          const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
          if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
            throw Error("generation: accessor or hidden JSON field");
          if (i) bytes++;
          json(key, depth + 1);
          bytes++;
          json(descriptor.value, depth + 1);
        }
      }
      active.delete(v);
    } else throw Error("generation: expected finite plain JSON");
    if (bytes > M3_GENERATION_LIMITS.bytes)
      throw Error("generation: JSON byte limit exceeded");
  }
  json(value, 0);
  const c = exact(
    value,
    ["format", "generators", "libraries", "recipes", "outputs", "selected"],
    "generation",
  );
  if (c.format !== "m3-generation-selection-v1")
    throw Error("generation: unsupported format");
  const maps: Record<string, Map<string, Record<string, unknown>>> = {};
  for (const name of [
    "generators",
    "libraries",
    "recipes",
    "outputs",
  ] as const) {
    const entries = c[name];
    if (!Array.isArray(entries) || entries.length > M3_GENERATION_LIMITS[name])
      throw Error(`generation/${name}: catalog limit exceeded`);
    const map = (maps[name] = new Map());
    for (const [i, entry] of entries.entries()) {
      const keys = {
        generators: ["id", "sourcePath"],
        libraries: ["id", "value"],
        recipes: ["id", "generatorId", "libraryId", "parameters"],
        outputs: ["id", "recipeId", "profile", "inputs", "definition"],
      }[name];
      const item = exact(entry, keys, `generation/${name}/${i}`);
      id(item.id, `generation/${name}/${i}/id`);
      if (map.has(item.id))
        throw Error(`generation/${name}: duplicate ID ${item.id}`);
      map.set(item.id, item);
      if (
        name === "generators" &&
        (typeof item.sourcePath !== "string" ||
          !/^(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.ts$/.test(
            item.sourcePath,
          ) ||
          item.sourcePath.length > 256)
      )
        throw Error(
          "generation: generator requires a contained relative TypeScript sourcePath",
        );
    }
  }
  for (const recipe of maps.recipes.values())
    for (const [field, catalog] of [
      ["generatorId", "generators"],
      ["libraryId", "libraries"],
    ]) {
      id(recipe[field], `generation/recipes/${recipe.id}/${field}`);
      if (!maps[catalog].has(recipe[field] as string))
        throw Error(`generation: unresolved ${field}`);
    }
  for (const output of maps.outputs.values()) {
    id(output.recipeId, `generation/outputs/${output.id}/recipeId`);
    if (
      !maps.recipes.has(output.recipeId as string) ||
      !profiles.includes(output.profile as string)
    )
      throw Error("generation: unresolved recipe or unsupported profile");
    const pins = exact(
      output.inputs,
      ["generatorBuildId", "libraryContentId", "recipeContentId"],
      "generation/output/inputs",
    );
    if (
      Object.values(pins).some(
        (pin) => typeof pin !== "string" || !/^sha256:[a-f0-9]{64}$/.test(pin),
      )
    )
      throw Error("generation: invalid input identity pin");
    if (
      !output.definition ||
      typeof output.definition !== "object" ||
      Array.isArray(output.definition)
    )
      throw Error("generation: output requires a definition object");
  }
  if (
    !c.selected ||
    typeof c.selected !== "object" ||
    Array.isArray(c.selected)
  )
    throw Error("generation: expected selected profile object");
  for (const [profile, outputId] of Object.entries(c.selected)) {
    id(outputId, `generation/selected/${profile}`);
    if (
      !profiles.includes(profile) ||
      maps.outputs.get(outputId)?.profile !== profile
    )
      throw Error("generation: selected output/profile mismatch");
  }
  return structuredClone(value) as M3GenerationCatalog;
}
