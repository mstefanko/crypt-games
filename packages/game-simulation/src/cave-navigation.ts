import type { CavePoint } from "@onepage/game-project/cave-types";
import { TerrainField } from "./terrain-field";
import {
  caveActorRect,
  caveClear,
  caveConnectorClear,
  moveCaveActor,
} from "./cave-motor";
import {
  SustainedNavigationScheduler,
  type SustainedNavigationCheckpoint,
} from "./navigation-service";
import type { NavigationGrid } from "./navigation";
import { caveFields, caveInteger } from "./cave-save";
export interface CaveRoute {
  actorId: string;
  path: number[];
  cursor: number;
  sourceTerrainRevision: number;
  cohortRevision: number;
}
export interface CaveRouteRequest {
  actorId: string;
  searchId: number;
  start: number;
}
export interface CaveNavigationSnapshot {
  latest: NavigationGrid;
  sourceTerrainRevision: number;
  cohortSourceTerrainRevision: number;
  scheduler: SustainedNavigationCheckpoint;
  requests: CaveRouteRequest[];
  routes: CaveRoute[];
}
const point = (cell: number): CavePoint => ({
  x: (cell % 64) * 2048,
  y: Math.floor(cell / 64) * 2048,
});
export function caveProjection(
  field: TerrainField,
  revision: number,
): NavigationGrid {
  return {
    width: 64,
    height: 64,
    revision,
    costs: Array.from({ length: 4096 }, (_, id) =>
      caveClear(field, caveActorRect(point(id))) ? 1 : 0,
    ),
  };
}
function connector(
  field: TerrainField,
  p: CavePoint,
  grid: NavigationGrid,
): number | undefined {
  const cx = Math.floor((p.x + 1024) / 2048),
    cy = Math.floor((p.y + 1024) / 2048),
    candidates: number[] = [];
  for (let y = cy - 1; y <= cy + 1; y++)
    for (let x = cx - 1; x <= cx + 1; x++)
      if (x >= 0 && x < 64 && y >= 0 && y < 64 && grid.costs[y * 64 + x])
        candidates.push(y * 64 + x);
  candidates.sort((a, b) => {
    const pa = point(a),
      pb = point(b);
    return (
      Math.abs(p.x - pa.x) +
        Math.abs(p.y - pa.y) -
        Math.abs(p.x - pb.x) -
        Math.abs(p.y - pb.y) || a - b
    );
  });
  return candidates.find((id) => caveConnectorClear(field, p, point(id)));
}
/** Immutable N0 cohorts. New removals update latest only; live frontiers finish. */
export class CaveNavigation {
  private latest: NavigationGrid;
  private sourceTerrainRevision = 0;
  private cohortSourceTerrainRevision = 0;
  private scheduler: SustainedNavigationScheduler;
  private requests: CaveRouteRequest[] = [];
  private routes: CaveRoute[] = [];
  constructor(field: TerrainField) {
    this.latest = caveProjection(field, 0);
    this.sourceTerrainRevision = field.terrainRevision;
    this.cohortSourceTerrainRevision = field.terrainRevision;
    this.scheduler = new SustainedNavigationScheduler(this.latest);
  }
  /** Isolated simulation stage, sharing only immutable projection arrays. */
  fork(): CaveNavigation {
    const branch = Object.create(CaveNavigation.prototype) as CaveNavigation;
    branch.latest = this.latest;
    branch.sourceTerrainRevision = this.sourceTerrainRevision;
    branch.cohortSourceTerrainRevision = this.cohortSourceTerrainRevision;
    branch.scheduler = this.scheduler.fork();
    branch.requests = this.requests.map((r) => ({ ...r }));
    branch.routes = this.routes.map((r) => ({ ...r, path: r.path }));
    return branch;
  }
  publishTerrain(field: TerrainField, revision: number): void {
    if (revision === this.sourceTerrainRevision) return;
    const next = caveProjection(field, this.latest.revision + 1);
    this.sourceTerrainRevision = revision;
    if (next.costs.some((n, i) => n !== this.latest.costs[i]))
      this.latest = next;
  }
  advance(
    field: TerrainField,
    actors: readonly (CavePoint & { id: string })[],
    goal: CavePoint,
  ): void {
    const active = new Set(actors.map((a) => a.id));
    this.routes = this.routes.filter((r) => active.has(r.actorId));
    for (const request of this.requests.filter((r) => !active.has(r.actorId))) {
      const status = this.scheduler.status(request.searchId);
      if (status === "queued" || status === "searching")
        this.scheduler.cancel(request.searchId);
      this.scheduler.release(request.searchId);
    }
    this.requests = this.requests.filter((r) => active.has(r.actorId));
    this.scheduler.advance(256);
    if (
      this.requests.length &&
      this.requests.every(
        (r) =>
          !["queued", "searching"].includes(this.scheduler.status(r.searchId)!),
      )
    ) {
      const cohortRevision = this.scheduler.observeSummary().terrainRevision;
      for (const r of this.requests) {
        const path = this.scheduler.copyRoute(r.searchId);
        const actor = actors.find((a) => a.id === r.actorId);
        if (
          actor &&
          path &&
          caveConnectorClear(field, actor, point(path[0])) &&
          path.every(
            (id, i) =>
              !i || caveConnectorClear(field, point(path[i - 1]), point(id)),
          )
        )
          this.routes.push({
            actorId: r.actorId,
            path,
            cursor: 0,
            sourceTerrainRevision: this.cohortSourceTerrainRevision,
            cohortRevision,
          });
        this.scheduler.release(r.searchId);
      }
      this.requests = [];
    }
    if (this.requests.length) return;
    const cohort = this.scheduler.observeTerrain();
    if (cohort.costs.some((n, i) => n !== this.latest.costs[i])) {
      this.scheduler.setTerrain({
        ...this.latest,
        revision: cohort.revision + 1,
      });
      this.cohortSourceTerrainRevision = this.sourceTerrainRevision;
    }
    const grid = this.scheduler.observeTerrain(),
      end = connector(field, goal, grid);
    if (end === undefined) return;
    const needed = actors
      .filter((a) => !this.routes.some((r) => r.actorId === a.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const actor of needed) {
      const start = connector(field, actor, grid);
      if (start === undefined) continue;
      this.requests.push({
        actorId: actor.id,
        start,
        searchId: this.scheduler.request({
          algorithm: "bfs",
          start,
          goal: end,
        }),
      });
    }
  }
  move(field: TerrainField, actor: CavePoint & { id: string }): CavePoint {
    const route = this.routes.find((r) => r.actorId === actor.id);
    if (!route) return { x: actor.x, y: actor.y };
    while (route.cursor < route.path.length) {
      const target = point(route.path[route.cursor]);
      if (actor.x === target.x && actor.y === target.y) {
        route.cursor++;
        continue;
      }
      const dx = Math.max(-256, Math.min(256, target.x - actor.x)),
        dy = dx ? 0 : Math.max(-256, Math.min(256, target.y - actor.y));
      return moveCaveActor(field, actor, dx, dy);
    }
    this.routes = this.routes.filter((r) => r !== route);
    return { x: actor.x, y: actor.y };
  }
  mode(id: string): "following" | "waiting-for-route" {
    return this.routes.some((r) => r.actorId === id)
      ? "following"
      : "waiting-for-route";
  }
  observe() {
    return {
      projectionRevision: this.latest.revision,
      cohortRevision: this.scheduler.observeSummary().terrainRevision,
      sourceTerrainRevision: this.sourceTerrainRevision,
      cohortSourceTerrainRevision: this.cohortSourceTerrainRevision,
      pending: this.requests.length,
      maxLatencyTicks: 258,
      work: this.scheduler.observeSummary().counters,
    };
  }
  capture(): CaveNavigationSnapshot {
    return {
      latest: { ...this.latest, costs: [...this.latest.costs] },
      sourceTerrainRevision: this.sourceTerrainRevision,
      cohortSourceTerrainRevision: this.cohortSourceTerrainRevision,
      scheduler: this.scheduler.capture(),
      requests: this.requests.map((r) => ({ ...r })),
      routes: this.routes.map((r) => ({ ...r, path: [...r.path] })),
    };
  }
  restore(
    v: CaveNavigationSnapshot,
    field: TerrainField,
    terrainRevision: number,
    actors: readonly (CavePoint & { id: string })[],
    goal: CavePoint,
  ): void {
    caveFields(v, [
      "latest",
      "sourceTerrainRevision",
      "cohortSourceTerrainRevision",
      "scheduler",
      "requests",
      "routes",
    ]);
    caveFields(v.latest, ["width", "height", "revision", "costs"]);
    caveInteger(v.latest.revision, 0, terrainRevision);
    caveInteger(v.sourceTerrainRevision, 0, terrainRevision);
    caveInteger(v.cohortSourceTerrainRevision, 0, v.sourceTerrainRevision);
    if (!Array.isArray(v.requests) || !Array.isArray(v.routes))
      throw Error("Cave route arrays");
    for (const r of v.requests) caveFields(r, ["actorId", "searchId", "start"]);
    for (const r of v.routes) {
      caveFields(r, [
        "actorId",
        "path",
        "cursor",
        "sourceTerrainRevision",
        "cohortRevision",
      ]);
      caveInteger(r.cursor);
      caveInteger(r.sourceTerrainRevision, 0, terrainRevision);
      caveInteger(r.cohortRevision);
      if (!Array.isArray(r.path)) throw Error("Cave route array");
    }
    const expected = caveProjection(field, v.latest.revision),
      baseline = caveProjection(new TerrainField(field.content), 0),
      grid = v.scheduler.state.grid;
    if (
      v.sourceTerrainRevision !== terrainRevision ||
      v.cohortSourceTerrainRevision > terrainRevision ||
      v.latest.width !== 64 ||
      v.latest.height !== 64 ||
      v.latest.costs.length !== 4096 ||
      v.latest.costs.some((n, i) => n !== expected.costs[i]) ||
      grid.width !== 64 ||
      grid.height !== 64 ||
      grid.costs.some(
        (n, i) => n > expected.costs[i] || n < baseline.costs[i],
      ) ||
      v.requests.length > 7 ||
      v.routes.length > 7
    )
      throw Error("Cave navigation projection/provenance");
    const scheduler = new SustainedNavigationScheduler(grid);
    scheduler.restore(v.scheduler);
    caveInteger(grid.revision, 0, v.latest.revision);
    const goalCell = Math.floor(goal.y / 2048) * 64 + Math.floor(goal.x / 2048);
    if (
      !grid.costs[goalCell] ||
      point(goalCell).x !== goal.x ||
      point(goalCell).y !== goal.y
    )
      throw Error("Cave extraction connector");
    const ids = new Set<string>();
    for (const r of [...v.requests, ...v.routes]) {
      if (!actors.some((a) => a.id === r.actorId) || ids.has(r.actorId))
        throw Error("Cave route actor");
      ids.add(r.actorId);
    }
    const searchIds = new Set<number>();
    for (const r of v.requests) {
      const search = v.scheduler.state.searches.find(
          (s) => s.id === r.searchId,
        ),
        actor = actors.find((a) => a.id === r.actorId)!;
      if (
        searchIds.has(r.searchId) ||
        !search ||
        !["queued", "searching"].includes(search.status) ||
        r.start !== search.start ||
        search.algorithm !== "bfs" ||
        search.goal !== goalCell ||
        !caveConnectorClear(field, actor, point(r.start))
      )
        throw Error("Cave pending route");
      searchIds.add(r.searchId);
    }
    if (v.requests.length !== v.scheduler.state.searches.length)
      throw Error("Cave orphan search");
    for (const r of v.routes)
      if (
        !r.path.length ||
        r.path.length > 4096 ||
        r.cursor < 0 ||
        r.cursor > r.path.length ||
        r.sourceTerrainRevision > v.cohortSourceTerrainRevision ||
        r.cohortRevision > grid.revision ||
        r.path[r.path.length - 1] !== goalCell ||
        (r.cursor < r.path.length &&
          !caveConnectorClear(
            field,
            actors.find((a) => a.id === r.actorId)!,
            point(r.path[r.cursor]),
          )) ||
        r.path.some(
          (n, i) =>
            !Number.isInteger(n) ||
            n < 0 ||
            n >= 4096 ||
            !expected.costs[n] ||
            (i > 0 &&
              Math.abs((n % 64) - (r.path[i - 1] % 64)) +
                Math.abs(
                  Math.floor(n / 64) - Math.floor(r.path[i - 1] / 64),
                ) !==
                1),
        )
      )
        throw Error("Cave route path");
    this.latest = { ...v.latest, costs: [...v.latest.costs] };
    this.sourceTerrainRevision = v.sourceTerrainRevision;
    this.cohortSourceTerrainRevision = v.cohortSourceTerrainRevision;
    this.scheduler = scheduler;
    this.requests = v.requests.map((r) => ({ ...r }));
    this.routes = v.routes.map((r) => ({ ...r, path: [...r.path] }));
  }
}
