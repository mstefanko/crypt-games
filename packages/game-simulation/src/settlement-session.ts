import { commitCargoDelivery } from "./production-cargo";
import { LiveNavigation } from "./live-navigation";
import { actionPhase, type ActionInstance } from "./action-timeline";
import { evaluateCondition, type RuleCondition } from "./rules";
/** Single consumer: settlement logistics. Reservations are physical endpoint claims. */
export interface SettlementBuildingDefinition {
  id: string;
  name: string;
  size: number;
  cost: Record<string, number>;
  capacity?: number;
  housing?: number;
  job?: string;
  recipe?: {
    input?: Record<string, number>;
    output: Record<string, number>;
    seconds: number;
    seasons?: number[];
    deposit?: string;
  };
  color: number;
  condition?: RuleCondition;
  passable?: boolean;
  terrainOnComplete?: number;
  doorOffset?: { x: number; y: number };
}
export interface SettlementDefinition {
  width: number;
  height: number;
  terrain: number[];
  people: number;
  supplies: Record<string, number>;
  buildings: SettlementBuildingDefinition[];
  initial: { type: string; x: number; y: number }[];
  seasonSeconds: number;
  migrants: number;
  opening: string;
}
export interface SettlementBuilding {
  id: string;
  type: string;
  x: number;
  y: number;
  complete: boolean;
  materials: Record<string, number>;
  work: number;
  inventory: Record<string, number>;
  assigned: number;
  progress: number;
}
export interface SettlementPile {
  id: string;
  cell: number;
  inventory: Record<string, number>;
}
export interface Reservation {
  id: number;
  owner: string;
  endpoint: string;
  resource: string;
  amount: number;
  kind: "pickup" | "capacity";
}
export type CitizenAction =
  | { kind: "move"; target: number; request?: number; path?: number[] }
  | {
      kind: "pickup" | "deposit";
      endpoint: string;
      resource: string;
      amount: number;
      token: number;
    }
  | { kind: "work"; building: string; elapsed: number }
  | { kind: "eat" | "warm" | "wait"; elapsed: number };
export interface SettlementCitizen {
  id: string;
  x: number;
  y: number;
  health: number;
  hunger: number;
  cold: number;
  house?: string;
  job: string;
  cargo: Record<string, number>;
  queue: CitizenAction[];
  why: string;
  retry: number;
  revision: number;
  work?: ActionInstance;
}
export interface SettlementState {
  time: number;
  tick: number;
  speed: number;
  season: number;
  outcome: "playing" | "won" | "lost";
  people: SettlementCitizen[];
  buildings: SettlementBuilding[];
  piles: SettlementPile[];
  reservations: Reservation[];
  terrain: number[];
  nextId: number;
  selected?: string;
  placement?: string;
  message: string;
  migrated: boolean;
  fireTimer: number;
  warnings: string[];
  sequence: number;
  chunkRevisions: number[];
  accumulator: number;
}
export type SettlementObservation<T> = T extends object
  ? { readonly [K in keyof T]: SettlementObservation<T[K]> }
  : T;
interface SettlementEvent {
  sequence: number;
  tick: number;
  sourceId: string;
  kind: string;
}
export class SettlementSession {
  #state: SettlementState;
  #navigation: LiveNavigation;
  #definition: SettlementDefinition;
  #seed: number;
  get seed() {
    return this.#seed;
  }
  get state(): SettlementObservation<SettlementState> {
    return structuredClone({
      ...this.#state,
      sequence: this.#sequence,
      accumulator: this.#accumulator,
    });
  }
  get definition(): SettlementObservation<SettlementDefinition> {
    return structuredClone(this.#definition);
  }
  get navigationRevision() {
    return this.#navigation.revision;
  }
  #accumulator = 0;
  #sequence = 0;
  #droppedEvents = 0;
  /** Cumulative pending events evicted by the bounded retention of the latest 64 events. */
  get droppedEvents() {
    return this.#droppedEvents;
  }
  #events: {
    sequence: number;
    tick: number;
    sourceId: string;
    kind: string;
  }[] = [];
  constructor(definition: SettlementDefinition, seed = 1) {
    this.#definition = structuredClone(definition);
    this.#seed = seed;
    definition = this.#definition;
    this.#state = {
      time: 0,
      tick: 0,
      speed: 1,
      season: 0,
      outcome: "playing",
      people: [],
      buildings: [],
      piles: [],
      reservations: [],
      terrain: [...definition.terrain],
      nextId: 1,
      message: definition.opening,
      migrated: false,
      fireTimer: 0,
      warnings: [],
      sequence: 0,
      chunkRevisions: Array.from(
        {
          length:
            Math.ceil(definition.width / 8) * Math.ceil(definition.height / 8),
        },
        () => 0,
      ),
      accumulator: 0,
    };
    this.#navigation = this.#makeNavigation();
    for (const b of definition.initial) {
      const placed = this.#addBuilding(b.type, b.x, b.y, true);
      if (this.#def(placed).capacity)
        placed.inventory = { ...definition.supplies };
    }
    for (let i = 0; i < definition.people; i++) this.#addPerson();
    this.#assignHomes();
  }
  #makeNavigation() {
    return new LiveNavigation({
      width: this.#definition.width,
      height: this.#definition.height,
      walkable: this.#state.terrain.map((t) => t !== 1),
      costs: this.#state.terrain.map((t) => (t === 4 ? 0.5 : 1)),
    });
  }
  #def(b: SettlementBuilding) {
    return this.#definition.buildings.find((d) => d.id === b.type)!;
  }
  #dirtyCell(cell: number) {
    const x = cell % this.#definition.width,
      y = Math.floor(cell / this.#definition.width),
      w = Math.ceil(this.#definition.width / 8);
    const i = Math.floor(y / 8) * w + Math.floor(x / 8);
    this.#state.chunkRevisions[i] = (this.#state.chunkRevisions[i] ?? 0) + 1;
  }
  #cell(x: number, y: number) {
    return Math.floor(y) * this.#definition.width + Math.floor(x);
  }
  #door(b: SettlementBuilding) {
    const d = this.#def(b);
    return this.#cell(
      b.x + (d.doorOffset?.x ?? 0),
      b.y + (d.doorOffset?.y ?? d.size),
    );
  }
  #addPerson() {
    const n = this.#state.nextId++;
    this.#state.people.push({
      id: `person-${n}`,
      x: 20 + (n % 4),
      y: 24 + Math.floor((n % 12) / 4),
      health: 100,
      hunger: 0,
      cold: 0,
      job: "laborer",
      cargo: {},
      queue: [],
      why: "Looking for work",
      retry: 0,
      revision: 0,
    });
  }
  #assignHomes() {
    const houses = this.#state.buildings.filter(
      (b) => b.complete && this.#def(b).housing,
    );
    let index = 0;
    for (const p of this.#state.people) {
      while (
        index < houses.length &&
        this.#state.people.filter((o) => o.house === houses[index]!.id)
          .length >= this.#def(houses[index]!).housing!
      )
        index++;
      if (!p.house && houses[index]) p.house = houses[index]!.id;
    }
  }
  #addBuilding(type: string, x: number, y: number, complete = false) {
    const b: SettlementBuilding = {
      id: `building-${this.#state.nextId++}`,
      type,
      x,
      y,
      complete,
      materials: {},
      inventory: {},
      work: 0,
      assigned: 0,
      progress: 0,
    };
    this.#state.buildings.push(b);
    this.#dirtyCell(this.#cell(x, y));
    const d = this.#def(b);
    for (let yy = y; yy < y + d.size; yy++)
      for (let xx = x; xx < x + d.size; xx++) {
        this.#dirtyCell(this.#cell(xx, yy));
        if (!d.passable) this.#navigation.setCell(this.#cell(xx, yy), false);
        else if (complete) {
          this.#state.terrain[this.#cell(xx, yy)] = d.terrainOnComplete ?? 4;
          this.#navigation.setCell(this.#cell(xx, yy), true, 0.5);
        }
      }
    return b;
  }
  available(resource: string) {
    return this.#state.buildings
      .filter(
        (b) =>
          b.complete &&
          this.#def(b).capacity &&
          this.#state.people.some((p) =>
            this.#navigation.reachable(this.#cell(p.x, p.y), this.#door(b)),
          ),
      )
      .reduce((n, b) => n + (b.inventory[resource] ?? 0), 0);
  }
  #endpoint(id: string): Record<string, number> | undefined {
    return (
      this.#state.buildings.find((b) => b.id === id)?.inventory ??
      this.#state.piles.find((p) => p.id === id)?.inventory
    );
  }
  #endpointCell(id: string) {
    const b = this.#state.buildings.find((b) => b.id === id);
    return b
      ? this.#door(b)
      : (this.#state.piles.find((p) => p.id === id)?.cell ?? -1);
  }
  #reserved(id: string, r: string, kind: Reservation["kind"]) {
    return this.#state.reservations
      .filter((v) => v.endpoint === id && v.resource === r && v.kind === kind)
      .reduce((n, v) => n + v.amount, 0);
  }
  #reserve(
    p: SettlementCitizen,
    id: string,
    resource: string,
    amount: number,
    kind: Reservation["kind"],
  ) {
    const token = this.#state.nextId++;
    this.#state.reservations.push({
      id: token,
      owner: p.id,
      endpoint: id,
      resource,
      amount,
      kind,
    });
    return token;
  }
  #release(id: number) {
    this.#state.reservations = this.#state.reservations.filter(
      (r) => r.id !== id,
    );
  }
  #cancel(p: SettlementCitizen) {
    for (const a of p.queue)
      if (a.kind === "move" && a.request !== undefined)
        this.#navigation.retire(a.request);
    p.queue = [];
    this.#state.reservations = this.#state.reservations.filter(
      (r) => r.owner !== p.id,
    );
    p.work = undefined;
  }
  #sources(p: SettlementCitizen, resource: string, amount = 1) {
    const cell = this.#cell(p.x, p.y);
    return [
      ...this.#state.buildings
        .filter((b) => b.complete)
        .map((b) => ({
          id: b.id,
          cell: this.#door(b),
          inventory: b.inventory,
        })),
      ...this.#state.piles,
    ]
      .filter(
        (e) =>
          (e.inventory[resource] ?? 0) -
            this.#reserved(e.id, resource, "pickup") >=
            amount && this.#navigation.reachable(cell, e.cell),
      )
      .sort(
        (a, b) =>
          this.#navigation.distance(cell, a.cell) -
            this.#navigation.distance(cell, b.cell) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }
  #moveTo(p: SettlementCitizen, target: number) {
    if (this.#cell(p.x, p.y) !== target) p.queue.push({ kind: "move", target });
  }
  #pickup(
    p: SettlementCitizen,
    endpoint: string,
    resource: string,
    amount: number,
  ) {
    this.#moveTo(p, this.#endpointCell(endpoint));
    p.queue.push({
      kind: "pickup",
      endpoint,
      resource,
      amount,
      token: this.#reserve(p, endpoint, resource, amount, "pickup"),
    });
  }
  #storage(p: SettlementCitizen, amount: number) {
    const cell = this.#cell(p.x, p.y);
    return this.#state.buildings
      .filter(
        (b) =>
          b.complete &&
          this.#def(b).capacity &&
          Object.values(b.inventory).reduce((a, b) => a + b, 0) +
            this.#state.reservations
              .filter((r) => r.endpoint === b.id && r.kind === "capacity")
              .reduce((a, b) => a + b.amount, 0) +
            amount <=
            this.#def(b).capacity! &&
          this.#navigation.reachable(cell, this.#door(b)),
      )
      .sort(
        (a, b) =>
          this.#navigation.distance(cell, this.#door(a)) -
          this.#navigation.distance(cell, this.#door(b)),
      )[0];
  }
  #deposit(
    p: SettlementCitizen,
    b: SettlementBuilding,
    resource: string,
    amount: number,
  ) {
    this.#moveTo(p, this.#door(b));
    p.queue.push({
      kind: "deposit",
      endpoint: b.id,
      resource,
      amount,
      token: this.#reserve(p, b.id, resource, amount, "capacity"),
    });
  }
  command(command: string) {
    const s = this.#state;
    if (
      command.startsWith("speed:") &&
      [0, 1, 2, 4].includes(Number(command.slice(6)))
    )
      s.speed = Number(command.slice(6));
    if (command.startsWith("build:")) {
      s.placement = command.slice(6);
      s.message = "Click a clear site. Door access must remain open.";
    }
    if (command.startsWith("select:")) s.selected = command.slice(7);
    if (command === "cancel") s.placement = undefined;
    if (command === "demolish" && s.selected) this.#demolish(s.selected);
    if (
      command.startsWith("staff:") &&
      Number.isFinite(Number(command.slice(6)))
    ) {
      const b = s.buildings.find((v) => v.id === s.selected);
      if (b && b.complete)
        b.assigned = Math.max(
          0,
          Math.min(12, b.assigned + Number(command.slice(6))),
        );
    }
  }
  place(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const s = this.#state,
      type = s.placement;
    if (!type) return;
    const d = this.#definition.buildings.find((b) => b.id === type);
    if (!d && type !== "road") return;
    x = Math.floor(x);
    y = Math.floor(y);
    if (type === "road") {
      if (
        x < 0 ||
        y < 0 ||
        x >= this.#definition.width ||
        y >= this.#definition.height
      )
        return;
      const i = this.#cell(x, y);
      if (
        s.terrain[i] !== 1 &&
        !s.buildings.some((b) => {
          const bd = this.#def(b);
          return x >= b.x && x < b.x + bd.size && y >= b.y && y < b.y + bd.size;
        })
      ) {
        s.terrain[i] = 4;
        this.#dirtyCell(i);
        this.#navigation.setCell(i, true, 0.5);
      }
      return;
    }
    if (!d) return;
    if (s.buildings.length >= 60) {
      s.message = "Building limit reached (60).";
      return;
    }
    const cells: number[] = [];
    for (let yy = y; yy < y + d.size; yy++)
      for (let xx = x; xx < x + d.size; xx++) cells.push(this.#cell(xx, yy));
    if (
      x < 0 ||
      y < 0 ||
      x + d.size >= this.#definition.width ||
      y + d.size >= this.#definition.height ||
      cells.some(
        (i) =>
          (!d.passable && s.terrain[i] === 1) ||
          s.buildings.some((b) => {
            const bd = this.#def(b);
            return (
              i % this.#definition.width >= b.x &&
              i % this.#definition.width < b.x + bd.size &&
              Math.floor(i / this.#definition.width) >= b.y &&
              Math.floor(i / this.#definition.width) < b.y + bd.size
            );
          }) ||
          s.people.some((p) => this.#cell(p.x, p.y) === i),
      )
    ) {
      s.message = "Site occupied, outside the map, or blocked by water.";
      return;
    }
    const b = this.#addBuilding(type, x, y);
    s.selected = b.id;
    s.placement = undefined;
    s.message = this.#navigation.reachable(this.#door(b), this.#cell(20, 26))
      ? "Site reserved. Builders will deliver materials."
      : "Door access is blocked: reopen a route or demolish to recover materials.";
  }
  #demolish(id: string) {
    const s = this.#state,
      b = s.buildings.find((v) => v.id === id);
    if (!b) return;
    for (const p of s.people) {
      if (
        p.queue.some(
          (a) =>
            ("building" in a && a.building === id) ||
            ("endpoint" in a && a.endpoint === id),
        )
      )
        this.#cancel(p);
      if (p.house === id) p.house = undefined;
    }
    s.reservations = s.reservations.filter((r) => r.endpoint !== id);
    s.piles.push({
      id: `pile-${s.nextId++}`,
      cell: this.#door(b),
      inventory: {
        ...b.inventory,
        ...Object.fromEntries(
          Object.entries(b.materials).map(([k, v]) => [
            k,
            v + (b.inventory[k] ?? 0),
          ]),
        ),
      },
    });
    const d = this.#def(b);
    for (let y = b.y; y < b.y + d.size; y++)
      for (let x = b.x; x < b.x + d.size; x++) {
        const cell = this.#cell(x, y);
        if (d.passable) s.terrain[cell] = this.#definition.terrain[cell]!;
        this.#navigation.setCell(
          cell,
          s.terrain[cell] !== 1,
          s.terrain[cell] === 4 ? 0.5 : 1,
        );
        this.#dirtyCell(cell);
      }
    this.#dirtyCell(this.#cell(b.x, b.y));
    s.buildings = s.buildings.filter((v) => v !== b);
    this.#assignHomes();
  }
  #decide(p: SettlementCitizen) {
    const s = this.#state;
    if (s.time < p.retry && p.revision === this.#navigation.revision) return;
    p.revision = this.#navigation.revision;
    if (
      (p.hunger > 45 || p.cold > 30) &&
      Object.values(p.cargo).some((n) => n > 0)
    ) {
      s.piles.push({
        id: `pile-${s.nextId++}`,
        cell: this.#cell(p.x, p.y),
        inventory: { ...p.cargo },
      });
      p.cargo = {};
    }
    const cargo = Object.entries(p.cargo).find(([, n]) => n > 0);
    if (cargo) {
      const b = this.#storage(p, cargo[1]);
      if (b) {
        this.#deposit(p, b, cargo[0], cargo[1]);
        p.why = `Delivering ${cargo[1]} ${cargo[0]} to storage`;
        return;
      }
      p.why = "Storage full or unreachable; retaining cargo";
      p.retry = s.time + 3;
      return;
    }
    if (p.cold > 15 && p.house) {
      const home = s.buildings.find((b) => b.id === p.house);
      if (home && (home.inventory.firewood ?? 0) > 0) {
        this.#moveTo(p, this.#door(home));
        p.queue.push({ kind: "warm", elapsed: 0 });
        p.why = "Returning home to warm up";
        return;
      }
    }
    if (p.cold > 15 || p.hunger > 22) {
      const resource = p.cold > 15 ? "firewood" : "food",
        source = this.#sources(p, resource)[0];
      if (source) {
        this.#pickup(p, source.id, resource, 1);
        p.queue.push({
          kind: resource === "food" ? "eat" : "warm",
          elapsed: 0,
        });
        p.why = resource === "food" ? "Fetching a meal" : "Seeking warmth";
        return;
      }
      p.why = `No reachable ${resource}; retrying after backoff`;
      p.retry = s.time + 5;
    }
    const home = s.buildings.find((b) => b.id === p.house);
    if (
      home &&
      s.season >= 2 &&
      (home.inventory.firewood ?? 0) +
        this.#reserved(home.id, "firewood", "capacity") <
        5
    ) {
      const source = this.#sources(p, "firewood")[0];
      if (source && source.id !== home.id) {
        const amount = Math.min(
          4,
          (source.inventory.firewood ?? 0) -
            this.#reserved(source.id, "firewood", "pickup"),
        );
        this.#pickup(p, source.id, "firewood", amount);
        this.#deposit(p, home, "firewood", amount);
        p.why = "Stocking household firewood";
        return;
      }
    }
    const incomplete = s.buildings
      .filter(
        (b) =>
          !b.complete &&
          this.#navigation.reachable(this.#cell(p.x, p.y), this.#door(b)),
      )
      .sort(
        (a, b) =>
          this.#navigation.distance(this.#cell(p.x, p.y), this.#door(a)) -
          this.#navigation.distance(this.#cell(p.x, p.y), this.#door(b)),
      );
    for (const b of incomplete) {
      const d = this.#def(b);
      const missing = Object.entries(d.cost).find(
        ([r, n]) =>
          (b.materials[r] ?? 0) + this.#reserved(b.id, r, "capacity") < n,
      );
      if (missing) {
        const [resource, n] = missing;
        const source = this.#sources(p, resource)[0];
        if (source) {
          const amount = Math.min(
            4,
            n -
              (b.materials[resource] ?? 0) -
              this.#reserved(b.id, resource, "capacity"),
            (source.inventory[resource] ?? 0) -
              this.#reserved(source.id, resource, "pickup"),
          );
          this.#pickup(p, source.id, resource, amount);
          this.#deposit(p, b, resource, amount);
          p.why = `Delivering ${resource} to ${d.name}`;
          return;
        }
      } else if (
        Object.entries(d.cost).every(([r, n]) => (b.materials[r] ?? 0) >= n) &&
        !s.people.some((q) =>
          q.queue.some((a) => a.kind === "work" && a.building === b.id),
        )
      ) {
        this.#moveTo(p, this.#door(b));
        p.queue.push({ kind: "work", building: b.id, elapsed: 0 });
        p.why = `Building ${d.name}`;
        return;
      }
    }
    const jobs = s.buildings
      .filter(
        (b) =>
          b.complete &&
          b.assigned > 0 &&
          this.#def(b).recipe &&
          (p.job === "laborer" ||
            p.job === this.#def(b).job ||
            s.time - b.progress >= 15) &&
          evaluateCondition(this.#def(b).condition, {
            flags: {},
            stats: { season: s.season },
            inventory: b.inventory,
          }) &&
          this.#navigation.reachable(this.#cell(p.x, p.y), this.#door(b)) &&
          s.people.filter((q) =>
            q.queue.some((a) => a.kind === "work" && a.building === b.id),
          ).length < b.assigned,
      )
      .sort((a, b) => {
        const preference = (v: SettlementBuilding) =>
          this.#def(v).job === p.job
            ? 0
            : p.job === "laborer" || s.time - v.progress > 15
              ? 1
              : 1000;
        return (
          preference(a) - preference(b) ||
          this.#navigation.distance(this.#cell(p.x, p.y), this.#door(a)) -
            this.#navigation.distance(this.#cell(p.x, p.y), this.#door(b))
        );
      });
    for (const b of jobs) {
      const d = this.#def(b),
        recipe = d.recipe!;
      if (recipe.seasons && !recipe.seasons.includes(s.season)) continue;
      const input = Object.entries(recipe.input ?? {}).find(
        ([r, n]) => (b.inventory[r] ?? 0) < n,
      );
      if (input) {
        const source = this.#sources(p, input[0], input[1])[0];
        if (source && source.id !== b.id) {
          this.#pickup(p, source.id, input[0], input[1]);
          this.#deposit(p, b, input[0], input[1]);
          p.why = `Supplying ${d.name}`;
          return;
        }
        continue;
      }
      if (
        recipe.deposit &&
        !s.terrain.some((t) => t === Number(recipe.deposit))
      )
        continue;
      this.#moveTo(p, this.#door(b));
      p.queue.push({ kind: "work", building: b.id, elapsed: 0 });
      p.job = d.job ?? "laborer";
      p.why = `Working at ${d.name}`;
      return;
    }
    for (const source of [
      ...s.piles,
      ...s.buildings
        .filter(
          (b) => b.complete && !this.#def(b).capacity && !this.#def(b).housing,
        )
        .map((b) => ({
          id: b.id,
          cell: this.#door(b),
          inventory: b.inventory,
        })),
    ])
      for (const [resource, n] of Object.entries(source.inventory)) {
        const building = s.buildings.find((b) => b.id === source.id);
        const retained = building
          ? (this.#def(building).recipe?.input?.[resource] ?? 0) * 2
          : 0;
        const amount = Math.min(
            4,
            n - retained - this.#reserved(source.id, resource, "pickup"),
          ),
          storage = this.#storage(p, amount);
        if (
          amount > 0 &&
          storage &&
          this.#navigation.reachable(this.#cell(p.x, p.y), source.cell)
        ) {
          this.#pickup(p, source.id, resource, amount);
          this.#deposit(p, storage, resource, amount);
          p.why = `Hauling ${resource} from local pile`;
          return;
        }
      }
    if (!p.why.startsWith("No reachable"))
      p.why = "Idle: no reachable staffed job or delivery";
    p.retry = s.time + 2;
  }
  step(dt: number) {
    if (!Number.isFinite(dt) || dt < 0 || this.#state.outcome !== "playing")
      return;
    this.#accumulator = Math.min(
      1.2,
      this.#accumulator + dt * this.#state.speed,
    );
    let ticks = 0;
    while (this.#accumulator >= 0.1 && ticks++ < 12) {
      this.#accumulator -= 0.1;
      this.#tick();
    }
  }
  #tick() {
    const s = this.#state;
    s.time += 0.1;
    s.tick++;
    s.season = Math.min(3, Math.floor(s.time / this.#definition.seasonSeconds));
    this.#navigation.step();
    if (s.season === 1 && !s.migrated) {
      s.migrated = true;
      for (
        let i = 0;
        i < this.#definition.migrants && s.people.length < 48;
        i++
      )
        this.#addPerson();
      this.#assignHomes();
      s.message = "Summer arrivals need housing and food.";
      this.#emit("discovery");
    }
    if (s.season === 3) {
      s.fireTimer += 0.1;
      if (s.fireTimer >= 20) {
        s.fireTimer = 0;
        for (const b of s.buildings.filter(
          (b) =>
            b.complete &&
            this.#def(b).housing &&
            s.people.some((p) => p.house === b.id),
        )) {
          if ((b.inventory.firewood ?? 0) > 0) {
            b.inventory.firewood!--;
            for (const p of s.people.filter((p) => p.house === b.id))
              p.cold = Math.max(0, p.cold - 25);
          }
        }
      }
    }
    for (const p of s.people) {
      p.hunger += 0.1;
      p.cold =
        s.season === 3
          ? p.cold + 0.1 * (p.house ? 1 : 2)
          : Math.max(0, p.cold - 0.3);
      if ((s.tick + Number(p.id.split("-")[1])) % 10 === 0) {
        if (p.hunger > 60 || p.cold > 45) p.health = Math.max(0, p.health - 2);
        if (
          (p.hunger > 45 || p.cold > 30) &&
          (s.time >= p.retry || p.revision !== this.#navigation.revision) &&
          p.queue.length &&
          !p.queue.some((a) => a.kind === "eat" || a.kind === "warm")
        ) {
          this.#cancel(p);
          p.retry = 0;
        }
        if (!p.queue.length) this.#decide(p);
      }
      const a = p.queue[0];
      if (!a) continue;
      if (a.kind === "move") {
        if (a.request === undefined)
          a.request = this.#navigation.request(this.#cell(p.x, p.y), a.target);
        const result = this.#navigation.result(a.request);
        if (result?.status === "complete") {
          a.path ??= [...result.path.slice(1)];
          const next = a.path[0];
          if (next === undefined) {
            this.#navigation.retire(a.request);
            p.queue.shift();
          } else {
            const x = (next % this.#definition.width) + 0.5,
              y = Math.floor(next / this.#definition.width) + 0.5,
              d = Math.hypot(x - p.x, y - p.y);
            if (d < 0.2) {
              p.x = x;
              p.y = y;
              a.path.shift();
            } else {
              p.x += ((x - p.x) / d) * 0.2;
              p.y += ((y - p.y) / d) * 0.2;
            }
          }
        } else if (
          a.request < 0 ||
          result?.status === "unreachable" ||
          result?.status === "stale"
        ) {
          this.#cancel(p);
          p.why = "Route blocked; waiting for terrain change or retry";
          p.retry = s.time + 4;
        }
      } else if (a.kind === "pickup") {
        const inv = this.#endpoint(a.endpoint);
        if (inv && (inv[a.resource] ?? 0) >= a.amount) {
          inv[a.resource] -= a.amount;
          p.cargo[a.resource] = (p.cargo[a.resource] ?? 0) + a.amount;
        } else {
          this.#cancel(p);
          p.retry = s.time + 2;
        }
        this.#release(a.token);
        if (p.queue[0] === a) p.queue.shift();
      } else if (a.kind === "deposit") {
        const b = s.buildings.find((b) => b.id === a.endpoint);
        if (b) {
          const target = b.complete ? b.inventory : b.materials;
          const amount = Math.min(a.amount, p.cargo[a.resource] ?? 0);
          if (
            commitCargoDelivery(
              p.cargo,
              a.resource,
              amount,
              (resource, quantity) => {
                target[resource] = (target[resource] ?? 0) + quantity;
                return true;
              },
            )
          )
            this.#emit("delivery");
        }
        this.#release(a.token);
        p.queue.shift();
      } else if (a.kind === "eat" || a.kind === "warm") {
        a.elapsed += 0.1;
        if (a.elapsed > 0.8) {
          const r = a.kind === "eat" ? "food" : "firewood";
          if (
            a.kind === "warm" &&
            p.house &&
            (s.buildings.find((b) => b.id === p.house)?.inventory.firewood ??
              0) > 0
          ) {
            p.cold = Math.max(0, p.cold - 35);
          } else if ((p.cargo[r] ?? 0) > 0) {
            p.cargo[r]--;
            if (a.kind === "eat") p.hunger = Math.max(0, p.hunger - 30);
            else p.cold = Math.max(0, p.cold - 35);
          }
          p.queue.shift();
        }
      } else if (a.kind === "work") {
        const b = s.buildings.find((b) => b.id === a.building);
        if (!b) {
          this.#cancel(p);
          continue;
        }
        const d = this.#def(b);
        p.work ??= {
          id: s.nextId++,
          elapsed: 0,
          timing: { tell: 0.2, active: 0.55, recover: 0.25 },
          hits: [],
        };
        p.work.elapsed = (p.work.elapsed + 0.1) % 1;
        void actionPhase(p.work);
        a.elapsed += 0.1;
        if (!b.complete) {
          b.work += 0.1;
          if (b.work >= 12) {
            b.complete = true;
            if (d.passable) {
              for (let yy = b.y; yy < b.y + d.size; yy++)
                for (let xx = b.x; xx < b.x + d.size; xx++) {
                  const i = this.#cell(xx, yy);
                  s.terrain[i] = d.terrainOnComplete ?? 4;
                  this.#navigation.setCell(i, true, 0.5);
                }
            }
            b.materials = {};
            this.#assignHomes();
            this.#emit("discovery");
            p.queue.shift();
          }
        } else if (a.elapsed >= d.recipe!.seconds) {
          const recipe = d.recipe!;
          if (
            Object.entries(recipe.input ?? {}).every(
              ([r, n]) => (b.inventory[r] ?? 0) >= n,
            )
          ) {
            for (const [r, n] of Object.entries(recipe.input ?? {}))
              b.inventory[r] -= n;
            for (const [r, n] of Object.entries(recipe.output))
              b.inventory[r] = (b.inventory[r] ?? 0) + n;
            if (recipe.deposit) {
              const nearest = s.terrain
                .map((t, i) => ({
                  t,
                  i,
                  d:
                    Math.abs((i % this.#definition.width) - b.x) +
                    Math.abs(Math.floor(i / this.#definition.width) - b.y),
                }))
                .filter((v) => v.t === Number(recipe.deposit))
                .sort((a, b) => a.d - b.d)[0];
              if (nearest) {
                s.terrain[nearest.i] = 0;
                this.#dirtyCell(nearest.i);
              }
            }
          }
          b.progress = s.time;
          p.queue.shift();
          p.work = undefined;
        }
      } else if (a.kind === "wait") {
        a.elapsed += 0.1;
        if (a.elapsed >= 1) p.queue.shift();
      }
    }
    for (const p of s.people.filter((p) => p.health <= 0)) {
      this.#cancel(p);
      if (Object.values(p.cargo).some((n) => n > 0))
        s.piles.push({
          id: `pile-${s.nextId++}`,
          cell: this.#cell(p.x, p.y),
          inventory: { ...p.cargo },
        });
    }
    s.people = s.people.filter((p) => p.health > 0);
    s.piles = s.piles.filter((p) =>
      Object.values(p.inventory).some((n) => n > 0),
    );
    s.warnings = [
      s.people.some((p) => p.hunger > 45) ? "Food shortage" : "",
      s.people.some((p) => p.cold > 30) ? "Freezing households" : "",
    ].filter(Boolean);
    if (s.people.length < 12) {
      s.outcome = "lost";
      s.message = "Population fell below twelve.";
      this.#emit("lose");
    } else if (s.time >= this.#definition.seasonSeconds * 4) {
      s.outcome =
        s.people.length >= 20 &&
        !s.people.some((p) => p.cold > 30) &&
        this.available("food") >= 20
          ? "won"
          : "lost";
      s.message =
        s.outcome === "won"
          ? "The settlement survived its first winter."
          : (s.warnings[0] ??
            (this.available("food") < 20
              ? "The final food reserve was too small."
              : "Too few residents survived."));
      this.#emit(s.outcome === "won" ? "win" : "lose");
    }
  }
  #emit(kind: string) {
    if (this.#events.length === 64) {
      this.#events.shift();
      this.#droppedEvents++;
    }
    this.#events.push({
      sequence: ++this.#sequence,
      tick: this.#state.tick,
      sourceId: "settlement",
      kind,
    });
  }
  drainEvents(): readonly SettlementObservation<SettlementEvent>[] {
    return this.#events.splice(0);
  }
  snapshot() {
    return structuredClone({
      ...this.#state,
      sequence: this.#sequence,
      accumulator: this.#accumulator,
      checkpoint: {
        version: 1,
        droppedEvents: this.#droppedEvents,
        seed: this.#seed,
        definition: JSON.stringify(this.#definition),
        navigation: this.#navigation.snapshot(),
        events: this.#events,
      },
    });
  }
  restore(value: unknown) {
    this.#restore(value, false);
  }
  /** Explicit migration for historical saves that cannot prove their seed or content identity. */
  restoreLegacy(value: unknown) {
    this.#restore(value, true);
  }
  #restore(value: unknown, legacy: boolean) {
    const candidate = structuredClone(value);
    assertDenseSnapshot(candidate);
    validateSettlementState(candidate, this.#definition);
    const state = candidate as SettlementState & {
      checkpoint?: {
        version: number;
        droppedEvents?: number;
        seed: number;
        definition: string;
        navigation: unknown;
        events: SettlementEvent[];
      };
    };
    if (state.checkpoint === undefined && !legacy)
      throw Error(
        "Settlement snapshot identity required; use restoreLegacy for explicit migration",
      );
    if (legacy && state.checkpoint !== undefined)
      throw Error("Legacy settlement snapshots must not contain a checkpoint");
    const navigation = new LiveNavigation({
      width: this.#definition.width,
      height: this.#definition.height,
      walkable: state.terrain.map((t) => t !== 1),
      costs: state.terrain.map((t) => (t === 4 ? 0.5 : 1)),
    });
    let events: SettlementEvent[] = [];
    let droppedEvents = 0;
    if (state.checkpoint !== undefined) {
      const checkpoint = state.checkpoint;
      if (
        !checkpoint ||
        checkpoint.version !== 1 ||
        checkpoint.seed !== this.#seed ||
        checkpoint.definition !== JSON.stringify(this.#definition) ||
        !(
          checkpoint.droppedEvents === undefined ||
          (Number.isSafeInteger(checkpoint.droppedEvents) &&
            checkpoint.droppedEvents >= 0 &&
            checkpoint.droppedEvents <= state.sequence)
        ) ||
        !Array.isArray(checkpoint.events)
      )
        throw Error("Incompatible settlement snapshot");
      let sequence = 0;
      for (const event of checkpoint.events) {
        if (
          !event ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence <= sequence ||
          event.sequence > state.sequence ||
          !Number.isSafeInteger(event.tick) ||
          event.tick < 0 ||
          event.tick > state.tick ||
          event.sourceId !== "settlement" ||
          !["discovery", "delivery", "win", "lose"].includes(event.kind)
        )
          throw Error("Invalid settlement events");
        sequence = event.sequence;
      }
      if (
        checkpoint.events.length > 64 ||
        (checkpoint.droppedEvents ?? 0) + checkpoint.events.length >
          state.sequence
      )
        throw Error("Invalid settlement events");
      navigation.restore(checkpoint.navigation);
      const topology = navigation.snapshot();
      const walkable = state.terrain.map((t) => t !== 1);
      const costs = state.terrain.map((t) => (t === 4 ? 0.5 : 1));
      for (const building of state.buildings) {
        const d = this.#definition.buildings.find(
          (d) => d.id === building.type,
        )!;
        for (let y = building.y; y < building.y + d.size; y++)
          for (let x = building.x; x < building.x + d.size; x++) {
            const cell = y * this.#definition.width + x;
            if (!d.passable) {
              walkable[cell] = false;
              costs[cell] = 1;
            } else if (building.complete) {
              walkable[cell] = true;
              costs[cell] = 0.5;
            }
          }
      }
      if (
        topology.cells.some((v, i) => v !== walkable[i]) ||
        topology.costs.some((v, i) => v !== costs[i])
      )
        throw Error("Inconsistent settlement navigation");
      for (const person of state.people)
        for (const action of person.queue)
          if (
            action.kind === "move" &&
            action.request !== undefined &&
            action.request >= 0
          ) {
            const search = topology.searches.find(
              (s) => s.id === action.request,
            );
            if (
              !search ||
              search.goal !== action.target ||
              (action.path !== undefined &&
                (action.path.length > search.path.length ||
                  action.path.some(
                    (v, i) =>
                      v !==
                      search.path[search.path.length - action.path!.length + i],
                  )))
            )
              throw Error("Inconsistent settlement route");
          }
      events = checkpoint.events;
      droppedEvents = checkpoint.droppedEvents ?? 0;
    } else {
      // Legacy checkpoints did not persist the search scheduler. Replan routes.
      for (const person of state.people)
        for (const action of person.queue)
          if (action.kind === "move") {
            action.request = undefined;
            action.path = undefined;
          }
      for (const building of state.buildings) {
        const definition = this.#definition.buildings.find(
          (d) => d.id === building.type,
        )!;
        for (let y = building.y; y < building.y + definition.size; y++)
          for (let x = building.x; x < building.x + definition.size; x++) {
            const cell = y * this.#definition.width + x;
            if (!definition.passable) navigation.setCell(cell, false);
            else if (building.complete) navigation.setCell(cell, true, 0.5);
          }
      }
    }
    delete state.checkpoint;
    this.#state = state;
    this.#navigation = navigation;
    this.#events = events;
    this.#droppedEvents = droppedEvents;
    this.#accumulator = state.accumulator;
    this.#sequence = state.sequence;
  }
}

function validateSettlementState(
  value: unknown,
  definition: SettlementDefinition,
): asserts value is SettlementState {
  const fail = (): never => {
    throw Error("Invalid settlement snapshot");
  };
  const object = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const number = (v: unknown, min = 0) =>
    typeof v === "number" && Number.isFinite(v) && v >= min;
  const integer = (v: unknown, min = 0) =>
    number(v, min) && Number.isSafeInteger(v);
  const text = (v: unknown) => typeof v === "string";
  const inventory = (v: unknown) =>
    object(v) && Object.values(v).every((n) => number(n));
  const optionalText = (v: unknown) => v === undefined || text(v);
  const cells = definition.width * definition.height;
  const cell = (v: unknown) => integer(v) && (v as number) < cells;
  if (!object(value)) fail();
  const s = value as Record<string, any>;
  if (
    !number(s.time) ||
    !integer(s.tick) ||
    Math.abs(s.time - s.tick * 0.1) > Math.max(1e-6, s.time * 1e-10) ||
    ![0, 1, 2, 4].includes(s.speed) ||
    !integer(s.season) ||
    s.season !== Math.min(3, Math.floor(s.time / definition.seasonSeconds)) ||
    !["playing", "won", "lost"].includes(s.outcome) ||
    !integer(s.nextId, 1) ||
    !integer(s.sequence) ||
    !number(s.accumulator) ||
    s.accumulator > 1.2 ||
    !number(s.fireTimer) ||
    s.fireTimer >= 20.1 ||
    !text(s.message) ||
    typeof s.migrated !== "boolean" ||
    !optionalText(s.selected) ||
    !optionalText(s.placement) ||
    !Array.isArray(s.warnings) ||
    !s.warnings.every(text) ||
    !Array.isArray(s.terrain) ||
    s.terrain.length !== cells ||
    !s.terrain.every((n: unknown) => integer(n)) ||
    !Array.isArray(s.chunkRevisions) ||
    s.chunkRevisions.length !==
      Math.ceil(definition.width / 8) * Math.ceil(definition.height / 8) ||
    !s.chunkRevisions.every((n: unknown) => integer(n)) ||
    !Array.isArray(s.people) ||
    !Array.isArray(s.buildings) ||
    !Array.isArray(s.piles) ||
    !Array.isArray(s.reservations)
  )
    fail();
  const ids = new Set<string>();
  const numericIds = new Set<number>();
  const claimNumber = (id: unknown) => {
    if (
      !integer(id, 1) ||
      (id as number) >= s.nextId ||
      numericIds.has(id as number)
    )
      fail();
    numericIds.add(id as number);
  };
  const claim = (id: unknown, prefix: string) => {
    if (
      !text(id) ||
      !(id as string).startsWith(prefix + "-") ||
      ids.has(id as string)
    )
      fail();
    const suffix = (id as string).slice(prefix.length + 1);
    if (!/^[1-9]\d*$/.test(suffix)) fail();
    claimNumber(Number(suffix));
    ids.add(id as string);
  };
  const buildings = new Map<string, SettlementBuildingDefinition>();
  for (const b of s.buildings) {
    if (!object(b)) fail();
    claim(b.id, "building");
    const d = definition.buildings.find((d) => d.id === b.type);
    if (
      !d ||
      !integer(b.x) ||
      !integer(b.y) ||
      b.x + d.size > definition.width ||
      b.y + d.size > definition.height ||
      typeof b.complete !== "boolean" ||
      !inventory(b.materials) ||
      !inventory(b.inventory) ||
      !number(b.work) ||
      !number(b.assigned) ||
      b.assigned > 12 ||
      !number(b.progress)
    )
      fail();
    buildings.set(b.id, d!);
  }
  for (const p of s.piles) {
    if (!object(p)) fail();
    claim(p.id, "pile");
    if (!cell(p.cell) || !inventory(p.inventory)) fail();
  }
  const endpoints = new Set([
    ...buildings.keys(),
    ...s.piles.map((p: any) => p.id),
  ]);
  const people = new Set<string>();
  for (const p of s.people) {
    if (!object(p)) fail();
    claim(p.id, "person");
    people.add(p.id);
    if (
      !number(p.x) ||
      p.x >= definition.width ||
      !number(p.y) ||
      p.y >= definition.height ||
      !number(p.health) ||
      p.health > 100 ||
      !number(p.hunger) ||
      !number(p.cold) ||
      !number(p.retry) ||
      !integer(p.revision) ||
      !text(p.job) ||
      !text(p.why) ||
      !inventory(p.cargo) ||
      !Array.isArray(p.queue) ||
      !(p.house === undefined || buildings.get(p.house)?.housing)
    )
      fail();
    if (p.work !== undefined) {
      const w = p.work;
      if (
        !object(w) ||
        !number(w.elapsed) ||
        !object(w.timing) ||
        !number(w.timing.tell) ||
        !number(w.timing.active) ||
        !number(w.timing.recover) ||
        !Array.isArray(w.hits) ||
        !w.hits.every(text)
      )
        fail();
      claimNumber(w.id);
    }
    for (const a of p.queue) {
      if (!object(a)) fail();
      if (a.kind === "move") {
        if (
          !cell(a.target) ||
          !(a.request === undefined || integer(a.request, -1)) ||
          !(
            a.path === undefined ||
            (Array.isArray(a.path) && a.path.every(cell))
          )
        )
          fail();
      } else if (a.kind === "pickup" || a.kind === "deposit") {
        // A pile can disappear after its last inventory is collected, before queued pickups execute.
        if (
          !text(a.endpoint) ||
          !text(a.resource) ||
          !number(a.amount) ||
          !integer(a.token, 1) ||
          a.token >= s.nextId
        )
          fail();
      } else if (a.kind === "work") {
        if (
          !buildings.has(a.building) ||
          !number(a.elapsed) ||
          (s.buildings.find((b: any) => b.id === a.building).complete &&
            !buildings.get(a.building)?.recipe)
        )
          fail();
      } else if (
        !["eat", "warm", "wait"].includes(a.kind) ||
        !number(a.elapsed)
      )
        fail();
    }
  }
  for (const r of s.reservations) {
    if (!object(r)) fail();
    claimNumber(r.id);
    if (
      !people.has(r.owner) ||
      !text(r.endpoint) ||
      !text(r.resource) ||
      !number(r.amount) ||
      !["pickup", "capacity"].includes(r.kind)
    )
      fail();
    const p = s.people.find((p: any) => p.id === r.owner);
    if (
      !p.queue.some(
        (a: any) =>
          a.token === r.id &&
          a.endpoint === r.endpoint &&
          a.resource === r.resource &&
          a.amount === r.amount &&
          a.kind === (r.kind === "pickup" ? "pickup" : "deposit"),
      )
    )
      fail();
  }
  for (const p of s.people)
    for (const a of p.queue)
      if (
        (a.kind === "pickup" || a.kind === "deposit") &&
        !s.reservations.some((r: any) => r.id === a.token && r.owner === p.id)
      )
        fail();
}

/** Array iteration helpers skip holes; checkpoints must have a value at every index. */
function assertDenseSnapshot(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++)
        if (!Object.hasOwn(item, i)) throw Error("Sparse checkpoint array");
    }
    pending.push(...Object.values(item));
  }
}
