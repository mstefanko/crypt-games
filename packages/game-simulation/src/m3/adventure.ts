import { boundedJSON, canonical } from "../../../game-project/src/runtime";
import type { GridDirection, ProfileIdentity } from "./grid";

export interface AdventureItem {
  id: string;
  stackable: boolean;
  maxStack?: number;
}
export interface AdventureGrant {
  itemId: string;
  quantity: number;
  instanceId?: string;
}
export interface AdventureEffects {
  grants?: readonly AdventureGrant[];
  /** Atomic inventory requirements removed before grants; instances require exact identity. */
  consumes?: readonly AdventureGrant[];
  flags?: Readonly<Record<string, boolean>>;
  stats?: Readonly<Record<string, number>>;
  completeQuest?: string;
}
export interface AdventureMap {
  id: string;
  name: string;
  width: number;
  height: number;
  walls: readonly number[];
  entrances: readonly { id: string; cell: number }[];
  pickups: readonly { id: string; cell: number; effects: AdventureEffects }[];
  dialogues: readonly {
    id: string;
    cell: number;
    flag: string;
    before: string;
    after: string;
    choiceId: string;
    effects: AdventureEffects;
  }[];
  exits: readonly {
    id: string;
    cell: number;
    mapId: string;
    entranceId: string;
    /** All declared monotonic flags must be acquired before travel. */
    requiresFlags?: readonly string[];
  }[];
}
export interface AdventureDefinitions {
  gameId: string;
  characterId: string;
  compatibilityVersion: 1;
  initial: { mapId: string; entranceId: string };
  maps: readonly AdventureMap[];
  items: readonly AdventureItem[];
  quests: readonly string[];
  flags: Readonly<Record<string, boolean>>;
  stats: Readonly<
    Record<string, { min: number; max: number; initial: number }>
  >;
  inventoryLimit?: number;
}
export interface InventorySlot {
  itemId: string;
  quantity: number;
  instanceId?: string;
}
export interface AdventureCampaign {
  gameId: string;
  characterId: string;
  revision: number;
  sequence: number;
  checkpoint: { mapId: string; entranceId: string };
  inventory: InventorySlot[];
  flags: Record<string, boolean>;
  stats: Record<string, number>;
  quests: Record<string, "open" | "complete">;
  removedPickups: { mapId: string; placementId: string }[];
  tokens: string[];
}
export interface AdventureActive {
  mapId: string;
  entranceId: string;
  player: number;
  epoch: number;
}
export interface AdventureState {
  campaign: AdventureCampaign;
  active: AdventureActive;
}
interface Order {
  sequence: number;
  revision: number;
}
export type AdventureCommand = Order &
  (
    | { kind: "move"; direction: GridDirection }
    | { kind: "pickup"; placementId: string; token: string }
    | { kind: "dialogue"; dialogueId: string; choiceId: string; token: string }
  );
export type AdventureTravelCommand = Order & {
  kind: "travel";
  exitId: string;
  token: string;
};
export type AdventureResult =
  | { ok: true; state: AdventureState }
  | { ok: false; state: AdventureState; error: string };
export interface AdventureTransition {
  baseRevision: number;
  baseSequence: number;
  baseState: string;
  targetMapId: string;
  state: AdventureState;
  command: AdventureTravelCommand;
}
export type AdventureTransitionResult =
  | { ok: true; transition: AdventureTransition }
  | { ok: false; state: AdventureState; error: string };
// Keeps the worst-case valid ASCII-ID campaign below the 1 MiB save envelope.
// Legacy v1 saves may carry up to LIMIT opaque receipts. New commits retain a
// recent window; permanent one-shot guards are pickups and completed quests.
const RECEIPT_WINDOW = 64;
const LIMIT = 2048,
  MAX = Number.MAX_SAFE_INTEGER;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fail(message: string): never {
  throw Error(message);
}
function id(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
  )
    fail("Invalid stable ID");
}
function num(value: unknown, min = 0, max = MAX): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    (value as number) < min ||
    (value as number) > max
  )
    fail("Invalid adventure integer");
}
function keys(
  value: unknown,
  allowed: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...allowed].sort().join()
  )
    fail("Invalid adventure fields");
}
function unique(values: readonly string[]) {
  if (new Set(values).size !== values.length) fail("Duplicate stable ID");
  values.forEach(id);
}
function mapFor(defs: AdventureDefinitions, mapId: string): AdventureMap {
  return (
    defs.maps.find((m) => m.id === mapId) ?? fail("Missing map definition")
  );
}
function entranceFor(
  defs: AdventureDefinitions,
  mapId: string,
  entranceId: string,
) {
  return (
    mapFor(defs, mapId).entrances.find((e) => e.id === entranceId) ??
    fail("Missing authored entrance")
  );
}
function validateEffects(
  defs: AdventureDefinitions,
  effects: AdventureEffects,
) {
  if (
    !effects ||
    typeof effects !== "object" ||
    Object.keys(effects).some(
      (k) => !["grants", "consumes", "flags", "stats", "completeQuest"].includes(k),
    )
  )
    fail("Invalid transaction effects");
  if (
    effects.grants &&
    (!Array.isArray(effects.grants) || effects.grants.length > 100)
  )
    fail("Too many grants");
  if (effects.consumes && (!Array.isArray(effects.consumes) || effects.consumes.length > 100)) fail("Too many consumes");
  for (const grant of [...(effects.grants ?? []), ...(effects.consumes ?? [])]) {
    const item =
      defs.items.find((i) => i.id === grant.itemId) ??
      fail("Missing item definition");
    num(grant.quantity, 1, 999);
    if (!item.stackable) {
      if (grant.quantity !== 1) fail("Nonstackable grant quantity");
      id(grant.instanceId);
    } else if (grant.instanceId !== undefined)
      fail("Stackable cannot have instance identity");
  }
  for (const [flag, value] of Object.entries(effects.flags ?? {})) {
    if (!Object.hasOwn(defs.flags, flag) || typeof value !== "boolean")
      fail("Undeclared progression flag");
    if (value !== true)
      fail("Progression effects require monotonic true flags");
  }
  for (const [stat, value] of Object.entries(effects.stats ?? {})) {
    if (!Object.hasOwn(defs.stats, stat)) fail("Undeclared progression stat");
    // Spending/consumption is outside this finite progression profile.
    num(value, 0, MAX);
  }
  if (
    effects.completeQuest !== undefined &&
    !defs.quests.includes(effects.completeQuest)
  )
    fail("Missing quest definition");
}
/** Validate references by stable ID. Filename/display name never enters durable identity. */
export function validateAdventureDefinitions(defs: AdventureDefinitions): void {
  id(defs.gameId);
  id(defs.characterId);
  if (defs.compatibilityVersion !== 1)
    fail("Unsupported campaign compatibility");
  num(defs.inventoryLimit ?? 100, 1, 100);
  if (
    !Array.isArray(defs.maps) ||
    defs.maps.length < 1 ||
    defs.maps.length > 128 ||
    !Array.isArray(defs.items) ||
    defs.items.length > 256 ||
    !Array.isArray(defs.quests) ||
    defs.quests.length > 256
  )
    fail("Adventure definitions exceed bounds");
  unique(defs.maps.map((m) => m.id));
  unique(defs.items.map((i) => i.id));
  unique(defs.quests);
  if (
    Object.keys(defs.flags).length > 256 ||
    Object.keys(defs.stats).length > 64
  )
    fail("Progression declarations exceed bounds");
  for (const [flag, value] of Object.entries(defs.flags)) {
    id(flag);
    if (typeof value !== "boolean") fail("Invalid flag default");
  }
  for (const [stat, range] of Object.entries(defs.stats)) {
    id(stat);
    num(range.min, -MAX, MAX);
    num(range.max, range.min, MAX);
    num(range.initial, range.min, range.max);
  }
  for (const item of defs.items) {
    if (typeof item.stackable !== "boolean") fail("Invalid item stack policy");
    num(
      item.maxStack ?? (item.stackable ? 999 : 1),
      1,
      item.stackable ? 999 : 1,
    );
  }
  const rewardQuests: string[] = [];
  for (const map of defs.maps) {
    num(map.width, 2, 64);
    num(map.height, 2, 64);
    if (
      !Array.isArray(map.walls) ||
      map.walls.length > map.width * map.height ||
      new Set(map.walls).size !== map.walls.length
    )
      fail("Invalid map walls");
    for (const cell of map.walls) num(cell, 0, map.width * map.height - 1);
    for (const placements of [
      map.entrances,
      map.pickups,
      map.dialogues,
      map.exits,
    ]) {
      if (!Array.isArray(placements) || placements.length > 256)
        fail("Map placements exceed bounds");
      unique(placements.map((p) => p.id));
      for (const placement of placements) {
        num(placement.cell, 0, map.width * map.height - 1);
        if (map.walls.includes(placement.cell)) fail("Placement overlaps wall");
      }
    }
    if (!map.entrances.length) fail("Map needs authored entrance");
    for (const pickup of map.pickups) {
      validateEffects(defs, pickup.effects);
      if (pickup.effects.completeQuest)
        rewardQuests.push(pickup.effects.completeQuest);
    }
    for (const dialogue of map.dialogues) {
      id(dialogue.choiceId);
      if (!Object.hasOwn(defs.flags, dialogue.flag))
        fail("Dialogue flag missing");
      validateEffects(defs, dialogue.effects);
      // Every item-granting dialogue in this finite profile has a durable
      // one-shot ledger; receipt-window expiry must never permit another reward.
      if (!dialogue.effects.completeQuest)
        fail("Dialogue requires a one-shot quest");
      rewardQuests.push(dialogue.effects.completeQuest);
    }
    for (const exit of map.exits) {
      entranceFor(defs, exit.mapId, exit.entranceId);
      if (exit.requiresFlags !== undefined) {
        if (!Array.isArray(exit.requiresFlags) || exit.requiresFlags.length > 8)
          fail("Exit capability requirements exceed bounds");
        unique(exit.requiresFlags);
        for (const flag of exit.requiresFlags)
          if (!Object.hasOwn(defs.flags, flag)) fail("Exit requires undeclared flag");
      }
    }
  }
  unique(rewardQuests);
  entranceFor(defs, defs.initial.mapId, defs.initial.entranceId);
}
export function createAdventure(defs: AdventureDefinitions): AdventureState {
  validateAdventureDefinitions(defs);
  const checkpoint = clone(defs.initial),
    entrance = entranceFor(defs, checkpoint.mapId, checkpoint.entranceId);
  return {
    campaign: {
      gameId: defs.gameId,
      characterId: defs.characterId,
      revision: 0,
      sequence: 0,
      checkpoint,
      inventory: [],
      flags: clone(defs.flags),
      stats: Object.fromEntries(
        Object.entries(defs.stats).map(([key, value]) => [key, value.initial]),
      ),
      quests: Object.fromEntries(defs.quests.map((q) => [q, "open" as const])),
      removedPickups: [],
      tokens: [],
    },
    active: { ...checkpoint, player: entrance.cell, epoch: 0 },
  };
}
function validateCampaign(
  defs: AdventureDefinitions,
  campaign: AdventureCampaign,
): AdventureCampaign {
  keys(campaign, [
    "gameId",
    "characterId",
    "revision",
    "sequence",
    "checkpoint",
    "inventory",
    "flags",
    "stats",
    "quests",
    "removedPickups",
    "tokens",
  ]);
  if (
    campaign.gameId !== defs.gameId ||
    campaign.characterId !== defs.characterId
  )
    fail("Campaign game/character mismatch");
  num(campaign.revision);
  num(campaign.sequence);
  if (campaign.revision !== campaign.sequence)
    fail("Campaign ordering mismatch");
  keys(campaign.checkpoint, ["mapId", "entranceId"]);
  entranceFor(defs, campaign.checkpoint.mapId, campaign.checkpoint.entranceId);
  if (
    !Array.isArray(campaign.inventory) ||
    campaign.inventory.length > (defs.inventoryLimit ?? 100)
  )
    fail("Inventory capacity exceeded");
  const instanceIds: string[] = [];
  for (const slot of campaign.inventory) {
    keys(
      slot,
      slot.instanceId === undefined
        ? ["itemId", "quantity"]
        : ["itemId", "quantity", "instanceId"],
    );
    const item =
      defs.items.find((i) => i.id === slot.itemId) ??
      fail("Missing inventory item definition");
    num(slot.quantity, 1, item.maxStack ?? (item.stackable ? 999 : 1));
    if (!item.stackable) {
      id(slot.instanceId);
      instanceIds.push(slot.instanceId);
    } else if (slot.instanceId !== undefined)
      fail("Unexpected stack instance ID");
  }
  unique(instanceIds);
  keys(campaign.flags, Object.keys(defs.flags));
  for (const value of Object.values(campaign.flags))
    if (typeof value !== "boolean") fail("Invalid campaign flag");
  keys(campaign.stats, Object.keys(defs.stats));
  for (const [key, value] of Object.entries(campaign.stats))
    num(value, defs.stats[key].min, defs.stats[key].max);
  keys(campaign.quests, defs.quests);
  for (const value of Object.values(campaign.quests))
    if (value !== "open" && value !== "complete") fail("Invalid quest state");
  if (
    !Array.isArray(campaign.removedPickups) ||
    campaign.removedPickups.length > LIMIT ||
    !Array.isArray(campaign.tokens) ||
    campaign.tokens.length > LIMIT
  )
    fail("Campaign progression capacity exceeded");
  const placements: string[] = [];
  for (const removed of campaign.removedPickups) {
    keys(removed, ["mapId", "placementId"]);
    if (
      !mapFor(defs, removed.mapId).pickups.some(
        (p) => p.id === removed.placementId,
      )
    )
      fail("Missing pickup definition");
    placements.push(`${removed.mapId}/${removed.placementId}`);
  }
  if (new Set(placements).size !== placements.length)
    fail("Duplicate removed pickup");
  unique(campaign.tokens);
  return campaign;
}
/** Reconstruct grants and consumptions from permanent pickup/quest outcomes.
 * Reconstruct durable outcomes, independently of expired execution receipts. */
function validateProgression(
  defs: AdventureDefinitions,
  campaign: AdventureCampaign,
): void {
  const expectedFlags = clone(defs.flags);
  const expectedStats = Object.fromEntries(
    Object.entries(defs.stats).map(([key, range]) => [key, range.initial]),
  );
  const expectedQuests: Record<string, "open" | "complete"> =
    Object.fromEntries(defs.quests.map((quest) => [quest, "open"]));
  const expectedStacks = new Map<string, number>();
  const expectedInstances = new Map<string, string>();
  const apply = (effect: AdventureEffects) => {
    for (const consumed of effect.consumes ?? []) {
      if (consumed.instanceId !== undefined) {
        if (expectedInstances.get(consumed.instanceId) !== consumed.itemId) fail("Consumed instance unavailable");
        expectedInstances.delete(consumed.instanceId);
      } else {
        const remaining = (expectedStacks.get(consumed.itemId) ?? 0) - consumed.quantity;
        if (remaining < 0) fail("Consumed stack unavailable");
        if (remaining === 0) expectedStacks.delete(consumed.itemId); else expectedStacks.set(consumed.itemId, remaining);
      }
    }
    for (const grant of effect.grants ?? []) {
      if (grant.instanceId !== undefined) {
        if (expectedInstances.has(grant.instanceId))
          fail("Duplicate authored reward instance");
        expectedInstances.set(grant.instanceId, grant.itemId);
      } else
        expectedStacks.set(
          grant.itemId,
          (expectedStacks.get(grant.itemId) ?? 0) + grant.quantity,
        );
    }
    Object.assign(expectedFlags, effect.flags ?? {});
    for (const [stat, delta] of Object.entries(effect.stats ?? {}))
      expectedStats[stat] += delta;
    if (effect.completeQuest) {
      if (expectedQuests[effect.completeQuest] === "complete")
        fail("Duplicate quest outcome");
      expectedQuests[effect.completeQuest] = "complete";
    }
  };
  for (const removed of campaign.removedPickups) {
    apply(
      mapFor(defs, removed.mapId).pickups.find(
        (p) => p.id === removed.placementId,
      )!.effects,
    );
  }
  // The authored M3 progression is monotonic: pickups unlock quest dialogue.
  // Iteration also permits a completed quest to unlock the next declared quest.
  const pending = defs.maps
    .flatMap((map) => map.dialogues)
    .filter(
      (dialogue) =>
        campaign.quests[dialogue.effects.completeQuest!] === "complete" &&
        expectedQuests[dialogue.effects.completeQuest!] !== "complete",
    );
  while (pending.length) {
    const index = pending.findIndex((dialogue) => expectedFlags[dialogue.flag]);
    if (index === -1) fail("Completed quest prerequisite missing");
    apply(pending.splice(index, 1)[0].effects);
  }
  const actualStacks = new Map<string, number>();
  const actualInstances = new Map<string, string>();
  for (const slot of campaign.inventory) {
    if (slot.instanceId !== undefined)
      actualInstances.set(slot.instanceId, slot.itemId);
    else
      actualStacks.set(
        slot.itemId,
        (actualStacks.get(slot.itemId) ?? 0) + slot.quantity,
      );
  }
  const entries = (values: Map<string, string | number>) =>
    Object.fromEntries(values);
  if (
    canonical(entries(actualStacks)) !== canonical(entries(expectedStacks)) ||
    canonical(entries(actualInstances)) !==
      canonical(entries(expectedInstances)) ||
    canonical(campaign.flags) !== canonical(expectedFlags) ||
    canonical(campaign.stats) !== canonical(expectedStats) ||
    canonical(campaign.quests) !== canonical(expectedQuests)
  )
    fail("Campaign progression and transactional outcomes disagree");
}
function validateActive(
  defs: AdventureDefinitions,
  active: AdventureActive,
  campaign: AdventureCampaign,
) {
  keys(active, ["mapId", "entranceId", "player", "epoch"]);
  const map = mapFor(defs, active.mapId);
  entranceFor(defs, active.mapId, active.entranceId);
  if (
    active.mapId !== campaign.checkpoint.mapId ||
    active.entranceId !== campaign.checkpoint.entranceId
  )
    fail("Active/durable map mismatch");
  num(active.player, 0, map.width * map.height - 1);
  num(active.epoch);
  if (map.walls.includes(active.player)) fail("Active player overlaps wall");
}
function order(state: AdventureState, command: Order) {
  num(command.sequence, 1);
  num(command.revision, 0, MAX - 1);
  if (
    command.sequence !== state.campaign.sequence + 1 ||
    command.revision !== state.campaign.revision
  )
    fail("Stale or unordered adventure command");
}
function token(campaign: AdventureCampaign, value: string) {
  id(value);
  if (campaign.tokens.includes(value))
    fail("Execution token already committed");
  campaign.tokens.push(value);
  campaign.tokens = campaign.tokens.slice(-RECEIPT_WINDOW);
}
function effects(
  defs: AdventureDefinitions,
  campaign: AdventureCampaign,
  effect: AdventureEffects,
) {
  validateEffects(defs, effect);
  if (
    effect.completeQuest &&
    campaign.quests[effect.completeQuest] === "complete"
  )
    fail("Quest reward already committed");
  for (const consumed of effect.consumes ?? []) {
    let remaining = consumed.quantity;
    for (const slot of campaign.inventory) {
      if (slot.itemId !== consumed.itemId || slot.instanceId !== consumed.instanceId) continue;
      const taken = Math.min(remaining, slot.quantity);
      slot.quantity -= taken; remaining -= taken;
      if (!remaining) break;
    }
    if (remaining) fail("Required inventory unavailable");
    campaign.inventory = campaign.inventory.filter(slot => slot.quantity > 0);
  }
  for (const grant of effect.grants ?? []) {
    const item = defs.items.find((i) => i.id === grant.itemId)!;
    if (!item.stackable) {
      if (
        campaign.inventory.some((slot) => slot.instanceId === grant.instanceId)
      )
        fail("Duplicate item instance ID");
      campaign.inventory.push(clone(grant));
    } else {
      let remaining = grant.quantity;
      const cap = item.maxStack ?? 999;
      for (const slot of campaign.inventory)
        if (slot.itemId === item.id && slot.quantity < cap) {
          const count = Math.min(remaining, cap - slot.quantity);
          slot.quantity += count;
          remaining -= count;
        }
      while (remaining > 0) {
        const count = Math.min(remaining, cap);
        campaign.inventory.push({ itemId: item.id, quantity: count });
        remaining -= count;
      }
    }
  }
  Object.assign(campaign.flags, effect.flags ?? {});
  for (const [stat, delta] of Object.entries(effect.stats ?? {}))
    campaign.stats[stat] += delta;
  if (effect.completeQuest) campaign.quests[effect.completeQuest] = "complete";
  validateCampaign(defs, campaign);
}
function near(map: AdventureMap, player: number, cell: number): boolean {
  return (
    Math.abs((player % map.width) - (cell % map.width)) +
      Math.abs(Math.floor(player / map.width) - Math.floor(cell / map.width)) <=
    1
  );
}
export function adventurePickupCollected(
  state: AdventureState,
  mapId: string,
  placementId: string,
): boolean {
  return state.campaign.removedPickups.some(
    (p) => p.mapId === mapId && p.placementId === placementId,
  );
}
export function adventureDialogue(
  defs: AdventureDefinitions,
  state: AdventureState,
  dialogueId: string,
): { text: string; choiceId: string | null } {
  const dialogue =
    mapFor(defs, state.active.mapId).dialogues.find(
      (d) => d.id === dialogueId,
    ) ?? fail("Missing dialogue");
  const ready = state.campaign.flags[dialogue.flag];
  return {
    text: ready ? dialogue.after : dialogue.before,
    choiceId:
      ready &&
      (!dialogue.effects.completeQuest ||
        state.campaign.quests[dialogue.effects.completeQuest] !== "complete")
        ? dialogue.choiceId
        : null,
  };
}
function rejected(
  state: AdventureState,
  error: unknown,
): AdventureResult & { ok: false } {
  return {
    ok: false,
    state,
    error: error instanceof Error ? error.message : "Invalid adventure command",
  };
}
export function applyAdventureCommand(
  defs: AdventureDefinitions,
  state: AdventureState,
  command: AdventureCommand,
): AdventureResult {
  try {
    order(state, command);
    const next = clone(state),
      map = mapFor(defs, state.active.mapId);
    if (command.kind === "move") {
      keys(command, ["kind", "direction", "sequence", "revision"]);
      if (!["up", "down", "left", "right"].includes(command.direction))
        fail("Invalid move direction");
      const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[
        command.direction
      ];
      if (!delta) fail("Invalid move direction");
      const x = (next.active.player % map.width) + delta[0],
        y = Math.floor(next.active.player / map.width) + delta[1];
      if (
        x < 0 ||
        x >= map.width ||
        y < 0 ||
        y >= map.height ||
        map.walls.includes(y * map.width + x)
      )
        fail("Blocked adventure move");
      next.active.player = y * map.width + x;
    } else if (command.kind === "pickup") {
      keys(command, ["kind", "placementId", "token", "sequence", "revision"]);
      id(command.placementId);
      const pickup =
        map.pickups.find((p) => p.id === command.placementId) ??
        fail("Missing pickup");
      if (!near(map, state.active.player, pickup.cell))
        fail("Pickup out of reach");
      if (adventurePickupCollected(state, map.id, pickup.id))
        fail("Pickup already collected");
      token(next.campaign, command.token);
      effects(defs, next.campaign, pickup.effects);
      next.campaign.removedPickups.push({
        mapId: map.id,
        placementId: pickup.id,
      });
    } else if (command.kind === "dialogue") {
      keys(command, [
        "kind",
        "dialogueId",
        "choiceId",
        "token",
        "sequence",
        "revision",
      ]);
      id(command.dialogueId);
      id(command.choiceId);
      const dialogue =
        map.dialogues.find((d) => d.id === command.dialogueId) ??
        fail("Missing dialogue");
      if (!near(map, state.active.player, dialogue.cell))
        fail("Dialogue out of reach");
      const availableChoice = adventureDialogue(
        defs,
        state,
        dialogue.id,
      ).choiceId;
      if (availableChoice === null || availableChoice !== command.choiceId)
        fail("Dialogue choice unavailable");
      token(next.campaign, command.token);
      effects(defs, next.campaign, dialogue.effects);
    } else fail("Unknown adventure command");
    next.campaign.revision++;
    next.campaign.sequence = command.sequence;
    validateCampaign(defs, next.campaign);
    validateActive(defs, next.active, next.campaign);
    return { ok: true, state: next };
  } catch (error) {
    return rejected(state, error);
  }
}
/** The caller loads target presentation before commit. Neither prepare nor failure changes current state. */
export function prepareAdventureTransition(
  defs: AdventureDefinitions,
  state: AdventureState,
  command: AdventureTravelCommand,
): AdventureTransitionResult {
  try {
    order(state, command);
    keys(command, ["kind", "exitId", "token", "sequence", "revision"]);
    if (command.kind !== "travel") fail("Invalid travel command");
    id(command.exitId);
    const map = mapFor(defs, state.active.mapId),
      exit =
        map.exits.find((e) => e.id === command.exitId) ?? fail("Missing exit");
    if (!near(map, state.active.player, exit.cell)) fail("Exit out of reach");
    if (exit.requiresFlags?.some((flag) => state.campaign.flags[flag] !== true))
      fail("Exit capability requirement missing");
    const entrance = entranceFor(defs, exit.mapId, exit.entranceId),
      next = clone(state);
    token(next.campaign, command.token);
    next.campaign.checkpoint = {
      mapId: exit.mapId,
      entranceId: exit.entranceId,
    };
    next.campaign.revision++;
    next.campaign.sequence = command.sequence;
    num(next.active.epoch, 0, MAX - 1);
    next.active = {
      mapId: exit.mapId,
      entranceId: exit.entranceId,
      player: entrance.cell,
      epoch: next.active.epoch + 1,
    };
    validateCampaign(defs, next.campaign);
    validateActive(defs, next.active, next.campaign);
    return {
      ok: true,
      transition: {
        baseRevision: state.campaign.revision,
        baseSequence: state.campaign.sequence,
        baseState: canonical(state),
        targetMapId: exit.mapId,
        state: next,
        command: clone(command),
      },
    };
  } catch (error) {
    return rejected(state, error);
  }
}
export function commitAdventureTransition(
  defs: AdventureDefinitions,
  current: AdventureState,
  transition: AdventureTransition,
  loadedMapId: string,
): AdventureResult {
  try {
    if (
      transition.baseRevision !== current.campaign.revision ||
      transition.baseSequence !== current.campaign.sequence ||
      transition.baseState !== canonical(current)
    )
      fail("Stale staged map transition");
    // A proposal is caller-owned data, not authority. Derive its entire result
    // again from the currently committed state and authored exit command.
    const expected = prepareAdventureTransition(
      defs,
      current,
      transition.command,
    );
    if (!expected.ok) fail(expected.error);
    if (canonical(transition) !== canonical(expected.transition))
      fail("Modified or forged staged map transition");
    if (loadedMapId !== expected.transition.targetMapId)
      fail("Loaded map does not match staged transition");
    const state = expected.transition.state;
    return { ok: true, state };
  } catch (error) {
    return rejected(current, error);
  }
}
export function serializeCampaign(
  defs: AdventureDefinitions,
  campaign: AdventureCampaign,
): string {
  validateCampaign(defs, campaign);
  return canonical({
    version: 1,
    kind: "adventure-campaign",
    compatibilityVersion: defs.compatibilityVersion,
    campaign,
  });
}
export function restoreCampaign(
  defs: AdventureDefinitions,
  bytes: string,
): AdventureState {
  validateAdventureDefinitions(defs);
  const data = boundedJSON(bytes, 1048576, { rejectNegativeZero: true });
  keys(data, ["version", "kind", "compatibilityVersion", "campaign"]);
  if (
    data.version !== 1 ||
    data.kind !== "adventure-campaign" ||
    data.compatibilityVersion !== defs.compatibilityVersion
  )
    fail("Unsupported campaign save version");
  const campaign = validateCampaign(defs, data.campaign as AdventureCampaign),
    entrance = entranceFor(
      defs,
      campaign.checkpoint.mapId,
      campaign.checkpoint.entranceId,
    );
  validateProgression(defs, campaign);
  return {
    campaign,
    active: { ...campaign.checkpoint, player: entrance.cell, epoch: 0 },
  };
}
export function serializeAdventureCheckpoint(
  defs: AdventureDefinitions,
  state: AdventureState,
  identity: ProfileIdentity,
): string {
  validateCampaign(defs, state.campaign);
  validateActive(defs, state.active, state.campaign);
  if (identity.gameId !== defs.gameId)
    fail("Adventure checkpoint game mismatch");
  return canonical({
    version: 1,
    kind: "adventure-exact",
    gameId: identity.gameId,
    rulesBuildId: identity.rulesBuildId,
    contentId: identity.contentId,
    state,
  });
}
export function restoreAdventureCheckpoint(
  defs: AdventureDefinitions,
  identity: ProfileIdentity,
  bytes: string,
): AdventureState {
  validateAdventureDefinitions(defs);
  const data = boundedJSON(bytes, 1048576, { rejectNegativeZero: true });
  keys(data, [
    "version",
    "kind",
    "gameId",
    "rulesBuildId",
    "contentId",
    "state",
  ]);
  if (
    data.version !== 1 ||
    data.kind !== "adventure-exact" ||
    data.gameId !== defs.gameId ||
    data.gameId !== identity.gameId ||
    data.rulesBuildId !== identity.rulesBuildId ||
    data.contentId !== identity.contentId
  )
    fail("Adventure checkpoint identity mismatch");
  keys(data.state, ["campaign", "active"]);
  const state = data.state as unknown as AdventureState;
  validateCampaign(defs, state.campaign);
  validateProgression(defs, state.campaign);
  validateActive(defs, state.active, state.campaign);
  return state;
}
