/** Semantic C1 owner. All inventory/stat changes commit through the existing M8b owner. */
import {
  boundedJSON,
  canonical,
  record,
  integer,
  string,
} from "@onepage/game-project/runtime";
import type { CharacterCatalog } from "@onepage/game-project/characters";
import {
  CHARACTER_BUILD_LIMITS,
  evaluateCharacterEquipment,
  validateCharacterBuildDefinition,
  type CharacterBuildDefinition,
  type CharacterEquipment,
} from "@onepage/game-project/character-build";
import { TransactionOwner, type TransactionOperation } from "./transactions";

export const CHARACTER_SESSION_LIMITS = Object.freeze({
  commits: 256,
  saveBytes: 1_048_576,
  authoredBytes: 524_288,
});
export type CharacterSessionAction =
  | {
      readonly kind: "create";
      readonly buildId: string;
      readonly appearanceId: string;
      readonly displayName: string;
    }
  | {
      readonly kind: "equip";
      readonly slotId: string;
      readonly itemId: string | null;
    }
  | {
      readonly kind: "customize";
      readonly appearanceId: string;
      readonly displayName: string;
    };
export interface CharacterSessionCommand {
  readonly id: string;
  readonly revision: number;
  readonly action: CharacterSessionAction;
}
export interface CharacterSessionReceipt {
  readonly id: string;
  readonly revision: number;
}
export interface CharacterInstance {
  readonly buildId: string;
  readonly appearanceId: string;
  readonly displayName: string;
  readonly equipment: readonly CharacterEquipment[];
}
export interface CharacterSessionCheckpoint {
  readonly format: "c1-character-session-v1";
  readonly definition: CharacterBuildDefinition;
  readonly catalog: CharacterCatalog;
  readonly revision: number;
  readonly character: CharacterInstance | null;
  readonly commands: readonly CharacterSessionCommand[];
  readonly transactions: ReturnType<TransactionOwner["capture"]>;
}
/** Reject accessors, aliases to exotic data, holes and excessive work before reading.
 * Save text additionally uses the runtime's duplicate-key and UTF-8 byte bounds. */
function plain(value: unknown): void {
  let nodes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 16)
      throw Error("Character session work cap");
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "string" && v.length <= 128) return;
    if (typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0))
      return;
    if (!v || typeof v !== "object")
      throw Error("Character session plain data required");
    const keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 256 ||
        keys.length !== v.length + 1
      )
        throw Error("Invalid character session array");
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !Object.hasOwn(d, "value"))
          throw Error("Invalid character session array entry");
        visit(d.value, depth + 1);
      }
      return;
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || keys.length > 32)
      throw Error("Invalid character session object");
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (
        typeof key !== "string" ||
        key === "__proto__" ||
        key.length > 128 ||
        !d.enumerable ||
        !Object.hasOwn(d, "value")
      )
        throw Error("Invalid character session field");
      visit(d.value, depth + 1);
    }
  };
  visit(value, 0);
}
function name(v: unknown): string {
  if (
    typeof v !== "string" ||
    !v.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "").length ||
    [...v].length > 64 ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/.test(
      v,
    )
  )
    throw Error("Invalid character display name");
  return v;
}
function command(value: unknown): CharacterSessionCommand {
  plain(value);
  const c = record(value, ["id", "revision", "action"]);
  const a = c.action as Record<string, unknown>;
  let action: CharacterSessionAction;
  if (a?.kind === "create") {
    record(a, ["kind", "buildId", "appearanceId", "displayName"]);
    action = {
      kind: "create",
      buildId: string(a.buildId),
      appearanceId: string(a.appearanceId),
      displayName: name(a.displayName),
    };
  } else if (a?.kind === "equip") {
    record(a, ["kind", "slotId", "itemId"]);
    action = {
      kind: "equip",
      slotId: string(a.slotId),
      itemId: a.itemId === null ? null : string(a.itemId),
    };
  } else if (a?.kind === "customize") {
    record(a, ["kind", "appearanceId", "displayName"]);
    action = {
      kind: "customize",
      appearanceId: string(a.appearanceId),
      displayName: name(a.displayName),
    };
  } else throw Error("Unknown character action");
  return {
    id: string(c.id),
    revision: integer(c.revision, 0, CHARACTER_SESSION_LIMITS.commits),
    action,
  };
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export class CharacterSessionOwner {
  private readonly definition: CharacterBuildDefinition;
  private readonly catalog: CharacterCatalog;
  private transactions: TransactionOwner;
  private commands: CharacterSessionCommand[] = [];
  private character: CharacterInstance | null = null;
  constructor(value: CharacterBuildDefinition, catalog: CharacterCatalog) {
    plain(catalog);
    this.catalog = copy(catalog);
    this.definition = validateCharacterBuildDefinition(value, this.catalog);
    // Reserve half the portable-save budget for the complete bounded witness.
    // 256 semantic commands plus <=15 short generated M8b operations each fit
    // the remaining half, including receipts and the selected instance.
    boundedJSON(
      canonical({ definition: this.definition, catalog: this.catalog }),
      CHARACTER_SESSION_LIMITS.authoredBytes,
    );
    this.transactions = new TransactionOwner({
      id: "c1-character-inventory-v1",
      resources: this.definition.items.map((_, i) => ({
        id: `item-${i}`,
        initial: 0,
        capacity: CHARACTER_BUILD_LIMITS.quantity,
      })),
      stats: this.definition.stats.map((_, i) => ({
        id: `stat-${i}`,
        initial: 0,
        min: -CHARACTER_BUILD_LIMITS.stat,
        max: CHARACTER_BUILD_LIMITS.stat,
      })),
      flags: ["created"],
      outcomes: ["creation"],
      rewardSeed: 0,
    });
  }
  execute(value: CharacterSessionCommand): CharacterSessionReceipt {
    const c = command(value);
    const previous = this.commands.find((x) => x.id === c.id);
    if (previous) {
      if (canonical(previous) !== canonical(c))
        throw Error("Conflicting character retry");
      return { id: previous.id, revision: previous.revision + 1 };
    }
    if (c.revision !== this.commands.length)
      throw Error("Stale character revision");
    if (this.commands.length === CHARACTER_SESSION_LIMITS.commits)
      throw Error("Character commit cap");
    const a = c.action;
    const before = this.transactions.capture();
    const inventory = before.resources.map((x) => x.quantity);
    let next: CharacterInstance;
    if (a.kind === "create") {
      if (this.character) throw Error("Character already created");
      const build = this.definition.builds.find((b) => b.id === a.buildId);
      if (!build) throw Error("Unknown character build");
      next = {
        buildId: build.id,
        appearanceId: a.appearanceId,
        displayName: a.displayName,
        equipment: build.equipment.map((e) => ({ ...e })),
      };
      for (const g of build.grants)
        inventory[this.definition.items.findIndex((x) => x.id === g.itemId)] +=
          g.quantity;
      for (const e of next.equipment)
        inventory[this.definition.items.findIndex((x) => x.id === e.itemId)]--;
    } else {
      if (!this.character) throw Error("Create character first");
      next = copy(this.character);
      if (a.kind === "customize")
        next = {
          ...next,
          appearanceId: a.appearanceId,
          displayName: a.displayName,
        };
      else {
        if (!this.definition.slots.includes(a.slotId))
          throw Error("Unknown equipment slot");
        const previousItem = next.equipment.find(
          (e) => e.slotId === a.slotId,
        )?.itemId;
        const equipment = next.equipment.filter((e) => e.slotId !== a.slotId);
        if (previousItem)
          inventory[
            this.definition.items.findIndex((x) => x.id === previousItem)
          ]++;
        if (a.itemId !== null) {
          const index = this.definition.items.findIndex(
            (x) => x.id === a.itemId,
          );
          if (index < 0) throw Error("Unknown equipment item");
          inventory[index]--;
          equipment.push({ slotId: a.slotId, itemId: a.itemId });
        }
        equipment.sort((x, y) => compare(x.slotId, y.slotId));
        next = { ...next, equipment };
      }
    }
    const build = this.definition.builds.find((b) => b.id === next.buildId)!;
    if (!build.appearanceIds.includes(next.appearanceId))
      throw Error("Appearance not permitted by build");
    const stats = evaluateCharacterEquipment(
      this.definition,
      next.buildId,
      next.equipment,
    );
    inventory.forEach((quantity) =>
      integer(quantity, 0, CHARACTER_BUILD_LIMITS.quantity),
    );
    const operations: TransactionOperation[] = [];
    inventory.forEach((quantity, i) => {
      const delta = quantity - before.resources[i].quantity;
      if (delta)
        operations.push({
          kind: delta < 0 ? "consume" : "grant",
          resource: `item-${i}`,
          amount: delta < 0 ? -delta : delta,
        });
    });
    stats.forEach((s, i) => {
      let delta = s.value - before.stats[i].value;
      if (
        delta > CHARACTER_BUILD_LIMITS.stat ||
        delta < -CHARACTER_BUILD_LIMITS.stat
      ) {
        const first =
          delta < 0
            ? -CHARACTER_BUILD_LIMITS.stat
            : CHARACTER_BUILD_LIMITS.stat;
        operations.push({ kind: "stat", stat: `stat-${i}`, delta: first });
        delta -= first;
      }
      operations.push({ kind: "stat", stat: `stat-${i}`, delta });
    });
    operations.push({ kind: "flag", flag: "created", value: true });
    // Creation: 8 item deltas + 6 stats + flag. Equipment: 2 item deltas
    // + at most 12 split stat deltas + flag. Both fit fifteen M8b operations.
    this.transactions.execute({
      id: `change-${c.revision}`,
      revision: c.revision,
      outcome: a.kind === "create" ? "creation" : null,
      operations,
    });
    this.character = next;
    this.commands.push(c);
    return { id: c.id, revision: this.commands.length };
  }
  inspect() {
    const state = this.transactions.capture();
    return {
      revision: this.commands.length,
      character: copy(this.character),
      inventory: this.definition.items.map((item, i) => ({
        itemId: item.id,
        quantity: state.resources[i].quantity,
      })),
      stats: this.definition.stats.map((stat, i) => ({
        statId: stat.id,
        value: state.stats[i].value,
      })),
    };
  }
  capture(): CharacterSessionCheckpoint {
    return {
      format: "c1-character-session-v1",
      definition: copy(this.definition),
      catalog: copy(this.catalog),
      revision: this.commands.length,
      character: copy(this.character),
      commands: copy(this.commands),
      transactions: this.transactions.capture(),
    };
  }
  /** Replay the finite semantic witness into temporary owners before any assignment. */
  restore(value: unknown): void {
    plain(value);
    const s = record(value, [
      "format",
      "definition",
      "catalog",
      "revision",
      "character",
      "commands",
      "transactions",
    ]);
    if (
      s.format !== "c1-character-session-v1" ||
      canonical(s.definition) !== canonical(this.definition) ||
      canonical(s.catalog) !== canonical(this.catalog)
    )
      throw Error("Incompatible character save");
    const revision = integer(s.revision, 0, CHARACTER_SESSION_LIMITS.commits);
    if (!Array.isArray(s.commands) || s.commands.length !== revision)
      throw Error("Invalid character history");
    const staged = new CharacterSessionOwner(this.definition, this.catalog);
    for (const c of s.commands) staged.execute(command(c));
    if (canonical(staged.capture()) !== canonical(value))
      throw Error("Inconsistent character save");
    this.transactions = staged.transactions;
    this.commands = staged.commands;
    this.character = staged.character;
  }
  save(): string {
    const bytes = canonical(this.capture());
    boundedJSON(bytes, CHARACTER_SESSION_LIMITS.saveBytes);
    return bytes;
  }
  load(bytes: string): void {
    this.restore(
      boundedJSON(bytes, CHARACTER_SESSION_LIMITS.saveBytes, {
        rejectNegativeZero: true,
      }),
    );
  }
}
