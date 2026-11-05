import {
  canonicalNavigationData as canonical,
  assertNavigationData,
} from "./navigation-data";
import type { NavigationGrid, NavigationSearch } from "./navigation";

/** Selected RTS workload, separate from the historical 256-cell replay owner. */
export const SUSTAINED_NAVIGATION_LIMITS = Object.freeze({
  width: 64,
  height: 64,
  searches: 32,
  quota: 256,
  defaultQuota: 128,
  expansionsPerSearch: 4096,
});
export interface SustainedNavigationState {
  tick: number;
  grid: NavigationGrid;
  nextId: number;
  cursor: number;
  searches: NavigationSearch[];
  counters: { expansions: number; neighborChecks: number; completed: number };
}
export interface SustainedNavigationCheckpoint {
  format: "n0-service-v1";
  state: SustainedNavigationState;
}
export interface SustainedNavigationRequest {
  algorithm: "bfs" | "astar";
  start: number;
  goal: number;
}
/** Detached presentation data; full search work remains available through observe/capture. */
export interface SustainedNavigationSummary {
  tick: number;
  terrainRevision: number;
  activeSearches: number;
  pendingSearches: number;
  searches: { id: number; status: NavigationSearch["status"] }[];
  counters: SustainedNavigationState["counters"];
}
export interface SustainedNavigationWork {
  expansions: number;
  neighborInspections: number;
  frontierComparisons: number;
  closedMembershipScans: number;
  frontierMembershipScans: number;
  heapComparisons: number;
  canonicalFrontierScans: number;
  canonicalFrontierMoves: number;
}
export interface SustainedNavigationDiagnostic {
  operation:
    | "expansion"
    | "request"
    | "cancel"
    | "release"
    | "terrain"
    | "sample"
    | "copy";
  phase: "before" | "after";
  tick: number;
  terrainRevision: number;
  strategy: "legacy" | "indexed";
  id?: number;
  start?: number;
  goal?: number;
  algorithm?: "bfs" | "astar";
  work?: SustainedNavigationWork;
  retainedElements?: number;
  initializedCells?: number;
  groupSize?: number;
  activeSlots?: number;
  terminalSlots?: number;
}
export interface SustainedNavigationOptions {
  strategy?: "legacy" | "indexed";
  /** Observational host hook. Must not call back into this scheduler; thrown errors are ignored. */
  diagnostics?: (event: SustainedNavigationDiagnostic) => void;
}
/** Derived acceleration only; canonical frontier order remains checkpoint authority. */
class SearchIndex {
  closed: Set<number>;
  members: Set<number>;
  heap: number[] = [];
  positions = new Map<number, number>();
  constructor(
    private search: NavigationSearch,
    private grid: NavigationGrid,
  ) {
    this.closed = new Set(search.closed);
    this.members = new Set(search.frontier);
    for (const cell of search.frontier) this.update(cell);
  }
  private less(a: number, b: number, work?: SustainedNavigationWork): boolean {
    if (work) work.heapComparisons++;
    const score = (n: number) =>
      this.search.distance[n] +
      Math.abs((n % this.grid.width) - (this.search.goal % this.grid.width)) +
      Math.abs(
        Math.floor(n / this.grid.width) -
          Math.floor(this.search.goal / this.grid.width),
      );
    return score(a) < score(b) || (score(a) === score(b) && a < b);
  }
  private swap(a: number, b: number): void {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
    this.positions.set(this.heap[a], a);
    this.positions.set(this.heap[b], b);
  }
  update(cell: number, work?: SustainedNavigationWork): void {
    const position = this.positions.get(cell);
    let i: number = position ?? this.heap.length;
    if (position === undefined) {
      this.heap.push(cell);
      this.positions.set(cell, i);
    }
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (!this.less(this.heap[i], this.heap[parent], work)) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(work?: SustainedNavigationWork): number {
    const cell = this.heap[0],
      last = this.heap.pop()!;
    this.positions.delete(cell);
    if (this.heap.length) {
      this.heap[0] = last;
      this.positions.set(last, 0);
      let i = 0;
      for (;;) {
        let child = i * 2 + 1;
        if (child >= this.heap.length) break;
        if (
          child + 1 < this.heap.length &&
          this.less(this.heap[child + 1], this.heap[child], work)
        )
          child++;
        if (!this.less(this.heap[child], this.heap[i], work)) break;
        this.swap(i, child);
        i = child;
      }
    }
    return cell;
  }
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function integer(
  v: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): asserts v is number {
  if (
    typeof v !== "number" ||
    !Number.isSafeInteger(v) ||
    Object.is(v, -0) ||
    v < min ||
    v > max
  )
    throw Error("Invalid sustained navigation integer");
}
function fields(
  v: unknown,
  keys: readonly string[],
): asserts v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    throw Error("Invalid sustained navigation fields");
}
function terrain(v: unknown): NavigationGrid {
  assertNavigationData(v); // Reject getters/hooks/sparse arrays without live JSON work.
  fields(v, ["width", "height", "revision", "costs"]);
  integer(v.width, 1, 64);
  integer(v.height, 1, 64);
  integer(v.revision, 0);
  if (!Array.isArray(v.costs) || v.costs.length !== v.width * v.height)
    throw Error("Invalid sustained navigation grid");
  for (const c of v.costs) integer(c, 0, 255);
  return {
    width: v.width,
    height: v.height,
    revision: v.revision,
    costs: [...v.costs],
  } as NavigationGrid;
}
const pending = (s: NavigationSearch) =>
  s.status === "queued" || s.status === "searching";
const add = (a: number, b = 1) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
function makeSearch(
  id: number,
  r: SustainedNavigationRequest,
  g: NavigationGrid,
): NavigationSearch {
  return {
    id,
    ...r,
    terrainRevision: g.revision,
    status: "queued",
    frontier: [r.start],
    distance: Array.from({ length: g.costs.length }, (_, i) =>
      i === r.start ? 0 : -1,
    ),
    parent: Array(g.costs.length).fill(-1),
    closed: [],
    path: [],
    completedTick: null,
    expansions: 0,
  };
}
function finish(
  s: NavigationSearch,
  status: NavigationSearch["status"],
  tick: number,
): void {
  s.status = status;
  s.completedTick = tick;
  s.frontier = [];
}
/** One slot: at most one cell expansion, four neighbors, and a bounded frontier scan. */
function expand(
  s: NavigationSearch,
  g: NavigationGrid,
  tick: number,
  index?: SearchIndex,
  work?: SustainedNavigationWork,
): number {
  s.status = "searching";
  if (!g.costs[s.start] || !g.costs[s.goal] || !s.frontier.length) {
    finish(s, "unreachable", tick);
    return 0;
  }
  let selected = 0;
  if (index && s.algorithm === "astar") {
    selected = s.frontier.indexOf(index.pop(work));
    if (work) work.canonicalFrontierScans += selected + 1;
  } else if (s.algorithm === "astar") {
    const score = (n: number) =>
      s.distance[n] +
      Math.abs((n % g.width) - (s.goal % g.width)) +
      Math.abs(Math.floor(n / g.width) - Math.floor(s.goal / g.width));
    for (let i = 1; i < s.frontier.length; i++) {
      if (work) work.frontierComparisons++;
      const a = s.frontier[i],
        b = s.frontier[selected];
      if (score(a) < score(b) || (score(a) === score(b) && a < b)) selected = i;
    }
  }
  if (work) work.canonicalFrontierMoves += s.frontier.length - selected - 1;
  const n = s.frontier.splice(selected, 1)[0];
  s.closed.push(n);
  index?.closed.add(n);
  index?.members.delete(n);
  if (work) work.expansions++;
  s.expansions++;
  if (n === s.goal) {
    for (let p = n; p !== -1; p = s.parent[p]) s.path.push(p);
    s.path.reverse();
    finish(s, "found", tick);
    return 0;
  }
  const x = n % g.width,
    y = Math.floor(n / g.width);
  for (const next of [
    y ? n - g.width : -1,
    x < g.width - 1 ? n + 1 : -1,
    y < g.height - 1 ? n + g.width : -1,
    x ? n - 1 : -1,
  ]) {
    if (work) work.neighborInspections++;
    if (next < 0 || !g.costs[next]) continue;
    if (work && !index)
      work.closedMembershipScans += s.closed.includes(next)
        ? s.closed.indexOf(next) + 1
        : s.closed.length;
    if (index ? index.closed.has(next) : s.closed.includes(next)) continue;
    const distance = s.distance[n] + g.costs[next];
    if (s.distance[next] === -1 || distance < s.distance[next]) {
      s.distance[next] = distance;
      s.parent[next] = n;
      if (work && !index)
        work.frontierMembershipScans += s.frontier.includes(next)
          ? s.frontier.indexOf(next) + 1
          : s.frontier.length;
      if (!(index ? index.members.has(next) : s.frontier.includes(next)))
        s.frontier.push(next);
      if (index) {
        index.members.add(next);
        if (s.algorithm === "astar") index.update(next, work);
      }
    }
  }
  if (!s.frontier.length) finish(s, "unreachable", tick);
  return 4;
}

/** Bounded live slots with explicit terminal release; no journal or lifetime request cap. */
export class SustainedNavigationScheduler {
  private state: SustainedNavigationState;
  private options: SustainedNavigationOptions;
  private indexes = new Map<number, SearchIndex>();
  constructor(value: NavigationGrid, options: SustainedNavigationOptions = {}) {
    if (
      options.strategy !== undefined &&
      options.strategy !== "legacy" &&
      options.strategy !== "indexed"
    )
      throw Error("Invalid navigation strategy");
    this.options = { ...options };
    this.state = {
      tick: 0,
      grid: terrain(value),
      nextId: 1,
      cursor: 0,
      searches: [],
      counters: { expansions: 0, neighborChecks: 0, completed: 0 },
    };
  }
  private emit(
    operation: SustainedNavigationDiagnostic["operation"],
    phase: "before" | "after",
    search?: Pick<NavigationSearch, "id" | "start" | "goal" | "algorithm">,
    work?: SustainedNavigationWork,
    retainedElements?: number,
  ): void {
    try {
      this.options.diagnostics?.({
        operation,
        phase,
        tick: this.state.tick,
        terrainRevision: this.state.grid.revision,
        strategy: this.options.strategy ?? "legacy",
        ...(search
          ? {
              id: search.id,
              start: search.start,
              goal: search.goal,
              algorithm: search.algorithm,
            }
          : {}),
        ...(work ? { work } : {}),
        ...(retainedElements === undefined ? {} : { retainedElements }),
        ...(operation === "request" && phase === "after" && search
          ? {
              initializedCells: this.state.grid.costs.length,
              groupSize: this.state.searches.filter(
                (s) =>
                  pending(s) &&
                  s.goal === search.goal &&
                  s.algorithm === search.algorithm &&
                  s.terrainRevision === this.state.grid.revision,
              ).length,
              activeSlots: this.state.searches.filter(pending).length,
              terminalSlots: this.state.searches.filter((s) => !pending(s))
                .length,
            }
          : {}),
      });
    } catch {
      // Diagnostics are outside simulation authority.
    }
  }
  private rebuildIndexes(): void {
    this.indexes = new Map();
    if (this.options.strategy === "indexed")
      for (const search of this.state.searches)
        if (pending(search))
          this.indexes.set(search.id, new SearchIndex(search, this.state.grid));
  }
  /** Isolated bounded stage for owners publishing a larger atomic transaction.
   * No canonicalization, serialization or replay; only live search arrays copy. */
  fork(): SustainedNavigationScheduler {
    const branch = Object.create(
      SustainedNavigationScheduler.prototype,
    ) as SustainedNavigationScheduler;
    const s = this.state;
    branch.state = {
      ...s,
      grid: s.grid,
      counters: { ...s.counters },
      searches: s.searches.map((search) => ({
        ...search,
        frontier: [...search.frontier],
        distance: [...search.distance],
        parent: [...search.parent],
        closed: [...search.closed],
        path: [...search.path],
      })),
    };
    branch.options = this.options;
    branch.rebuildIndexes();
    if (this.options.diagnostics)
      this.emit(
        "copy",
        "after",
        undefined,
        undefined,
        s.searches.reduce(
          (n, search) =>
            n +
            search.frontier.length +
            search.distance.length +
            search.parent.length +
            search.closed.length +
            search.path.length,
          0,
        ),
      );
    return branch;
  }
  request(value: SustainedNavigationRequest): number {
    assertNavigationData(value);
    fields(value, ["algorithm", "start", "goal"]);
    const g = this.state.grid;
    integer(value.start, 0, g.costs.length - 1);
    integer(value.goal, 0, g.costs.length - 1);
    if (value.algorithm !== "bfs" && value.algorithm !== "astar")
      throw Error("Invalid navigation algorithm");
    if (value.algorithm === "bfs" && g.costs.some((c) => c > 1))
      throw Error("BFS requires unit costs");
    if (
      this.state.searches.length >= 32 ||
      this.state.nextId >= Number.MAX_SAFE_INTEGER
    )
      throw Error("Sustained navigation live slot/ID cap");
    const id = this.state.nextId;
    if (this.options.diagnostics)
      this.emit("request", "before", { id, ...value });
    this.state.nextId++;
    const search = makeSearch(id, value, g);
    this.state.searches.push(search);
    if (this.options.strategy === "indexed")
      this.indexes.set(id, new SearchIndex(search, g));
    this.emit("request", "after", search);
    return id;
  }
  cancel(id: number): void {
    integer(id, 1);
    const s = this.state.searches.find((s) => s.id === id);
    if (!s || !pending(s)) throw Error("Navigation request not pending");
    finish(s, "cancelled", this.state.tick);
    this.indexes.delete(id);
    this.emit("cancel", "after", s);
    // Discard obsolete work; only current-revision pending/found/unreachable carry search arrays.
    s.distance = [];
    s.parent = [];
    s.closed = [];
    s.path = [];
    this.state.counters.completed = add(this.state.counters.completed);
  }
  release(id: number): void {
    integer(id, 1);
    const i = this.state.searches.findIndex((s) => s.id === id);
    if (i < 0 || pending(this.state.searches[i]))
      throw Error("Navigation release requires terminal result");
    this.emit("release", "after", this.state.searches[i]);
    this.indexes.delete(id);
    this.state.searches.splice(i, 1);
    if (i < this.state.cursor) this.state.cursor--;
    if (this.state.cursor >= this.state.searches.length) this.state.cursor = 0;
  }
  setTerrain(value: NavigationGrid): void {
    const next = terrain(value),
      old = this.state.grid;
    if (
      next.width !== old.width ||
      next.height !== old.height ||
      next.revision !== old.revision + 1 ||
      old.revision === Number.MAX_SAFE_INTEGER
    )
      throw Error("Navigation terrain revision/dimensions");
    this.state.grid = next;
    this.indexes.clear();
    this.emit("terrain", "after");
    for (const s of this.state.searches) {
      if (pending(s))
        this.state.counters.completed = add(this.state.counters.completed);
      if (pending(s) || s.status === "found" || s.status === "unreachable") {
        finish(s, "stale", this.state.tick);
        s.distance = [];
        s.parent = [];
        s.closed = [];
        s.path = [];
      }
    }
  }
  /** Advance authority without copying search frontiers or terrain. */
  advance(quota: number = SUSTAINED_NAVIGATION_LIMITS.defaultQuota): void {
    integer(quota, 1, 256);
    if (this.state.tick === Number.MAX_SAFE_INTEGER)
      throw Error("Navigation tick cap");
    this.state.tick++;
    const { searches, grid } = this.state;
    for (let slot = 0; slot < quota && searches.some(pending); slot++) {
      while (!pending(searches[this.state.cursor]))
        this.state.cursor = (this.state.cursor + 1) % searches.length;
      const s = searches[this.state.cursor],
        before = s.expansions;
      const work: SustainedNavigationWork | undefined = this.options.diagnostics
        ? {
            expansions: 0,
            neighborInspections: 0,
            frontierComparisons: 0,
            closedMembershipScans: 0,
            frontierMembershipScans: 0,
            heapComparisons: 0,
            canonicalFrontierScans: 0,
            canonicalFrontierMoves: 0,
          }
        : undefined;
      this.emit("expansion", "before", s);
      const checks = expand(
        s,
        grid,
        this.state.tick,
        this.indexes.get(s.id),
        work,
      );
      this.emit("expansion", "after", s, work);
      if (!pending(s)) this.indexes.delete(s.id);
      this.state.counters.expansions = add(
        this.state.counters.expansions,
        s.expansions - before,
      );
      this.state.counters.neighborChecks = add(
        this.state.counters.neighborChecks,
        checks,
      );
      if (!pending(s))
        this.state.counters.completed = add(this.state.counters.completed);
      this.state.cursor = (this.state.cursor + 1) % searches.length;
    }
  }
  /** Compatibility API: advance and return the complete detached state. */
  step(
    quota: number = SUSTAINED_NAVIGATION_LIMITS.defaultQuota,
  ): SustainedNavigationState {
    this.advance(quota);
    return this.observe();
  }
  canRequest(count: number): boolean {
    integer(count, 0, 32);
    return this.state.nextId <= Number.MAX_SAFE_INTEGER - count;
  }
  status(id: number): NavigationSearch["status"] | undefined {
    integer(id, 1);
    const search = this.state.searches.find((s) => s.id === id);
    this.emit("sample", "after", search);
    return search?.status;
  }
  /** One route cell by value; pending, stale, released and exhausted routes have none. */
  nextRouteCell(id: number, routeCursor: number): number | undefined {
    integer(id, 1);
    integer(routeCursor, 0, this.state.grid.costs.length - 1);
    const search = this.state.searches.find((s) => s.id === id);
    this.emit("sample", "after", search);
    return search?.status === "found"
      ? search.path[routeCursor + 1]
      : undefined;
  }
  isPassable(cell: number): boolean {
    integer(cell, 0, this.state.grid.costs.length - 1);
    return this.state.grid.costs[cell] > 0;
  }
  /** Detached terminal path without copying all live search work. */
  copyRoute(id: number): number[] | undefined {
    integer(id, 1);
    const search = this.state.searches.find((s) => s.id === id);
    if (this.options.diagnostics)
      this.emit(
        "copy",
        "after",
        search,
        undefined,
        search?.status === "found" ? search.path.length : 0,
      );
    return search?.status === "found" ? [...search.path] : undefined;
  }
  observeTerrain(): NavigationGrid {
    return { ...this.state.grid, costs: [...this.state.grid.costs] };
  }
  observeSummary(): SustainedNavigationSummary {
    return {
      tick: this.state.tick,
      terrainRevision: this.state.grid.revision,
      activeSearches: this.state.searches.length,
      pendingSearches: this.state.searches.filter(pending).length,
      searches: this.state.searches.map(({ id, status }) => ({ id, status })),
      counters: { ...this.state.counters },
    };
  }
  observe(): SustainedNavigationState {
    if (this.options.diagnostics)
      this.emit(
        "copy",
        "after",
        undefined,
        undefined,
        this.state.searches.reduce(
          (n, s) =>
            n +
            s.frontier.length +
            s.distance.length +
            s.parent.length +
            s.closed.length +
            s.path.length,
          0,
        ),
      );
    return copy(this.state);
  }
  capture(): SustainedNavigationCheckpoint {
    return { format: "n0-service-v1", state: this.observe() };
  }
  restore(value: unknown): void {
    if (canonical(value).length > 8 * 1024 * 1024)
      throw Error("Navigation checkpoint byte cap");
    fields(value, ["format", "state"]);
    if (value.format !== "n0-service-v1")
      throw Error("Incompatible navigation service checkpoint");
    fields(value.state, [
      "tick",
      "grid",
      "nextId",
      "cursor",
      "searches",
      "counters",
    ]);
    const v = value.state;
    integer(v.tick, 0);
    integer(v.nextId, 1);
    integer(v.cursor, 0);
    const g = terrain(v.grid);
    if (
      g.width !== this.state.grid.width ||
      g.height !== this.state.grid.height
    )
      throw Error("Incompatible navigation dimensions");
    if (
      !Array.isArray(v.searches) ||
      v.searches.length > 32 ||
      v.cursor >= Math.max(1, v.searches.length)
    )
      throw Error("Navigation live slot cap/cursor");
    fields(v.counters, ["expansions", "neighborChecks", "completed"]);
    for (const n of Object.values(v.counters)) integer(n, 0);
    let priorId = 0,
      retainedExpansions = 0;
    for (const raw of v.searches) {
      fields(raw, [
        "id",
        "algorithm",
        "start",
        "goal",
        "terrainRevision",
        "status",
        "frontier",
        "distance",
        "parent",
        "closed",
        "path",
        "completedTick",
        "expansions",
      ]);
      const s = raw as unknown as NavigationSearch;
      integer(s.id, priorId + 1, (v.nextId as number) - 1);
      priorId = s.id;
      integer(s.start, 0, g.costs.length - 1);
      integer(s.goal, 0, g.costs.length - 1);
      integer(s.terrainRevision, 0, g.revision);
      integer(s.expansions, 0, g.costs.length);
      if (s.expansions / 256 > (v.tick as number))
        throw Error("Navigation expansion clock");
      if (s.algorithm !== "bfs" && s.algorithm !== "astar")
        throw Error("Navigation algorithm");
      if (
        ![
          "queued",
          "searching",
          "found",
          "unreachable",
          "cancelled",
          "stale",
        ].includes(s.status)
      )
        throw Error("Navigation status");
      if (pending(s)) {
        if (s.completedTick !== null)
          throw Error("Navigation pending completion");
      } else {
        integer(s.completedTick, 0, v.tick as number);
        if (
          (s.status === "found" || s.status === "unreachable") &&
          s.completedTick < 1
        )
          throw Error("Navigation completion clock");
      }
      for (const a of [s.frontier, s.distance, s.parent, s.closed, s.path])
        if (!Array.isArray(a) || a.length > g.costs.length)
          throw Error("Navigation search arrays");
      if (s.status === "stale" || s.status === "cancelled") {
        if (
          [s.frontier, s.distance, s.parent, s.closed, s.path].some(
            (a) => a.length,
          )
        )
          throw Error("Navigation obsolete arrays");
        if (s.status === "stale" && s.terrainRevision >= g.revision)
          throw Error("Navigation stale revision");
      } else {
        if (
          s.terrainRevision !== g.revision ||
          (s.algorithm === "bfs" && g.costs.some((c) => c > 1))
        )
          throw Error("Navigation current revision/cost");
        const rebuilt = makeSearch(
          s.id,
          { algorithm: s.algorithm, start: s.start, goal: s.goal },
          g,
        );
        // At most 4096 expansions per retained search. Validate frontier semantics without lifetime history.
        for (let i = 0; i < s.expansions && pending(rebuilt); i++)
          expand(rebuilt, g, s.completedTick ?? 0);
        if (s.status === "unreachable" && rebuilt.status === "queued")
          expand(rebuilt, g, s.completedTick!);
        const comparable = {
          ...s,
          completedTick: pending(s) ? null : s.completedTick,
        };
        if (canonical(rebuilt) !== canonical(comparable))
          throw Error("Inconsistent navigation frontier");
      }
      retainedExpansions += s.expansions;
    }
    if (
      (v.counters.expansions as number) < retainedExpansions ||
      (v.counters.completed as number) <
        v.searches.filter((s) => !pending(s as NavigationSearch)).length
    )
      throw Error("Navigation counters");
    this.state = copy(v as unknown as SustainedNavigationState);
    this.rebuildIndexes();
  }
}
