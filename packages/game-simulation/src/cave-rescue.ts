import { validateCaveContent } from "@onepage/game-project/cave-validation";
import type {
  CaveContent,
  CaveDirection,
  CavePoint,
} from "@onepage/game-project/cave-types";
import {
  TerrainField,
  type TerrainSnapshot,
  type TerrainReceipt,
} from "./terrain-field";
import {
  stageTerrainEdits,
  drillFootprint,
  diskTerrainCells,
} from "./terrain-edit";
import type { TerrainEffect } from "./terrain-edit";
import {
  caveActorRect,
  caveClear,
  caveRectsOverlap,
  moveCaveActor,
} from "./cave-motor";
import { CaveNavigation, type CaveNavigationSnapshot } from "./cave-navigation";
import {
  caveSupportedNodes,
  createCaveSupport,
  stageCaveSupport,
  type CaveSupportState,
} from "./cave-support";
import {
  CAVE_RULES_VERSION,
  CAVE_CHECKPOINT_BYTES,
  CAVE_PROGRESS_BYTES,
  caveCheckpointAdmissionBound,
  caveProgressAdmissionBound,
  caveCopy,
  caveDataBytes,
  caveFields,
  caveInteger,
} from "./cave-save";
import { raycastField } from "./terrain-query";
export interface CaveCommand {
  moveX?: -1 | 0 | 1;
  moveY?: -1 | 0 | 1;
  aim?: CaveDirection;
  drill?: boolean;
  charge?: boolean;
  brace?: string;
  cancel?: boolean;
  tick?: number;
  sourceId?: string;
  sequence?: number;
}
export interface CaveActor {
  id: string;
  x: number;
  y: number;
  hp: number;
}
export interface CaveDrone {
  id: string;
  x: number;
  y: number;
  rescued: boolean;
  extracted: boolean;
}
export interface CaveCharge {
  id: number;
  x: number;
  y: number;
  dueTick: number;
}
export interface CaveEvent {
  id: number;
  tick: number;
  kind: string;
  subject: string;
  amount: number;
}
interface CaveState {
  tick: number;
  stateRevision: number;
  status: "playing" | "defeated" | "complete";
  player: CaveActor;
  drones: CaveDrone[];
  inventory: { charges: number; braces: number };
  ore: number;
  support: CaveSupportState;
  charges: CaveCharge[];
  nextChargeId: number;
  nextEventId: number;
  lastSequence: number;
  aim: CaveDirection;
  nextDrillTick: number;
  events: CaveEvent[];
  lastTerrainReceipt: TerrainReceipt | null;
}
export interface CaveCheckpoint {
  version: "cave-checkpoint-v1";
  rulesVersion: string;
  rulesBuildId: string;
  content: CaveContent;
  terrain: TerrainSnapshot;
  state: CaveState;
  navigation: CaveNavigationSnapshot;
}
export interface CaveProgress {
  version: "cave-progress-v1";
  baseEntryPolicy: "cave-base-entry-v1";
  checkpoint: CaveCheckpoint;
}
export interface CaveDiagnosticEntry {
  tick: number;
  events: CaveEvent[];
  terrain: TerrainReceipt;
  bytes: number;
}
const directions: Record<CaveDirection, CavePoint> = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};
const contains = (content: CaveContent, p: CavePoint) => {
  const r = content.extraction;
  return (
    p.x >= r.x &&
    p.y >= r.y &&
    p.x + 2048 <= r.x + r.width &&
    p.y + 2048 <= r.y + r.height
  );
};
/** Blast cover uses closed rays except a solid touched only at the source while
 * the ray immediately exits that cell. Such a contact cannot shield an actor
 * on the source's clear side; later face/corner contacts still block exposure. */
function caveBlastCovered(
  field: TerrainField,
  origin: CavePoint,
  delta: CavePoint,
): boolean {
  return raycastField(field, origin, delta).contacts.some((contact) => {
    if (contact.time.n !== 0) return true;
    const left = contact.cell.x * 1024,
      top = contact.cell.y * 1024;
    const exitsAtOrigin =
      (origin.x === left && delta.x < 0) ||
      (origin.x === left + 1024 && delta.x > 0) ||
      (origin.y === top && delta.y < 0) ||
      (origin.y === top + 1024 && delta.y > 0);
    return !exitsAtOrigin;
  });
}
/** Sole cave authority; drones are immune and all actors are mutually nonblocking. */
export class CaveRescueOwner {
  readonly content: CaveContent;
  readonly rulesBuildId: string;
  readonly checkpointAdmissionBytes: number;
  readonly progressAdmissionBytes: number;
  private readonly extractionGoal: CavePoint;
  private field: TerrainField;
  private navigation: CaveNavigation;
  private state: CaveState;
  private diagnostics: CaveDiagnosticEntry[] = [];
  private diagnosticBytes = 0;
  private diagnosticEvictions = 0;
  private terrainObservation: TerrainSnapshot | undefined;
  constructor(content: CaveContent, rulesBuildId = "cave-focused-test-build") {
    this.content = validateCaveContent(content);
    if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(rulesBuildId))
      throw Error("Cave rules build identity");
    this.rulesBuildId = rulesBuildId;
    const contentBytes = caveDataBytes(this.content, 524288);
    this.checkpointAdmissionBytes = caveCheckpointAdmissionBound(
      contentBytes,
      this.content.drones.length,
    );
    this.progressAdmissionBytes = caveProgressAdmissionBound(contentBytes);
    this.extractionGoal = {
      x: Math.ceil(this.content.extraction.x / 2048) * 2048,
      y: Math.ceil(this.content.extraction.y / 2048) * 2048,
    };
    if (!contains(this.content, this.extractionGoal))
      throw Error(
        "Cave extraction pad requires a full coarse navigation footprint",
      );
    this.field = new TerrainField(this.content);
    this.navigation = new CaveNavigation(this.field);
    this.state = this.initialState();
  }
  private initialState(): CaveState {
    return {
      tick: 0,
      stateRevision: 0,
      status: "playing",
      player: { ...this.content.player },
      drones: this.content.drones.map((d) => ({
        ...d,
        rescued: false,
        extracted: false,
      })),
      inventory: {
        charges: this.content.tools.charges,
        braces: this.content.tools.braces,
      },
      ore: 0,
      support: createCaveSupport(this.content, this.field),
      charges: [],
      nextChargeId: 1,
      nextEventId: 1,
      lastSequence: 0,
      aim: "right",
      nextDrillTick: 0,
      events: [],
      lastTerrainReceipt: null,
    };
  }
  restart(): void {
    this.field = new TerrainField(this.content);
    this.navigation = new CaveNavigation(this.field);
    this.state = this.initialState();
    this.diagnostics = [];
    this.diagnosticBytes = 0;
    this.diagnosticEvictions = 0;
    this.terrainObservation = undefined;
  }
  private decode(
    command: CaveCommand,
  ): Required<Omit<CaveCommand, "brace">> & { brace: string | undefined } {
    caveDataBytes(command, 2048);
    if (
      !command ||
      typeof command !== "object" ||
      Array.isArray(command) ||
      Object.getPrototypeOf(command) !== Object.prototype
    )
      throw Error("Cave command requires plain object");
    const allowed = [
      "moveX",
      "moveY",
      "aim",
      "drill",
      "charge",
      "brace",
      "cancel",
      "tick",
      "sourceId",
      "sequence",
    ];
    if (Object.keys(command).some((k) => !allowed.includes(k)))
      throw Error("Unknown cave command field");
    if (Object.hasOwn(command, "aim") && typeof command.aim !== "string")
      throw Error("Invalid cave aim");
    const input = {
      moveX: command.moveX ?? 0,
      moveY: command.moveY ?? 0,
      aim: command.aim ?? this.state.aim,
      drill: command.drill ?? false,
      charge: command.charge ?? false,
      brace: command.brace,
      cancel: command.cancel ?? false,
      tick: command.tick ?? this.state.tick + 1,
      sourceId: command.sourceId ?? this.content.player.id,
      sequence: command.sequence ?? this.state.lastSequence + 1,
    };
    for (const value of [input.moveX, input.moveY]) caveInteger(value, -1, 1);
    if (
      typeof input.aim !== "string" ||
      !Object.hasOwn(directions, input.aim) ||
      [input.drill, input.charge, input.cancel].some(
        (b) => typeof b !== "boolean",
      ) ||
      input.tick !== this.state.tick + 1 ||
      input.sourceId !== this.content.player.id ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence <= this.state.lastSequence ||
      (typeof input.brace !== "undefined" && typeof input.brace !== "string")
    )
      throw Error("Invalid/stale cave command");
    if (input.cancel)
      return {
        ...input,
        moveX: 0,
        moveY: 0,
        drill: false,
        charge: false,
        brace: undefined,
      };
    return input;
  }
  private predictedPlayer(input: { moveX: number; moveY: number }): CaveActor {
    const speed = input.moveX && input.moveY ? 362 : 512;
    return {
      ...this.state.player,
      ...moveCaveActor(
        this.field,
        this.state.player,
        input.moveX * speed,
        input.moveY * speed,
      ),
    };
  }
  private chargePoint(player: CavePoint, aim: CaveDirection): CavePoint {
    const direction = directions[aim];
    return {
      x: player.x + 1024 + direction.x * 1024,
      y: player.y + 1024 + direction.y * 1024,
    };
  }
  private availableTools(
    player: CavePoint,
    aim: CaveDirection,
  ): { charge: boolean; braceSockets: string[] } {
    if (this.state.status !== "playing")
      return { charge: false, braceSockets: [] };
    const point = this.chargePoint(player, aim),
      distance = (socket: CavePoint) => {
        const dx = socket.x - player.x - 1024,
          dy = socket.y - player.y - 1024;
        return dx * dx + dy * dy;
      };
    const sockets =
      this.state.inventory.braces < 1
        ? []
        : this.content.roof.braceSockets.filter(
            (socket) =>
              !this.state.support.braces.includes(socket.id) &&
              distance(socket) <=
                this.content.tools.braceReach * this.content.tools.braceReach &&
              caveClear(this.field, {
                x: socket.x - 512,
                y: socket.y - 512,
                width: 1024,
                height: 1024,
              }),
          );
    return {
      charge:
        this.state.inventory.charges > 0 &&
        this.state.charges.length < 4 &&
        caveClear(this.field, { ...point, width: 1, height: 1 }),
      braceSockets: [...sockets]
        .sort(
          (a, b) =>
            distance(a) - distance(b) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .map((socket) => socket.id),
    };
  }
  /** Nonmutating tool ingress query; uses this command's swept post-movement pose. */
  toolAvailability(command: CaveCommand = {}): {
    charge: boolean;
    braceSockets: string[];
  } {
    const input = this.decode(command);
    return this.availableTools(this.predictedPlayer(input), input.aim);
  }
  step(command: CaveCommand = {}): ReturnType<CaveRescueOwner["observe"]> {
    const input = this.decode(command);
    if (this.state.status !== "playing") return this.observe();
    if (
      this.state.tick >= 1000000000 ||
      this.state.nextEventId > 1000000000 - 256 ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence > 1000000000
    )
      throw Error("Cave lifetime counter cap: export/restart");
    const tick = this.state.tick + 1,
      player = this.predictedPlayer(input),
      inventory = { ...this.state.inventory };
    const available =
      input.charge || input.brace !== undefined
        ? this.availableTools(player, input.aim)
        : undefined;
    let placed: CaveCharge | undefined;
    if (input.charge) {
      if (!available!.charge)
        throw Error(
          "Cave charge unavailable: inventory/live cap or obstructed placement",
        );
      placed = {
        id: this.state.nextChargeId,
        ...this.chargePoint(player, input.aim),
        dueTick: tick + this.content.tools.chargeFuse,
      };
      inventory.charges--;
    }
    if (input.brace !== undefined) {
      if (!available!.braceSockets.includes(input.brace))
        throw Error(
          "Cave brace unavailable: inventory/socket/range/obstruction",
        );
      inventory.braces--;
    }
    const due = this.state.charges
        .filter((c) => c.dueTick <= tick)
        .sort((a, b) => a.id - b.id),
      effects: TerrainEffect[] = [];
    let nextDrillTick = this.state.nextDrillTick;
    if (input.drill && tick >= nextDrillTick) {
      effects.push({
        sourceId: this.content.player.id,
        sequence: input.sequence,
        kind: "drill",
        cells: drillFootprint(
          this.field,
          caveActorRect(player),
          input.aim,
          this.content.tools.drillReach,
        ),
        damage: this.content.tools.drillDamage,
      });
      nextDrillTick = tick + 6;
    }
    for (const c of due)
      effects.push({
        sourceId: `charge-${c.id}`,
        sequence: c.id,
        kind: "blast",
        cells: diskTerrainCells(this.field, c, this.content.tools.chargeRadius),
        damage: this.content.tools.chargeDamage,
      });
    const terrain = stageTerrainEdits(this.field, effects),
      preview = terrain.preview();
    const support = stageCaveSupport(
        this.content,
        preview,
        this.state.support,
        input.brace,
      ),
      events: CaveEvent[] = [];
    let nextEventId = this.state.nextEventId;
    const emit = (kind: string, subject: string, amount = 0) =>
      events.push({ id: nextEventId++, tick, kind, subject, amount });
    // Brace admission is explicit and precedes all expiry/collapse events.
    if (input.brace) emit("brace-installed", input.brace, 1);
    if (placed) emit("charge-placed", String(placed.id), 1);
    for (const c of due) {
      emit("charge-detonated", String(c.id));
      const dx = player.x + 1024 - c.x,
        dy = player.y + 1024 - c.y;
      if (
        dx * dx + dy * dy <=
          this.content.tools.chargeRadius * this.content.tools.chargeRadius &&
        !caveBlastCovered(this.field, c, { x: dx, y: dy })
      ) {
        player.hp = Math.max(0, player.hp - this.content.tools.chargeDamage);
        emit(
          "player-damage",
          this.content.player.id,
          this.content.tools.chargeDamage,
        );
      }
    }
    for (const e of support.events) {
      emit(e.kind, e.zoneId);
      if (
        e.kind === "roof-collapse" &&
        caveRectsOverlap(
          caveActorRect(player),
          this.content.roof.zones.find((z) => z.id === e.zoneId)!.rect,
        )
      ) {
        player.hp = Math.max(0, player.hp - this.content.tools.roofDamage);
        emit(
          "player-damage",
          this.content.player.id,
          this.content.tools.roofDamage,
        );
      }
    }
    const pending = [
      ...this.state.charges.filter((c) => !due.some((d) => d.id === c.id)),
      ...(placed ? [placed] : []),
    ];
    const charges = pending.map((c) => {
      const chained = due.some(
        (d) =>
          (d.x - c.x) * (d.x - c.x) + (d.y - c.y) * (d.y - c.y) <=
          this.content.tools.chargeRadius * this.content.tools.chargeRadius,
      );
      return {
        ...c,
        dueTick: chained ? Math.min(c.dueTick, tick + 1) : c.dueTick,
      };
    });
    const navigation = this.navigation.fork();
    const drones = this.state.drones.map((d) => {
      let next = { ...d };
      if (
        !next.rescued &&
        Math.abs(next.x - player.x) + Math.abs(next.y - player.y) <= 4096
      ) {
        next.rescued = true;
        emit("drone-rescued", next.id);
      }
      if (next.rescued && !next.extracted)
        next = { ...next, ...navigation.move(this.field, next) };
      if (next.rescued && !next.extracted && contains(this.content, next)) {
        next.extracted = true;
        emit("drone-extracted", next.id);
      }
      return next;
    });
    let status: CaveState["status"] = player.hp === 0 ? "defeated" : "playing";
    if (status === "defeated") emit("defeat", player.id);
    else if (
      drones.every((d) => d.extracted) &&
      contains(this.content, player)
    ) {
      status = "complete";
      emit("extraction-complete", player.id);
    }
    navigation.publishTerrain(preview, preview.terrainRevision);
    navigation.advance(
      preview,
      drones.filter((d) => d.rescued && !d.extracted),
      this.extractionGoal,
    );
    // Publish only after terrain, support, movement, navigation and events stage successfully.
    terrain.commit();
    this.navigation = navigation;
    this.state = {
      tick,
      stateRevision: this.state.stateRevision + 1,
      status,
      player,
      drones,
      inventory,
      ore: this.field.rewardTotal,
      support: support.state,
      charges,
      nextChargeId: this.state.nextChargeId + (placed ? 1 : 0),
      nextEventId,
      lastSequence: input.sequence,
      aim: input.aim,
      nextDrillTick,
      events,
      lastTerrainReceipt: terrain.receipt,
    };
    const bytes =
        64 + events.length * 256 + terrain.receipt.changes.length * 1024,
      entry = {
        tick,
        events: events.map((e) => ({ ...e })),
        terrain: terrain.receipt,
        bytes,
      };
    this.diagnostics.push(entry);
    this.diagnosticBytes += bytes;
    while (
      this.diagnostics.length > 120 ||
      this.diagnosticBytes > 2 * 1024 * 1024
    ) {
      this.diagnosticBytes -= this.diagnostics.shift()!.bytes;
      this.diagnosticEvictions++;
    }
    return this.observe();
  }
  private copyState(): CaveState {
    const s = this.state;
    return {
      ...s,
      player: { ...s.player },
      drones: s.drones.map((d) => ({ ...d })),
      inventory: { ...s.inventory },
      support: {
        braces: [...s.support.braces],
        zones: s.support.zones.map((z) => ({ ...z })),
      },
      charges: s.charges.map((c) => ({ ...c })),
      events: s.events.map((e) => ({ ...e })),
      lastTerrainReceipt: s.lastTerrainReceipt
        ? {
            ...s.lastTerrainReceipt,
            changes: s.lastTerrainReceipt.changes.map((c) => ({
              ...c,
              causes: [...c.causes],
            })),
            dirtyChunks: [...s.lastTerrainReceipt.dirtyChunks],
          }
        : null,
    };
  }
  private observeTerrain(): TerrainSnapshot {
    if (
      !this.terrainObservation ||
      this.terrainObservation.stateRevision !== this.field.stateRevision
    ) {
      const s = this.field.snapshot();
      Object.freeze(s.cells);
      Object.freeze(s.hp);
      Object.freeze(s.chunkRevisions);
      this.terrainObservation = Object.freeze(s);
    }
    return this.terrainObservation;
  }
  observe() {
    return {
      ...this.copyState(),
      contentId: this.content.id,
      drones: this.state.drones.map((d) => ({
        ...d,
        mode: d.extracted
          ? "extracted"
          : !d.rescued
            ? "stranded"
            : this.navigation.mode(d.id),
      })),
      terrain: this.observeTerrain(),
      navigation: this.navigation.observe(),
      diagnostics: {
        entries: this.diagnostics.map((e) => ({
          tick: e.tick,
          events: e.events.length,
          changedCells: e.terrain.changes.length,
          bytes: e.bytes,
        })),
        bytes: this.diagnosticBytes,
        evictedTicks: this.diagnosticEvictions,
        truncated: this.diagnosticEvictions > 0,
        maxTicks: 120,
        maxBytes: 2 * 1024 * 1024,
      },
    };
  }
  /** Detached causal evidence on demand; the normal observation carries summaries. */
  inspectDiagnostics(): CaveDiagnosticEntry[] {
    return caveCopy(this.diagnostics);
  }
  capture(): CaveCheckpoint {
    const snapshot: CaveCheckpoint = {
      version: "cave-checkpoint-v1",
      rulesVersion: CAVE_RULES_VERSION,
      rulesBuildId: this.rulesBuildId,
      content: this.content,
      terrain: this.field.snapshot(),
      state: caveCopy(this.state),
      navigation: this.navigation.capture(),
    };
    caveDataBytes(snapshot);
    return caveCopy(snapshot);
  }
  restore(value: unknown): void {
    caveDataBytes(value);
    caveFields(value, [
      "version",
      "rulesVersion",
      "rulesBuildId",
      "content",
      "terrain",
      "state",
      "navigation",
    ]);
    if (
      value.version !== "cave-checkpoint-v1" ||
      value.rulesVersion !== CAVE_RULES_VERSION ||
      value.rulesBuildId !== this.rulesBuildId ||
      JSON.stringify(value.content) !== JSON.stringify(this.content)
    )
      throw Error("Incompatible cave checkpoint identity/content");
    const candidate = new CaveRescueOwner(this.content, this.rulesBuildId);
    candidate.field.restore(value.terrain);
    candidate.validateState(value.state);
    const state = caveCopy(value.state as CaveState);
    candidate.navigation.restore(
      value.navigation as CaveNavigationSnapshot,
      candidate.field,
      candidate.field.terrainRevision,
      state.drones.filter((d) => d.rescued && !d.extracted),
      this.extractionGoal,
    );
    candidate.state = state;
    this.field = candidate.field;
    this.navigation = candidate.navigation;
    this.state = candidate.state;
    this.diagnostics = [];
    this.diagnosticBytes = 0;
    this.diagnosticEvictions = 0;
    this.terrainObservation = undefined;
  }
  private validateState(value: unknown): void {
    caveFields(value, [
      "tick",
      "stateRevision",
      "status",
      "player",
      "drones",
      "inventory",
      "ore",
      "support",
      "charges",
      "nextChargeId",
      "nextEventId",
      "lastSequence",
      "aim",
      "nextDrillTick",
      "events",
      "lastTerrainReceipt",
    ]);
    const s = value as unknown as CaveState;
    caveInteger(s.tick, 0, 1000000000);
    if (this.field.stateRevision > s.tick)
      throw Error("Cave terrain revision exceeds owner clock");
    if (s.stateRevision !== s.tick) throw Error("Cave owner revision");
    caveInteger(s.lastSequence, s.tick, 1000000000);
    caveInteger(s.nextEventId, 1, 1000000000);
    caveInteger(s.nextChargeId, 1, 5);
    caveInteger(s.nextDrillTick, 0, s.tick + 6);
    if (typeof s.aim !== "string" || !Object.hasOwn(directions, s.aim))
      throw Error("Cave aim");
    caveFields(s.player, ["id", "x", "y", "hp"]);
    if (s.player.id !== this.content.player.id)
      throw Error("Cave player identity");
    caveInteger(s.player.hp, 0, this.content.player.hp);
    const position = (p: CavePoint) => {
      caveInteger(p.x, 0, 129024);
      caveInteger(p.y, 0, 129024);
      if (!caveClear(this.field, caveActorRect(p)))
        throw Error("Cave embedded actor");
    };
    position(s.player);
    if (
      !Array.isArray(s.drones) ||
      s.drones.length !== this.content.drones.length
    )
      throw Error("Cave drone count");
    s.drones.forEach((d, i) => {
      caveFields(d, ["id", "x", "y", "rescued", "extracted"]);
      if (
        d.id !== this.content.drones[i].id ||
        typeof d.rescued !== "boolean" ||
        typeof d.extracted !== "boolean" ||
        (d.extracted && !d.rescued) ||
        (!d.rescued &&
          (d.x !== this.content.drones[i].x ||
            d.y !== this.content.drones[i].y)) ||
        (d.extracted && !contains(this.content, d))
      )
        throw Error("Cave drone state");
      position(d);
    });
    caveFields(s.inventory, ["charges", "braces"]);
    caveInteger(s.inventory.charges, 0, this.content.tools.charges);
    caveInteger(s.inventory.braces, 0, this.content.tools.braces);
    if (s.ore !== this.field.rewardTotal)
      throw Error("Cave reward conservation");
    caveFields(s.support, ["braces", "zones"]);
    if (
      !Array.isArray(s.support.braces) ||
      new Set(s.support.braces).size !== s.support.braces.length ||
      s.support.braces.some(
        (id) => !this.content.roof.braceSockets.some((b) => b.id === id),
      ) ||
      s.support.braces.length + s.inventory.braces !==
        this.content.tools.braces ||
      !Array.isArray(s.support.zones) ||
      s.support.zones.length !== this.content.roof.zones.length
    )
      throw Error("Cave support inventory/state");
    const active = caveSupportedNodes(
      this.content,
      this.field,
      s.support.braces,
    );
    s.support.zones.forEach((z, i) => {
      caveFields(z, ["id", "status", "remaining"]);
      const authored = this.content.roof.zones[i],
        supported = authored.nodeIds.some((id) => active.has(id));
      if (
        z.id !== authored.id ||
        !["supported", "warning", "collapsed"].includes(z.status) ||
        (z.status === "supported" && !supported) ||
        (z.status === "warning" && supported)
      )
        throw Error("Cave support graph state");
      caveInteger(
        z.remaining,
        z.status === "warning" ? 1 : 0,
        z.status === "warning" ? 120 : 0,
      );
    });
    if (!Array.isArray(s.charges) || s.charges.length > 4)
      throw Error("Cave charge cap");
    let prior = 0;
    for (const c of s.charges) {
      caveFields(c, ["id", "x", "y", "dueTick"]);
      caveInteger(c.id, prior + 1, s.nextChargeId - 1);
      prior = c.id;
      caveInteger(c.x, 0, 131071);
      caveInteger(c.y, 0, 131071);
      caveInteger(
        c.dueTick,
        s.tick + 1,
        s.tick + this.content.tools.chargeFuse,
      );
      if (!caveClear(this.field, { x: c.x, y: c.y, width: 1, height: 1 }))
        throw Error("Cave embedded charge");
    }
    if (s.inventory.charges + s.nextChargeId - 1 !== this.content.tools.charges)
      throw Error("Cave charge spend");
    if (
      !Array.isArray(s.events) ||
      s.events.length > 256 ||
      s.nextEventId > 1 + s.tick * 256 ||
      (s.tick === 0 && (s.events.length || s.nextEventId !== 1))
    )
      throw Error("Cave event cap/clock");
    for (let i = 0; i < s.events.length; i++) {
      const e = s.events[i];
      caveFields(e, ["id", "tick", "kind", "subject", "amount"]);
      if (
        e.id !== s.nextEventId - s.events.length + i ||
        e.tick !== s.tick ||
        typeof e.kind !== "string" ||
        typeof e.subject !== "string"
      )
        throw Error("Cave event ordering/clock");
      caveInteger(e.amount);
      const valid =
        e.kind === "brace-installed"
          ? this.content.roof.braceSockets.some((b) => b.id === e.subject) &&
            s.support.braces.includes(e.subject) &&
            e.amount === 1
          : e.kind === "charge-placed"
            ? /^[1-4]$/.test(e.subject) &&
              Number(e.subject) < s.nextChargeId &&
              e.amount === 1
            : e.kind === "charge-detonated"
              ? /^[1-4]$/.test(e.subject) &&
                Number(e.subject) < s.nextChargeId &&
                e.amount === 0
              : e.kind === "player-damage"
                ? e.subject === s.player.id &&
                  [
                    this.content.tools.chargeDamage,
                    this.content.tools.roofDamage,
                  ].includes(e.amount)
                : ["roof-warning", "roof-supported", "roof-collapse"].includes(
                      e.kind,
                    )
                  ? this.content.roof.zones.some((z) => z.id === e.subject) &&
                    e.amount === 0
                  : ["drone-rescued", "drone-extracted"].includes(e.kind)
                    ? s.drones.some(
                        (d) =>
                          d.id === e.subject &&
                          d.rescued &&
                          (e.kind !== "drone-extracted" || d.extracted),
                      ) && e.amount === 0
                    : ["defeat", "extraction-complete"].includes(e.kind)
                      ? e.subject === s.player.id && e.amount === 0
                      : false;
      if (!valid) throw Error("Cave semantic event");
    }
    const expected =
      s.player.hp === 0
        ? "defeated"
        : s.drones.every((d) => d.extracted) && contains(this.content, s.player)
          ? "complete"
          : "playing";
    if (s.status !== expected) throw Error("Cave objective/status state");
    if (s.lastTerrainReceipt !== null) {
      const receipt = s.lastTerrainReceipt;
      caveFields(receipt, [
        "stateRevision",
        "terrainRevision",
        "changes",
        "dirtyChunks",
        "reward",
        "candidates",
      ]);
      if (
        receipt.stateRevision !== this.field.stateRevision ||
        receipt.terrainRevision !== this.field.terrainRevision ||
        !Array.isArray(receipt.changes) ||
        receipt.changes.length > 1280 ||
        !Array.isArray(receipt.dirtyChunks)
      )
        throw Error("Cave terrain receipt");
      caveInteger(receipt.candidates, receipt.changes.length, 1280);
      let prior = -1,
        reward = 0;
      const chunks = new Set<number>();
      for (const c of receipt.changes) {
        caveFields(c, [
          "id",
          "x",
          "y",
          "material",
          "previousHp",
          "hp",
          "removed",
          "reward",
          "causes",
        ]);
        caveInteger(c.id, prior + 1, 16383);
        prior = c.id;
        const current = this.field.cell(c.id % 128, Math.floor(c.id / 128)),
          material = this.content.materials[this.content.cells[c.id]];
        if (
          c.x !== current.x ||
          c.y !== current.y ||
          c.material !== this.content.cells[c.id] ||
          c.hp !== current.hp ||
          c.removed !== (c.hp === 0) ||
          current.protected ||
          c.reward !== (c.removed ? material.oreYield : 0)
        )
          throw Error("Cave receipt cell state");
        caveInteger(c.previousHp, 1, material.hp);
        caveInteger(c.hp, 0, c.previousHp - 1);
        const causes = c.causes;
        if (
          !Array.isArray(causes) ||
          !causes.length ||
          causes.length > 5 ||
          causes.some(
            (cause, i) =>
              typeof cause !== "string" ||
              !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(cause) ||
              (i > 0 && cause <= causes[i - 1]),
          )
        )
          throw Error("Cave receipt causes");
        reward += c.reward;
        chunks.add(Math.floor(c.y / 16) * 8 + Math.floor(c.x / 16));
      }
      const expected = [...chunks].sort((a, b) => a - b);
      if (
        receipt.reward !== reward ||
        receipt.dirtyChunks.length !== expected.length ||
        receipt.dirtyChunks.some((id, i) => id !== expected[i])
      )
        throw Error("Cave receipt totals/chunks");
    }
  }
  captureProgress(): CaveProgress {
    if (
      !contains(this.content, this.state.player) ||
      this.state.charges.length ||
      this.state.support.zones.some((z) => z.status === "warning") ||
      this.state.status === "defeated"
    )
      throw Error(
        "Cave progress requires safe extraction pad; use exact checkpoint",
      );
    const checkpoint = this.capture(),
      navigation = new CaveNavigation(this.field);
    navigation.publishTerrain(this.field, this.field.terrainRevision);
    checkpoint.navigation = navigation.capture();
    checkpoint.state.events = [];
    checkpoint.state.lastTerrainReceipt = null;
    checkpoint.state.nextDrillTick = checkpoint.state.tick;
    checkpoint.state.aim = "right";
    const progress: CaveProgress = {
      version: "cave-progress-v1",
      baseEntryPolicy: "cave-base-entry-v1",
      checkpoint,
    };
    caveDataBytes(progress, CAVE_PROGRESS_BYTES);
    return progress;
  }
  restoreProgress(value: unknown): void {
    caveDataBytes(value, CAVE_PROGRESS_BYTES);
    caveFields(value, ["version", "baseEntryPolicy", "checkpoint"]);
    if (
      value.version !== "cave-progress-v1" ||
      value.baseEntryPolicy !== "cave-base-entry-v1"
    )
      throw Error("Incompatible cave progress");
    const candidate = new CaveRescueOwner(this.content, this.rulesBuildId);
    candidate.restore(value.checkpoint);
    candidate.captureProgress();
    candidate.state.player = {
      ...candidate.state.player,
      x: this.content.player.x,
      y: this.content.player.y,
    };
    candidate.state.nextDrillTick = candidate.state.tick;
    candidate.state.aim = "right";
    candidate.navigation = new CaveNavigation(candidate.field);
    candidate.navigation.publishTerrain(
      candidate.field,
      candidate.field.terrainRevision,
    );
    this.field = candidate.field;
    this.navigation = candidate.navigation;
    this.state = candidate.state;
    this.diagnostics = [];
    this.diagnosticBytes = 0;
    this.diagnosticEvictions = 0;
    this.terrainObservation = undefined;
  }
}
export const createCaveRescue = (content: CaveContent, rulesBuildId?: string) =>
  new CaveRescueOwner(content, rulesBuildId);
