/** Development-only source index. Domain validation remains authoritative. */
export type ResourceKind =
  | "project"
  | "level"
  | "scenario"
  | "archetype"
  | "ability"
  | "map"
  | "entrance"
  | "rectangle"
  | "platform"
  | "spawn"
  | "pickup"
  | "dialogue"
  | "exit"
  | "item"
  | "quest"
  | "flag"
  | "stat"
  | "localizable-string"
  | "choice"
  | "item-instance";
export interface ResourceIdentity {
  kind: ResourceKind;
  id: string;
  owner?: string;
}
export interface SourcePointer {
  file: string;
  jsonPointer: string;
}
export interface AuthoringResource {
  identity: ResourceIdentity;
  source: SourcePointer;
  identityPointer: string;
}
export interface ResourceReference {
  from: ResourceIdentity;
  to: ResourceIdentity;
  source: SourcePointer;
  dictionaryKey?: boolean;
}
export interface ResourceGraph {
  resources: AuthoringResource[];
  references: ResourceReference[];
  diagnostics: { code: string; source: SourcePointer; message: string }[];
}
export interface AuthoringDocument {
  file: string;
  pointerPrefix?: string;
  kind:
    | "platform-manifest"
    | "platform-level"
    | "platform-scenario"
    | "platform-archetype"
    | "platform-ability"
    | "adventure"
    | "localization";
  value: unknown;
}
export interface LocalizationResource {
  id: string;
  fallbackLocale: string;
  arguments: Record<string, "string" | "number">;
  locales: Record<string, string>;
}
/** Declares interpolation and fallback; shaping, glyph coverage and text fit are later proofs. */
export function validateLocalizationResource(
  value: LocalizationResource,
): void {
  const record = (input: unknown): input is Record<string, unknown> =>
    !!input && typeof input === "object" && !Array.isArray(input);
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !value.id.length ||
    value.id.length > 256 ||
    typeof value.fallbackLocale !== "string" ||
    !record(value.arguments) ||
    !record(value.locales)
  )
    throw new Error("Invalid localization contract");
  const entries = Object.entries(value.locales);
  if (
    !Object.hasOwn(value.locales, value.fallbackLocale) ||
    entries.length < 1 ||
    entries.length > 64 ||
    Object.keys(value.arguments).length > 32 ||
    Object.entries(value.arguments).some(
      ([name, type]) =>
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
        (type !== "string" && type !== "number"),
    )
  )
    throw new Error("Invalid localization contract");
  for (const [locale, text] of entries) {
    if (
      !/^[A-Za-z0-9-]{1,64}$/.test(locale) ||
      typeof text !== "string" ||
      text.length > 16384
    )
      throw new Error("Invalid localization locale");
    const names = [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(
      (match) => match[1],
    );
    if (
      names.some((name) => !Object.hasOwn(value.arguments, name)) ||
      Object.keys(value.arguments).some((name) => !names.includes(name))
    )
      throw new Error(
        "Localization interpolation arguments differ from declaration",
      );
    if (text.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "").match(/[{}]/))
      throw new Error("Invalid localization interpolation syntax");
  }
}
export const AUTHORING_RESOURCE_LIMITS = {
  documents: 512,
  resources: 16384,
  references: 65536,
  bytes: 16 * 1024 * 1024,
} as const;
export function resourceKey(identity: ResourceIdentity): string {
  return JSON.stringify([identity.kind, identity.owner ?? null, identity.id]);
}
const escape = (value: string) =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");
type ObjectValue = Record<string, any>;

export function extractAuthoringResources(
  documents: readonly AuthoringDocument[],
): ResourceGraph {
  if (
    documents.length > AUTHORING_RESOURCE_LIMITS.documents ||
    JSON.stringify(documents).length > AUTHORING_RESOURCE_LIMITS.bytes
  )
    throw new Error("Authoring document limit exceeded");
  const graph: ResourceGraph = {
    resources: [],
    references: [],
    diagnostics: [],
  };
  const files = new Set<string>();
  for (const document of documents) {
    if (
      !document ||
      typeof document.file !== "string" ||
      !document.file.length ||
      !document.value ||
      typeof document.value !== "object" ||
      Array.isArray(document.value)
    )
      throw new Error("Invalid authoring document");
    const documentKey = JSON.stringify([
      document.file,
      document.pointerPrefix ?? "",
    ]);
    if (files.has(documentKey))
      throw new Error(`Duplicate source file: ${document.file}`);
    files.add(documentKey);
    if (
      document.pointerPrefix &&
      !/^\/(?:[^~]|~[01])*$/.test(document.pointerPrefix)
    )
      throw new Error("Invalid source pointer prefix");
    const d = document.value as ObjectValue;
    const source = (jsonPointer: string): SourcePointer => ({
      file: document.file,
      jsonPointer: `${document.pointerPrefix ?? ""}${jsonPointer}`,
    });
    const add = (
      kind: ResourceKind,
      id: string,
      pointer: string,
      owner?: string,
      identityPointer = `${pointer}/id`,
    ): ResourceIdentity => {
      if (typeof id !== "string" || !id.length || id.length > 256)
        throw new Error(
          `Invalid resource ID at ${document.file}${identityPointer}`,
        );
      const identity = { kind, id, ...(owner === undefined ? {} : { owner }) };
      graph.resources.push({
        identity,
        source: source(pointer),
        identityPointer: `${document.pointerPrefix ?? ""}${identityPointer}`,
      });
      return identity;
    };
    const ref = (
      from: ResourceIdentity,
      kind: ResourceKind,
      id: string | null | undefined,
      pointer: string,
      owner?: string,
      dictionaryKey = false,
    ) => {
      if (id != null)
        graph.references.push({
          from,
          to: { kind, id, ...(owner === undefined ? {} : { owner }) },
          source: source(pointer),
          ...(dictionaryKey ? { dictionaryKey: true } : {}),
        });
    };
    if (document.kind === "platform-manifest") {
      const root = add("project", d.gameId, "", undefined, "/gameId");
      for (const [field, kind] of [
        ["levelIds", "level"],
        ["scenarioIds", "scenario"],
        ["archetypeIds", "archetype"],
        ["abilityIds", "ability"],
      ] as const)
        d[field].forEach((id: string, i: number) =>
          ref(root, kind, id, `/${field}/${i}`),
        );
      ref(root, "level", d.initialLevelId, "/initialLevelId");
      ref(root, "scenario", d.initialScenarioId, "/initialScenarioId");
    } else if (document.kind === "platform-level") {
      const root = add("level", d.id, "");
      ref(root, "level", d.goal.nextLevelId, "/goal/nextLevelId");
      for (const field of ["rectangles", "platforms", "spawns"] as const)
        d[field].forEach((value: ObjectValue, i: number) => {
          const p = `/${field}/${i}`;
          const child = add(
            (
              {
                rectangles: "rectangle",
                platforms: "platform",
                spawns: "spawn",
              } as const
            )[field],
            value.id,
            p,
            resourceKey(root),
          );
          ref(child, "level", d.id, "/id");
          if (field === "spawns")
            ref(child, "archetype", value.archetypeId, `${p}/archetypeId`);
        });
    } else if (document.kind === "platform-scenario") {
      const root = add("scenario", d.id, "");
      ref(root, "level", d.levelId, "/levelId");
    } else if (document.kind === "platform-archetype") {
      const root = add("archetype", d.id, "");
      d.abilities.forEach((id: string, i: number) =>
        ref(root, "ability", id, `/abilities/${i}`),
      );
    } else if (document.kind === "platform-ability") add("ability", d.id, "");
    else if (document.kind === "localization") {
      for (const [i, value] of (
        d.strings as LocalizationResource[]
      ).entries()) {
        add("localizable-string", value.id, `/strings/${i}`);
        validateLocalizationResource(value);
      }
    } else if (document.kind === "adventure") {
      const root = add("project", d.gameId, "", undefined, "/gameId");
      ref(root, "map", d.initial.mapId, "/initial/mapId");
      ref(
        root,
        "entrance",
        d.initial.entranceId,
        "/initial/entranceId",
        resourceKey({ kind: "map", id: d.initial.mapId }),
      );
      d.items.forEach((item: ObjectValue, i: number) =>
        add("item", item.id, `/items/${i}`),
      );
      d.quests.forEach((id: string, i: number) =>
        add("quest", id, `/quests/${i}`, undefined, `/quests/${i}`),
      );
      // Dictionary keys are source-addressable identities; copying requires explicit key remapping.
      for (const [field, kind] of [
        ["flags", "flag"],
        ["stats", "stat"],
      ] as const)
        for (const id of Object.keys(d[field]))
          add(
            kind,
            id,
            `/${field}/${escape(id)}`,
            undefined,
            `/${field}/${escape(id)}`,
          );
      d.maps.forEach((map: ObjectValue, i: number) => {
        const p = `/maps/${i}`;
        const room = add("map", map.id, p);
        const owner = resourceKey(room);
        map.entrances.forEach((value: ObjectValue, j: number) =>
          add("entrance", value.id, `${p}/entrances/${j}`, owner),
        );
        for (const field of ["pickups", "dialogues", "exits"] as const)
          map[field].forEach((value: ObjectValue, j: number) => {
            const q = `${p}/${field}/${j}`;
            const child = add(
              (
                {
                  pickups: "pickup",
                  dialogues: "dialogue",
                  exits: "exit",
                } as const
              )[field],
              value.id,
              q,
              owner,
            );
            ref(child, "map", map.id, `${p}/id`);
            if (field === "exits") {
              ref(child, "map", value.mapId, `${q}/mapId`);
              if (value.requiresFlags !== undefined) {
                const requirements: unknown = value.requiresFlags;
                const valid =
                  Array.isArray(requirements) &&
                  requirements.length <= 8 &&
                  Array.from(requirements).every(
                    (flag) =>
                      typeof flag === "string" &&
                      /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(flag),
                  ) &&
                  new Set(requirements).size === requirements.length;
                if (!valid)
                  graph.diagnostics.push({
                    code: "invalid-exit-requirements",
                    source: source(`${q}/requiresFlags`),
                    message:
                      "Exit requiresFlags must be an array of at most eight distinct stable flag IDs",
                  });
                else
                  requirements.forEach((flag: string, k: number) =>
                    ref(child, "flag", flag, `${q}/requiresFlags/${k}`),
                  );
              }
              ref(
                child,
                "entrance",
                value.entranceId,
                `${q}/entranceId`,
                resourceKey({ kind: "map", id: value.mapId }),
              );
            }
            if (field === "dialogues") {
              ref(child, "flag", value.flag, `${q}/flag`);
              add(
                "choice",
                value.choiceId,
                q,
                resourceKey(child),
                `${q}/choiceId`,
              );
            }
            if (value.effects) {
              value.effects.grants?.forEach((grant: ObjectValue, k: number) => {
                ref(
                  child,
                  "item",
                  grant.itemId,
                  `${q}/effects/grants/${k}/itemId`,
                );
                if (grant.instanceId)
                  add(
                    "item-instance",
                    grant.instanceId,
                    `${q}/effects/grants/${k}`,
                    undefined,
                    `${q}/effects/grants/${k}/instanceId`,
                  );
              });
              ref(
                child,
                "quest",
                value.effects.completeQuest,
                `${q}/effects/completeQuest`,
              );
              for (const [field, kind] of [
                ["flags", "flag"],
                ["stats", "stat"],
              ] as const)
                for (const id of Object.keys(value.effects[field] ?? {}))
                  ref(
                    child,
                    kind,
                    id,
                    `${q}/effects/${field}/${escape(id)}`,
                    undefined,
                    true,
                  );
            }
          });
      });
    } else throw new Error("Unsupported authoring document kind");
    if (
      graph.resources.length > AUTHORING_RESOURCE_LIMITS.resources ||
      graph.references.length > AUTHORING_RESOURCE_LIMITS.references
    )
      throw new Error("Authoring graph limit exceeded");
  }
  const known = new Set<string>();
  for (const resource of graph.resources) {
    const key = resourceKey(resource.identity);
    if (known.has(key))
      graph.diagnostics.push({
        code: "duplicate-resource",
        source: resource.source,
        message: key,
      });
    known.add(key);
  }
  for (const reference of graph.references)
    if (!known.has(resourceKey(reference.to)))
      graph.diagnostics.push({
        code: "unresolved-reference",
        source: reference.source,
        message: resourceKey(reference.to),
      });
  return graph;
}
export function deletionImpact(
  graph: ResourceGraph,
  identities: readonly ResourceIdentity[],
): ResourceReference[] {
  const removed = new Set(identities.map(resourceKey));
  // Deleting a container also removes its owned placements/entrances.
  let changed = true;
  while (changed) {
    changed = false;
    for (const resource of graph.resources) {
      const key = resourceKey(resource.identity);
      if (
        resource.identity.owner &&
        removed.has(resource.identity.owner) &&
        !removed.has(key)
      ) {
        removed.add(key);
        changed = true;
      }
    }
  }
  return graph.references.filter(
    (reference) =>
      removed.has(resourceKey(reference.to)) &&
      !removed.has(resourceKey(reference.from)),
  );
}
export function sourceForResource(
  graph: ResourceGraph,
  identity: ResourceIdentity,
): SourcePointer | undefined {
  return graph.resources.find(
    (resource) => resourceKey(resource.identity) === resourceKey(identity),
  )?.source;
}

/** Copy only known document contracts. No heuristic rewriting of arbitrary strings. */
export function duplicateAuthoringDocuments(
  documents: readonly AuthoringDocument[],
  allocateId: (identity: ResourceIdentity) => string,
): {
  documents: AuthoringDocument[];
  idMap: Map<string, ResourceIdentity>;
  retainedReferences: ResourceReference[];
  graph: ResourceGraph;
} {
  const original = extractAuthoringResources(documents);
  if (original.diagnostics.some((d) => d.code === "duplicate-resource"))
    throw new Error("Cannot copy ambiguous resources");
  const idMap = new Map<string, ResourceIdentity>();
  const used = new Set(original.resources.map((r) => resourceKey(r.identity)));
  for (const resource of [...original.resources].sort((a, b) =>
    resourceKey(a.identity) < resourceKey(b.identity)
      ? -1
      : resourceKey(a.identity) > resourceKey(b.identity)
        ? 1
        : 0,
  )) {
    const id = allocateId(resource.identity);
    if (!id || id.length > 256 || id === resource.identity.id)
      throw new Error("Copy requires fresh bounded IDs");
    const identity = { ...resource.identity, id };
    const key = resourceKey(identity);
    if (used.has(key)) throw new Error("Copy ID collision");
    used.add(key);
    idMap.set(resourceKey(resource.identity), identity);
  }
  const remapOwner = (key: string): ResourceIdentity => {
    const identity = idMap.get(key)!;
    const owner =
      identity.owner && idMap.has(identity.owner)
        ? remapOwner(identity.owner)
        : undefined;
    return { ...identity, ...(owner ? { owner: resourceKey(owner) } : {}) };
  };
  const owned = [...idMap].map(([key]) => [key, remapOwner(key)] as const);
  for (const [key, identity] of owned) idMap.set(key, identity);
  const copies = structuredClone(documents) as AuthoringDocument[];
  const write = (source: SourcePointer, value: string, keyIdentity = false) => {
    const document = copies
      .filter(
        (d) =>
          d.file === source.file &&
          (!d.pointerPrefix ||
            source.jsonPointer === d.pointerPrefix ||
            source.jsonPointer.startsWith(`${d.pointerPrefix}/`)),
      )
      .sort(
        (a, b) =>
          (b.pointerPrefix?.length ?? 0) - (a.pointerPrefix?.length ?? 0),
      )[0];
    const parts = source.jsonPointer
      .slice((document.pointerPrefix?.length ?? 0) + 1)
      .split("/")
      .map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
    let object = document.value as ObjectValue;
    const unsafe = (key: string) =>
      ["__proto__", "constructor", "prototype"].includes(key);
    for (const part of parts.slice(0, -1)) {
      if (
        unsafe(part) ||
        !object ||
        typeof object !== "object" ||
        !Object.hasOwn(object, part)
      )
        throw new Error("Unsafe copy source path");
      object = object[part];
    }
    const key = parts.at(-1)!;
    if (unsafe(key) || unsafe(value) || !Object.hasOwn(object, key))
      throw new Error("Unsafe copy source field");
    if (keyIdentity) {
      if (Object.hasOwn(object, value))
        throw new Error("Copy dictionary collision");
      object[value] = object[key];
      delete object[key];
    } else object[key] = value;
  };
  const keyField = (identity: ResourceIdentity) =>
    identity.kind === "flag" || identity.kind === "stat";
  // References are rewritten before key identities so their original pointers remain valid.
  for (const reference of original.references) {
    const target = idMap.get(resourceKey(reference.to));
    if (target) write(reference.source, target.id, reference.dictionaryKey);
  }
  for (const resource of original.resources)
    write(
      { file: resource.source.file, jsonPointer: resource.identityPointer },
      idMap.get(resourceKey(resource.identity))!.id,
      keyField(resource.identity),
    );
  return {
    documents: copies,
    idMap,
    retainedReferences: original.references
      .filter((r) => !idMap.has(resourceKey(r.to)))
      .map((r) => ({ ...r, from: idMap.get(resourceKey(r.from))! })),
    graph: extractAuthoringResources(copies),
  };
}
