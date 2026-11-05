import { describe, expect, it } from "vitest";
import {
  DeterministicRandom,
  RANDOM_ALGORITHM,
  RANDOM_LIMITS,
  deriveRandomSeed,
  RANDOM_SEED_DERIVATION,
} from "./rng";
import type { RandomSnapshot, RandomStreamDefinition } from "./rng";

const definition = { name: "encounter", owner: "test.rules", seed: 0 };
const make = (seed = 0) => new DeterministicRandom([{ ...definition, seed }]);
const draw = (random: DeterministicRandom) =>
  random.drawUint32("test.rules", "encounter");

// Independent arbitrary-precision arithmetic reference: no JS signed bitwise
// coercions or Math.imul. Same published improved SplitMix32 specification.
function reference(seed: number, count: number): number[] {
  const mask = 0xffffffffn;
  let state = BigInt(seed);
  return Array.from({ length: count }, () => {
    state = (state + 0x9e3779b9n) & mask;
    let value = ((state ^ (state >> 16n)) * 0x21f0aaadn) & mask;
    value = ((value ^ (value >> 15n)) * 0x735a2d97n) & mask;
    return Number((value ^ (value >> 15n)) & mask);
  });
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("M8a exact SplitMix32 rules streams", () => {
  it.each([
    [
      0,
      [
        1684164658, 3653269916, 2939563536, 2141751570, 3295091513, 4057132772,
        2256158761, 2742494325,
      ],
    ],
    [
      1,
      [
        1580013426, 350525680, 3524174333, 3011703609, 643872864, 2282937712,
        2300340400, 3453518249,
      ],
    ],
    [
      0xffffffff,
      [
        3950124170, 4293442868, 1302505678, 2762329221, 3361369063, 1522821371,
        2702171692, 1229560074,
      ],
    ],
  ] as const)(
    "matches independently calculated known answers for seed %s",
    (seed, expected) => {
      const random = make(seed);
      expect(
        Array.from({ length: expected.length }, () => draw(random)),
      ).toEqual(expected);
      expect(reference(seed, expected.length)).toEqual(expected);
    },
  );

  it("matches arbitrary-precision reference over wraps and 128 explicit seeds", () => {
    for (let seed = 0; seed < 128; seed++) {
      const actualSeed = seed * 33554431;
      const random = make(actualSeed);
      expect(Array.from({ length: 64 }, () => draw(random))).toEqual(
        reference(actualSeed, 64),
      );
    }
  });

  it("rejects entropy/coercion seeds, malformed definitions, duplicate streams and ceilings", () => {
    for (const seed of [-1, 0x100000000, 0.5, NaN, Infinity, "1", undefined])
      expect(
        () =>
          new DeterministicRandom([{ ...definition, seed: seed as number }]),
      ).toThrow();
    expect(() => new DeterministicRandom([])).toThrow(/cap/);
    expect(() => new DeterministicRandom(new Array(1))).toThrow();
    expect(
      () =>
        new DeterministicRandom(
          Array.from({ length: 17 }, (_, i) => ({
            ...definition,
            name: `stream-${i}`,
          })),
        ),
    ).toThrow(/cap/);
    expect(() => new DeterministicRandom([definition, definition])).toThrow(
      /Duplicate/,
    );
    for (const patch of [
      { name: "" },
      { name: "bad name" },
      { owner: "x".repeat(65) },
      { extra: 1 },
    ])
      expect(
        () => new DeterministicRandom([{ ...definition, ...patch }]),
      ).toThrow();
    expect(
      new DeterministicRandom(
        Array.from({ length: 16 }, (_, i) => ({
          ...definition,
          name: `stream-${i}`,
        })),
      ).capture().streams,
    ).toHaveLength(16);
  });

  it("uses exact [0,maxExclusive) integer ranges and rejection sampling, counting raw retries", () => {
    const random = make(0xffffffff);
    // First two values 3950124170 and 4293442868 reject at this threshold.
    expect(random.drawInteger("test.rules", "encounter", 0x80000001)).toBe(
      1302505678,
    );
    expect(random.capture().streams[0].draws).toBe(3);
    expect(random.drawInteger("test.rules", "encounter", 1)).toBe(0);
    expect(random.capture().streams[0].draws).toBe(4);
    expect(draw(random)).toBe(3361369063);
    for (const bound of [2, 3, 5, 17, 65537, 0xffffffff, 0x100000000]) {
      const sample = make(1);
      const candidates = reference(1, 128);
      const ceiling = Math.floor(0x100000000 / bound) * bound;
      let cursor = 0;
      for (let i = 0; i < 32; i++) {
        while (candidates[cursor] >= ceiling) cursor++;
        expect(sample.drawInteger("test.rules", "encounter", bound)).toBe(
          candidates[cursor++] % bound,
        );
      }
      expect(sample.capture().streams[0].draws).toBe(cursor);
    }
  });

  it("rejects wrong ownership and invalid bounds before any mutation", () => {
    const random = make(),
      before = random.capture();
    for (const bound of [0, -1, 0.1, NaN, Infinity, 0x100000001, "2"])
      expect(() =>
        random.drawInteger("test.rules", "encounter", bound as number),
      ).toThrow();
    expect(() => random.drawUint32("presentation", "encounter")).toThrow(
      /owner/,
    );
    expect(() => random.drawUint32("test.rules", "missing")).toThrow(/owner/);
    expect(random.capture()).toEqual(before);
  });

  it("uses names for ownership rather than seed mixing", () => {
    const random = new DeterministicRandom([
      { name: "encounter", owner: "rules.encounter", seed: 7 },
      { name: "loot", owner: "rules.loot", seed: 7 },
    ]);
    for (let i = 0; i < 16; i++)
      expect(random.drawUint32("rules.encounter", "encounter")).toBe(
        random.drawUint32("rules.loot", "loot"),
      );
  });

  it("keeps every configured stream independent and snapshots detached from definitions", () => {
    const definitions: RandomStreamDefinition[] = [
      definition,
      { ...definition, name: "loot", owner: "test.loot", seed: 1 },
    ];
    const random = new DeterministicRandom(definitions);
    definitions[0] = { ...definition, seed: 123 };
    const before = random.capture();
    for (let i = 0; i < 100; i++) random.drawUint32("test.loot", "loot");
    expect(draw(random)).toBe(1684164658);
    const detached = random.capture() as unknown as {
      streams: { state: number }[];
    };
    detached.streams[0].state = 0;
    expect(random.capture().streams[0].state).not.toBe(0);
    expect(before.streams[0].draws).toBe(0);
    expect(random.capture().streams[1].draws).toBe(100);
  });

  it("restores before and after draws and preserves continuation after rejection retries", () => {
    const random = make(0xffffffff),
      initial = random.capture();
    random.drawInteger("test.rules", "encounter", 0x80000001);
    const after = random.capture(),
      continuation = Array.from({ length: 10 }, () => draw(random));
    random.restore(after);
    expect(Array.from({ length: 10 }, () => draw(random))).toEqual(
      continuation,
    );
    random.restore(initial);
    expect(draw(random)).toBe(3950124170);
  });

  it("rejects incompatible or inconsistent snapshots atomically across the entire stream set", () => {
    const random = new DeterministicRandom([
      definition,
      { ...definition, name: "loot", seed: 1 },
    ]);
    draw(random);
    const before = random.capture();
    const cases: unknown[] = [
      null,
      [],
      { ...before, algorithm: "other" },
      { ...before, extra: 1 },
      { ...before, streams: [] },
      { ...before, streams: [...before.streams].reverse() },
    ];
    for (const patch of [
      { owner: "other" },
      { name: "other" },
      { seed: 3 },
      { state: 0 },
      { state: 0x100000000 },
      { draws: -1 },
      { draws: 0.5 },
      { draws: RANDOM_LIMITS.draws + 1 },
      { extra: 1 },
    ]) {
      const changed = clone(before) as unknown as {
        streams: Record<string, unknown>[];
      };
      Object.assign(changed.streams[1], patch);
      cases.push(changed);
    }
    for (const value of cases) {
      expect(() => random.restore(value)).toThrow();
      expect(random.capture()).toEqual(before);
    }
    expect(before.algorithm).toBe(RANDOM_ALGORITHM);
  });

  it("enforces the draw ceiling and rolls back a rejected candidate when the next retry exceeds it", () => {
    const draws = RANDOM_LIMITS.draws - 1;
    // Select an initial seed so the next raw draw is the first seed=uint32-max
    // known answer, which must reject for bound 2^31+1.
    const seed = Number(
      (0xffffffffn - 0x9e3779b9n * BigInt(draws)) & 0xffffffffn,
    );
    const random = make(seed);
    const snapshot: RandomSnapshot = {
      algorithm: RANDOM_ALGORITHM,
      streams: [{ ...definition, seed, state: 0xffffffff, draws }],
    };
    random.restore(snapshot);
    expect(() =>
      random.drawInteger("test.rules", "encounter", 0x80000001),
    ).toThrow(/draw cap/);
    expect(random.capture()).toEqual(snapshot);
    expect(draw(random)).toBe(3950124170);
    const exhausted = random.capture();
    expect(exhausted.streams[0].draws).toBe(RANDOM_LIMITS.draws);
    expect(() => draw(random)).toThrow(/draw cap/);
    expect(random.capture()).toEqual(exhausted);
  });
});

// Independent BigInt reference for FNV-1a ASCII hashing plus the existing mixer.
function referenceSeed(seed: number, name: string): number {
  const mask = 0xffffffffn;
  let hash = 0x811c9dc5n;
  for (const character of name)
    hash = ((hash ^ BigInt(character.charCodeAt(0))) * 0x01000193n) & mask;
  let value = BigInt(seed) ^ hash;
  value = ((value ^ (value >> 16n)) * 0x21f0aaadn) & mask;
  value = ((value ^ (value >> 15n)) * 0x735a2d97n) & mask;
  return Number((value ^ (value >> 15n)) & mask);
}
describe("named stream seed derivation", () => {
  it("pins ASCII encoding and matches the independent reference without changing RNG draws", () => {
    expect(RANDOM_SEED_DERIVATION).toBe("fnv1a-ascii-splitmix32-v1");
    for (const [seed, population, rewards] of [
      [0, 947415488, 3991904661],
      [42, 2812294395, 2256499898],
      [0xffffffff, 2033952456, 2841831092],
    ]) {
      expect(deriveRandomSeed(seed, "world.population")).toBe(population);
      expect(deriveRandomSeed(seed, "world.rewards")).toBe(rewards);
    }
    for (const seed of [0, 1, 42, 0xffffffff])
      for (const name of [
        "world.population",
        "world.rewards",
        "a",
        "a".repeat(64),
      ]) {
        expect(deriveRandomSeed(seed, name)).toBe(referenceSeed(seed, name));
        expect(deriveRandomSeed(seed, name)).toBe(deriveRandomSeed(seed, name));
      }
  });
  it("rejects malformed master seeds and non-ASCII or unbounded stream names", () => {
    for (const seed of [-0, -1, 2 ** 32, 0.5, NaN, Infinity, "42", null])
      expect(() =>
        deriveRandomSeed(seed as number, "world.population"),
      ).toThrow();
    for (const name of [
      "",
      "é",
      "World",
      "a".repeat(65),
      "world/population",
      null,
      1,
    ])
      expect(() => deriveRandomSeed(42, name as string)).toThrow();
  });
  it("avoids the former exact two/four-draw shifts and short cross-stream shifts across a bounded seed corpus", () => {
    for (let seed = 0; seed < 128; seed++) {
      const draws = (initial: number) => {
        const random = make(initial);
        return Array.from({ length: 40 }, () => draw(random));
      };
      const rooms = draws(seed);
      // The former additive constants were exactly 2 and 4 Weyl increments.
      expect(draws((seed + 1013904242) % 2 ** 32).slice(0, 16)).toEqual(
        rooms.slice(2, 18),
      );
      expect(draws((seed + 2027808484) % 2 ** 32).slice(0, 16)).toEqual(
        rooms.slice(4, 20),
      );
      const population = draws(deriveRandomSeed(seed, "world.population"));
      const rewards = draws(deriveRandomSeed(seed, "world.rewards"));
      expect(deriveRandomSeed(seed, "world.population")).not.toBe(
        deriveRandomSeed(seed, "world.rewards"),
      );
      for (const [first, second] of [
        [rooms, population],
        [rooms, rewards],
        [population, rewards],
      ]) {
        for (let lag = 0; lag <= 16; lag++) {
          expect(first.slice(lag, lag + 16)).not.toEqual(second.slice(0, 16));
          expect(second.slice(lag, lag + 16)).not.toEqual(first.slice(0, 16));
        }
      }
    }
  });
});
