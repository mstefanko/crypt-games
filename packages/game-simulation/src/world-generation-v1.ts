/** G0 authored top-down rooms. No geometry synthesis or platform traversal claim. */
import { boundedJSON, canonical } from "@onepage/game-project/runtime";
import { DeterministicRandom } from "./rng";
import {
  validateAdventureDefinitions,
  type AdventureDefinitions,
  type AdventureMap,
} from "./m3/adventure";
export const WORLD_GENERATOR = "authored-adventure-rooms-v1";
export const WORLD_LIMITS = Object.freeze({
  rooms: 8,
  templates: 32,
  attempts: 8,
  work: 2048,
  cells: 256,
});
export interface WorldSocket {
  id: string;
  direction: "west" | "east";
  cell: number;
  clearance: number;
}
export interface WorldRoom {
  id: string;
  revision: number;
  roles: string[];
  weight: number;
  sockets: WorldSocket[];
  map: AdventureMap;
}
export interface WorldLibrary {
  format: "world-library-v1";
  rooms: WorldRoom[];
}
export interface WorldRecipe {
  format: "world-recipe-v1";
  generator: typeof WORLD_GENERATOR;
  seed: number;
  gameId: string;
  roles: string[];
  attempts: number;
  work: number;
  clearance: number;
}
export interface WorldPlacement {
  id: string;
  templateId: string;
  revision: number;
  locked: boolean;
}
export interface WorldRealization {
  format: "world-realized-v1";
  placements: WorldPlacement[];
  definition: AdventureDefinitions;
  attempt: number;
  work: number;
  random: ReturnType<DeterministicRandom["capture"]>;
}
const check = (ok: unknown, message: string): void => {
  if (!ok) throw Error(`world: ${message}`);
};
const fields = (value: unknown, names: string[]) => {
  check(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join() === names.sort().join(),
    "invalid contract fields",
  );
};
const int = (n: number, min: number, max: number) =>
  Number.isInteger(n) && !Object.is(n, -0) && n >= min && n <= max;
const id = (s: string) =>
  typeof s === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(s);
function reachable(map: AdventureMap, start: number, target: number): boolean {
  const visited = new Set([start]),
    queue = [start],
    walls = new Set(map.walls);
  for (let index = 0; index < queue.length; index++) {
    const cell = queue[index];
    if (cell === target) return true;
    for (const next of [
      cell - map.width,
      cell + map.width,
      ...(cell % map.width ? [cell - 1] : []),
      ...(cell % map.width < map.width - 1 ? [cell + 1] : []),
    ])
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
  return false;
}
export function validateWorldInputs(
  recipe: WorldRecipe,
  library: WorldLibrary,
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
  ]);
  fields(library, ["format", "rooms"]);
  check(
    recipe.format === "world-recipe-v1" && recipe.generator === WORLD_GENERATOR,
    "unsupported recipe/generator",
  );
  check(
    int(recipe.seed, 0, 0xffffffff) && id(recipe.gameId),
    "invalid seed/game ID",
  );
  check(
    Array.isArray(recipe.roles) &&
      recipe.roles.length >= 2 &&
      recipe.roles.length <= WORLD_LIMITS.rooms &&
      recipe.roles.every(id),
    "invalid graph roles",
  );
  check(
    int(recipe.attempts, 1, WORLD_LIMITS.attempts) &&
      int(recipe.work, 1, WORLD_LIMITS.work) &&
      int(recipe.clearance, 1, 4),
    "invalid bounds",
  );
  check(
    library.format === "world-library-v1" &&
      Array.isArray(library.rooms) &&
      library.rooms.length > 0 &&
      library.rooms.length <= WORLD_LIMITS.templates,
    "invalid library",
  );
  const seen = new Set();
  for (const room of library.rooms) {
    fields(room, ["id", "revision", "roles", "weight", "sockets", "map"]);
    check(
      id(room.id) &&
        !seen.has(room.id) &&
        int(room.revision, 1, 65535) &&
        int(room.weight, 1, 100),
      "invalid template identity/weight",
    );
    seen.add(room.id);
    check(
      Array.isArray(room.roles) &&
        room.roles.length <= 8 &&
        room.roles.every(id) &&
        new Set(room.roles).size === room.roles.length,
      "invalid template roles",
    );
    const map = room.map;
    check(
      int(map.width, 3, 16) &&
        int(map.height, 3, 16) &&
        map.width * map.height <= WORLD_LIMITS.cells,
      "room cell bound",
    );
    check(
      Array.isArray(room.sockets) && room.sockets.length === 2,
      "requires west/east sockets",
    );
    for (const socket of room.sockets)
      fields(socket, ["id", "direction", "cell", "clearance"]);
    for (const direction of ["west", "east"]) {
      const socket = room.sockets.find((s) => s.direction === direction);
      check(
        socket &&
          id(socket.id) &&
          int(socket.clearance, 1, 4) &&
          int(socket.cell, 0, map.width * map.height - 1) &&
          !map.walls.includes(socket.cell),
        "invalid socket clearance/cell",
      );
      if (socket)
        for (let offset = 0; offset < socket.clearance; offset++)
          check(
            (socket.cell % map.width) + offset < map.width &&
              !map.walls.includes(socket.cell + offset),
            "blocked socket clearance",
          );
    }
    check(
      room.sockets[0].id !== room.sockets[1].id &&
        reachable(map, room.sockets[0].cell, room.sockets[1].cell),
      "disconnected sockets",
    );
    check(
      map.pickups.length === 0 &&
        map.dialogues.length === 0 &&
        map.exits.length === 0,
      "G0 room content supports unpopulated authored geometry only",
    );
    validateAdventureDefinitions({
      gameId: "room-check",
      characterId: "traveler",
      compatibilityVersion: 1,
      initial: { mapId: map.id, entranceId: map.entrances[0]?.id },
      maps: [map],
      items: [],
      quests: [],
      flags: {},
      stats: {},
    });
  }
}
/** A finite linear role graph; bidirectional links use certified authored sockets. */
export function generateWorld(
  recipe: WorldRecipe,
  library: WorldLibrary,
  previous?: WorldRealization,
): WorldRealization {
  validateWorldInputs(recipe, library);
  if (previous) {
    boundedJSON(JSON.stringify(previous), 262144);
    fields(previous, [
      "format",
      "placements",
      "definition",
      "attempt",
      "work",
      "random",
    ]);
    check(
      int(previous.attempt, 1, recipe.attempts) &&
        int(previous.work, 1, WORLD_LIMITS.work),
      "invalid retained counters",
    );
    const retainedRandom = new DeterministicRandom([
      { name: "world.rooms", owner: "world", seed: recipe.seed },
      {
        name: "world.dressing",
        owner: "world",
        seed: (recipe.seed + 2779096485) % 4294967296,
      },
    ]);
    // Previous seeds can differ during explicit regeneration; proposal tooling validates the original snapshot.
    check(
      previous.random.algorithm === retainedRandom.capture().algorithm,
      "invalid retained RNG algorithm",
    );
    const priorSeed = previous.random.streams.find(
      (stream) => stream.name === "world.rooms",
    )?.seed;
    check(priorSeed !== undefined, "missing retained room stream");
    validateWorldRandom({ ...recipe, seed: priorSeed! }, previous.random);
    validateAdventureDefinitions(previous.definition);
    check(
      previous.format === "world-realized-v1" &&
        previous.placements.length === recipe.roles.length,
      "incompatible retained graph",
    );
    for (const placement of previous.placements) {
      fields(placement, ["id", "templateId", "revision", "locked"]);
      check(
        typeof placement.locked === "boolean" &&
          id(placement.templateId) &&
          int(placement.revision, 1, 65535),
        "invalid retained placement",
      );
    }
    check(
      previous.definition.gameId === recipe.gameId,
      "retained game identity mismatch",
    );
    check(
      previous.definition.maps.length === previous.placements.length &&
        previous.placements.every(
          (p, i) =>
            p.id === `room-${i}` && previous.definition.maps[i].id === p.id,
        ),
      "invalid retained placements",
    );
  }
  const random = new DeterministicRandom([
    { name: "world.rooms", owner: "world", seed: recipe.seed },
    {
      name: "world.dressing",
      owner: "world",
      seed: (recipe.seed + 2779096485) % 4294967296,
    },
  ]);
  let work = 0;
  {
    const attempt = 1;
    const placements: WorldPlacement[] = [],
      maps: AdventureMap[] = [];
    for (let index = 0; index < recipe.roles.length; index++) {
      const placementId = `room-${index}`,
        retained = previous?.placements[index];
      const eligible = library.rooms
        .filter((room) => {
          check(
            ++work <= recipe.work,
            `work exhausted at seed ${recipe.seed}, node ${index}`,
          );
          return (
            room.roles.includes(recipe.roles[index]) &&
            room.sockets.every((s) => s.clearance >= recipe.clearance)
          );
        })
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      check(
        eligible.length,
        `no eligible authored room for role ${recipe.roles[index]} at node ${index}, clearance ${recipe.clearance}`,
      );
      // Every node consumes its weighted draw, even when locked. Editing or
      // retaining a room cannot change the verifiable RNG/counter witness.
      let roll = random.drawInteger(
        "world",
        "world.rooms",
        eligible.reduce((n, r) => n + r.weight, 0),
      );
      let room: WorldRoom;
      if (retained?.locked) {
        const match = eligible.find(
          (r) =>
            r.id === retained.templateId && r.revision === retained.revision,
        );
        check(match, `locked placement ${placementId} no longer compatible`);
        room = match!;
      } else {
        room = eligible[0];
        for (const candidate of eligible) {
          if (roll < candidate.weight) {
            room = candidate;
            break;
          }
          roll -= candidate.weight;
        }
      }
      if (retained && !retained.locked) {
        const original = library.rooms.find(
          (r) =>
            r.id === retained.templateId && r.revision === retained.revision,
        );
        check(original, "unknown retained template");
        const priorMap = previous!.definition.maps[index];
        const expected = {
          ...structuredClone(original!.map),
          id: placementId,
          entrances: [
            {
              id: "west",
              cell: original!.sockets.find((s) => s.direction === "west")!.cell,
            },
            {
              id: "east",
              cell: original!.sockets.find((s) => s.direction === "east")!.cell,
            },
          ],
          exits: priorMap.exits,
        };
        check(
          canonical(expected) === canonical(priorMap),
          "unlocked manual edit requires explicit lock",
        );
      }
      const west = room.sockets.find((s) => s.direction === "west")!,
        east = room.sockets.find((s) => s.direction === "east")!;
      const map: AdventureMap = retained?.locked
        ? structuredClone(previous!.definition.maps[index])
        : {
            ...structuredClone(room.map),
            id: placementId,
            entrances: [
              { id: "west", cell: west.cell },
              { id: "east", cell: east.cell },
            ],
            exits: [],
          };
      if (!retained?.locked)
        map.exits = [
          ...(index
            ? [
                {
                  id: "west",
                  cell: west.cell,
                  mapId: `room-${index - 1}`,
                  entranceId: "east",
                },
              ]
            : []),
          ...(index < recipe.roles.length - 1
            ? [
                {
                  id: "east",
                  cell: east.cell,
                  mapId: `room-${index + 1}`,
                  entranceId: "west",
                },
              ]
            : []),
        ];
      check(
        map.entrances.length === 2 &&
          map.entrances[0].id === "west" &&
          map.entrances[1].id === "east" &&
          map.entrances[0].cell === west.cell &&
          map.entrances[1].cell === east.cell &&
          map.width === room.map.width &&
          map.height === room.map.height &&
          room.sockets.every((s) =>
            Array.from({ length: s.clearance }, (_, i) => s.cell + i).every(
              (cell) => !map.walls.includes(cell),
            ),
          ),
        `retained socket mismatch: ${placementId}`,
      );
      check(
        map.pickups.length === 0 && map.dialogues.length === 0,
        `G0 room content supports unpopulated authored geometry only: ${placementId}`,
      );
      const expectedExits = [
        ...(index
          ? [
              {
                id: "west",
                cell: west.cell,
                mapId: `room-${index - 1}`,
                entranceId: "east",
              },
            ]
          : []),
        ...(index < recipe.roles.length - 1
          ? [
              {
                id: "east",
                cell: east.cell,
                mapId: `room-${index + 1}`,
                entranceId: "west",
              },
            ]
          : []),
      ];
      check(
        JSON.stringify(map.exits) === JSON.stringify(expectedExits),
        `retained graph mismatch: ${placementId}`,
      );
      check(
        map.entrances.length === 2 &&
          reachable(map, map.entrances[0].cell, map.entrances[1].cell),
        `locked route blocked: ${placementId}`,
      );
      placements.push({
        id: placementId,
        templateId: room.id,
        revision: room.revision,
        locked: retained?.locked ?? false,
      });
      maps.push(map);
    }
    const definition: AdventureDefinitions = {
      gameId: recipe.gameId,
      characterId: "traveler",
      compatibilityVersion: 1,
      initial: { mapId: "room-0", entranceId: "west" },
      maps,
      items: [],
      quests: [],
      flags: {},
      stats: {},
    };
    validateAdventureDefinitions(definition);
    return {
      format: "world-realized-v1",
      placements,
      definition,
      attempt,
      work,
      random: random.capture(),
    };
  }
}

/** Validate retained RNG without executing generation or reconstructing geometry. */
export function validateWorldRandom(
  recipe: WorldRecipe,
  snapshot: unknown,
): void {
  const random = new DeterministicRandom([
    { name: "world.rooms", owner: "world", seed: recipe.seed },
    {
      name: "world.dressing",
      owner: "world",
      seed: (recipe.seed + 2779096485) % 4294967296,
    },
  ]);
  random.restore(snapshot);
}
