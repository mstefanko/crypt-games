/** G1 composes actual P2 combat with a finite hub/run progression owner. */
import { boundedJSON } from "@onepage/game-project/runtime";
import { TransactionOwner, type TransactionCheckpoint } from "./transactions";
import { deriveRandomSeed } from "./rng";
import { DestructionEncounter } from "./destruction-encounter";
import type {
  ActionEncounterConfiguration,
  ActionEncounterInput,
} from "./destruction-encounter";
import {
  arenaCheck,
  canonicalArenaData,
  generateArenaManifest,
  validateArenaManifest,
  validateArenaContent,
} from "./generated-arena";
import type {
  ArenaReward,
  GeneratedArenaManifest,
  GeneratedArenaRecipe,
  GeneratedArenaRoom,
} from "./generated-arena";

export const GENERATED_ARENA_RUN_LIMITS = Object.freeze({
  transitions: 64,
  saveBytes: 2097152,
  health: 40,
  modifiers: 7,
  replayTicks: 65536,
  replayRuns: 1024,
});
export type GeneratedArenaPhase =
  | "hub"
  | "active"
  | "reward"
  | "failed"
  | "complete";
type EncounterCheckpoint = ReturnType<DestructionEncounter["capture"]>;
type ProgressEvent =
  | { kind: "travel"; roomId: string }
  | { kind: "reward"; reward: ArenaReward };
interface RoomState {
  roomId: string;
  encounter: EncounterCheckpoint;
}
interface RunState {
  manifest: GeneratedArenaManifest;
  currentRoomId: string;
  health: number;
  modifiers: ArenaReward[];
  cleared: string[];
  claimed: string[];
  visited: string[];
  rooms: RoomState[];
  events: ProgressEvent[];
  transactions: TransactionCheckpoint;
}
export interface GeneratedArenaRunCheckpoint {
  format: "generated-arena-run-v1";
  phase: GeneratedArenaPhase;
  durableUnlock: boolean;
  /** The only durable outcome is this flag. A completed run's bounded proof is
   * retained across reset, permitting strict restoration without trusting a flag. */
  unlockProof: RunState | null;
  run: RunState | null;
}
/** Order is contractual: add power bonuses, apply focus multiplier once per
 * focus reward in acquisition order, then cap damage. Vitality heals on claim. */
export function arenaModifierStats(modifiers: readonly ArenaReward[]) {
  arenaCheck(
    Array.isArray(modifiers) &&
      modifiers.length <= 7 &&
      modifiers.every((item) => ["power", "focus", "vitality"].includes(item)),
    "invalid modifiers",
  );
  let damage = 2 + modifiers.filter((item) => item === "power").length;
  for (const reward of modifiers)
    if (reward === "focus") damage = Math.floor((damage * 3) / 2);
  return {
    damage: Math.min(16, damage),
    maxHealth: Math.min(
      40,
      20 + 4 * modifiers.filter((item) => item === "vitality").length,
    ),
  };
}
export function arenaRoomConfiguration(
  room: GeneratedArenaRoom,
  health: number,
  modifiers: readonly ArenaReward[],
): ActionEncounterConfiguration {
  const stats = arenaModifierStats(modifiers);
  arenaCheck(
    Number.isSafeInteger(health) && health > 0 && health <= stats.maxHealth,
    "invalid room entry health",
  );
  return {
    id: room.id,
    width: 4096,
    height: 3072,
    player: { x: 256, y: 1536, hp: health },
    enemies: room.tier
      ? [
          {
            id: "bruiser",
            role: "bruiser",
            x: 3072,
            y: 1536,
            hp: room.tier === 3 ? 8 : 4,
          },
          ...(room.tier >= 2
            ? [
                {
                  id: "ranger",
                  role: "ranger" as const,
                  x: 3584,
                  y: room.encounterSeed % 2 ? 1024 : 1792,
                  hp: room.tier === 3 ? 6 : 4,
                },
              ]
            : []),
        ]
      : [],
    objects: room.placements.map((placement) => ({
      id: placement.id,
      kind: placement.kind === "cover" ? ("wall" as const) : ("prop" as const),
      rect: { ...placement.rect },
      hp: placement.kind === "cover" ? 6 : 2,
      team: 0,
      brokenBlocking: false,
      reward: placement.kind === "cover" ? 0 : 1,
      blast:
        placement.kind === "barrel"
          ? { bands: [{ radius: 1024, damage: 4 }], friendlyFire: true }
          : null,
    })),
    modifiers: [
      { id: "run-damage", damageBonus: stats.damage - 2, healthBonus: 0 },
    ],
  };
}
function rewardTransactions(manifest: GeneratedArenaManifest) {
  return new TransactionOwner({
    id: "generated-arena-rewards-v1",
    resources: ["power", "focus", "vitality"].map((id) => ({
      id,
      initial: 0,
      capacity: 7,
    })),
    stats: [],
    flags: ["boss-unlock"],
    outcomes: manifest.rooms
      .filter((room) => room.tier > 0)
      .map((room) => room.id),
    rewardSeed: deriveRandomSeed(manifest.recipe.seed, "arena.transactions"),
  });
}
function copy<T>(value: T): T {
  return structuredClone(value);
}
/** Reserve the first winning proof while the run is still active, so completion
 * cannot suddenly double a save beyond its persistence box. */
function admitPersistence(run: RunState | null, proof: RunState | null) {
  let ticks = 0,
    runs = 0;
  for (const state of [run, proof ?? run]) {
    if (state === null) continue;
    arenaCheck(
      state &&
        typeof state === "object" &&
        Array.isArray(state.rooms) &&
        state.rooms.length <= 8,
      "saved room cap",
    );
    for (const room of state.rooms) {
      const checkpoint = room.encounter;
      arenaCheck(
        checkpoint &&
          typeof checkpoint === "object" &&
          Array.isArray(checkpoint.replay) &&
          checkpoint.replay.length <= 1024,
        "saved replay shape",
      );
      arenaCheck(
        Number.isSafeInteger(checkpoint.state?.tick) &&
          checkpoint.state.tick >= 0,
        "saved replay clock",
      );
      ticks += checkpoint.state.tick;
      runs += checkpoint.replay.length;
    }
  }
  arenaCheck(
    ticks <= GENERATED_ARENA_RUN_LIMITS.replayTicks &&
      runs <= GENERATED_ARENA_RUN_LIMITS.replayRuns,
    "aggregate replay quota",
  );
  canonicalArenaData(
    {
      format: "generated-arena-run-v1",
      phase: "complete",
      durableUnlock: proof !== null,
      unlockProof: proof ?? run,
      run,
    },
    GENERATED_ARENA_RUN_LIMITS.saveBytes,
  );
}

/** One active room only. Room entry stages a fresh P2 owner, while cleared-room
 * revisits restore their exact destruction/actor state without respawning loot. */
export class GeneratedArenaRun {
  private phase: GeneratedArenaPhase = "hub";
  private unlockProof: RunState | null = null;
  private run: RunState | null = null;
  private encounter: DestructionEncounter | null = null;
  start(recipe: GeneratedArenaRecipe) {
    return this.startManifest(generateArenaManifest(recipe));
  }
  startManifest(value: unknown) {
    const checked = validateArenaContent(value);
    arenaCheck(
      checked.recipe.theme !== "grove" || this.unlockProof,
      "grove theme requires the durable boss unlock",
    );
    return this.beginManifest(checked);
  }
  private beginManifest(value: GeneratedArenaManifest) {
    arenaCheck(this.phase === "hub", "reset to hub before starting a run");
    const manifest = validateArenaManifest(value);
    const next: RunState = {
      manifest,
      currentRoomId: "room-0",
      health: 20,
      modifiers: [],
      cleared: ["room-0"],
      claimed: [],
      visited: ["room-0"],
      rooms: [],
      events: [],
      transactions: rewardTransactions(manifest).capture(),
    };
    admitPersistence(next, this.unlockProof);
    this.run = next;
    this.encounter = null;
    this.phase = "active";
    return this.observe();
  }
  private room() {
    arenaCheck(this.run, "no active run");
    return this.run.manifest.rooms.find(
      (room) => room.id === this.run!.currentRoomId,
    )!;
  }
  private storeEncounter() {
    if (!this.run || !this.encounter) return;
    const saved = {
      roomId: this.run.currentRoomId,
      encounter: this.encounter.capture(),
    };
    const index = this.run.rooms.findIndex(
      (room) => room.roomId === saved.roomId,
    );
    if (index < 0) this.run.rooms.push(saved);
    else this.run.rooms[index] = saved;
  }
  private synchronize() {
    if (!this.run || !this.encounter) return;
    const observation = this.encounter.observe();
    this.run.health = observation.player.hp;
    if (observation.status === "defeated") this.phase = "failed";
    else if (observation.status === "cleared") {
      if (!this.run.cleared.includes(this.run.currentRoomId))
        this.run.cleared.push(this.run.currentRoomId);
      this.phase = this.run.claimed.includes(this.run.currentRoomId)
        ? "active"
        : "reward";
    }
    this.storeEncounter();
  }
  step(input: ActionEncounterInput) {
    arenaCheck(
      this.phase === "active" && this.encounter,
      "no playing encounter",
    );
    arenaCheck(
      this.encounter.observe().status === "playing",
      "cleared rooms do not advance",
    );
    this.encounter.step(input, (checkpoint) => {
      const next = copy(this.run!);
      const index = next.rooms.findIndex(
        (room) => room.roomId === next.currentRoomId,
      );
      arenaCheck(index >= 0, "missing active room snapshot");
      next.rooms[index] = { roomId: next.currentRoomId, encounter: checkpoint };
      next.health = checkpoint.state.player.hp;
      if (
        checkpoint.state.status === "cleared" &&
        !next.cleared.includes(next.currentRoomId)
      )
        next.cleared.push(next.currentRoomId);
      admitPersistence(next, this.unlockProof);
    });
    this.synchronize();
    return this.observe();
  }
  travel(roomId: string) {
    arenaCheck(
      this.run && this.phase === "active" && this.run.events.length < 64,
      "travel unavailable/cap",
    );
    const state = this.run;
    arenaCheck(
      state.cleared.includes(state.currentRoomId),
      "clear encounter before leaving",
    );
    arenaCheck(
      state.manifest.links.some(
        (link) =>
          (link.from === state.currentRoomId && link.to === roomId) ||
          (link.to === state.currentRoomId && link.from === roomId),
      ),
      "rooms are not adjacent",
    );
    const room = state.manifest.rooms.find((room) => room.id === roomId)!;
    arenaCheck(
      state.events.length +
        (room.tier && !state.claimed.includes(roomId) ? 2 : 1) <=
        64,
      "transition cap: reserve the room reward claim",
    );
    let encounter: DestructionEncounter | null = null;
    const retained = state.rooms.find((saved) => saved.roomId === roomId);
    if (retained) {
      // Retained config owns original health/modifiers; no generation at entry.
      encounter = new DestructionEncounter(retained.encounter.configuration);
      encounter.restore(retained.encounter);
    } else if (room.tier)
      encounter = new DestructionEncounter(
        arenaRoomConfiguration(room, state.health, state.modifiers),
      );
    // Construction/restore completes before any transition state is published.
    const next = copy(state);
    next.currentRoomId = roomId;
    next.events.push({ kind: "travel", roomId });
    if (!next.visited.includes(roomId)) {
      next.visited.push(roomId);
      if (room.role === "rest")
        next.health = Math.min(
          arenaModifierStats(next.modifiers).maxHealth,
          next.health + 4,
        );
    }
    if (!room.tier && !next.cleared.includes(roomId)) next.cleared.push(roomId);
    if (encounter && !retained)
      next.rooms.push({ roomId, encounter: encounter.capture() });
    admitPersistence(next, this.unlockProof);
    this.run = next;
    this.encounter = encounter;
    // Revisiting cleared combat never restores old room-entry health over the
    // run's current health. Actors/destruction remain retained presentation.

    return this.observe();
  }
  chooseReward(reward: ArenaReward) {
    arenaCheck(
      this.run && this.phase === "reward" && this.run.events.length < 64,
      "reward unavailable/cap",
    );
    const room = this.room(),
      next = copy(this.run);
    arenaCheck(
      room.rewards.includes(reward) && !next.claimed.includes(room.id),
      "invalid/already claimed reward",
    );
    const transactions = rewardTransactions(next.manifest);
    transactions.restore(next.transactions);
    transactions.execute({
      id: `claim-${room.id}`,
      revision: next.claimed.length,
      outcome: room.id,
      operations: [
        { kind: "grant", resource: reward, amount: 1 },
        ...(room.role === "boss"
          ? [{ kind: "flag" as const, flag: "boss-unlock", value: true }]
          : []),
      ],
    });
    next.transactions = transactions.capture();
    next.modifiers.push(reward);
    arenaModifierStats(next.modifiers);
    if (reward === "vitality")
      next.health = Math.min(
        arenaModifierStats(next.modifiers).maxHealth,
        next.health + 4,
      );
    next.claimed.push(room.id);
    next.events.push({ kind: "reward", reward });
    admitPersistence(next, this.unlockProof);
    this.run = next;
    this.phase = room.role === "boss" ? "complete" : "active";
    if (this.phase === "complete" && !this.unlockProof)
      this.unlockProof = copy(next);
    return this.observe();
  }
  reset() {
    this.phase = "hub";
    this.run = null;
    this.encounter = null;
    return this.observe();
  }
  observe() {
    const run = this.run;
    const encounter = this.encounter?.observe() ?? null;
    if (run && encounter)
      encounter.player = {
        ...encounter.player,
        hp: run.health,
        maxHp: arenaModifierStats(run.modifiers).maxHealth,
      };
    return {
      phase: this.phase,
      durableUnlock: this.unlockProof !== null,
      run: run
        ? {
            manifest: copy(run.manifest),
            currentRoomId: run.currentRoomId,
            health: run.health,
            modifiers: [...run.modifiers],
            cleared: [...run.cleared],
            claimed: [...run.claimed],
            visited: [...run.visited],
            exits: run.manifest.links.flatMap((link) =>
              link.from === run.currentRoomId
                ? [link.to]
                : link.to === run.currentRoomId
                  ? [link.from]
                  : [],
            ),
            encounter,
            encounterRetained:
              encounter !== null && run.claimed.includes(run.currentRoomId),
          }
        : null,
    };
  }
  capture(): GeneratedArenaRunCheckpoint {
    return {
      format: "generated-arena-run-v1",
      phase: this.phase,
      durableUnlock: this.unlockProof !== null,
      unlockProof: copy(this.unlockProof),
      run: copy(this.run),
    };
  }
  /** Rebuilds the active run and retained first-winning proof, each with <=64
   * progression decisions and <=8 initial room hydrations. Retained revisits
   * restore P2 again, replaying that room's bounded transcript from its authored
   * initial state. The aggregate tick quota is stored history, not a one-pass
   * restore-work quota. No seed-only state or world regeneration is accepted. */
  restore(value: unknown): void {
    const normalized = canonicalArenaData(
      value,
      GENERATED_ARENA_RUN_LIMITS.saveBytes,
    );
    arenaCheck(
      value && typeof value === "object" && !Array.isArray(value),
      "checkpoint shape",
    );
    const source = value as GeneratedArenaRunCheckpoint;
    arenaCheck(
      Object.keys(source).sort().join() ===
        ["format", "phase", "durableUnlock", "unlockProof", "run"]
          .sort()
          .join() && source.format === "generated-arena-run-v1",
      "checkpoint fields/version",
    );
    admitPersistence(source.run, source.unlockProof);
    const staged = new GeneratedArenaRun();
    if (source.unlockProof !== null) {
      const proof = GeneratedArenaRun.restoreRun(source.unlockProof);
      arenaCheck(
        proof.phase === "complete" &&
          proof.run!.manifest.recipe.theme === "forge",
        "invalid durable unlock proof",
      );
      staged.unlockProof = copy(proof.run);
    }
    if (source.run !== null) {
      arenaCheck(
        source.run.manifest.recipe.theme !== "grove" || staged.unlockProof,
        "missing grove unlock proof",
      );
      const restored = GeneratedArenaRun.restoreRun(
        source.run,
        staged.unlockProof,
      );
      staged.run = restored.run;
      staged.encounter = restored.encounter;
      staged.phase = restored.phase;
      if (staged.phase === "complete" && !staged.unlockProof)
        staged.unlockProof = copy(staged.run);
    }
    arenaCheck(
      normalized ===
        canonicalArenaData(
          staged.capture(),
          GENERATED_ARENA_RUN_LIMITS.saveBytes,
        ),
      "inconsistent checkpoint",
    );
    this.phase = staged.phase;
    this.run = staged.run;
    this.encounter = staged.encounter;
    this.unlockProof = staged.unlockProof;
  }
  private static restoreRun(
    source: RunState,
    quotaProof: RunState | null = null,
  ): GeneratedArenaRun {
    arenaCheck(
      source &&
        typeof source === "object" &&
        Array.isArray(source.events) &&
        source.events.length <= 64 &&
        Array.isArray(source.rooms) &&
        source.rooms.length <= 8,
      "progression/room cap",
    );
    const staged = new GeneratedArenaRun();
    // Active post-unlock saves use the already validated durable proof budget.
    // Reserving another first-run proof here would reject valid larger runs.
    staged.unlockProof = copy(quotaProof);
    staged.beginManifest(source.manifest);
    const loaded = new Set<string>();
    const hydrate = () => {
      const current = staged.run!.currentRoomId;
      const retained = source.rooms.find((saved) => saved.roomId === current);
      if (!retained || loaded.has(current)) return;
      arenaCheck(staged.encounter, "checkpoint contains inactive room");
      staged.encounter.restore(retained.encounter);
      staged.synchronize();
      loaded.add(current);
    };
    for (const event of source.events) {
      hydrate();
      if (event.kind === "travel") {
        arenaCheck(
          Object.keys(event).sort().join() === "kind,roomId",
          "travel fields",
        );
        staged.travel(event.roomId);
      } else {
        arenaCheck(
          event.kind === "reward" &&
            Object.keys(event).sort().join() === "kind,reward",
          "reward fields",
        );
        staged.chooseReward(event.reward);
      }
    }
    hydrate();
    arenaCheck(
      canonicalArenaData(staged.run, GENERATED_ARENA_RUN_LIMITS.saveBytes) ===
        canonicalArenaData(source, GENERATED_ARENA_RUN_LIMITS.saveBytes),
      "inconsistent run/room state",
    );
    return staged;
  }
  save(): string {
    return canonicalArenaData(
      this.capture(),
      GENERATED_ARENA_RUN_LIMITS.saveBytes,
    );
  }
  load(bytes: string): void {
    arenaCheck(typeof bytes === "string", "save bytes required");
    const value = boundedJSON(bytes, GENERATED_ARENA_RUN_LIMITS.saveBytes, {
      rejectNegativeZero: true,
    });
    arenaCheck(
      canonicalArenaData(value, GENERATED_ARENA_RUN_LIMITS.saveBytes) === bytes,
      "noncanonical save",
    );
    this.restore(value);
  }
}
