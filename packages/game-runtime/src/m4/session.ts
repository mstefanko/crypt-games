import {
  createArenaExecution as createArena,
  createGridExecution as createGrid,
  executeArenaFrame as advanceArena,
  executeGridCommand as applyGridCommand,
  restoreArenaExact as restoreArenaCheckpoint,
  restoreGridExact as restoreGridCheckpoint,
  createAdventureExecution as createAdventure,
  executeAdventureCommand as applyAdventureCommand,
  prepareAdventureTravel as prepareAdventureTransition,
  commitAdventureTravel as commitAdventureTransition,
  restoreAdventureExact as restoreAdventureCheckpoint,
  validateArenaInput,
  validateGridCommand,
  validateAdventureCommand,
  createDuelExecution,
  executeDuelFrame,
  restoreDuelExact,
  validateDuelFrame,
} from "../session/execution";
import { snapshotDefinitions } from "../m3/project";
import type { M3ProjectDefinitions } from "../../../game-project/src/m3-project";
import {
  scenarioDocument,
  validateScenarioDocument,
} from "./scenario-document";
import { acceptsRewardBoundary, rewardSlot } from "../m3/host-commands";
/** Development-only production-codec adapter. Do not import from player entries. */
import {
  observeArena,
  encodeArenaCheckpoint,
  type ArenaWorld,
  type ArenaIdentity,
  type ArenaInput,
} from "../../../game-simulation/src/m3/arena";
import {
  serializeGridCheckpoint,
  type GridState,
  type GridCommand,
} from "../../../game-simulation/src/m3/grid";
import {
  serializeAdventureCheckpoint,
  type AdventureState,
  type AdventureCommand,
  type AdventureTravelCommand,
} from "../../../game-simulation/src/m3/adventure";
import type { DuelGame } from "../m3/duel";
import type { InputFrame } from "../../../game-project/src/types";
import { actions } from "../input";
import {
  findScenario,
  namedScenarios,
  scenarioArenaDefinition,
  type M4Profile,
  type NamedScenario,
} from "./scenarios";
import {
  canonical,
  record,
  integer,
  string,
  boolean,
  detached,
  parseBounded,
  sha256,
  firstDifference,
  MAX_COMMANDS,
} from "./codec";
import {
  validateArtifact,
  type M4Artifact,
  type ArtifactEnvironment,
  type Attachment,
} from "./artifact";
export { namedScenarios };
export type { M4Profile, NamedScenario };
export interface SessionOptions {
  project: M3ProjectDefinitions;
  profile: M4Profile;
  identity: ArenaIdentity;
  buildId?: string;
  runtimeBuildId?: string;
  scenario?: string;
  checkpointInterval?: number;
}
export type M4Command =
  | { kind: "frame"; input: ArenaInput | InputFrame }
  | {
      kind: "command";
      command: GridCommand | AdventureCommand | AdventureTravelCommand;
    }
  | { kind: "pause"; paused: boolean }
  | { kind: "cancel" }
  | { kind: "restart" }
  | {
      kind: "director";
      action: "tick" | "complete" | "skip";
      epoch: number;
      slot: string;
      token: string;
      ticks?: number;
    };
export interface HostState {
  paused: boolean;
  epoch: number;
  pendingCancel: boolean;
  cinematic: null | { slot: string; tick: number; token: string };
}
export interface SessionSnapshot {
  index: number;
  bytes: string;
  host: HostState;
}
export interface LogEntry {
  index: number;
  clock: number;
  epoch: number;
  command: M4Command;
  outcome: string;
}
export class M4Error extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly jsonPointer = "",
  ) {
    super(message);
  }
}
/** Validate before any mutable production call, including terminal-state no-op calls. */
export function validateCommand(profile: M4Profile, value: unknown): M4Command {
  const x = parseBounded(value, 16384) as Record<string, unknown>;
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw Error("M4_COMMAND: expected object");
  if (x.kind === "frame") {
    record(x, ["kind", "input"]);
    const f = x.input as Record<string, unknown>;
    if (profile === "arena") {
      x.input = validateArenaInput(f);
    } else if (profile === "duel") {
      x.input = validateDuelFrame(f);
    } else throw Error("M4_CLOCK: turn profiles require one ordered command");
  } else if (x.kind === "command") {
    record(x, ["kind", "command"]);
    const c = x.command as Record<string, unknown>;
    if (!c || typeof c !== "object") throw Error("M4_COMMAND: missing command");
    if (profile === "grid") x.command = validateGridCommand(c);
    else if (profile === "adventure")
      x.command = validateAdventureCommand(c);
    else throw Error("M4_COMMAND: unsupported profile command");
  } else if (x.kind === "pause") {
    record(x, ["kind", "paused"]);
    boolean(x.paused);
  } else if (x.kind === "cancel" || x.kind === "restart") record(x, ["kind"]);
  else if (x.kind === "director") {
    const extra = Object.hasOwn(x, "ticks") ? ["ticks"] : [];
    record(x, ["kind", "action", "epoch", "slot", "token", ...extra]);
    if (!["tick", "complete", "skip"].includes(x.action as string))
      throw Error("M4_DIRECTOR: invalid boundary");
    integer(x.epoch, 0, Number.MAX_SAFE_INTEGER);
    string(x.slot);
    string(x.token);
    if ("ticks" in x) integer(x.ticks, 1, 200000);
    if (x.action === "tick" && !("ticks" in x))
      throw Error("M4_DIRECTOR: ticks required");
  } else throw Error("M4_COMMAND: unsupported command");
  return x as unknown as M4Command;
}
export class M4Session {
  readonly profile: M4Profile;
  readonly identity: ArenaIdentity;
  readonly buildId: string;
  readonly runtimeBuildId: string;
  private scenario: NamedScenario;
  private arena!: ArenaWorld;
  private grid!: GridState;
  private duel!: DuelGame;
  private adventure!: AdventureState;
  private host: HostState = {
    paused: true,
    epoch: 0,
    pendingCancel: false,
    cinematic: null,
  };
  private index = 0;
  private generation = 0;
  private retainedBytes = 0;
  private recording = false;
  private log: LogEntry[] = [];
  private snapshots: SessionSnapshot[] = [];
  private initial!: SessionSnapshot;
  private imported?: M4Artifact;
  readonly checkpointInterval: number;
  readonly project: M3ProjectDefinitions;
  constructor(options: SessionOptions) {
    record(options, [
      "project",
      "profile",
      "identity",
      ...["buildId", "runtimeBuildId", "scenario", "checkpointInterval"].filter(
        (k) => Object.hasOwn(options, k),
      ),
    ]);
    if (!["arena", "grid", "duel", "adventure"].includes(options.profile))
      throw Error("M4_PROFILE: unsupported profile");
    this.project = snapshotDefinitions(options.project);
    this.profile = options.profile;
    const id = record(options.identity, [
      "gameId",
      "rulesBuildId",
      "contentId",
    ]);
    Object.values(id).forEach((v) => string(v));
    this.identity = Object.freeze(detached(options.identity));
    this.buildId = string(options.buildId ?? this.identity.rulesBuildId);
    this.runtimeBuildId = string(options.runtimeBuildId ?? "unbuilt");
    this.checkpointInterval = integer(
      options.checkpointInterval ?? 300,
      1,
      10000,
    );
    this.scenario = findScenario(
      options.scenario ?? `${this.profile}-default`,
      this.profile,
    );
    this.initialize();
  }
  /** Fresh scenario staging preserves exact held decoder state; user restore separately cancels controls. */
  static stageScenario(options: SessionOptions, bytes: string) {
    const next = new M4Session(options);
    next.loadBytes(bytes);
    next.initial = next.snapshot();
    next.snapshots = [detached(next.initial)];
    return next;
  }
  /** One detached codec owner amortizes expensive trusted-fixture construction. */
  static validateScenarioCheckpoints(
    options: SessionOptions,
    checkpoints: string[],
  ) {
    const validator = new M4Session(options);
    for (let i = 0; i < checkpoints.length; i++) {
      try {
        validator.loadBytes(checkpoints[i]);
        if (validator.checkpoint() !== checkpoints[i])
          throw Error("Noncanonical assertion checkpoint");
      } catch (error) {
        throw new M4Error(
          "M4_SCENARIO_ASSERTION",
          error instanceof Error ? error.message : String(error),
          `/assertions/${i}/bytes`,
        );
      }
    }
  }
  private initialize() {
    this.recording = false;
    if (this.profile === "arena") {
      this.arena = createArena(
        scenarioArenaDefinition(this.project.arena, this.scenario),
        this.identity,
        this.scenario.seed,
      );
      for (let i = 0; i < (this.scenario.projectiles ?? 0); i++)
        advanceArena(this.arena, {
          moveX: 0,
          moveY: 0,
          aim: 0,
          fire: true,
          dash: false,
          shove: false,
        });
    }
    if (this.profile === "grid") this.grid = createGrid(this.project.grid);
    if (this.profile === "duel")
      this.duel = createDuelExecution(this.project.duel, this.identity);
    if (this.profile === "adventure")
      this.adventure = createAdventure(this.project.adventure);
    this.host = {
      paused: true,
      epoch: 0,
      pendingCancel: false,
      cinematic: null,
    };
    this.index = 0;
    this.initial = this.snapshot();
    this.log = [];
    this.snapshots = [detached(this.initial)];
    this.retainedBytes = new TextEncoder().encode(
      JSON.stringify(this.initial),
    ).length;
    this.imported = undefined;
  }
  async scenarioDocument(id?: string) {
    return scenarioDocument(this, id);
  }
  async loadScenario(value: unknown) {
    const generation = this.generation;
    const document = await validateScenarioDocument(value, this);
    if (generation !== this.generation)
      throw new M4Error(
        "M4_STALE_OPERATION",
        "Scenario load was canceled by a newer session mutation.",
      );
    const next = this.fork(document.fixture);
    next.loadBytes(document.initial.bytes);
    this.scenario = findScenario(document.fixture, this.profile);
    this.initialize();
    this.loadBytes(next.checkpoint());
    this.initial = this.snapshot();
    this.snapshots = [detached(this.initial)];
    this.generation++;
    return this.observe();
  }
  reset(scenario = this.scenario.id) {
    const next = findScenario(scenario, this.profile);
    this.scenario = next;
    this.initialize();
    this.generation++;
  }
  pause(paused = true) {
    this.step({ kind: "pause", paused });
  }
  checkpoint(): string {
    if (this.host.cinematic)
      throw new M4Error(
        "M4_CINEMATIC_BOUNDARY",
        "Exact snapshots exclude active cinematics; complete or skip the scene first.",
      );
    return this.rawCheckpoint();
  }
  private rawCheckpoint() {
    return this.profile === "arena"
      ? encodeArenaCheckpoint(this.arena)
      : this.profile === "grid"
        ? serializeGridCheckpoint(this.grid, this.identity)
        : this.profile === "duel"
          ? this.duel.checkpoint()
          : serializeAdventureCheckpoint(
              this.project.adventure,
              this.adventure,
              this.identity,
            );
  }
  private snapshot(): SessionSnapshot {
    return {
      index: this.index,
      bytes: this.checkpoint(),
      host: detached(this.host),
    };
  }
  private loadBytes(bytes: string) {
    if (typeof bytes !== "string") throw Error("M4_CHECKPOINT: expected bytes");
    if (this.profile === "arena") restoreArenaCheckpoint(this.arena, bytes);
    if (this.profile === "grid")
      this.grid = restoreGridCheckpoint(
        this.project.grid,
        this.identity,
        bytes,
      );
    if (this.profile === "duel") restoreDuelExact(this.duel, bytes);
    if (this.profile === "adventure")
      this.adventure = restoreAdventureCheckpoint(
        this.project.adventure,
        this.identity,
        bytes,
      );
  }
  restore(bytes: string) {
    const next = new M4Session({
      project: this.project,
      profile: this.profile,
      identity: this.identity,
      buildId: this.buildId,
      runtimeBuildId: this.runtimeBuildId,
      scenario: this.scenario.id,
    });
    next.loadBytes(bytes);
    this.loadBytes(next.checkpoint());
    this.host = {
      paused: true,
      epoch: this.host.epoch + 1,
      pendingCancel: true,
      cinematic: null,
    };
    this.index = 0;
    this.recording = false;
    this.log = [];
    this.initial = this.snapshot();
    this.snapshots = [detached(this.initial)];
    this.retainedBytes = new TextEncoder().encode(
      JSON.stringify(this.initial),
    ).length;
    this.imported = undefined;
    this.generation++;
  }
  private clock() {
    return this.profile === "arena"
      ? this.arena.tick
      : this.profile === "duel"
        ? this.duel.observation().tick
        : this.profile === "grid"
          ? this.grid.sequence
          : this.adventure.campaign.sequence;
  }
  observe() {
    const state =
      this.profile === "arena"
        ? observeArena(this.arena)
        : this.profile === "duel"
          ? this.duel.observation()
          : this.profile === "grid"
            ? this.grid
            : this.adventure;
    return detached({
      profile: this.profile,
      scenario: this.scenario.id,
      paused: this.host.paused,
      index: this.index,
      clock: {
        kind: this.scenario.clock,
        index: this.clock(),
        revision:
          this.profile === "grid"
            ? this.grid.revision
            : this.profile === "adventure"
              ? this.adventure.campaign.revision
              : this.clock(),
        sequence:
          this.profile === "grid"
            ? this.grid.sequence
            : this.profile === "adventure"
              ? this.adventure.campaign.sequence
              : this.clock(),
        epoch: this.host.epoch,
      },
      state,
      host: this.host,
      geometry:
        this.profile === "arena"
          ? {
              width: this.arena.definition.width,
              height: this.arena.definition.height,
            }
          : this.profile === "duel"
            ? {
                level: this.project.duel.levels.find(
                  (l) => l.id === this.duel.observation().levelId,
                ),
              }
            : this.profile === "adventure"
              ? {
                  map: this.project.adventure.maps.find(
                    (m) => m.id === this.adventure.active.mapId,
                  ),
                }
              : undefined,
    });
  }
  step(value: unknown) {
    const command = validateCommand(this.profile, value);
    if (command.kind === "frame" && this.host.pendingCancel) {
      if (this.profile === "arena") {
        const input = command.input as ArenaInput;
        input.cancel = true;
        input.fire = input.dash = input.shove = false;
        input.edges = ["fire", "dash", "shove"].map((action) => ({
          action: action as "fire" | "dash" | "shove",
          kind: "cancel",
        }));
      } else {
        for (const slot of (command.input as InputFrame).slots) {
          for (const a of actions) slot.held[a] = false;
          slot.axes.moveX = 0;
          slot.edges = actions.map((action) => ({ action, kind: "cancel" }));
        }
      }
    }
    if (this.recording && this.log.length >= MAX_COMMANDS)
      throw Error("M4_LIMIT: recording command ceiling reached");
    const before = this.rawCheckpoint(),
      host = detached(this.host),
      index = this.index;
    try {
      this.apply(command);
      this.index++;
      const entry: LogEntry = {
        index: this.index,
        clock: this.clock(),
        epoch: this.host.epoch,
        command,
        outcome: this.outcome(),
      };
      if (this.recording) {
        const checkpoint =
          !this.host.cinematic && this.index % this.checkpointInterval === 0
            ? this.snapshot()
            : undefined;
        const bytes =
          new TextEncoder().encode(JSON.stringify(entry)).length +
          (checkpoint
            ? new TextEncoder().encode(JSON.stringify(checkpoint)).length
            : 0);
        if (
          this.retainedBytes + bytes > 24 * 1024 * 1024 ||
          (checkpoint && this.snapshots.length >= 9998)
        )
          throw Error(
            "M4_LIMIT: retained recording exceeds bounded log/checkpoint budget",
          );
        this.log.push(detached(entry));
        if (checkpoint) this.snapshots.push(checkpoint);
        this.retainedBytes += bytes;
      }
      this.generation++;
      return detached(entry);
    } catch (error) {
      this.loadBytes(before);
      this.host = host;
      this.index = index;
      throw error;
    }
  }
  private outcome() {
    return this.profile === "arena"
      ? this.arena.result
      : this.profile === "duel"
        ? this.duel.result
        : "committed";
  }
  private apply(command: M4Command) {
    if (command.kind === "pause") {
      this.host.paused = command.paused;
      if (command.paused) this.host.pendingCancel = true;
      return;
    }
    if (command.kind === "cancel") {
      this.host.pendingCancel = true;
      return;
    }
    if (command.kind === "restart") {
      // Same production host restart constructors, independent of recording origin.
      if (this.profile === "arena")
        this.arena = createArena(
          scenarioArenaDefinition(this.project.arena, this.scenario),
          this.identity,
          this.scenario.seed,
        );
      else if (this.profile === "grid")
        this.grid = createGrid(this.project.grid);
      else if (this.profile === "duel") this.duel.restart();
      else this.adventure = createAdventure(this.project.adventure);
      this.host = {
        paused: true,
        epoch: this.host.epoch + 1,
        pendingCancel: true,
        cinematic: null,
      };
      return;
    }
    if (command.kind === "director") {
      const c = this.host.cinematic;
      if (
        !c ||
        command.epoch !== this.host.epoch ||
        command.slot !== c.slot ||
        command.token !== c.token
      )
        throw Error("M4_DIRECTOR: stale outcome token/epoch/slot");
      if (command.action === "tick")
        c.tick = integer(c.tick + command.ticks!, 0, 200000);
      else {
        if (
          !acceptsRewardBoundary(
            { epoch: command.epoch, slot: command.slot, kind: command.action },
            {
              epoch: this.host.epoch,
              ending: true,
              revision: this.adventure.campaign.revision,
            },
          )
        )
          throw Error("M4_DIRECTOR: rejected production boundary");
        this.host.cinematic = null;
      }
      return;
    }
    if (!this.host.paused)
      throw Error("M4_PAUSE: manual semantic steps require a paused host");
    if (this.host.cinematic)
      throw new M4Error(
        "M4_CINEMATIC_BOUNDARY",
        "Only Director boundaries are accepted during a cinematic.",
      );
    if (command.kind === "frame") {
      if (this.profile === "arena") {
        if (this.arena.result !== "playing")
          throw Error("M4_TERMINAL: restart before advancing a finished arena");
        const input = detached(command.input as ArenaInput);
        if (this.host.pendingCancel) {
          input.cancel = true;
          input.fire = input.dash = input.shove = false;
          input.edges = ["fire", "dash", "shove"].map((action) => ({
            action: action as "fire" | "dash" | "shove",
            kind: "cancel",
          }));
        }
        advanceArena(this.arena, input);
      } else {
        const input = detached(command.input as InputFrame);
        if (this.host.pendingCancel)
          for (const s of input.slots) {
            for (const a of actions) s.held[a] = false;
            s.axes.moveX = 0;
            s.edges = actions.map((action) => ({ action, kind: "cancel" }));
          }
        executeDuelFrame(this.duel, input);
      }
      this.host.pendingCancel = false;
    } else if (this.profile === "grid") {
      const result = applyGridCommand(
        this.grid,
        command.command as GridCommand,
      );
      if (!result.ok) throw Error("M4_COMMAND: " + result.error);
      this.grid = result.state;
    } else {
      const c = command.command as AdventureCommand | AdventureTravelCommand;
      const rewarded = Object.values(this.adventure.campaign.quests).includes(
        "complete",
      );
      if (c.kind === "travel") {
        const prepared = prepareAdventureTransition(
          this.project.adventure,
          this.adventure,
          c,
        );
        if (!prepared.ok) throw Error("M4_TRANSITION: " + prepared.error);
        const committed = commitAdventureTransition(
          this.project.adventure,
          this.adventure,
          prepared.transition,
          prepared.transition.targetMapId,
        );
        if (!committed.ok) throw Error("M4_TRANSITION: " + committed.error);
        this.adventure = committed.state;
        this.host.epoch++;
      } else {
        const result = applyAdventureCommand(
          this.project.adventure,
          this.adventure,
          c,
        );
        if (!result.ok) throw Error("M4_COMMAND: " + result.error);
        this.adventure = result.state;
      }
      if (
        !rewarded &&
        Object.values(this.adventure.campaign.quests).includes("complete")
      ) {
        const slot = rewardSlot(this.adventure.campaign.revision);
        this.host.cinematic = {
          slot,
          tick: 0,
          token: `${this.host.epoch}:${slot}`,
        };
      }
    }
  }
  startRecording() {
    this.initial = this.snapshot();
    this.initial.index = 0;
    this.index = 0;
    this.log = [];
    this.snapshots = [detached(this.initial)];
    this.retainedBytes = new TextEncoder().encode(
      JSON.stringify(this.initial),
    ).length;
    this.recording = true;
    this.imported = undefined;
    this.generation++;
  }
  async exportArtifact(
    environment: Partial<ArtifactEnvironment> = {},
    attachments: Attachment[] = [],
  ): Promise<M4Artifact> {
    if (!this.recording)
      throw Error("M4_RECORDING: start recording before exporting");
    const final = this.snapshot();
    // Capture all mutable inputs before the first asynchronous digest.
    const initial = detached(this.initial),
      commands = detached(this.log),
      metadata = detached(environment),
      evidence = detached(attachments);
    const checkpoints = detached(this.snapshots);
    if (checkpoints.at(-1)?.index !== final.index) checkpoints.push(final);
    const artifact: M4Artifact = {
      format: "pocket-game-bug",
      version: 1,
      profile: this.profile,
      scenario: this.scenario.id,
      identity: detached(this.identity),
      buildId: this.buildId,
      runtimeBuildId: this.runtimeBuildId,
      sourceRevision: metadata.sourceRevision ?? "unknown",
      seed: this.scenario.seed,
      initial: await this.hashed(initial),
      commands,
      checkpoints: await Promise.all(checkpoints.map((s) => this.hashed(s))),
      schedule: {
        requested: [1],
        actual: commands.filter((e) => e.command.kind === "frame").map(() => 1),
      },
      firstDivergence: null,
      environment: {
        runtime: metadata.runtime ?? "browser",
        platform: metadata.platform ?? "unknown",
        sourceRevision: metadata.sourceRevision ?? "unknown",
      },
      consoleErrors: [],
      notes: [],
      attachments: evidence,
    };
    await validateArtifact(artifact, this);
    return detached(artifact);
  }
  private async hashed(s: SessionSnapshot) {
    return {
      ...detached(s),
      hash: await sha256(s.bytes),
      stateHash: await sha256(canonical(s)),
    };
  }
  async importArtifact(value: unknown) {
    const generation = this.generation;
    const artifact = await validateArtifact(value, this);
    const next = this.fork(artifact.scenario);
    try {
      next.loadBytes(artifact.initial.bytes);
    } catch (error) {
      throw new M4Error(
        "M4_CHECKPOINT",
        error instanceof Error ? error.message : String(error),
        "/initial/bytes",
      );
    }
    next.host = detached(artifact.initial.host);
    next.index = 0;
    next.imported = artifact;
    next.initial = detached(artifact.initial);
    next.log = detached(artifact.commands);
    next.snapshots = detached(artifact.checkpoints);
    next.seek(artifact.commands.length, false); // Validate entire replay before publishing anything.
    if (generation !== this.generation)
      throw new M4Error(
        "M4_STALE_OPERATION",
        "Artifact import was canceled by a newer session mutation.",
      );
    this.scenario = findScenario(artifact.scenario, this.profile);
    this.initialize();
    this.loadBytes(artifact.initial.bytes);
    this.host = detached(artifact.initial.host);
    this.index = 0;
    this.initial = detached(artifact.initial);
    this.log = detached(artifact.commands);
    this.snapshots = detached(artifact.checkpoints);
    this.imported = artifact;
    this.recording = false;
    this.generation++;
    return this.observe();
  }
  private fork(scenario = this.scenario.id) {
    return new M4Session({
      project: this.project,
      profile: this.profile,
      identity: this.identity,
      buildId: this.buildId,
      runtimeBuildId: this.runtimeBuildId,
      scenario,
      checkpointInterval: this.checkpointInterval,
    });
  }
  replay() {
    return this.seek(this.imported?.commands.length ?? this.log.length, false);
  }
  seekClock(value: unknown) {
    const target = record(parseBounded(value, 1024), [
      "kind",
      "index",
      "epoch",
    ]);
    if (target.kind !== this.scenario.clock)
      throw Error("M4_CLOCK: target kind must match profile clock");
    const index = integer(target.index, 0, Number.MAX_SAFE_INTEGER),
      epoch = integer(target.epoch, 0, Number.MAX_SAFE_INTEGER);
    const entry = this.log
      .filter((e) => e.clock === index && e.epoch === epoch)
      .at(-1);
    if (entry) return this.seek(entry.index);
    const initial = this.fork();
    initial.loadBytes(this.initial.bytes);
    const initialIndex = initial.clock();
    if (this.initial.host.epoch === epoch && initialIndex === index)
      return this.seek(0);
    throw Error(
      "M4_CLOCK: no recorded endpoint has this tick/command index and epoch",
    );
  }
  seek(target: number, useCheckpoints = true) {
    integer(target, 0, this.log.length);
    const next = this.fork();
    const available = useCheckpoints
      ? this.snapshots.filter((s) => s.index <= target)
      : [this.initial];
    const base = available.at(-1) ?? this.initial;
    next.loadBytes(base.bytes);
    next.host = detached(base.host);
    next.index = base.index;
    for (let i = base.index; i < target; i++) {
      const expected = this.log[i];
      const actual = next.step(expected.command);
      const d = firstDifference(expected, actual);
      if (d)
        throw new M4Error(
          "M4_DIVERGENCE",
          `Replay command diverged at ${i + 1}`,
          `/commands/${i}${d}`,
        );
      const check = this.snapshots.find((s) => s.index === next.index);
      if (check) this.compareSnapshot(check, next.snapshot());
    }
    if (next.host.cinematic)
      throw new M4Error(
        "M4_CINEMATIC_BOUNDARY",
        "Seek target is inside an unsupported active cinematic.",
      );
    // No presentation owner is invoked during catch-up; caller presents this one detached observation.
    const final = next.snapshot();
    this.loadBytes(final.bytes);
    this.host = detached(final.host);
    this.index = target;
    this.recording = false;
    this.generation++;
    return this.observe();
  }
  private compareSnapshot(a: SessionSnapshot, b: SessionSnapshot) {
    const d = firstDifference(
      { bytes: JSON.parse(a.bytes), host: a.host, index: a.index },
      { bytes: JSON.parse(b.bytes), host: b.host, index: b.index },
    );
    if (d)
      throw new M4Error(
        "M4_DIVERGENCE",
        "Exact checkpoint divergence",
        `/checkpoints/${a.index}${d}`,
      );
    if (a.bytes !== b.bytes)
      throw new M4Error(
        "M4_DIVERGENCE",
        "Noncanonical exact checkpoint bytes",
        `/checkpoints/${a.index}/bytes`,
      );
  }
}
export function createM4Session(options: SessionOptions) {
  return new M4Session(options);
}
