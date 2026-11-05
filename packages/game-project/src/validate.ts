import {
  array,
  boolean,
  boundedJSON,
  canonical,
  integer,
  record as rawRecord,
  string,
} from "./runtime";
import type {
  AbilityDefinition,
  AssertionValue,
  ArchetypeDefinition,
  Diagnostic,
  GameDefinitions,
  InputRecord,
  LevelDefinition,
  Rect,
  ScenarioDefinition,
} from "./types";
import { ACTIONS, UNIT } from "./types";

export class ValidationError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
    const colon = message.indexOf(":");
    this.diagnostics = [
      {
        code: "game-definition-invalid",
        severity: "error",
        file: "definitions.json",
        jsonPointer: colon < 0 ? "" : message.slice(0, colon),
        message,
        repair:
          "Use the supported fields, integer bounds and existing stable definition IDs.",
      },
    ];
  }
}
let locations = new WeakMap<object, string>();
function locate(value: unknown, path = "", depth = 0): void {
  if (depth > 32) throw Error(`${path}: nesting limit exceeded`);
  if (value && typeof value === "object") {
    locations.set(value, path);
    for (const [key, child] of Object.entries(value))
      locate(
        child,
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        depth + 1,
      );
  }
}
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  return rawRecord(
    value,
    keys,
    value && typeof value === "object" ? (locations.get(value) ?? "") : "",
  );
}
const pathOf = (o: Record<string, unknown>, key: string) =>
  `${locations.get(o) ?? ""}/${key}`;
const n = (v: unknown, max = 16777216, min = 0) => integer(v, min, max);
const fieldNumber = (
  o: Record<string, unknown>,
  key: string,
  max = 16777216,
  min = 0,
) => integer(o[key], min, max, pathOf(o, key));
const fieldString = (o: Record<string, unknown>, key: string) =>
  string(o[key], pathOf(o, key));
function fieldBoolean(o: Record<string, unknown>, key: string): boolean {
  try {
    return boolean(o[key]);
  } catch {
    throw Error(`${pathOf(o, key)}: expected boolean`);
  }
}
const fieldArray = (o: Record<string, unknown>, key: string, cap: number) =>
  array(o[key], cap, pathOf(o, key));
const idList = (v: unknown, cap: number) =>
  unique(array(v, cap).map((x) => string(x)));
function unique<T extends string>(items: T[]): T[] {
  if (new Set(items).size !== items.length) throw Error("duplicate stable ID");
  return items;
}
function rect(v: unknown): Rect {
  const o = record(v, ["x", "y", "width", "height"]);
  return {
    x: fieldNumber(o, "x", 16777216, -16777216),
    y: fieldNumber(o, "y", 16777216, -16777216),
    width: fieldNumber(o, "width", 65536, 1),
    height: fieldNumber(o, "height", 65536, 1),
  };
}
function rectFields(o: Record<string, unknown>): Rect {
  return {
    x: fieldNumber(o, "x", 16777216, -16777216),
    y: fieldNumber(o, "y", 16777216, -16777216),
    width: fieldNumber(o, "width", 65536, 1),
    height: fieldNumber(o, "height", 65536, 1),
  };
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const item of Object.values(v)) freeze(item);
    Object.freeze(v);
  }
  return v;
}
export function validateInputRecord(v: unknown): InputRecord {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("input record expected");
  const source = v as Record<string, unknown>;
  const o = record(v, [
    "tick",
    "slot",
    "sequence",
    "edges",
    ...(Object.hasOwn(source, "heldPatch") ? ["heldPatch"] : []),
    ...(Object.hasOwn(source, "axesPatch") ? ["axesPatch"] : []),
  ]);
  const edges = fieldArray(o, "edges", 32).map((e) => {
    const q = record(e, ["action", "kind"]);
    if (
      !ACTIONS.includes(q.action as never) ||
      !["pressed", "released", "cancel"].includes(q.kind as string)
    )
      throw Error("invalid input edge");
    return { action: q.action, kind: q.kind } as InputRecord["edges"][number];
  });
  const result: InputRecord = {
    tick: fieldNumber(o, "tick", Number.MAX_SAFE_INTEGER),
    slot: fieldNumber(o, "slot", 3),
    sequence: fieldNumber(o, "sequence", Number.MAX_SAFE_INTEGER),
    edges,
  };
  if (Object.hasOwn(o, "heldPatch")) {
    const p = o.heldPatch;
    if (
      !p ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      Object.keys(p).some((k) => !ACTIONS.includes(k as never))
    )
      throw Error("invalid held patch");
    result.heldPatch = {};
    for (const [k, v] of Object.entries(p))
      result.heldPatch[k as keyof typeof result.heldPatch] = boolean(v);
  }
  if (Object.hasOwn(o, "axesPatch")) {
    const p = o.axesPatch;
    if (
      !p ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      Object.keys(p).some((k) => k !== "moveX")
    )
      throw Error("invalid axes patch");
    result.axesPatch = {};
    if (Object.hasOwn(p, "moveX"))
      result.axesPatch.moveX = integer(
        (p as Record<string, unknown>).moveX,
        -127,
        127,
      );
  }
  return result;
}
function ability(v: unknown): AbilityDefinition {
  const o = record(v, [
    "id",
    "startup",
    "active",
    "recovery",
    "hit",
    "damage",
    "knockbackX",
    "knockbackY",
    "stunTicks",
    "hitStopTicks",
    "guardDamage",
    "maxHits",
    "rehitTicks",
  ]);
  return {
    id: fieldString(o, "id"),
    startup: fieldNumber(o, "startup", 600),
    active: fieldNumber(o, "active", 600, 1),
    recovery: fieldNumber(o, "recovery", 600),
    hit: rect(o.hit),
    damage: fieldNumber(o, "damage", 1000, 1),
    knockbackX: fieldNumber(o, "knockbackX", 8192),
    knockbackY: fieldNumber(o, "knockbackY", 8192, -8192),
    stunTicks: fieldNumber(o, "stunTicks", 600),
    hitStopTicks: fieldNumber(o, "hitStopTicks", 60),
    guardDamage: fieldNumber(o, "guardDamage", 1000),
    maxHits: fieldNumber(o, "maxHits", 8, 1),
    rehitTicks: fieldNumber(o, "rehitTicks", 600, 1),
  };
}
function archetype(v: unknown): ArchetypeDefinition {
  const o = record(v, [
    "id",
    "body",
    "hurt",
    "push",
    "health",
    "speed",
    "jumpSpeed",
    "gravity",
    "maxFallSpeed",
    "coyoteTicks",
    "jumpBufferTicks",
    "attackBufferTicks",
    "abilities",
    "ai",
    "aiRange",
  ]);
  if (o.ai !== "none" && o.ai !== "patrol") throw Error("invalid AI module");
  return {
    id: fieldString(o, "id"),
    body: rect(o.body),
    hurt: rect(o.hurt),
    push: rect(o.push),
    health: fieldNumber(o, "health", 10000, 1),
    speed: fieldNumber(o, "speed", 8192, 1),
    jumpSpeed: fieldNumber(o, "jumpSpeed", 8192, 1),
    gravity: fieldNumber(o, "gravity", 8192, 1),
    maxFallSpeed: fieldNumber(o, "maxFallSpeed", 8192, 1),
    coyoteTicks: fieldNumber(o, "coyoteTicks", 60),
    jumpBufferTicks: fieldNumber(o, "jumpBufferTicks", 60, 1),
    attackBufferTicks: fieldNumber(o, "attackBufferTicks", 60, 1),
    abilities: idList(o.abilities, 2),
    ai: o.ai,
    aiRange: fieldNumber(o, "aiRange", 16777216),
  };
}
function level(v: unknown): LevelDefinition {
  const o = record(v, [
    "id",
    "width",
    "height",
    "tileSize",
    "tiles",
    "rectangles",
    "platforms",
    "spawns",
    "goal",
    "deathY",
  ]);
  const width = fieldNumber(o, "width", 65536, 8),
    height = fieldNumber(o, "height", 65536, 8),
    tileSize = fieldNumber(o, "tileSize", 32, 8) as 8 | 16 | 32;
  if (![8, 16, 32].includes(tileSize) || width % tileSize || height % tileSize)
    throw Error("level dimensions must align with 8/16/32 tile size");
  const tiles = fieldArray(o, "tiles", 1048576).map((t) => n(t, 2));
  if (tiles.length !== (width / tileSize) * (height / tileSize))
    throw Error("tile count mismatch");
  const rectangles = fieldArray(o, "rectangles", 1024).map((v) => {
    const q = record(v, ["id", "x", "y", "width", "height", "oneWay"]);
    return {
      ...rectFields(q),
      id: fieldString(q, "id"),
      oneWay: fieldBoolean(q, "oneWay"),
    };
  });
  const platforms = fieldArray(o, "platforms", 32).map((v) => {
    const q = record(v, ["id", "x", "y", "width", "height", "endX", "speed"]);
    return {
      ...rectFields(q),
      id: fieldString(q, "id"),
      endX: fieldNumber(q, "endX"),
      speed: fieldNumber(q, "speed", 1024, 1),
    };
  });
  const spawns = fieldArray(o, "spawns", 256).map((v) => {
    const q = record(v, [
      "id",
      "archetypeId",
      "x",
      "y",
      "slot",
      "team",
      "facing",
    ]);
    const facing = fieldNumber(q, "facing", 1, -1);
    if (facing === 0) throw Error("facing must be -1 or 1");
    return {
      id: fieldString(q, "id"),
      archetypeId: fieldString(q, "archetypeId"),
      x: fieldNumber(q, "x"),
      y: fieldNumber(q, "y"),
      slot: q.slot === null ? null : fieldNumber(q, "slot", 3),
      team: fieldNumber(q, "team", 255),
      facing: facing as -1 | 1,
    };
  });
  unique([...rectangles.map((x) => x.id), ...platforms.map((x) => x.id)]);
  unique(spawns.map((x) => x.id));
  unique(spawns.filter((x) => x.slot !== null).map((x) => String(x.slot)));
  const g = record(o.goal, ["x", "y", "width", "height", "nextLevelId"]);
  const goal = {
    ...rectFields(g),
    nextLevelId: g.nextLevelId === null ? null : fieldString(g, "nextLevelId"),
  };
  for (const r of [...rectangles, ...platforms, goal])
    if (
      r.x < 0 ||
      r.y < 0 ||
      r.x + r.width > width * UNIT ||
      r.y + r.height > height * UNIT
    )
      throw Error("geometry outside map");
  for (const p of platforms) {
    if (p.endX + p.width > width * UNIT)
      throw Error("platform path outside map");
    const sweep = {
      x: Math.min(p.x, p.endX),
      y: p.y,
      width: Math.abs(p.endX - p.x) + p.width,
      height: p.height,
    };
    if (rectangles.some((r) => !r.oneWay && overlap(sweep, r)))
      throw Error("platform swept path intersects solid rectangle");
    for (
      let row = Math.floor(sweep.y / (tileSize * UNIT));
      row <= Math.floor((sweep.y + sweep.height - 1) / (tileSize * UNIT));
      row++
    )
      for (
        let col = Math.floor(sweep.x / (tileSize * UNIT));
        col <= Math.floor((sweep.x + sweep.width - 1) / (tileSize * UNIT));
        col++
      )
        if (tiles[row * (width / tileSize) + col] === 1)
          throw Error("platform swept path intersects solid tile");
  }
  return {
    id: fieldString(o, "id"),
    width,
    height,
    tileSize,
    tiles,
    rectangles,
    platforms,
    spawns,
    goal,
    deathY: fieldNumber(o, "deathY", 16777216),
  };
}
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;
function scenario(v: unknown): ScenarioDefinition {
  const source = v as Record<string, unknown>;
  const o = record(v, [
    "id",
    "levelId",
    "seed",
    "playerSlots",
    "ticks",
    "actions",
    "assertions",
    ...(source && Object.hasOwn(source, "commands") ? ["commands"] : []),
  ]);
  const result: ScenarioDefinition = {
    id: fieldString(o, "id"),
    levelId: fieldString(o, "levelId"),
    seed: fieldNumber(o, "seed", 4294967295),
    playerSlots: fieldArray(o, "playerSlots", 4).map((x) => n(x, 3)),
    ticks: fieldNumber(o, "ticks", 200000),
    actions: fieldArray(o, "actions", 200000).map(validateInputRecord),
    assertions: fieldArray(o, "assertions", 1024).map((v) => {
      const q = record(v, ["tick", "path", "equals"]);
      if (
        typeof q.path !== "string" ||
        q.path.length > 256 ||
        !/^[a-zA-Z0-9./_-]+$/.test(q.path)
      )
        throw Error("invalid assertion path");
      return {
        tick: fieldNumber(q, "tick", 200000),
        path: q.path,
        equals: assertionValue(q.equals),
      };
    }),
  };
  if (Object.hasOwn(o, "commands"))
    return {
      ...result,
      commands: fieldArray(o, "commands", 1024).map((v) => {
        const c = record(v, ["tick", "type"]);
        if (c.type !== "restart")
          throw Error(`${pathOf(c, "type")}: unsupported scenario command`);
        return { tick: fieldNumber(c, "tick", 200000), type: "restart" };
      }),
    };
  return result;
}
function assertionValue(value: unknown): AssertionValue {
  let nodes = 0;
  function visit(v: unknown, depth: number): AssertionValue {
    if (++nodes > 256 || depth > 8)
      throw Error("assertion equality exceeds depth8/node256 bound");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (v.length > 512)
        throw Error("assertion equality string exceeds512 characters");
      return v;
    }
    if (typeof v === "number")
      return integer(v, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (Array.isArray(v)) return v.map((x) => visit(x, depth + 1));
    if (v && typeof v === "object") {
      const result: Record<string, AssertionValue> = {};
      for (const [key, child] of Object.entries(v)) {
        if (
          key.length > 128 ||
          ["__proto__", "constructor", "prototype"].includes(key)
        )
          throw Error("invalid assertion object key");
        result[key] = visit(child, depth + 1);
      }
      return result;
    }
    throw Error("invalid assertion equality value");
  }
  return visit(value, 0);
}
export function validateDefinitions(value: unknown): GameDefinitions {
  try {
    locations = new WeakMap<object, string>();
    locate(value);
    const o = record(value, [
      "manifest",
      "levels",
      "archetypes",
      "abilities",
      "scenarios",
    ]);
    const m = record(o.manifest, [
        "schemaVersion",
        "gameId",
        "title",
        "rulesModule",
        "initialLevelId",
        "initialScenarioId",
        "levelIds",
        "archetypeIds",
        "abilityIds",
        "scenarioIds",
        "viewport",
      ]),
      viewport = record(m.viewport, ["width", "height"]);
    if (m.schemaVersion !== 1 || m.rulesModule !== "platform-combat-v1")
      throw Error("/manifest: unsupported schema/rules module");
    if (typeof m.title !== "string" || m.title.length > 120)
      throw Error("/manifest/title: invalid title");
    const definitions: GameDefinitions = {
      manifest: {
        schemaVersion: 1,
        gameId: fieldString(m, "gameId"),
        title: m.title,
        rulesModule: "platform-combat-v1",
        initialLevelId: fieldString(m, "initialLevelId"),
        initialScenarioId: fieldString(m, "initialScenarioId"),
        levelIds: idList(m.levelIds, 64),
        archetypeIds: idList(m.archetypeIds, 256),
        abilityIds: idList(m.abilityIds, 256),
        scenarioIds: idList(m.scenarioIds, 128),
        viewport: {
          width: fieldNumber(viewport, "width", 1024, 64),
          height: fieldNumber(viewport, "height", 1024, 64),
        },
      },
      levels: fieldArray(o, "levels", 64).map(level),
      archetypes: fieldArray(o, "archetypes", 256).map(archetype),
      abilities: fieldArray(o, "abilities", 256).map(ability),
      scenarios: fieldArray(o, "scenarios", 128).map(scenario),
    };
    const d = definitions;
    for (const key of [
      "levels",
      "archetypes",
      "abilities",
      "scenarios",
    ] as const)
      unique(d[key].map((x) => x.id));
    for (const [items, ids] of [
      [d.levels, d.manifest.levelIds],
      [d.archetypes, d.manifest.archetypeIds],
      [d.abilities, d.manifest.abilityIds],
      [d.scenarios, d.manifest.scenarioIds],
    ] as const)
      if (items.length !== ids.length || items.some((x) => !ids.includes(x.id)))
        throw Error("manifest reference list mismatch");
    if (
      !d.levels.some((x) => x.id === d.manifest.initialLevelId) ||
      !d.scenarios.some(
        (x) =>
          x.id === d.manifest.initialScenarioId &&
          x.levelId === d.manifest.initialLevelId,
      )
    )
      throw Error("missing initial level/scenario");
    for (const a of d.archetypes)
      if (
        !a.abilities.length ||
        a.abilities.some((id) => !d.abilities.some((b) => b.id === id))
      )
        throw Error("missing ability reference");
    for (const l of d.levels) {
      if (
        l.goal.nextLevelId !== null &&
        !d.levels.some((x) => x.id === l.goal.nextLevelId)
      )
        throw Error("missing next level");
      for (const s of l.spawns) {
        const a = d.archetypes.find((x) => x.id === s.archetypeId);
        if (!a) throw Error("missing archetype reference");
        const b = {
          x: s.x + a.body.x,
          y: s.y + a.body.y,
          width: a.body.width,
          height: a.body.height,
        };
        if (
          b.x < 0 ||
          b.y < 0 ||
          b.x + b.width > l.width * UNIT ||
          b.y + b.height > l.height * UNIT
        )
          throw Error("spawn body outside map");
        if (l.rectangles.some((r) => !r.oneWay && overlap(b, r)))
          throw Error("spawn embedded in rectangle");
        const size = l.tileSize * UNIT;
        for (
          let y = Math.floor(b.y / size);
          y <= Math.floor((b.y + b.height - 1) / size);
          y++
        )
          for (
            let x = Math.floor(b.x / size);
            x <= Math.floor((b.x + b.width - 1) / size);
            x++
          )
            if (l.tiles[y * (l.width / l.tileSize) + x] === 1)
              throw Error("spawn embedded in tile");
      }
      // Horizontal rider clearance is checked for every implemented body, across
      // the whole path and the possible standing offsets at platform edges.
      for (const p of l.platforms)
        for (const a of d.archetypes) {
          const clearance = {
            x: Math.min(p.x, p.endX) - a.body.width + 1,
            y: p.y - a.body.height,
            width: Math.abs(p.endX - p.x) + p.width + 2 * a.body.width - 2,
            height: a.body.height,
          };
          const pointer = `/levels/${d.levels.indexOf(l)}/platforms/${l.platforms.indexOf(p)}`;
          if (
            clearance.x < 0 ||
            clearance.y < 0 ||
            clearance.x + clearance.width > l.width * UNIT
          )
            throw Error(
              `${pointer}: platform rider clearance extends outside map`,
            );
          if (l.rectangles.some((r) => !r.oneWay && overlap(clearance, r)))
            throw Error(
              `${pointer}: platform rider path intersects solid rectangle`,
            );
          const size = l.tileSize * UNIT;
          for (
            let y = Math.floor(clearance.y / size);
            y <= Math.floor((clearance.y + clearance.height - 1) / size);
            y++
          )
            for (
              let x = Math.floor(clearance.x / size);
              x <= Math.floor((clearance.x + clearance.width - 1) / size);
              x++
            )
              if (l.tiles[y * (l.width / l.tileSize) + x] === 1)
                throw Error(
                  `${pointer}: platform rider path intersects solid tile`,
                );
        }
    }
    for (const s of d.scenarios) {
      const l = d.levels.find((x) => x.id === s.levelId);
      if (!l) throw Error("scenario level missing");
      unique(s.playerSlots.map(String));
      if (s.playerSlots.some((slot) => !l.spawns.some((x) => x.slot === slot)))
        throw Error("scenario player slot missing");
      const held = Array.from(
        { length: 4 },
        () =>
          Object.fromEntries(ACTIONS.map((a) => [a, false])) as Record<
            (typeof ACTIONS)[number],
            boolean
          >,
      );
      let lastTick = -1;
      let counts = [0, 0, 0, 0],
        sequences = [-1, -1, -1, -1];
      for (const [index, action] of s.actions.entries()) {
        const pointer = `/scenarios/${d.scenarios.indexOf(s)}/actions/${index}`;
        if (action.tick >= s.ticks || action.tick < lastTick)
          throw Error(
            `${pointer}/tick: scenario action tick outside ordered run`,
          );
        if (action.tick !== lastTick) {
          counts = [0, 0, 0, 0];
          sequences = [-1, -1, -1, -1];
          lastTick = action.tick;
        }
        if (action.sequence <= sequences[action.slot])
          throw Error(
            `${pointer}/sequence: scenario sequence must increase per slot/tick`,
          );
        sequences[action.slot] = action.sequence;
        counts[action.slot] += action.edges.length;
        if (counts[action.slot] > 32)
          throw Error(`${pointer}/edges: transition limit exceeded`);
        for (const e of action.edges) {
          const prior = held[action.slot][e.action];
          if (
            (e.kind === "pressed" && prior) ||
            (e.kind === "released" && !prior)
          )
            throw Error(`${pointer}/edges: invalid held transition`);
          held[action.slot][e.action] = e.kind === "pressed";
        }
        for (const [key, value] of Object.entries(action.heldPatch ?? {}))
          if (value !== held[action.slot][key as (typeof ACTIONS)[number]])
            throw Error(
              `${pointer}/heldPatch/${key}: held patch disagrees with transitions`,
            );
      }
      for (const [index, assertion] of s.assertions.entries())
        if (assertion.tick > s.ticks)
          throw Error(
            `/scenarios/${d.scenarios.indexOf(s)}/assertions/${index}/tick: assertion outside run`,
          );
      let priorCommandTick = -1;
      for (const [index, command] of (s.commands ?? []).entries()) {
        if (command.tick >= s.ticks || command.tick <= priorCommandTick)
          throw Error(
            `/scenarios/${d.scenarios.indexOf(s)}/commands/${index}/tick: commands require ordered unique in-run ticks`,
          );
        priorCommandTick = command.tick;
      }
    }
    return freeze(definitions);
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : String(error),
    );
  }
}
export function parseDefinitions(json: string): GameDefinitions {
  return validateDefinitions(boundedJSON(json));
}
export function canonicalDefinitions(definitions: GameDefinitions): string {
  return canonical(definitions);
}
