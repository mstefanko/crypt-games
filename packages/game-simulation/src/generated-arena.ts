/** World G1: finite, inspectable room assembly. These identities pin the complete
 * development recipe/library; changing authored geometry requires a new version. */
import { sha256Content } from "./content-hash";
import { boundedJSON, canonical } from "@onepage/game-project/runtime";
import {
  DeterministicRandom,
  deriveRandomSeed,
  RANDOM_ALGORITHM,
  RANDOM_SEED_DERIVATION,
} from "./rng";

export const GENERATED_ARENA_GENERATOR = "authored-arena-graph-v1" as const;
export const GENERATED_ARENA_RULES = "arena-action-rules-v1" as const;
export const GENERATED_ARENA_LIBRARY = "forge-grove-16-templates-v1" as const;
export const GENERATED_ARENA_LIMITS = Object.freeze({
  rooms: 8,
  templates: 16,
  branches: 1,
  attempts: 1,
  work: 8192,
  manifestBytes: 262144,
  placementsPerRoom: 4,
  actorRadius: 64,
});
export type ArenaTheme = "forge" | "grove";
export type ArenaReward = "power" | "focus" | "vitality";
export interface GeneratedArenaRecipe {
  format: "generated-arena-recipe-v1";
  seed: number;
  rooms: number;
  branches: number;
  theme: ArenaTheme;
}
export interface ArenaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ArenaPlacement {
  id: string;
  kind: "cover" | "barrel";
  rect: ArenaRect;
}
export interface GeneratedArenaRoom {
  id: string;
  templateId: string;
  revision: 1;
  role: "start" | "arena" | "rest" | "branch" | "boss";
  theme: ArenaTheme;
  locked: boolean;
  edited: boolean;
  originSeed: number;
  tier: number;
  encounterSeed: number;
  rewards: ArenaReward[];
  placements: ArenaPlacement[];
  /** Actor-centre polyline from west entrance to east exit, certified against
   * the complete baseline collision including all unbroken cover. */
  traversal: { x: number; y: number }[];
}
export interface GeneratedArenaManifest {
  format: "generated-arena-manifest-v1";
  generator: typeof GENERATED_ARENA_GENERATOR;
  rules: typeof GENERATED_ARENA_RULES;
  library: typeof GENERATED_ARENA_LIBRARY;
  randomAlgorithm: typeof RANDOM_ALGORITHM;
  seedDerivation: typeof RANDOM_SEED_DERIVATION;
  recipe: GeneratedArenaRecipe;
  rooms: GeneratedArenaRoom[];
  links: { from: string; to: string; optional: boolean }[];
  route: string[];
  attempt: 1;
  work: number;
  digest: string;
}
export function arenaCheck(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(`generated arena: ${message}`);
}
/** Reject accessors, sparse arrays, symbols, nonfinite/fractional values and
 * oversized trees before canonicalization or publication. Shared with run saves. */
export function canonicalArenaData(
  value: unknown,
  cap: number = GENERATED_ARENA_LIMITS.manifestBytes,
): string {
  let nodes = 0;
  function visit(v: unknown, depth: number): void {
    arenaCheck(++nodes <= 60000 && depth <= 24, "data work/depth cap");
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "string") {
      arenaCheck(v.length <= 256, "string cap");
      return;
    }
    if (typeof v === "number") {
      arenaCheck(
        Number.isSafeInteger(v) && !Object.is(v, -0),
        "noncanonical integer",
      );
      return;
    }
    arenaCheck(v && typeof v === "object", "invalid data");
    const keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      arenaCheck(
        Object.getPrototypeOf(v) === Array.prototype &&
          v.length <= 8192 &&
          keys.length === v.length + 1,
        "array cap/shape",
      );
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        arenaCheck(d && Object.hasOwn(d, "value"), "array accessor/hole");
        visit(d.value, depth + 1);
      }
    } else {
      arenaCheck(
        Object.getPrototypeOf(v) === Object.prototype && keys.length <= 32,
        "object shape",
      );
      for (const key of keys) {
        arenaCheck(typeof key === "string", "symbol key");
        const d = Object.getOwnPropertyDescriptor(v, key)!;
        arenaCheck(
          Object.hasOwn(d, "value") && d.enumerable,
          "accessor/hidden key",
        );
        visit(d.value, depth + 1);
      }
    }
  }
  visit(value, 0);
  const bytes = canonical(value);
  boundedJSON(bytes, cap, { rejectNegativeZero: true });
  return bytes;
}
function fields(v: object, names: string[]) {
  arenaCheck(
    Object.keys(v).sort().join() === [...names].sort().join(),
    "unknown/missing fields",
  );
}
function int(n: number, min: number, max: number) {
  return Number.isSafeInteger(n) && !Object.is(n, -0) && n >= min && n <= max;
}
export function validateArenaRecipe(value: unknown): GeneratedArenaRecipe {
  canonicalArenaData(value);
  arenaCheck(
    value && typeof value === "object" && !Array.isArray(value),
    "recipe shape",
  );
  const r = value as GeneratedArenaRecipe;
  fields(r, ["format", "seed", "rooms", "branches", "theme"]);
  arenaCheck(
    r.format === "generated-arena-recipe-v1" &&
      int(r.seed, 0, 0xffffffff) &&
      int(r.rooms, 4, 8) &&
      int(r.branches, 0, 1) &&
      (r.theme === "forge" || r.theme === "grove"),
    "unsupported recipe",
  );
  return { ...r };
}
function digest(value: unknown): string {
  return `sha256:${sha256Content(canonical(value))}`;
}
function template(theme: ArenaTheme, index: number): ArenaPlacement[] {
  // Eight authored layouts per theme. The centre corridor always has >=128
  // clearance; cover shape and barrel side vary inside the certified box.
  const offset = index % 4;
  return [
    {
      id: "cover",
      kind: "cover",
      rect: {
        x: 1536 + offset * 128,
        y: index < 4 ? 512 : 2048,
        width: 256,
        height: 512,
      },
    },
    {
      id: "barrel",
      kind: "barrel",
      rect: {
        x: 2560 + offset * 64,
        y: theme === "forge" ? 512 : 2304,
        width: 128,
        height: 128,
      },
    },
  ];
}
/** A segment's swept actor square conservatively contains the circular body.
 * Witness tests use all baseline blockers, so destruction cannot be required. */
function traversal(room: GeneratedArenaRoom): void {
  arenaCheck(
    Array.isArray(room.traversal) &&
      room.traversal.length >= 2 &&
      room.traversal.length <= 8,
    "traversal bound",
  );
  const radius = GENERATED_ARENA_LIMITS.actorRadius;
  arenaCheck(
    canonical(room.traversal[0]) === canonical({ x: 320, y: 1600 }) &&
      canonical(room.traversal.at(-1)) === canonical({ x: 3904, y: 1600 }),
    "entrance/exit witness mismatch",
  );
  for (let i = 0; i < room.traversal.length; i++) {
    const p = room.traversal[i];
    fields(p, ["x", "y"]);
    arenaCheck(
      int(p.x, radius, 4096 - radius) && int(p.y, radius, 3072 - radius),
      "witness outside arena",
    );
    if (!i) continue;
    const a = room.traversal[i - 1];
    arenaCheck(a.x === p.x || a.y === p.y, "witness must be axis aligned");
    const swept = {
      x: Math.min(a.x, p.x) - radius,
      y: Math.min(a.y, p.y) - radius,
      width: Math.abs(a.x - p.x) + radius * 2,
      height: Math.abs(a.y - p.y) + radius * 2,
    };
    for (const { rect: b } of room.placements)
      arenaCheck(
        !(
          swept.x < b.x + b.width &&
          swept.x + swept.width > b.x &&
          swept.y < b.y + b.height &&
          swept.y + swept.height > b.y
        ),
        `blocked traversal ${room.id}`,
      );
  }
}
function topology(r: GeneratedArenaRecipe) {
  const optional = r.branches ? r.rooms - 2 : -1;
  const route = Array.from({ length: r.rooms }, (_, i) => i)
    .filter((i) => i !== optional)
    .map((i) => `room-${i}`);
  const links = route
    .slice(1)
    .map((to, i) => ({ from: route[i], to, optional: false }));
  if (optional >= 0)
    links.push({ from: "room-1", to: `room-${optional}`, optional: true });
  return { route, links };
}
function withDigest(
  value: Omit<GeneratedArenaManifest, "digest">,
): GeneratedArenaManifest {
  return { ...value, digest: digest(value) };
}
function generate(
  recipe: GeneratedArenaRecipe,
  retained?: GeneratedArenaManifest,
  locks: readonly string[] = [],
): GeneratedArenaManifest {
  const random = new DeterministicRandom(
    ["templates", "rewards"].map((name) => ({
      name: `arena.${name}`,
      owner: "arena",
      seed: deriveRandomSeed(recipe.seed, `arena.${name}`),
    })),
  );
  const rooms: GeneratedArenaRoom[] = [];
  let work = 0;
  for (let i = 0; i < recipe.rooms; i++) {
    const variant = random.drawInteger("arena", "arena.templates", 8);
    const rewards: ArenaReward[] = ["power", "focus", "vitality"];
    const first = random.drawInteger("arena", "arena.rewards", 3);
    const a = rewards.splice(first, 1)[0];
    const b = rewards[random.drawInteger("arena", "arena.rewards", 2)];
    const role: GeneratedArenaRoom["role"] =
      i === 0
        ? "start"
        : i === recipe.rooms - 1
          ? "boss"
          : recipe.branches && i === recipe.rooms - 2
            ? "branch"
            : i > 1 && i % 2 === 0
              ? "rest"
              : "arena";
    const id = `room-${i}`;
    const prior = retained?.rooms.find((room) => room.id === id);
    const candidate: GeneratedArenaRoom = {
      id,
      templateId: `${recipe.theme}-${variant}`,
      revision: 1,
      role,
      theme: recipe.theme,
      locked: locks.includes(id),
      edited: false,
      originSeed: recipe.seed,
      tier:
        role === "start" || role === "rest"
          ? 0
          : role === "boss"
            ? 3
            : role === "branch"
              ? 2
              : 1,
      encounterSeed: deriveRandomSeed(recipe.seed, `arena.encounter.${i}`),
      rewards: role === "start" || role === "rest" ? [] : [a, b],
      placements: template(recipe.theme, variant),
      traversal: [
        { x: 320, y: 1600 },
        { x: 3904, y: 1600 },
      ],
    };
    if (locks.includes(id)) {
      arenaCheck(
        prior && prior.role === role && prior.theme === recipe.theme,
        "locked room boundary/role mismatch",
      );
      rooms.push({ ...structuredClone(prior), locked: true });
    } else rooms.push(candidate);
    work += 16 + candidate.placements.length * candidate.traversal.length;
  }
  const graph = topology(recipe);
  const manifest = withDigest({
    format: "generated-arena-manifest-v1",
    generator: GENERATED_ARENA_GENERATOR,
    rules: GENERATED_ARENA_RULES,
    library: GENERATED_ARENA_LIBRARY,
    randomAlgorithm: RANDOM_ALGORITHM,
    seedDerivation: RANDOM_SEED_DERIVATION,
    recipe: { ...recipe },
    rooms,
    ...graph,
    attempt: 1,
    work,
  });
  validateArenaManifest(manifest);
  return manifest;
}
export function generateArenaManifest(
  value: GeneratedArenaRecipe,
): GeneratedArenaManifest {
  return generate(validateArenaRecipe(value));
}
/** Validates realized content directly; restore never calls generation. Pinned
 * templates constrain edits; selection and reward draws remain frozen data. */
export function validateArenaManifest(value: unknown): GeneratedArenaManifest {
  canonicalArenaData(value);
  arenaCheck(
    value && typeof value === "object" && !Array.isArray(value),
    "manifest shape",
  );
  const m = value as GeneratedArenaManifest;
  fields(m, [
    "format",
    "generator",
    "rules",
    "library",
    "randomAlgorithm",
    "seedDerivation",
    "recipe",
    "rooms",
    "links",
    "route",
    "attempt",
    "work",
    "digest",
  ]);
  const r = validateArenaRecipe(m.recipe);
  arenaCheck(
    m.format === "generated-arena-manifest-v1" &&
      m.generator === GENERATED_ARENA_GENERATOR &&
      m.rules === GENERATED_ARENA_RULES &&
      m.library === GENERATED_ARENA_LIBRARY &&
      m.randomAlgorithm === RANDOM_ALGORITHM &&
      m.seedDerivation === RANDOM_SEED_DERIVATION,
    "missing/incompatible generation pins",
  );
  arenaCheck(
    Array.isArray(m.rooms) &&
      m.rooms.length === r.rooms &&
      m.attempt === 1 &&
      int(m.work, 1, 8192),
    "manifest bounds",
  );
  arenaCheck(
    canonical({ route: m.route, links: m.links }) === canonical(topology(r)),
    "invalid graph/progression",
  );
  for (const [i, room] of m.rooms.entries()) {
    fields(room, [
      "id",
      "templateId",
      "revision",
      "role",
      "theme",
      "locked",
      "edited",
      "originSeed",
      "tier",
      "encounterSeed",
      "rewards",
      "placements",
      "traversal",
    ]);
    const role =
      i === 0
        ? "start"
        : i === r.rooms - 1
          ? "boss"
          : r.branches && i === r.rooms - 2
            ? "branch"
            : i > 1 && i % 2 === 0
              ? "rest"
              : "arena";
    arenaCheck(
      room.id === `room-${i}` &&
        room.theme === r.theme &&
        room.role === role &&
        room.revision === 1 &&
        typeof room.locked === "boolean" &&
        typeof room.edited === "boolean" &&
        (!room.edited || room.locked) &&
        int(room.originSeed, 0, 0xffffffff) &&
        (room.locked || room.originSeed === r.seed) &&
        room.encounterSeed ===
          deriveRandomSeed(room.originSeed, `arena.encounter.${i}`),
      "room identity/role mismatch",
    );
    arenaCheck(
      room.tier ===
        (role === "start" || role === "rest"
          ? 0
          : role === "boss"
            ? 3
            : role === "branch"
              ? 2
              : 1),
      "encounter pacing mismatch",
    );
    arenaCheck(
      Array.isArray(room.rewards) &&
        room.rewards.length === (room.tier ? 2 : 0) &&
        new Set(room.rewards).size === room.rewards.length &&
        room.rewards.every((reward) =>
          ["power", "focus", "vitality"].includes(reward),
        ),
      "invalid reward choice",
    );
    arenaCheck(
      typeof room.templateId === "string" &&
        new RegExp(`^${r.theme}-[0-7]$`).test(room.templateId),
      "unknown authored template",
    );
    const baseline = template(r.theme, Number(room.templateId.slice(-1)));
    arenaCheck(
      Array.isArray(room.placements) &&
        room.placements.length === baseline.length,
      "placement count mismatch",
    );
    for (const [slot, placement] of room.placements.entries()) {
      fields(placement, ["id", "kind", "rect"]);
      fields(placement.rect, ["x", "y", "width", "height"]);
      const original = baseline[slot],
        rect = placement.rect;
      arenaCheck(
        placement.id === original.id &&
          placement.kind === original.kind &&
          rect.width === original.rect.width &&
          rect.height === original.rect.height &&
          int(rect.x, 0, 4096 - rect.width) &&
          int(rect.y, 0, 3072 - rect.height),
        "invalid authored placement edit",
      );
      arenaCheck(
        !room.placements
          .slice(slot + 1)
          .some(
            ({ rect: b }) =>
              rect.x < b.x + b.width &&
              rect.x + rect.width > b.x &&
              rect.y < b.y + b.height &&
              rect.y + rect.height > b.y,
          ),
        "overlapping static placements",
      );
    }
    if (!room.edited) {
      arenaCheck(
        canonical(room.placements) === canonical(baseline),
        "placement/template mismatch",
      );
      arenaCheck(
        canonical(room.traversal) ===
          canonical([
            { x: 320, y: 1600 },
            { x: 3904, y: 1600 },
          ]),
        "unedited traversal/template mismatch",
      );
    }
    const replay = new DeterministicRandom(
      ["templates", "rewards"].map((name) => ({
        name: `arena.${name}`,
        owner: "arena",
        seed: deriveRandomSeed(room.originSeed, `arena.${name}`),
      })),
    );
    let variant = 0,
      selected: ArenaReward[] = [];
    for (let node = 0; node <= i; node++) {
      variant = replay.drawInteger("arena", "arena.templates", 8);
      const choices: ArenaReward[] = ["power", "focus", "vitality"];
      const first = choices.splice(
        replay.drawInteger("arena", "arena.rewards", 3),
        1,
      )[0];
      selected = [
        first,
        choices[replay.drawInteger("arena", "arena.rewards", 2)],
      ];
    }
    arenaCheck(
      room.templateId === `${r.theme}-${variant}` &&
        canonical(room.rewards) === canonical(room.tier ? selected : []),
      "selection/provenance mismatch",
    );
    const actors = [
      { x: 256, y: 1536 },
      ...(room.tier
        ? [
            { x: 3072, y: 1536 },
            ...(room.tier >= 2
              ? [{ x: 3584, y: room.encounterSeed % 2 ? 1024 : 1792 }]
              : []),
          ]
        : []),
    ];
    for (const [n, a] of actors.entries()) {
      arenaCheck(
        !room.placements.some(
          ({ rect: b }) =>
            a.x < b.x + b.width &&
            a.x + 128 > b.x &&
            a.y < b.y + b.height &&
            a.y + 128 > b.y,
        ),
        "embedded encounter spawn",
      );
      arenaCheck(
        !actors
          .slice(n + 1)
          .some(
            (b) =>
              a.x < b.x + 128 &&
              a.x + 128 > b.x &&
              a.y < b.y + 128 &&
              a.y + 128 > b.y,
          ),
        "overlapping encounter spawns",
      );
    }
    traversal(room);
  }
  arenaCheck(
    m.work ===
      m.rooms.reduce(
        (total, room) =>
          total + 16 + room.placements.length * room.traversal.length,
        0,
      ),
    "work witness mismatch",
  );
  const { digest: actual, ...content } = m;
  arenaCheck(actual === digest(content), "manifest digest mismatch");
  return structuredClone(m);
}
/** Locks preserve exact realized room selections, placements, encounters/rewards.
 * Every slot still consumes its draws; locked data belongs to prior provenance. */
export function regenerateArenaManifest(
  prior: GeneratedArenaManifest,
  recipe: GeneratedArenaRecipe,
  lockedRoomIds?: readonly string[],
): GeneratedArenaManifest {
  const old = validateArenaManifest(prior),
    next = validateArenaRecipe(recipe);
  const locks =
    lockedRoomIds ??
    old.rooms
      .filter((room) => room.locked || room.edited)
      .map((room) => room.id);
  canonicalArenaData(locks);
  arenaCheck(
    locks.length <= 8 &&
      new Set(locks).size === locks.length &&
      locks.every((id) => old.rooms.some((room) => room.id === id)),
    "invalid locks",
  );
  arenaCheck(
    !locks.length ||
      (old.recipe.rooms === next.rooms &&
        old.recipe.branches === next.branches &&
        old.recipe.theme === next.theme),
    "locked graph boundary mismatch",
  );
  return generate(next, old, locks);
}
/** Exact selected content, ordinary editable JSON; never calls generation again.
 * Source identity and realized manifest travel together, including locked choices. */
export interface FrozenArenaProject {
  format: "editable-arena-project-v1";
  manifest: GeneratedArenaManifest;
}
export function validateFrozenArenaProject(value: unknown): FrozenArenaProject {
  canonicalArenaData(value);
  arenaCheck(
    value && typeof value === "object" && !Array.isArray(value),
    "frozen project shape",
  );
  const project = value as FrozenArenaProject;
  fields(project, ["format", "manifest"]);
  arenaCheck(
    project.format === "editable-arena-project-v1",
    "unsupported frozen project version",
  );
  return {
    format: project.format,
    manifest: validateArenaManifest(project.manifest),
  };
}
/** Central reopen boundary for both bare manifests and the complete editable
 * wrapper. Callers must pass the wrapper itself so its fields are validated. */
export function validateArenaContent(value: unknown): GeneratedArenaManifest {
  canonicalArenaData(value);
  arenaCheck(
    value && typeof value === "object" && !Array.isArray(value),
    "arena content shape",
  );
  return (value as { format?: string }).format === "editable-arena-project-v1"
    ? validateFrozenArenaProject(value).manifest
    : validateArenaManifest(value);
}
export function freezeArenaManifest(
  value: GeneratedArenaManifest,
): FrozenArenaProject {
  return validateFrozenArenaProject({
    format: "editable-arena-project-v1",
    manifest: value,
  });
}

/** Bounded authored edit: move existing cover/barrels while retaining their
 * IDs, kinds and dimensions. Pins retain the original template provenance;
 * edited content is explicitly locked and fails fresh-recipe reproduction. */
export function editArenaRoom(
  value: GeneratedArenaManifest,
  roomId: string,
  placements: readonly ArenaPlacement[],
): GeneratedArenaManifest {
  const manifest = validateArenaManifest(value);
  canonicalArenaData(placements);
  const room = manifest.rooms.find((room) => room.id === roomId);
  arenaCheck(room, "unknown edited room");
  room.placements = structuredClone([...placements]);
  room.edited = true;
  room.locked = true;
  const { digest: _digest, ...content } = manifest;
  return validateArenaManifest(withDigest(content));
}
