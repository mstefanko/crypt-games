/** Live bounded search service. Consumers: narrative walking and settlement logistics.
 * Unlike historical navigation, completed requests can be retired; no lifetime log. */
export interface LiveNavigationOptions {
  width: number;
  height: number;
  walkable?: readonly boolean[];
  costs?: readonly number[];
  maxRequests?: number;
  expansionsPerTick?: number;
}
export interface LivePathResult {
  status: "queued" | "in-progress" | "complete" | "unreachable" | "stale";
  path: number[];
  revision: number;
}
interface Search extends LivePathResult {
  start: number;
  goal: number;
  open: Set<number>;
  g: Map<number, number>;
  parent: Map<number, number>;
}
export class LiveNavigation {
  readonly width: number;
  readonly height: number;
  revision = 0;
  private cells: boolean[];
  private costs: number[];
  private regions: number[] = [];
  private searches = new Map<number, Search>();
  private next = 1;
  private dirty = true;
  private portals = new Map<number, Set<number>>();
  private local: number[] = [];
  private centers = new Map<number, { x: number; y: number }>();
  private max: number;
  private budget: number;
  constructor(o: LiveNavigationOptions) {
    const positiveInteger = (value: unknown): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    if (
      !o ||
      !positiveInteger(o.width) ||
      !positiveInteger(o.height) ||
      (o.maxRequests !== undefined && !positiveInteger(o.maxRequests)) ||
      (o.expansionsPerTick !== undefined &&
        !positiveInteger(o.expansionsPerTick))
    )
      throw Error("Invalid live navigation dimensions or budget");
    const count = o.width * o.height;
    // Ordinary arrays cannot represent more cells. A smaller workload cap needs
    // a consumer contract; this is a representation limit, not a memory budget.
    if (!Number.isSafeInteger(count) || count > 0xffffffff)
      throw Error("Invalid live navigation cell count");
    const validateArray = (
      values: unknown,
      valid: (value: unknown) => boolean,
    ) => {
      if (values === undefined) return;
      if (!Array.isArray(values) || values.length > count)
        throw Error("Invalid live navigation cell array");
      for (let i = 0; i < values.length; i++)
        if (!Object.hasOwn(values, i) || !valid(values[i]))
          throw Error("Invalid live navigation cell value");
    };
    // Dense prefixes retain the constructor's existing default-fill behavior.
    validateArray(o.walkable, (value) => typeof value === "boolean");
    validateArray(
      o.costs,
      (value) => typeof value === "number" && Number.isFinite(value),
    );
    this.width = o.width;
    this.height = o.height;
    this.cells = Array.from(
      { length: count },
      (_, i) => o.walkable?.[i] ?? true,
    );
    this.costs = this.cells.map((_, i) => Math.max(0.25, o.costs?.[i] ?? 1));
    this.max = o.maxRequests ?? 128;
    this.budget = o.expansionsPerTick ?? 512;
  }
  snapshot() {
    return structuredClone({
      width: this.width,
      height: this.height,
      cells: this.cells,
      costs: this.costs,
      revision: this.revision,
      next: this.next,
      max: this.max,
      budget: this.budget,
      searches: [...this.searches].map(([id, s]) => ({
        id,
        ...s,
        open: [...s.open],
        g: [...s.g],
        parent: [...s.parent],
      })),
    });
  }
  restore(value: unknown) {
    const v = structuredClone(value) as ReturnType<LiveNavigation["snapshot"]>;
    assertDenseSnapshot(v);
    const fail = (): never => {
      throw Error("Invalid live navigation snapshot");
    };
    const integer = (n: unknown, min = 0): n is number =>
      typeof n === "number" && Number.isSafeInteger(n) && n >= min;
    const cell = (n: unknown): n is number =>
      integer(n) && n < this.width * this.height;
    if (
      !v ||
      v.width !== this.width ||
      v.height !== this.height ||
      !integer(v.revision) ||
      !integer(v.next, 1) ||
      !integer(v.max, 1) ||
      v.max !== this.max ||
      !integer(v.budget, 1) ||
      v.budget !== this.budget ||
      !Array.isArray(v.cells) ||
      v.cells.length !== this.width * this.height ||
      !v.cells.every((n) => typeof n === "boolean") ||
      !Array.isArray(v.costs) ||
      v.costs.length !== v.cells.length ||
      !v.costs.every((n) => Number.isFinite(n) && n >= 0.25) ||
      !Array.isArray(v.searches) ||
      v.searches.length > v.max
    )
      fail();
    const searches = new Map<number, Search>();
    for (const s of v.searches) {
      if (
        !s ||
        !integer(s.id, 1) ||
        s.id >= v.next ||
        searches.has(s.id) ||
        !cell(s.start) ||
        !cell(s.goal) ||
        !["queued", "in-progress", "complete", "unreachable", "stale"].includes(
          s.status,
        ) ||
        !integer(s.revision) ||
        s.revision > v.revision ||
        !Array.isArray(s.path) ||
        !s.path.every(cell) ||
        !Array.isArray(s.open) ||
        !s.open.every(cell) ||
        new Set(s.open).size !== s.open.length ||
        !Array.isArray(s.g) ||
        !s.g.every(
          (e) =>
            Array.isArray(e) &&
            e.length === 2 &&
            cell(e[0]) &&
            Number.isFinite(e[1]) &&
            e[1] >= 0,
        ) ||
        !Array.isArray(s.parent) ||
        !s.parent.every(
          (e) => Array.isArray(e) && e.length === 2 && cell(e[0]) && cell(e[1]),
        )
      )
        fail();
      const g = new Map(s.g),
        parent = new Map(s.parent);
      if (
        g.size !== s.g.length ||
        parent.size !== s.parent.length ||
        g.get(s.start) !== 0 ||
        s.open.some((n) => !g.has(n))
      )
        fail();
      for (const [child, predecessor] of parent) {
        if (
          !g.has(child) ||
          !g.has(predecessor) ||
          g.get(predecessor)! >= g.get(child)! ||
          Math.abs((child % this.width) - (predecessor % this.width)) +
            Math.abs(
              Math.floor(child / this.width) -
                Math.floor(predecessor / this.width),
            ) !==
            1
        )
          fail();
      }
      if (
        s.status === "complete" &&
        (s.path[0] !== s.start || s.path.at(-1) !== s.goal)
      )
        fail();
      // A stale completed route retains its original path after topology edits.
      // Validate that persisted paths follow the saved search tree, regardless
      // of whether those cells remain walkable in the current topology.
      if (
        s.path.length &&
        (s.path[0] !== s.start ||
          s.path.at(-1) !== s.goal ||
          new Set(s.path).size !== s.path.length ||
          s.path.some((cell, i) => i > 0 && parent.get(cell) !== s.path[i - 1]))
      )
        fail();
      searches.set(s.id, { ...s, open: new Set(s.open), g, parent });
    }
    this.cells = v.cells;
    this.costs = v.costs;
    this.revision = v.revision;
    this.next = v.next;
    this.searches = searches;
    this.dirty = true;
  }
  private neighbors(i: number) {
    const x = i % this.width,
      y = Math.floor(i / this.width);
    return [
      x > 0 ? i - 1 : -1,
      x + 1 < this.width ? i + 1 : -1,
      y > 0 ? i - this.width : -1,
      y + 1 < this.height ? i + this.width : -1,
    ].filter((n) => n >= 0 && this.cells[n]);
  }
  setCell(i: number, walkable: boolean, cost = 1) {
    this.assertCell(i);
    if (
      typeof walkable !== "boolean" ||
      typeof cost !== "number" ||
      !Number.isFinite(cost)
    )
      throw Error("Invalid live navigation cell value");
    const normalizedCost = Math.max(0.25, cost);
    if (this.cells[i] === walkable && this.costs[i] === normalizedCost) return;
    if (
      !Number.isSafeInteger(this.revision) ||
      this.revision < 0 ||
      this.revision >= Number.MAX_SAFE_INTEGER
    )
      throw Error("Live navigation revision exhausted");
    this.cells[i] = walkable;
    this.costs[i] = normalizedCost;
    this.dirty = true;
    this.revision++;
    for (const s of this.searches.values()) s.status = "stale";
  }
  private rebuild() {
    if (!this.dirty) return;
    this.dirty = false;
    this.regions = this.cells.map(() => -1);
    this.portals.clear();
    let r = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (!this.cells[i] || this.regions[i] >= 0) continue;
      const q = [i];
      this.regions[i] = r;
      for (let p = 0; p < q.length; p++)
        for (const n of this.neighbors(q[p]!))
          if (this.regions[n] < 0) {
            this.regions[n] = r;
            q.push(n);
          }
      r++;
    }
    this.local = this.cells.map(() => -1);
    this.centers.clear();
    let node = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (!this.cells[i] || this.local[i] >= 0) continue;
      const chunk = this.chunk(i),
        queue = [i];
      this.local[i] = node;
      let x = 0,
        y = 0;
      for (let at = 0; at < queue.length; at++) {
        const v = queue[at]!;
        x += v % this.width;
        y += Math.floor(v / this.width);
        for (const n of this.neighbors(v))
          if (this.chunk(n) === chunk && this.local[n] < 0) {
            this.local[n] = node;
            queue.push(n);
          }
      }
      this.centers.set(node, { x: x / queue.length, y: y / queue.length });
      node++;
    }
    for (let i = 0; i < this.cells.length; i++)
      if (this.cells[i])
        for (const n of this.neighbors(i)) {
          const a = this.local[i]!,
            b = this.local[n]!;
          if (a !== b) {
            const set = this.portals.get(a) ?? new Set<number>();
            set.add(b);
            this.portals.set(a, set);
          }
        }
  }

  private chunk(i: number) {
    return (
      Math.floor((i % this.width) / 8) +
      Math.floor(Math.floor(i / this.width) / 8) * Math.ceil(this.width / 8)
    );
  }
  reachable(a: number, b: number) {
    this.rebuild();
    return this.regions[a] >= 0 && this.regions[a] === this.regions[b];
  }
  distance(a: number, b: number) {
    if (!this.reachable(a, b)) return Infinity;
    const start = this.local[a]!,
      goal = this.local[b]!;
    if (start === goal)
      return (
        Math.abs((a % this.width) - (b % this.width)) +
        Math.abs(Math.floor(a / this.width) - Math.floor(b / this.width))
      );
    const open = new Set([start]),
      cost = new Map([[start, 0]]);
    while (open.size) {
      let current = -1,
        best = Infinity;
      for (const n of open)
        if (cost.get(n)! < best) {
          best = cost.get(n)!;
          current = n;
        }
      open.delete(current);
      if (current === goal) {
        const first = this.centers.get(start)!,
          last = this.centers.get(goal)!;
        return (
          best +
          Math.abs(first.x - (a % this.width)) +
          Math.abs(first.y - Math.floor(a / this.width)) +
          Math.abs(last.x - (b % this.width)) +
          Math.abs(last.y - Math.floor(b / this.width))
        );
      }
      for (const n of this.portals.get(current) ?? []) {
        const u = this.centers.get(current)!,
          v = this.centers.get(n)!;
        const value = best + Math.abs(u.x - v.x) + Math.abs(u.y - v.y);
        if (value < (cost.get(n) ?? Infinity)) {
          cost.set(n, value);
          open.add(n);
        }
      }
    }
    return Infinity;
  }

  request(start: number, goal: number) {
    this.assertCell(start);
    this.assertCell(goal);
    if (this.searches.size >= this.max) return -1;
    // The next counter is persisted too; never publish an unsafe continuation.
    if (this.next >= Number.MAX_SAFE_INTEGER)
      throw Error("Live navigation request IDs exhausted");
    const id = this.next++;
    this.searches.set(id, {
      start,
      goal,
      status: this.reachable(start, goal) ? "queued" : "unreachable",
      path: [],
      revision: this.revision,
      open: new Set([start]),
      g: new Map([[start, 0]]),
      parent: new Map(),
    });
    return id;
  }
  private assertCell(i: number) {
    if (!Number.isSafeInteger(i) || i < 0 || i >= this.cells.length)
      throw Error("Invalid live navigation cell index");
  }
  result(id: number): LivePathResult | undefined {
    const search = this.searches.get(id);
    if (!search) return undefined;
    return {
      status: search.status,
      path: [...search.path],
      revision: search.revision,
    };
  }
  retire(id: number) {
    this.searches.delete(id);
  }
  step() {
    let budget = this.budget;
    for (const s of this.searches.values()) {
      if (!["queued", "in-progress"].includes(s.status)) continue;
      s.status = "in-progress";
      while (budget-- > 0 && s.open.size) {
        let current = -1,
          best = Infinity;
        for (const n of s.open) {
          const f =
            s.g.get(n)! +
            0.25 *
              (Math.abs((n % this.width) - (s.goal % this.width)) +
                Math.abs(
                  Math.floor(n / this.width) - Math.floor(s.goal / this.width),
                ));
          if (f < best) {
            best = f;
            current = n;
          }
        }
        s.open.delete(current);
        if (current === s.goal) {
          const path = [current];
          while (s.parent.has(path[0]!)) path.unshift(s.parent.get(path[0]!)!);
          s.path = path;
          s.status = "complete";
          break;
        }
        for (const n of this.neighbors(current)) {
          const cost = s.g.get(current)! + this.costs[n]!;
          if (cost < (s.g.get(n) ?? Infinity)) {
            s.g.set(n, cost);
            s.parent.set(n, current);
            s.open.add(n);
          }
        }
      }
      if (!s.open.size && s.status === "in-progress") s.status = "unreachable";
      if (budget <= 0) break;
    }
  }
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
