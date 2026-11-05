/** Exact SplitMix32 (improved mixer), versioned rules randomness.
 * Constants/shift order: bryc/code jshash/PRNGs.md, improved SplitMix32 variant.
 * https://github.com/bryc/code/blob/master/jshash/PRNGs.md#splitmix32
 * Cosmetic consumers own separate instances.
 * The odd Weyl increment visits all uint32 states; xor-shifts and odd multiplies
 * are bijections, so every uint32 output occurs once per complete state cycle.
 * This small simulation generator is not a security/secret-generation primitive.
 */
export const RANDOM_ALGORITHM = "splitmix32-21f0aaad-735a2d97-v1" as const;
/** ASCII stream identity hashing and master-seed mixing; separate from draw semantics. */
export const RANDOM_SEED_DERIVATION = "fnv1a-ascii-splitmix32-v1" as const;
export const RANDOM_LIMITS = Object.freeze({
  streams: 16,
  draws: 1_000_000,
  attempts: 64,
});
const RANGE = 0x100000000;
const INCREMENT = 0x9e3779b9;

export interface RandomStreamDefinition {
  readonly name: string;
  readonly owner: string;
  /** Explicit uint32; zero is valid. Equal seeds produce equal sequences regardless
   * of name/owner; choose distinct seeds when that correlation is unwanted. */
  readonly seed: number;
}
export interface RandomStreamState extends RandomStreamDefinition {
  readonly state: number;
  /** Raw uint32 draws, including rejection-sampling retries. */
  readonly draws: number;
}
export interface RandomSnapshot {
  readonly algorithm: typeof RANDOM_ALGORITHM;
  readonly streams: readonly RandomStreamState[];
}

function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw Error("Invalid random integer");
  return value;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/.test(value))
    throw Error("Invalid random stream identity");
  return value;
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Invalid random snapshot fields");
  return value as Record<string, unknown>;
}
function mix(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
  return (value ^ (value >>> 15)) >>> 0;
}
function raw(state: number): { state: number; value: number } {
  state = (state + INCREMENT) >>> 0;
  return { state, value: mix(state) };
}
/** Derive a bounded named stream without consuming a draw. Hash the validated
 * 1–64 ASCII identity with FNV-1a, XOR the uint32 master seed, then apply the
 * existing bijective improved SplitMix32 mixer. Avoid additive sequence offsets.
 * This is deterministic domain separation, not cryptographic independence. */
export function deriveRandomSeed(seed: number, name: string): number {
  integer(seed, 0, RANGE - 1);
  if (Object.is(seed, -0)) throw Error("Invalid random seed");
  identity(name);
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index++)
    hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193) >>> 0;
  return mix((seed ^ hash) >>> 0);
}

export class DeterministicRandom {
  private readonly definitions: readonly RandomStreamDefinition[];
  private streams: RandomStreamState[];

  constructor(definitions: readonly RandomStreamDefinition[]) {
    if (
      !Array.isArray(definitions) ||
      definitions.length < 1 ||
      definitions.length > RANDOM_LIMITS.streams
    )
      throw Error("Random stream cap exceeded");
    this.definitions = Array.from(definitions, (definition) => {
      const source = object(definition, ["name", "owner", "seed"]);
      return {
        name: identity(source.name),
        owner: identity(source.owner),
        seed: integer(source.seed, 0, RANGE - 1),
      };
    }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (
      this.definitions.some(
        (definition, i) =>
          i > 0 && definition.name === this.definitions[i - 1].name,
      )
    )
      throw Error("Duplicate random stream");
    this.streams = this.definitions.map((definition) => ({
      ...definition,
      state: definition.seed,
      draws: 0,
    }));
  }

  private stream(owner: string, name: string): number {
    const index = this.streams.findIndex((stream) => stream.name === name);
    if (index < 0 || this.streams[index].owner !== owner)
      throw Error("Random stream owner mismatch");
    return index;
  }

  /** A singleton range still consumes one draw; the full uint32 range is valid. */
  drawInteger(owner: string, name: string, maxExclusive: number): number {
    integer(maxExclusive, 1, RANGE);
    const index = this.stream(owner, name);
    let stream = { ...this.streams[index] };
    const ceiling = Math.floor(RANGE / maxExclusive) * maxExclusive;
    for (let attempt = 0; attempt < RANDOM_LIMITS.attempts; attempt++) {
      if (stream.draws === RANDOM_LIMITS.draws)
        throw Error("Random draw cap exceeded");
      const draw = raw(stream.state);
      stream = { ...stream, state: draw.state, draws: stream.draws + 1 };
      if (draw.value < ceiling) {
        this.streams[index] = stream;
        return draw.value % maxExclusive;
      }
    }
    // Exhaustion is atomic: even rejected raw candidates remain uncommitted.
    throw Error("Random rejection attempt cap exceeded");
  }

  drawUint32(owner: string, name: string): number {
    return this.drawInteger(owner, name, RANGE);
  }

  capture(): RandomSnapshot {
    return {
      algorithm: RANDOM_ALGORITHM,
      streams: this.streams.map((stream) => ({ ...stream })),
    };
  }

  /** Exact configured names, owners, seeds, order and state/counter consistency.
   * Stages the complete bounded value before replacing any committed stream. */
  restore(value: unknown): void {
    const source = object(value, ["algorithm", "streams"]);
    if (
      source.algorithm !== RANDOM_ALGORITHM ||
      !Array.isArray(source.streams) ||
      source.streams.length !== this.definitions.length
    )
      throw Error("Incompatible random snapshot");
    const restoredStreams = source.streams;
    const staged = this.definitions.map((definition, i) => {
      const stream = object(restoredStreams[i], [
        "name",
        "owner",
        "seed",
        "state",
        "draws",
      ]);
      if (
        stream.name !== definition.name ||
        stream.owner !== definition.owner ||
        stream.seed !== definition.seed
      )
        throw Error("Incompatible random stream");
      const state = integer(stream.state, 0, RANGE - 1);
      const draws = integer(stream.draws, 0, RANDOM_LIMITS.draws);
      if (state !== (definition.seed + Math.imul(INCREMENT, draws)) >>> 0)
        throw Error("Inconsistent random state and draw count");
      return { ...definition, state, draws };
    });
    this.streams = staged;
  }
}

/** Compatibility stream for document queue content authored before named streams.
 * Generation consumes this stream fully before exposing a case; checkpoints retain
 * the generated queue and seed rather than an unfinished generation cursor.
 */
export function createInspectionQueueRandom(
  seed: number,
  shift: number,
): () => number {
  integer(seed, 0, RANGE - 1);
  integer(shift, 0, 15);
  let state = (seed ^ ((shift + 1) * 0x9e3779b9)) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / RANGE;
  };
}
