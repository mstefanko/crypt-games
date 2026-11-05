import {
  canonicalNavigationData as canonical,
  requireNavigationDataElements,
} from "./navigation-data";
/** N0: finite orthogonal grids. Destination cost is charged; no diagonal/corner moves. */
export const NAVIGATION_LIMITS = Object.freeze({
  cells: 256,
  requests: 16,
  quota: 64,
  ticks: 4096,
  operations: 8192,
  cost: 255,
} as const);
export interface NavigationGrid {
  width: number;
  height: number;
  revision: number;
  costs: number[];
}
export interface NavigationRequest {
  id: number;
  algorithm: "bfs" | "astar";
  start: number;
  goal: number;
}
export type NavigationStatus =
  | "queued"
  | "searching"
  | "found"
  | "unreachable"
  | "cancelled"
  | "stale";
export interface NavigationSearch extends NavigationRequest {
  terrainRevision: number;
  status: NavigationStatus;
  frontier: number[];
  distance: number[];
  parent: number[];
  closed: number[];
  path: number[];
  completedTick: number | null;
  expansions: number;
}
export interface NavigationState {
  tick: number;
  grid: NavigationGrid;
  searches: NavigationSearch[];
  counters: { expansions: number; neighborChecks: number; completed: number };
}
type Operation =
  | { kind: "request"; request: NavigationRequest }
  | { kind: "step"; quota: number }
  | { kind: "cancel"; id: number }
  | { kind: "terrain"; grid: NavigationGrid };
export interface NavigationCheckpoint {
  format: "n0-navigation-v1";
  initial: NavigationGrid;
  state: NavigationState;
  operations: Operation[];
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function integer(
  value: unknown,
  min: number,
  max: number,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < min ||
    value > max
  )
    throw Error("Invalid navigation integer");
}
function fields(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(value, key) ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !("value" in Object.getOwnPropertyDescriptor(value, key)!),
    )
  )
    throw Error("Invalid navigation fields");
}
function grid(value: unknown): NavigationGrid {
  fields(value, ["width", "height", "revision", "costs"]);
  integer(value.width, 1, 256);
  integer(value.height, 1, 256);
  integer(value.revision, 0, 4096);
  if (
    value.width * value.height > 256 ||
    !Array.isArray(value.costs) ||
    value.costs.length !== value.width * value.height ||
    Object.getPrototypeOf(value.costs) !== Array.prototype ||
    Reflect.ownKeys(value.costs).length !== value.costs.length + 1
  )
    throw Error("Invalid navigation grid");
  requireNavigationDataElements(value.costs);
  for (const cost of value.costs) integer(cost, 0, 255);
  return copy(value as unknown as NavigationGrid);
}
export class NavigationScheduler {
  private readonly initial: NavigationGrid;
  private state: NavigationState;
  private operations: Operation[] = [];
  constructor(value: NavigationGrid) {
    this.initial = grid(value);
    this.state = {
      tick: 0,
      grid: copy(this.initial),
      searches: [],
      counters: { expansions: 0, neighborChecks: 0, completed: 0 },
    };
  }
  private room(): void {
    if (this.operations.length >= NAVIGATION_LIMITS.operations)
      throw Error("Navigation operation cap");
  }
  request(value: NavigationRequest): NavigationState {
    this.room();
    fields(value, ["id", "algorithm", "start", "goal"]);
    integer(value.id, 1, 65535);
    const size = this.state.grid.costs.length;
    integer(value.start, 0, size - 1);
    integer(value.goal, 0, size - 1);
    if (value.algorithm !== "bfs" && value.algorithm !== "astar")
      throw Error("Invalid navigation algorithm");
    if (
      this.state.searches.length >= 16 ||
      this.state.searches.some((s) => s.id === value.id)
    )
      throw Error("Navigation request cap or duplicate ID");
    if (value.algorithm === "bfs" && this.state.grid.costs.some((c) => c > 1))
      throw Error("BFS requires uniform unit costs");
    this.state.searches.push({
      ...copy(value),
      terrainRevision: this.state.grid.revision,
      status: "queued",
      frontier: [value.start],
      distance: Array.from({ length: size }, (_, i) =>
        i === value.start ? 0 : -1,
      ),
      parent: Array(size).fill(-1),
      closed: [],
      path: [],
      completedTick: null,
      expansions: 0,
    });
    this.operations.push({ kind: "request", request: copy(value) });
    return this.observe();
  }
  private finish(s: NavigationSearch, status: NavigationStatus): void {
    s.status = status;
    s.completedTick = this.state.tick;
    s.frontier = [];
    this.state.counters.completed++;
  }
  cancel(id: number): NavigationState {
    this.room();
    integer(id, 1, 65535);
    const s = this.state.searches.find((s) => s.id === id);
    if (!s || !["queued", "searching"].includes(s.status))
      throw Error("Navigation request not pending");
    this.finish(s, "cancelled");
    this.operations.push({ kind: "cancel", id });
    return this.observe();
  }
  setTerrain(value: NavigationGrid): NavigationState {
    this.room();
    const next = grid(value);
    const old = this.state.grid;
    if (
      next.width !== old.width ||
      next.height !== old.height ||
      next.revision !== old.revision + 1
    )
      throw Error("Navigation terrain revision/dimensions");
    this.state.grid = next;
    for (const s of this.state.searches) {
      if (s.status === "found") {
        s.status = "stale";
        s.path = [];
      } else if (s.status === "queued" || s.status === "searching")
        this.finish(s, "stale");
    }
    this.operations.push({ kind: "terrain", grid: copy(next) });
    return this.observe();
  }
  step(quota: number): NavigationState {
    this.room();
    integer(quota, 1, 64);
    if (this.state.tick >= 4096) throw Error("Navigation tick cap");
    this.state.tick++;
    const g = this.state.grid;
    for (let work = 0; work < quota; work++) {
      const s = this.state.searches.find(
        (s) => s.status === "queued" || s.status === "searching",
      );
      if (!s) break;
      s.status = "searching";
      if (!g.costs[s.start] || !g.costs[s.goal] || !s.frontier.length) {
        this.finish(s, "unreachable");
        continue;
      }
      const heuristic = (n: number) =>
        Math.abs((n % g.width) - (s.goal % g.width)) +
        Math.abs(Math.floor(n / g.width) - Math.floor(s.goal / g.width));
      if (s.algorithm === "astar")
        s.frontier.sort(
          (a, b) =>
            s.distance[a] + heuristic(a) - (s.distance[b] + heuristic(b)) ||
            a - b,
        );
      const n = s.frontier.shift()!;
      s.closed.push(n);
      s.expansions++;
      this.state.counters.expansions++;
      if (n === s.goal) {
        const path = [];
        for (let p = n; p !== -1; p = s.parent[p]) path.push(p);
        s.path = path.reverse();
        this.finish(s, "found");
        continue;
      }
      const x = n % g.width,
        y = Math.floor(n / g.width); // Stable north, east, south, west.
      for (const next of [
        y > 0 ? n - g.width : -1,
        x < g.width - 1 ? n + 1 : -1,
        y < g.height - 1 ? n + g.width : -1,
        x > 0 ? n - 1 : -1,
      ]) {
        this.state.counters.neighborChecks++;
        if (next < 0 || !g.costs[next] || s.closed.includes(next)) continue;
        const distance = s.distance[n] + g.costs[next];
        if (s.distance[next] === -1 || distance < s.distance[next]) {
          s.distance[next] = distance;
          s.parent[next] = n;
          if (!s.frontier.includes(next)) s.frontier.push(next);
        }
      }
      if (!s.frontier.length) this.finish(s, "unreachable");
    }
    this.operations.push({ kind: "step", quota });
    return this.observe();
  }
  observe(): NavigationState {
    return copy(this.state);
  }
  capture(): NavigationCheckpoint {
    return {
      format: "n0-navigation-v1",
      initial: copy(this.initial),
      state: this.observe(),
      operations: copy(this.operations),
    };
  }
  restore(value: unknown): void {
    const normalized = canonical(value);
    fields(value, ["format", "initial", "state", "operations"]);
    if (
      value.format !== "n0-navigation-v1" ||
      canonical(value.initial) !== canonical(this.initial) ||
      !Array.isArray(value.operations) ||
      value.operations.length > 8192
    )
      throw Error("Incompatible navigation checkpoint");
    const staged = new NavigationScheduler(this.initial);
    for (const op of value.operations) {
      if (!op || typeof op !== "object")
        throw Error("Invalid navigation operation");
      switch (op.kind) {
        case "request":
          fields(op, ["kind", "request"]);
          staged.request(op.request as NavigationRequest);
          break;
        case "step":
          fields(op, ["kind", "quota"]);
          staged.step(op.quota as number);
          break;
        case "cancel":
          fields(op, ["kind", "id"]);
          staged.cancel(op.id as number);
          break;
        case "terrain":
          fields(op, ["kind", "grid"]);
          staged.setTerrain(op.grid as NavigationGrid);
          break;
        default:
          throw Error("Invalid navigation operation");
      }
    }
    if (normalized !== canonical(staged.capture()))
      throw Error("Inconsistent navigation checkpoint");
    this.state = staged.state;
    this.operations = staged.operations;
  }
}
