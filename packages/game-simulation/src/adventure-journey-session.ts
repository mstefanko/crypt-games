import {
  createAdventure,
  applyAdventureCommand,
  prepareAdventureTransition,
  commitAdventureTransition,
  serializeAdventureCheckpoint,
  restoreAdventureCheckpoint,
  type AdventureDefinitions,
  type AdventureMap,
  type AdventureState,
} from "./m3/adventure";
import type { GridDirection, ProfileIdentity } from "./m3/grid";
import { sampleTickField } from "./tick-field";

export interface AdventureJourneyRegion {
  map: AdventureMap;
  /** Reproducible sparse obstacles, excluding the open horizontal corridor. */
  obstacles?: {
    columns: readonly number[];
    openRows: readonly number[];
    modulus: number;
  };
  exposure: number;
  sheltered?: boolean;
  slowWeather?: { threshold: number; additionalInterval: number };
}
export interface AdventureJourneyDefinition {
  identity: ProfileIdentity;
  adventure: Omit<AdventureDefinitions, "maps">;
  regions: readonly AdventureJourneyRegion[];
  initialPickup?: { placementId: string; token: string };
  delivery: {
    mapId: string;
    dialogueId: string;
    choiceId: string;
    token: string;
    flag: string;
  };
  home: { mapId: string; cell: number };
  moveInterval: number;
  weather: {
    period: number;
    speeds: readonly number[];
    stormThreshold: number;
    calmThreshold: number;
    stormDelay: number;
    calmDelay: number;
  };
  messages: {
    initial: string;
    shelter: string;
    travel: string;
    delivered: string;
    won: string;
    help: string;
  };
}
export type AdventureJourneyCommand =
  | { kind: "cancel" }
  | {
      kind: "move";
      direction: GridDirection;
      sequence?: number;
      revision?: number;
    }
  | { kind: "interact"; sequence?: number; revision?: number };
export interface AdventureJourneyEvent {
  sequence: number;
  tick: number;
  sourceId: string;
  kind: "move" | "travel" | "delivery" | "win";
}
export interface AdventureJourneyObservation {
  requestedSeed: number;
  effectiveSeed: number;
  mapIndex: number;
  map: AdventureMap;
  maps: readonly AdventureMap[];
  player: number;
  previousPlayer: number;
  facing: GridDirection;
  moveProgress: number;
  time: number;
  exposure: number;
  storm: boolean;
  sheltered: boolean;
  delivered: boolean;
  won: boolean;
  status: string;
  routeCount: number;
  tick: number;
  revision: number;
}
interface JourneyCheckpoint {
  kind: "adventure-journey";
  version: 2;
  identity: ProfileIdentity;
  seed: number;
  state: string;
  time: number;
  cooldown: number;
  interval: number;
  previousPlayer: number;
  facing: GridDirection;
  exposure: number;
  won: boolean;
  storm: boolean;
  stormTime: number;
  calmTime: number;
  status: string;
  tick: number;
  eventSequence: number;
  events: AdventureJourneyEvent[];
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Seeded journey orchestration over the existing adventure and tick-field owners. */
export class AdventureJourneySession {
  private readonly definition: AdventureJourneyDefinition;
  private readonly definitions: AdventureDefinitions;
  private readonly maps: readonly AdventureMap[];
  private readonly identity: ProfileIdentity;
  private state: AdventureState;
  private time = 0;
  private cooldown = 0;
  private interval: number;
  private previousPlayer: number;
  private facing: GridDirection = "down";
  private exposure = 0;
  private won = false;
  private storm = false;
  private stormTime = 0;
  private calmTime = 0;
  private status: string;
  private tick = 0;
  private eventSequence = 0;
  private events: AdventureJourneyEvent[] = [];
  private readonly routeCounts: number[];

  constructor(
    definition: AdventureJourneyDefinition,
    readonly seed: number,
  ) {
    if (!Number.isSafeInteger(seed) || seed < 0)
      throw Error("Invalid journey seed");
    this.definition = clone(definition);
    const d = this.definition;
    if (
      !d.regions.length ||
      d.regions.length > 64 ||
      d.moveInterval <= 0 ||
      d.weather.period <= 0 ||
      !d.weather.speeds.length
    )
      throw Error("Invalid journey definition");
    this.identity = {
      ...d.identity,
      contentId: `${d.identity.contentId}-${seed}`,
    };
    this.maps = d.regions.map((region, index) => {
      const map = clone(region.map),
        walls = new Set(map.walls),
        rule = region.obstacles;
      if (rule) {
        if (!Number.isSafeInteger(rule.modulus) || rule.modulus < 1)
          throw Error("Invalid obstacle recipe");
        for (let y = 1; y < map.height - 1; y++)
          for (const x of rule.columns)
            if (
              !rule.openRows.includes(y) &&
              (seed + index + x + y) % rule.modulus === 0
            )
              walls.add(y * map.width + x);
      }
      return { ...map, walls: [...walls] };
    });
    this.definitions = { ...d.adventure, maps: this.maps };
    this.state = createAdventure(this.definitions);
    // Validate travel sockets and the delivery/home path before accepting a layout.
    this.routeCounts = this.maps.map((map) => {
      const seen = new Set([map.entrances[0].cell]),
        queue = [...seen],
        walls = new Set(map.walls);
      for (let j = 0; j < queue.length; j++) {
        const cell = queue[j];
        for (const next of [
          cell - map.width,
          cell + map.width,
          cell % map.width > 0 ? cell - 1 : -1,
          cell % map.width < map.width - 1 ? cell + 1 : -1,
        ])
          if (
            next >= 0 &&
            next < map.width * map.height &&
            !walls.has(next) &&
            !seen.has(next)
          ) {
            seen.add(next);
            queue.push(next);
          }
      }
      const targets = [
        ...map.exits.map((exit) => exit.cell),
        ...map.dialogues.map((dialogue) => dialogue.cell),
        ...(map.id === d.home.mapId ? [d.home.cell] : []),
      ];
      if (targets.some((cell) => !seen.has(cell)))
        throw Error("Disconnected journey interaction");
      return map.exits.length;
    });
    if (d.initialPickup)
      this.state = applyAdventureCommand(this.definitions, this.state, {
        kind: "pickup",
        ...d.initialPickup,
        ...this.order(),
      }).state;
    this.previousPlayer = this.state.active.player;
    this.interval = d.moveInterval;
    this.status = d.messages.initial;
  }
  private order() {
    return {
      sequence: this.state.campaign.sequence + 1,
      revision: this.state.campaign.revision,
    };
  }
  private index() {
    return this.maps.findIndex((map) => map.id === this.state.active.mapId);
  }
  private near(a: number, b: number) {
    const width = this.maps[this.index()].width;
    return (
      Math.abs((a % width) - (b % width)) +
        Math.abs(Math.floor(a / width) - Math.floor(b / width)) <=
      1
    );
  }
  private emit(kind: AdventureJourneyEvent["kind"]) {
    this.events.push({
      sequence: ++this.eventSequence,
      tick: this.tick,
      sourceId: this.state.active.mapId,
      kind,
    });
    if (this.events.length > 256) this.events.shift();
  }
  step(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0 || dt > 1)
      throw Error("Invalid journey step");
    if (!dt || this.won) return;
    this.tick++;
    this.time += dt;
    this.cooldown -= dt;
    const region = this.definition.regions[this.index()],
      weather = this.definition.weather,
      map = this.maps[this.index()],
      player = this.state.active.player;
    this.exposure = sampleTickField(
      {
        period: weather.period,
        phase: this.seed % weather.period,
        direction: this.seed % 2 ? 1 : -1,
        speed: weather.speeds[this.seed % weather.speeds.length],
      },
      Math.floor(this.time * 60),
      player % map.width,
      Math.floor(player / map.width),
      region.exposure,
    );
    this.stormTime =
      this.exposure > weather.stormThreshold ? this.stormTime + dt : 0;
    this.calmTime =
      this.exposure < weather.calmThreshold ? this.calmTime + dt : 0;
    if (this.stormTime >= weather.stormDelay) this.storm = true;
    if (this.calmTime >= weather.calmDelay || region.sheltered)
      this.storm = false;
  }
  command(command: AdventureJourneyCommand): boolean {
    if (command.kind === "cancel") {
      this.previousPlayer = this.state.active.player;
      return true;
    }
    if (
      this.won ||
      (command.sequence !== undefined &&
        command.sequence !== this.state.campaign.sequence + 1) ||
      (command.revision !== undefined &&
        command.revision !== this.state.campaign.revision)
    )
      return false;
    if (command.kind === "move") {
      if (this.cooldown > 0) return false;
      this.previousPlayer = this.state.active.player;
      this.facing = command.direction;
      const result = applyAdventureCommand(this.definitions, this.state, {
        kind: "move",
        direction: command.direction,
        ...this.order(),
      });
      this.state = result.state;
      const slow = this.definition.regions[this.index()].slowWeather;
      this.interval =
        this.definition.moveInterval +
        (slow && this.exposure > slow.threshold ? slow.additionalInterval : 0);
      this.cooldown = this.interval;
      if (result.ok) this.emit("move");
      return result.ok;
    }
    const d = this.definition,
      map = this.maps[this.index()],
      exit = map.exits.find((candidate) =>
        this.near(this.state.active.player, candidate.cell),
      );
    if (exit) {
      const prepared = prepareAdventureTransition(
        this.definitions,
        this.state,
        {
          kind: "travel",
          exitId: exit.id,
          token: `travel-${this.state.campaign.sequence + 1}`,
          ...this.order(),
        },
      );
      if (!prepared.ok) return false;
      const result = commitAdventureTransition(
        this.definitions,
        this.state,
        prepared.transition,
        exit.mapId,
      );
      this.state = result.state;
      this.previousPlayer = this.state.active.player;
      this.status = d.regions[this.index()].sheltered
        ? d.messages.shelter
        : `${this.maps[this.index()].name}${d.messages.travel}`;
      if (result.ok) this.emit("travel");
      return result.ok;
    }
    const dialogue = map.dialogues.find(
      (candidate) => candidate.id === d.delivery.dialogueId,
    );
    if (
      map.id === d.delivery.mapId &&
      dialogue &&
      this.near(this.state.active.player, dialogue.cell) &&
      !this.state.campaign.flags[d.delivery.flag]
    ) {
      const result = applyAdventureCommand(this.definitions, this.state, {
        kind: "dialogue",
        dialogueId: d.delivery.dialogueId,
        choiceId: d.delivery.choiceId,
        token: d.delivery.token,
        ...this.order(),
      });
      this.state = result.state;
      if (result.ok) {
        this.status = d.messages.delivered;
        this.emit("delivery");
      }
      return result.ok;
    }
    if (
      map.id === d.home.mapId &&
      this.near(this.state.active.player, d.home.cell) &&
      this.state.campaign.flags[d.delivery.flag]
    ) {
      this.won = true;
      this.status = d.messages.won;
      this.emit("win");
      return true;
    }
    this.status = d.messages.help;
    return false;
  }
  observe(): AdventureJourneyObservation {
    const index = this.index();
    return clone({
      requestedSeed: this.seed,
      effectiveSeed: this.seed,
      mapIndex: index,
      map: this.maps[index],
      maps: this.maps,
      player: this.state.active.player,
      previousPlayer: this.previousPlayer,
      facing: this.facing,
      moveProgress: Math.max(0, Math.min(1, 1 - this.cooldown / this.interval)),
      time: this.time,
      exposure: this.exposure,
      storm: this.storm,
      sheltered: !!this.definition.regions[index].sheltered,
      delivered: !!this.state.campaign.flags[this.definition.delivery.flag],
      won: this.won,
      status: this.status,
      routeCount: this.routeCounts[index],
      tick: this.tick,
      revision: this.state.campaign.revision,
    });
  }
  drainEvents(): AdventureJourneyEvent[] {
    const events = this.events;
    this.events = [];
    return clone(events);
  }
  snapshot(): JourneyCheckpoint {
    return clone({
      kind: "adventure-journey",
      version: 2,
      identity: this.identity,
      seed: this.seed,
      state: serializeAdventureCheckpoint(
        this.definitions,
        this.state,
        this.identity,
      ),
      time: this.time,
      cooldown: this.cooldown,
      interval: this.interval,
      previousPlayer: this.previousPlayer,
      facing: this.facing,
      exposure: this.exposure,
      won: this.won,
      storm: this.storm,
      stormTime: this.stormTime,
      calmTime: this.calmTime,
      status: this.status,
      tick: this.tick,
      eventSequence: this.eventSequence,
      events: this.events,
    });
  }
  restore(value: unknown): void {
    const v = value as JourneyCheckpoint;
    if (
      !v ||
      v.kind !== "adventure-journey" ||
      v.version !== 2 ||
      v.seed !== this.seed ||
      JSON.stringify(v.identity) !== JSON.stringify(this.identity)
    )
      throw Error("Incompatible journey checkpoint; restart required");
    const state = restoreAdventureCheckpoint(
      this.definitions,
      this.identity,
      v.state,
    );
    if (
      ![
        v.time,
        v.cooldown,
        v.interval,
        v.exposure,
        v.stormTime,
        v.calmTime,
      ].every(Number.isFinite) ||
      v.time < 0 ||
      v.stormTime < 0 ||
      v.calmTime < 0 ||
      v.interval <= 0 ||
      v.exposure < 0 ||
      v.exposure > 1 ||
      !Number.isSafeInteger(v.tick) ||
      v.tick < 0 ||
      !Number.isSafeInteger(v.eventSequence) ||
      v.eventSequence < 0 ||
      !["up", "down", "left", "right"].includes(v.facing) ||
      typeof v.status !== "string" ||
      typeof v.won !== "boolean" ||
      typeof v.storm !== "boolean" ||
      !Array.isArray(v.events) ||
      v.events.length > 256
    )
      throw Error("Invalid journey checkpoint");
    const map = this.maps.find(
      (candidate) => candidate.id === state.active.mapId,
    )!;
    if (
      !Number.isSafeInteger(v.previousPlayer) ||
      v.previousPlayer < 0 ||
      v.previousPlayer >= map.width * map.height ||
      v.events.some(
        (event) =>
          !Number.isSafeInteger(event.sequence) ||
          event.sequence < 1 ||
          event.sequence > v.eventSequence ||
          !Number.isSafeInteger(event.tick) ||
          event.tick < 0 ||
          event.tick > v.tick ||
          !["move", "travel", "delivery", "win"].includes(event.kind) ||
          !this.maps.some((candidate) => candidate.id === event.sourceId),
      )
    )
      throw Error("Invalid journey event checkpoint");
    this.state = state;
    this.time = v.time;
    this.cooldown = v.cooldown;
    this.interval = v.interval;
    this.previousPlayer = v.previousPlayer;
    this.facing = v.facing;
    this.exposure = v.exposure;
    this.won = v.won;
    this.storm = v.storm;
    this.stormTime = v.stormTime;
    this.calmTime = v.calmTime;
    this.status = v.status;
    this.tick = v.tick;
    this.eventSequence = v.eventSequence;
    this.events = clone(v.events);
  }
}
