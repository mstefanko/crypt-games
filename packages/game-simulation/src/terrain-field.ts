import { validateCaveContent } from "@onepage/game-project/cave-validation";
import type { CaveContent } from "@onepage/game-project/cave-types";
import {
  assertCavePlainData,
  caveRecord,
  caveInteger,
  caveArray,
} from "@onepage/game-project/cave-data";
export interface TerrainCell {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly material: number;
  readonly hp: number;
  readonly protected: boolean;
  readonly solid: boolean;
}
export interface TerrainSnapshot {
  readonly version: "cave-terrain-v1";
  readonly contentId: string;
  readonly cells: readonly number[];
  readonly hp: readonly number[];
  readonly stateRevision: number;
  readonly terrainRevision: number;
  readonly chunkRevisions: readonly number[];
  readonly rewardTotal: number;
}
export interface TerrainDamage {
  readonly id: number;
  readonly damage: number;
  readonly causes: readonly string[];
}
export interface TerrainChange {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly material: number;
  readonly previousHp: number;
  readonly hp: number;
  readonly removed: boolean;
  readonly reward: number;
  readonly causes: readonly string[];
}
export interface TerrainReceipt {
  readonly stateRevision: number;
  readonly terrainRevision: number;
  readonly changes: readonly TerrainChange[];
  readonly dirtyChunks: readonly number[];
  readonly reward: number;
  readonly candidates: number;
}
export interface TerrainTransaction {
  readonly receipt: TerrainReceipt;
  snapshot(): TerrainSnapshot;
  preview(): TerrainField;
  commit(): TerrainReceipt;
}
type Chunk = { materials: Uint8Array; hp: Uint16Array; revision: number };
const index = (x: number, y: number) => ({
  chunk: Math.floor(y / 16) * 8 + Math.floor(x / 16),
  local: (y % 16) * 16 + (x % 16),
});
const integer = (v: unknown, min: number, max: number, path: string) =>
  caveInteger(v, min, max, path);
const trusted = Symbol("terrain-owned-preview");
export class TerrainField {
  readonly content: CaveContent;
  #chunks: Chunk[] = [];
  #stateRevision = 0;
  #terrainRevision = 0;
  #rewardTotal = 0;
  constructor(
    content: CaveContent,
    snapshot?: TerrainSnapshot,
    internal?: typeof trusted,
  ) {
    this.content =
      internal === trusted ? content : validateCaveContent(content);
    if (internal === trusted) return;
    for (let i = 0; i < 64; i++)
      this.#chunks.push({
        materials: new Uint8Array(256),
        hp: new Uint16Array(256),
        revision: 0,
      });
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const i = y * 128 + x,
          { chunk, local } = index(x, y),
          m = content.cells[i];
        this.#chunks[chunk].materials[local] = m;
        this.#chunks[chunk].hp[local] = content.materials[m].hp;
      }
    if (snapshot) this.restore(snapshot);
  }
  get stateRevision(): number {
    return this.#stateRevision;
  }
  get terrainRevision(): number {
    return this.#terrainRevision;
  }
  get rewardTotal(): number {
    return this.#rewardTotal;
  }
  cell(x: number, y: number): TerrainCell {
    integer(x, -262144, 262144, "cell/x");
    integer(y, -262144, 262144, "cell/y");
    if (x < 0 || y < 0 || x >= 128 || y >= 128)
      return {
        id: -1,
        x,
        y,
        material: 0,
        hp: 65535,
        protected: true,
        solid: true,
      };
    const { chunk, local } = index(x, y),
      c = this.#chunks[chunk],
      material = c.materials[local];
    return {
      id: y * 128 + x,
      x,
      y,
      material,
      hp: c.hp[local],
      protected: this.content.protected[y * 128 + x],
      solid: material !== 0,
    };
  }
  snapshot(): TerrainSnapshot {
    return this.#snapshot(
      this.#chunks,
      this.#stateRevision,
      this.#terrainRevision,
      this.#rewardTotal,
    );
  }
  #snapshot(
    chunks: readonly Chunk[],
    stateRevision: number,
    terrainRevision: number,
    rewardTotal: number,
  ): TerrainSnapshot {
    const cells: number[] = [],
      hp: number[] = [];
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const { chunk, local } = index(x, y);
        cells.push(chunks[chunk].materials[local]);
        hp.push(chunks[chunk].hp[local]);
      }
    return {
      version: "cave-terrain-v1",
      contentId: this.content.id,
      cells,
      hp,
      stateRevision,
      terrainRevision,
      chunkRevisions: chunks.map((c) => c.revision),
      rewardTotal,
    };
  }
  restore(value: unknown): void {
    assertCavePlainData(value, 1048576);
    const o = caveRecord(
      value,
      [
        "version",
        "contentId",
        "cells",
        "hp",
        "stateRevision",
        "terrainRevision",
        "chunkRevisions",
        "rewardTotal",
      ],
      "/terrain",
    );
    if (o.version !== "cave-terrain-v1" || o.contentId !== this.content.id)
      throw Error("/terrain: incompatible content/version");
    const state = integer(
        o.stateRevision,
        0,
        1073741824,
        "/terrain/stateRevision",
      ),
      terrain = integer(
        o.terrainRevision,
        0,
        Math.min(state, 16384),
        "/terrain/terrainRevision",
      );
    const cells = caveArray(o.cells, 16384, "/terrain/cells"),
      hp = caveArray(o.hp, 16384, "/terrain/hp"),
      revs = caveArray(o.chunkRevisions, 64, "/terrain/chunkRevisions");
    if (cells.length !== 16384 || hp.length !== 16384 || revs.length !== 64)
      throw Error("/terrain: invalid array lengths");
    const chunks: Chunk[] = revs.map((r, i) => ({
      materials: new Uint8Array(256),
      hp: new Uint16Array(256),
      revision: integer(r, 0, state, `/terrain/chunkRevisions/${i}`),
    }));
    let reward = 0,
      removed = 0,
      changed = false,
      totalLost = 0;
    const chunkLost = Array<number>(64).fill(0),
      changedChunks = new Set<number>();
    for (let i = 0; i < 16384; i++) {
      const baseline = this.content.cells[i],
        material = integer(
          cells[i],
          0,
          this.content.materials.length - 1,
          `/terrain/cells/${i}`,
        ),
        remaining = integer(hp[i], 0, 65535, `/terrain/hp/${i}`),
        original = this.content.materials[baseline].hp;
      if (
        (material !== 0 && material !== baseline) ||
        (material === 0 && remaining !== 0) ||
        (material !== 0 && (remaining < 1 || remaining > original)) ||
        (this.content.protected[i] &&
          (material !== baseline || remaining !== original))
      )
        throw Error(
          `/terrain/cells/${i}: removal-only material/HP/protection invariant`,
        );
      const { chunk, local } = index(i % 128, Math.floor(i / 128));
      chunks[chunk].materials[local] = material;
      chunks[chunk].hp[local] = remaining;
      const lost = original - remaining;
      totalLost += lost;
      chunkLost[chunk] += lost;
      if (material !== baseline || remaining !== original) {
        changed = true;
        changedChunks.add(chunk);
      }
      if (baseline !== 0 && material === 0) {
        reward += this.content.materials[baseline].oreYield;
        removed++;
      }
    }
    if (
      integer(o.rewardTotal, 0, 1073725440, "/terrain/rewardTotal") !==
        reward ||
      removed < terrain ||
      removed > 0 !== terrain > 0 ||
      changed !== state > 0 ||
      state > totalLost ||
      chunks.reduce((n, c) => n + c.revision, 0) < state ||
      (changedChunks.size > 0 &&
        [...changedChunks].some((i) => chunks[i].revision === 0)) ||
      chunks.some(
        (c, i) =>
          c.revision > chunkLost[i] ||
          (!changedChunks.has(i) && c.revision !== 0),
      )
    )
      throw Error("/terrain: inconsistent revisions/reward");
    this.#chunks = chunks;
    this.#stateRevision = state;
    this.#terrainRevision = terrain;
    this.#rewardTotal = reward;
  }
  /** Validated cell changes stage copied dirty chunks only. Publication is stale-safe. */
  stageDamage(
    damage: readonly TerrainDamage[],
    candidates = damage.length,
  ): TerrainTransaction {
    assertCavePlainData(damage, 524288);
    integer(candidates, damage.length, 1280, "terrain candidates");
    if (damage.length > 1280) throw Error("terrain touched cell cap");
    const seen = new Set<number>(),
      changes: TerrainChange[] = [],
      dirty = new Map<number, Chunk>();
    let reward = 0,
      occupancy = false;
    for (const d of damage) {
      caveRecord(d, ["id", "damage", "causes"], "damage");
      integer(d.id, 0, 16383, "damage/id");
      integer(d.damage, 0, 5120, "damage/damage");
      if (seen.has(d.id)) throw Error("duplicate cell damage");
      seen.add(d.id);
      if (
        !Array.isArray(d.causes) ||
        d.causes.length < 1 ||
        d.causes.length > 5 ||
        d.damage > d.causes.length * 1024 ||
        d.causes.some(
          (c) =>
            typeof c !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(c),
        ) ||
        new Set(d.causes).size !== d.causes.length
      )
        throw Error("invalid cell causes");
      const x = d.id % 128,
        y = Math.floor(d.id / 128),
        old = this.cell(x, y);
      if (!old.solid || old.protected || d.damage === 0) continue;
      const hp = Math.max(0, old.hp - d.damage);
      if (hp === old.hp) continue;
      const { chunk, local } = index(x, y);
      let next = dirty.get(chunk);
      if (!next) {
        const c = this.#chunks[chunk];
        next = {
          materials: c.materials.slice(),
          hp: c.hp.slice(),
          revision: c.revision + 1,
        };
        dirty.set(chunk, next);
      }
      next.hp[local] = hp;
      if (hp === 0) {
        next.materials[local] = 0;
        occupancy = true;
      }
      const yieldValue =
        hp === 0 ? this.content.materials[old.material].oreYield : 0;
      reward += yieldValue;
      changes.push(
        Object.freeze({
          id: d.id,
          x,
          y,
          material: old.material,
          previousHp: old.hp,
          hp,
          removed: hp === 0,
          reward: yieldValue,
          causes: Object.freeze([...d.causes].sort()),
        }),
      );
    }
    changes.sort((a, b) => a.id - b.id);
    const state = this.#stateRevision + (changes.length ? 1 : 0),
      terrain = this.#terrainRevision + (occupancy ? 1 : 0),
      total = this.#rewardTotal + reward;
    integer(state, 0, 1073741824, "stateRevision");
    const base = this.#stateRevision,
      baseChunks = this.#chunks,
      staged = [...baseChunks];
    for (const [i, c] of dirty) staged[i] = c;
    const receipt: TerrainReceipt = Object.freeze({
      stateRevision: state,
      terrainRevision: terrain,
      changes: Object.freeze(changes),
      dirtyChunks: Object.freeze([...dirty.keys()].sort((a, b) => a - b)),
      reward,
      candidates,
    });
    let committed = false;
    return {
      receipt,
      snapshot: () => this.#snapshot(staged, state, terrain, total),
      preview: () => {
        const candidate = new TerrainField(this.content, undefined, trusted);
        candidate.#chunks = staged;
        candidate.#stateRevision = state;
        candidate.#terrainRevision = terrain;
        candidate.#rewardTotal = total;
        return candidate;
      },
      commit: () => {
        if (
          committed ||
          this.#stateRevision !== base ||
          this.#chunks !== baseChunks
        )
          throw Error("stale/already committed terrain transaction");
        this.#chunks = staged;
        this.#stateRevision = state;
        this.#terrainRevision = terrain;
        this.#rewardTotal = total;
        committed = true;
        return receipt;
      },
    };
  }
}
export function createTerrainField(
  content: CaveContent,
  snapshot?: TerrainSnapshot,
): TerrainField {
  return new TerrainField(content, snapshot);
}
export * from "./terrain-query";
export * from "./terrain-edit";
