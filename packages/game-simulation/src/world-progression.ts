/** Finite monotonic adventure progression and authored-anchor reward population. */
import { boundedJSON, canonical } from "@onepage/game-project/runtime";
import { DeterministicRandom, deriveRandomSeed } from "./rng";
import {
  validateAdventureDefinitions,
  type AdventureDefinitions,
  type AdventureMap,
} from "./m3/adventure";
import {
  generateWorld as generateGeometry,
  validateWorldInputs as validateGeometry,
  WORLD_GENERATOR,
  type WorldRecipe,
  type WorldRoom,
  type WorldPlacement,
} from "./world-generation-v1";
export const WORLD_PROGRESSION_GENERATOR = "authored-adventure-progression-v2";
export const WORLD_PROGRESSION_LIMITS = Object.freeze({
  capabilities: 8,
  anchorsPerRoom: 8,
  rewards: 16,
  rewardsPerRoom: 3,
  totalRewards: 24,
  progressionStates: 2048,
});
export interface WorldProgressionRecipe
  extends Omit<WorldRecipe, "format" | "generator"> {
  format: "world-recipe-v2";
  generator: typeof WORLD_PROGRESSION_GENERATOR;
  capabilities: string[];
  grants: { node: number; capability: string; anchorId: string }[];
  /** Gates protect the east exit of this node; west exits remain available. */
  gates: { node: number; requires: string[] }[];
  population: { perRoom: number; maxTotal: number };
}
export interface WorldPopulatedRoom extends WorldRoom {
  anchors: { id: string; cell: number }[];
}
export interface WorldPopulationLibrary {
  format: "world-library-v2";
  rooms: WorldPopulatedRoom[];
  /** Each reward becomes one stackable production AdventureItem. */
  rewards: { id: string; weight: number; quantity: number }[];
}
export interface WorldProgressionRealization {
  format: "world-realized-v2";
  placements: WorldPlacement[];
  definition: AdventureDefinitions;
  attempt: number;
  work: number;
  random: ReturnType<DeterministicRandom["capture"]>;
  population: {
    id: string;
    roomId: string;
    anchorId: string;
    rewardId: string;
  }[];
  progression: {
    states: number;
    reachableRooms: string[];
    capabilities: string[];
  };
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(`world: ${message}`);
}
function fields(value: unknown, names: string[]) {
  check(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join() === names.sort().join(),
    "invalid progression contract fields",
  );
}
const int = (value: number, min: number, max: number) =>
  Number.isInteger(value) &&
  !Object.is(value, -0) &&
  value >= min &&
  value <= max;
const id = (value: string) =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(value);
function uniqueIds(values: string[], max: number) {
  return (
    Array.isArray(values) &&
    values.length <= max &&
    values.every(id) &&
    new Set(values).size === values.length
  );
}
function geometryRecipe(recipe: WorldProgressionRecipe): WorldRecipe {
  return {
    format: "world-recipe-v1",
    generator: WORLD_GENERATOR,
    seed: recipe.seed,
    gameId: recipe.gameId,
    roles: recipe.roles,
    attempts: recipe.attempts,
    work: recipe.work,
    clearance: recipe.clearance,
  };
}
function geometryLibrary(library: WorldPopulationLibrary) {
  return {
    format: "world-library-v1" as const,
    rooms: library.rooms.map(({ anchors: _anchors, ...room }) => room),
  };
}
function randomFor(recipe: WorldProgressionRecipe) {
  return new DeterministicRandom([
    {
      name: "world.population",
      owner: "world",
      seed: deriveRandomSeed(recipe.seed, "world.population"),
    },
    {
      name: "world.rewards",
      owner: "world",
      seed: deriveRandomSeed(recipe.seed, "world.rewards"),
    },
  ]);
}
function connected(map: AdventureMap, start: number, target: number) {
  const visited = new Set([start]),
    queue = [start],
    walls = new Set(map.walls);
  for (let i = 0; i < queue.length; i++) {
    const cell = queue[i];
    if (cell === target) return true;
    for (const next of [
      cell - map.width,
      cell + map.width,
      ...(cell % map.width ? [cell - 1] : []),
      ...(cell % map.width < map.width - 1 ? [cell + 1] : []),
    ]) {
      if (
        next >= 0 &&
        next < map.width * map.height &&
        !walls.has(next) &&
        !visited.has(next)
      ) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
export function validateProgressionInputs(
  recipe: WorldProgressionRecipe,
  library: WorldPopulationLibrary,
): void {
  boundedJSON(JSON.stringify({ recipe, library }), 262144);
  fields(recipe, [
    "format",
    "generator",
    "seed",
    "gameId",
    "roles",
    "attempts",
    "work",
    "clearance",
    "capabilities",
    "grants",
    "gates",
    "population",
  ]);
  fields(library, ["format", "rooms", "rewards"]);
  check(
    recipe.format === "world-recipe-v2" &&
      recipe.generator === WORLD_PROGRESSION_GENERATOR &&
      library.format === "world-library-v2",
    "unsupported progression recipe/library/generator",
  );
  check(Array.isArray(library.rooms), "invalid progression rooms");
  for (const room of library.rooms)
    fields(room, [
      "id",
      "revision",
      "roles",
      "weight",
      "sockets",
      "map",
      "anchors",
    ]);
  validateGeometry(geometryRecipe(recipe), geometryLibrary(library));
  check(uniqueIds(recipe.capabilities, 8), "invalid capabilities");
  check(
    Array.isArray(recipe.grants) &&
      recipe.grants.length === recipe.capabilities.length,
    "each capability requires one grant",
  );
  const granted = new Set<string>();
  for (const grant of recipe.grants) {
    fields(grant, ["node", "capability", "anchorId"]);
    check(
      int(grant.node, 0, recipe.roles.length - 1) &&
        recipe.capabilities.includes(grant.capability) &&
        !granted.has(grant.capability) &&
        id(grant.anchorId),
      "invalid/duplicate capability grant",
    );
    granted.add(grant.capability);
  }
  check(
    Array.isArray(recipe.gates) && recipe.gates.length < recipe.roles.length,
    "invalid gate count",
  );
  const gates = new Set<number>();
  for (const gate of recipe.gates) {
    fields(gate, ["node", "requires"]);
    check(
      int(gate.node, 0, recipe.roles.length - 2) &&
        !gates.has(gate.node) &&
        uniqueIds(gate.requires, 8) &&
        gate.requires.length > 0 &&
        gate.requires.every((capability) => granted.has(capability)),
      "invalid gate requirements",
    );
    gates.add(gate.node);
  }
  fields(recipe.population, ["perRoom", "maxTotal"]);
  check(
    int(recipe.population.perRoom, 0, 3) &&
      int(recipe.population.maxTotal, 0, 24) &&
      recipe.population.perRoom * recipe.roles.length <=
        recipe.population.maxTotal,
    "population budget exceeded",
  );
  check(
    Array.isArray(library.rewards) &&
      library.rewards.length <= 16 &&
      (recipe.population.perRoom === 0 || library.rewards.length > 0),
    "invalid reward pool",
  );
  const rewards = new Set<string>();
  for (const reward of library.rewards) {
    fields(reward, ["id", "weight", "quantity"]);
    check(
      id(reward.id) &&
        !rewards.has(reward.id) &&
        int(reward.weight, 1, 100) &&
        int(reward.quantity, 1, 9),
      "invalid reward",
    );
    rewards.add(reward.id);
  }
  for (const room of library.rooms) {
    check(
      Array.isArray(room.anchors) && room.anchors.length <= 8,
      "anchor bound",
    );
    const ids = new Set<string>(),
      cells = new Set<number>();
    for (const anchor of room.anchors) {
      fields(anchor, ["id", "cell"]);
      check(
        id(anchor.id) &&
          !ids.has(anchor.id) &&
          int(anchor.cell, 0, room.map.width * room.map.height - 1) &&
          !cells.has(anchor.cell) &&
          !room.map.walls.includes(anchor.cell) &&
          !room.sockets.some(
            (socket) =>
              anchor.cell >= socket.cell &&
              anchor.cell < socket.cell + socket.clearance,
          ),
        "invalid/overlapping anchor",
      );
      check(
        connected(room.map, room.sockets[0].cell, anchor.cell),
        `unreachable anchor ${room.id}/${anchor.id}`,
      );
      ids.add(anchor.id);
      cells.add(anchor.cell);
    }
  }
}
/** Enumerate (room, capability-mask) states. Certified intra-room paths connect all grants and sockets. */
function proveProgression(
  recipe: WorldProgressionRecipe,
  maps: AdventureMap[],
) {
  const capabilities = [...recipe.capabilities].sort();
  // At most eight capabilities; arithmetic keeps this outside the RNG-only bitwise seam.
  const has = (mask: number, name: string) =>
    Math.floor(mask / 2 ** capabilities.indexOf(name)) % 2 === 1;
  const merge = (mask: number, names: readonly string[]) =>
    names.reduce(
      (value, name) =>
        has(value, name) ? value : value + 2 ** capabilities.indexOf(name),
      mask,
    );
  const queue: { node: number; mask: number }[] = [{ node: 0, mask: 0 }],
    seen = new Set<string>(),
    rooms = new Set<number>();
  let all = 0;
  for (let i = 0; i < queue.length; i++) {
    const state = queue[i],
      map = maps[state.node];
    const mask = merge(
        state.mask,
        map.pickups.flatMap((pickup) =>
          Object.keys(pickup.effects.flags ?? {}),
        ),
      ),
      key = `${state.node}/${mask}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rooms.add(state.node);
    all = merge(
      all,
      capabilities.filter((name) => has(mask, name)),
    );
    check(seen.size <= 2048, "progression state budget exhausted");
    for (const exit of map.exits) {
      if ((exit.requiresFlags ?? []).every((name) => has(mask, name))) {
        const node = maps.findIndex((candidate) => candidate.id === exit.mapId);
        const next = `${node}/${mask}`;
        if (!seen.has(next)) queue.push({ node, mask });
      }
    }
  }
  if (rooms.size !== maps.length) {
    const gate = recipe.gates.find(
      (candidate) =>
        rooms.has(candidate.node) && !rooms.has(candidate.node + 1),
    );
    const missing =
      gate?.requires.filter((name) => !has(all, name)).join(",") ?? "unknown";
    throw Error(
      `world: impossible gate at room-${gate?.node ?? 0}: missing capabilities ${missing}`,
    );
  }
  check(
    all === 2 ** capabilities.length - 1,
    "unreachable required capability",
  );
  return {
    states: seen.size,
    reachableRooms: [...rooms]
      .sort((a, b) => a - b)
      .map((node) => `room-${node}`),
    capabilities,
  };
}
export function generateProgressionWorld(
  recipe: WorldProgressionRecipe,
  library: WorldPopulationLibrary,
  previous?: WorldProgressionRealization,
  previousRecipe: WorldProgressionRecipe = recipe,
): WorldProgressionRealization {
  // Retained content belongs to the complete original recipe, not a new recipe
  // with only its seed replaced. The caller must retain that recipe with output.
  validateProgressionInputs(recipe, library);
  if (previous) {
    validateProgressionInputs(previousRecipe, library);
    boundedJSON(JSON.stringify(previous), 262144);
    fields(previous, [
      "format",
      "placements",
      "definition",
      "attempt",
      "work",
      "random",
      "population",
      "progression",
    ]);
    check(
      previous.format === "world-realized-v2" &&
        Array.isArray(previous.population) &&
        previous.population.length <= 24,
      "incompatible retained population",
    );
    check(
      previous.random.streams.find((stream) => stream.name === "world.rooms")
        ?.seed === previousRecipe.seed,
      "retained recipe seed mismatch; pass the complete original recipe",
    );
    validateProgressionRandom(previousRecipe, previous.random);
    validateAdventureDefinitions(previous.definition);
    const rebuilt = generate(previousRecipe, library, previous);
    check(
      canonical(rebuilt) === canonical(previous),
      "retained realization divergence under original recipe",
    );
  }
  return generate(recipe, library, previous);
}
function generate(
  recipe: WorldProgressionRecipe,
  library: WorldPopulationLibrary,
  previous: WorldProgressionRealization | undefined,
): WorldProgressionRealization {
  // The existing geometry validator still certifies retained dimensions, sockets and paths.
  const retainedGeometry = previous
    ? {
        format: "world-realized-v1" as const,
        placements: previous.placements,
        definition: {
          ...previous.definition,
          maps: previous.definition.maps.map((map) => ({
            ...map,
            pickups: [],
            exits: map.exits.map(({ requiresFlags: _flags, ...exit }) => exit),
          })),
          items: [],
          flags: {},
        },
        attempt: previous.attempt,
        work: previous.work,
        random: {
          ...previous.random,
          streams: previous.random.streams.filter(
            (stream) =>
              stream.name === "world.rooms" || stream.name === "world.dressing",
          ),
        },
      }
    : undefined;
  const geometry = generateGeometry(
    geometryRecipe(recipe),
    geometryLibrary(library),
    retainedGeometry,
  );
  const random = randomFor(recipe),
    population: WorldProgressionRealization["population"] = [],
    maps: AdventureMap[] = [];
  const rewards = [...library.rewards].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const [node, placement] of geometry.placements.entries()) {
    const room = library.rooms.find(
      (candidate) => candidate.id === placement.templateId,
    )!;
    const map = structuredClone(geometry.definition.maps[node]);
    const grants = recipe.grants.filter((grant) => grant.node === node);
    check(
      new Set(grants.map((grant) => grant.anchorId)).size === grants.length,
      `overlapping required grants at ${placement.id}`,
    );
    const pickups: AdventureMap["pickups"][number][] = grants.map((grant) => {
      const anchor = room.anchors.find(
        (candidate) => candidate.id === grant.anchorId,
      );
      check(anchor, `missing grant anchor ${placement.id}/${grant.anchorId}`);
      return {
        id: `cap-${grant.capability}`,
        cell: anchor.cell,
        effects: { flags: { [grant.capability]: true } },
      };
    });
    const available = room.anchors
      .filter((anchor) => !grants.some((grant) => grant.anchorId === anchor.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    check(
      available.length >= recipe.population.perRoom,
      `insufficient reward anchors at ${placement.id}`,
    );
    for (let slot = 0; slot < recipe.population.perRoom; slot++) {
      const rollAnchor = random.drawInteger(
        "world",
        "world.population",
        available.length,
      );
      let rollReward = random.drawInteger(
        "world",
        "world.rewards",
        rewards.reduce((sum, reward) => sum + reward.weight, 0),
      );
      let reward = rewards[0];
      for (const candidate of rewards) {
        if (rollReward < candidate.weight) {
          reward = candidate;
          break;
        }
        rollReward -= candidate.weight;
      }
      let anchor = available[rollAnchor];
      const pickupId = `reward-${slot}`;
      if (placement.locked) {
        const saved = previous!.population.find(
          (entry) => entry.roomId === placement.id && entry.id === pickupId,
        );
        check(saved, `missing retained reward ${placement.id}/${pickupId}`);
        fields(saved, ["id", "roomId", "anchorId", "rewardId"]);
        const retainedAnchor = available.find(
            (candidate) => candidate.id === saved.anchorId,
          ),
          retainedReward = rewards.find(
            (candidate) => candidate.id === saved.rewardId,
          );
        check(
          retainedAnchor && retainedReward,
          `incompatible retained reward ${placement.id}/${pickupId}`,
        );
        anchor = retainedAnchor;
        reward = retainedReward;
      }
      available.splice(available.indexOf(anchor), 1);
      pickups.push({
        id: pickupId,
        cell: anchor.cell,
        effects: { grants: [{ itemId: reward.id, quantity: reward.quantity }] },
      });
      population.push({
        id: pickupId,
        roomId: placement.id,
        anchorId: anchor.id,
        rewardId: reward.id,
      });
    }
    map.pickups = pickups;
    const gate = recipe.gates.find((candidate) => candidate.node === node);
    map.exits = map.exits.map((exit) =>
      exit.id === "east" && gate
        ? { ...exit, requiresFlags: [...gate.requires].sort() }
        : exit,
    );
    for (const pickup of map.pickups)
      check(
        connected(map, map.entrances[0].cell, pickup.cell),
        `locked pickup route blocked: ${placement.id}/${pickup.id}`,
      );
    if (previous && placement.locked) {
      const retained = previous.definition.maps[node];
      check(
        canonical(retained.pickups) === canonical(pickups) &&
          canonical(retained.exits) === canonical(map.exits),
        `retained population/gate mismatch: ${placement.id}`,
      );
    }
    maps.push(map);
  }
  const definition: AdventureDefinitions = {
    ...geometry.definition,
    maps,
    items: rewards.map((reward) => ({
      id: reward.id,
      stackable: true,
      maxStack: 999,
    })),
    flags: Object.fromEntries(
      [...recipe.capabilities].sort().map((capability) => [capability, false]),
    ),
  };
  validateAdventureDefinitions(definition);
  const progression = proveProgression(recipe, maps);
  return {
    format: "world-realized-v2",
    placements: geometry.placements,
    definition,
    attempt: geometry.attempt,
    work: geometry.work,
    random: {
      algorithm: geometry.random.algorithm,
      streams: [...geometry.random.streams, ...random.capture().streams].sort(
        (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      ),
    },
    population,
    progression,
  };
}
export function validateProgressionRandom(
  recipe: WorldProgressionRecipe,
  snapshot: unknown,
): void {
  const geometry = new DeterministicRandom([
    { name: "world.rooms", owner: "world", seed: recipe.seed },
    {
      name: "world.dressing",
      owner: "world",
      seed: (recipe.seed + 2779096485) % 4294967296,
    },
  ]);
  const extra = randomFor(recipe).capture();
  const random = new DeterministicRandom(
    [...geometry.capture().streams, ...extra.streams].map(
      ({ name, owner, seed }) => ({ name, owner, seed }),
    ),
  );
  random.restore(snapshot);
}
