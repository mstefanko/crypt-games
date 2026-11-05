/** Authoring-only metadata. Schemas and domain validators remain authoritative. */
import {
  ManifestSchema,
  LevelSchema,
  ArchetypeSchema,
  AbilitySchema,
  ScenarioSchema,
} from "./authoring";

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  maxLength?: number;
  default?: unknown;
  anyOf?: Schema[];
  const?: unknown;
};
export interface AuthoringFieldDescriptor {
  readonly path: string;
  readonly type: string;
  readonly units: string;
  readonly nullable: boolean;
  readonly contextualLimits: readonly {
    bound: "minimum" | "maximum";
    expression:
      | "map-minus-size"
      | "map-minus-position"
      | "spawn-minimum"
      | "spawn-maximum";
    axis: "x" | "y";
  }[];
  readonly allowedValues: readonly unknown[] | null;
  readonly itemAllowedValues: readonly unknown[] | null;
  readonly limits: Readonly<{
    minimum?: number;
    maximum?: number;
    maxItems?: number;
    maxLength?: number;
  }>;
  readonly default: Readonly<
    { kind: "none" } | { kind: "value"; value: unknown }
  >;
  readonly referenceKind: string | null;
  readonly group: string;
  readonly help: string;
  readonly transforms: readonly string[];
  readonly persistence: "authored-source";
  readonly applicability: readonly string[];
  readonly mutationImpact: "restart-preview";
}
const schemas = {
  manifest: ManifestSchema,
  level: LevelSchema,
  archetype: ArchetypeSchema,
  ability: AbilitySchema,
  scenario: ScenarioSchema,
};
const referenceKinds: Record<string, string> = {
  initialLevelId: "level",
  nextLevelId: "level",
  levelId: "level",
  levelIds: "level",
  initialScenarioId: "scenario",
  scenarioIds: "scenario",
  archetypeId: "archetype",
  archetypeIds: "archetype",
  abilityIds: "ability",
  abilities: "ability",
};
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
function allowedValues(schema: Schema): unknown[] | null {
  if (Object.hasOwn(schema, "const")) return [structuredClone(schema.const)];
  if (schema.anyOf?.every((branch) => Object.hasOwn(branch, "const")))
    return schema.anyOf.map((branch) => structuredClone(branch.const));
  return null;
}
function describe(
  schema: Schema,
  path: string,
  field: string,
  kind: string,
): AuthoringFieldDescriptor {
  const numeric = schema.anyOf?.find(
    (branch) => branch.type === "integer" || branch.type === "number",
  );
  const limitSchema = numeric ?? schema;
  const limits = Object.fromEntries(
    ["minimum", "maximum", "maxItems", "maxLength"]
      .filter((k) => k in limitSchema)
      .map((k) => [k, limitSchema[k as keyof Schema]]),
  );
  const contextualLimits: AuthoringFieldDescriptor["contextualLimits"][number][] =
    [];
  const geometry =
    kind === "level" &&
    /^\/(rectangles|platforms)\/\*\/(x|y|width|height|endX)$|^\/goal\/(x|y|width|height)$/.test(
      path,
    );
  if (geometry) {
    if (field === "x" || field === "y") limits.minimum = 0;
    contextualLimits.push({
      bound: "maximum",
      expression:
        field === "width" || field === "height"
          ? "map-minus-position"
          : "map-minus-size",
      axis: field === "y" || field === "height" ? "y" : "x",
    });
  }
  if (kind === "level" && /^\/spawns\/\*\/(x|y)$/.test(path)) {
    contextualLimits.push(
      {
        bound: "minimum",
        expression: "spawn-minimum",
        axis: field as "x" | "y",
      },
      {
        bound: "maximum",
        expression: "spawn-maximum",
        axis: field as "x" | "y",
      },
    );
  }
  const units =
    field === "gravity"
      ? "fixed point/tick² (256 units/pixel; 60Hz)"
      : /^(speed|jumpSpeed|maxFallSpeed|knockbackX|knockbackY)$/.test(field)
        ? "fixed point/tick (256 units/pixel; 60Hz)"
        : field === "aiRange"
          ? "fixed point (256 units/pixel)"
          : /Ticks$|^(startup|active|recovery|ticks|tick|rehitTicks)$/.test(
                field,
              )
            ? "60Hz ticks"
            : /^(x|y|width|height|endX|deathY|tileSize)$/.test(field)
              ? (kind === "level" &&
                  ["/width", "/height", "/tileSize"].includes(path)) ||
                (kind === "manifest" && path.startsWith("/viewport/"))
                ? "pixels"
                : "fixed point (256 units/pixel)"
              : "dimensionless";
  return {
    path,
    type: schema.type ?? (schema.anyOf ? "union" : "literal"),
    units,
    nullable:
      schema.type === "null" ||
      !!schema.anyOf?.some((branch) => branch.type === "null"),
    contextualLimits,
    allowedValues: allowedValues(schema),
    itemAllowedValues: schema.items ? allowedValues(schema.items) : null,
    limits,
    default: Object.hasOwn(schema, "default")
      ? { kind: "value", value: structuredClone(schema.default) }
      : { kind: "none" },
    referenceKind: referenceKinds[field] ?? null,
    group: path.split("/")[1] || "general",
    help: `${field}: validated by validateDefinitions; schema limits do not establish tested workload support.`,
    transforms:
      kind === "level" && (/^(x|y|endX)$/.test(field) || field === "deathY")
        ? ["translate-integer"]
        : [],
    persistence: "authored-source",
    applicability: ["legacy", "m2", "duel"],
    mutationImpact: "restart-preview",
  };
}
/** Resolve geometry metadata against the selected object and level, in fixed-point units. */
export function resolveAuthoringFieldLimits(
  field: AuthoringFieldDescriptor,
  context: {
    level: { width: number; height: number };
    object: { x?: number; y?: number; width?: number; height?: number };
    archetype?: {
      body: { x: number; y: number; width: number; height: number };
    };
  },
): AuthoringFieldDescriptor["limits"] {
  const limits = { ...field.limits };
  for (const rule of field.contextualLimits) {
    const axis = rule.axis;
    const size = axis === "x" ? "width" : "height";
    const map = context.level[size] * 256;
    let value: number;
    if (rule.expression === "map-minus-size")
      value = map - context.object[size]!;
    else if (rule.expression === "map-minus-position")
      value = map - context.object[axis]!;
    else {
      if (!context.archetype)
        throw Error("Spawn bounds require its referenced archetype");
      value =
        rule.expression === "spawn-minimum"
          ? -context.archetype.body[axis]
          : map - context.archetype.body[axis] - context.archetype.body[size];
    }
    if (!Number.isSafeInteger(value))
      throw Error("Contextual bounds require complete integer geometry");
    limits[rule.bound] =
      rule.bound === "minimum"
        ? Math.max(limits.minimum ?? -Infinity, value)
        : Math.min(limits.maximum ?? Infinity, value);
  }
  return limits;
}
export function authoringFields(
  kind: keyof typeof schemas,
): readonly AuthoringFieldDescriptor[] {
  if (!Object.hasOwn(schemas, kind))
    throw Error("Unsupported authoring descriptor kind.");
  const fields: AuthoringFieldDescriptor[] = [];
  const visit = (schema: Schema, path = "") => {
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      const child = `${path}/${key}`;
      fields.push(describe(value, child, key, kind));
      visit(value, child);
      if (value.items) visit(value.items, `${child}/*`);
    }
  };
  visit(schemas[kind] as Schema);
  return deepFreeze(fields);
}
export const AUTHORING_CAPABILITIES = deepFreeze({
  version: 1,
  profiles: ["legacy", "m2", "duel", "adventure"],
  platform: {
    validator: "validateDefinitions",
    schemas: Object.keys(schemas),
    clockHz: 60,
    geometry: "axis-aligned integer rectangles; tileSize 8|16|32",
    transforms: ["translate-integer"],
    liveMutation: "restart-preview",
  },
  adventure: {
    validator: "validateAdventureDefinitions + adventureShape",
    clock: "ordered commands; idle does not tick",
    geometry: "finite orthogonal cells",
    transforms: ["cell-placement"],
    liveMutation: "restart-preview",
  },
  localization: {
    kind: "localization",
    status: "authoring-only; no runtime localization resolver",
    fallback:
      "requested locale, then declared default locale; missing key is an error",
    interpolation:
      "named {identifier} placeholders; every locale must declare the same placeholder set; no executable expressions",
  },
});
