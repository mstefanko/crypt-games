import { LiveNavigation } from "./live-navigation";
import { commitCargoDelivery } from "./production-cargo";
import { NavigationScheduler, type NavigationGrid } from "./navigation";
export interface ProductionJob {
  id: string;
  cell: number;
  workSeconds: number;
  resource: string;
  quantity: number;
  repeat: boolean;
  enabled: boolean;
}
export interface ProductionWorker {
  id: string;
  cell: number;
  job: string | null;
  state:
    | "idle"
    | "travel-to-job"
    | "work"
    | "carry-to-storage"
    | "blocked"
    | "build/repair";
  path: number[];
  travel: number;
  work: number;
  payload: { resource: string; quantity: number } | null;
}
export interface ProductionEvent {
  kind: "delivery" | "complete";
  worker: string;
  job: string;
  resource: string;
  quantity: number;
}
/** One job and payload per worker. Outputs remain carried until delivery is accepted.
 * Navigation is bounded through the shared scheduler; terrain changes explicitly replan. */
export class ProductionJobs {
  workers: ProductionWorker[];
  jobs: ProductionJob[];
  private liveNavigation: LiveNavigation;
  private navigationRevision: number;
  constructor(
    readonly grid: NavigationGrid,
    readonly storage: number,
    workers: readonly { id: string; cell: number }[],
    jobs: readonly ProductionJob[],
    readonly secondsPerCell = 0.35,
  ) {
    const validCell = (cell: number) =>
      Number.isInteger(cell) && cell >= 0 && cell < grid.costs.length;
    new NavigationScheduler(grid);
    this.navigationRevision = grid.revision;
    this.liveNavigation = new LiveNavigation({
      width: grid.width,
      height: grid.height,
      walkable: grid.costs.map(Boolean),
      costs: grid.costs,
      expansionsPerTick: 512,
      maxRequests: 1,
    });
    if (
      !Number.isFinite(secondsPerCell) ||
      secondsPerCell <= 0 ||
      !validCell(storage) ||
      workers.length > 64 ||
      jobs.length > 64 ||
      new Set(workers.map((w) => w.id)).size !== workers.length ||
      workers.some((w) => !w.id || !validCell(w.cell)) ||
      new Set(jobs.map((j) => j.id)).size !== jobs.length ||
      jobs.some(
        (j) =>
          !j.id ||
          !validCell(j.cell) ||
          !Number.isFinite(j.workSeconds) ||
          j.workSeconds <= 0 ||
          !Number.isInteger(j.quantity) ||
          j.quantity < 0 ||
          (j.quantity > 0 && !j.resource),
      )
    )
      throw Error("Invalid production definition");
    this.workers = workers.map((w) => ({
      ...w,
      job: null,
      state: "idle",
      path: [],
      travel: 0,
      work: 0,
      payload: null,
    }));
    this.jobs = jobs.map((j) => ({ ...j }));
  }
  assign(worker: string, job: string | null): boolean {
    const w = this.workers.find((w) => w.id === worker);
    if (!w || w.payload) return false;
    if (
      job !== null &&
      (!this.jobs.some((j) => j.id === job && j.enabled) ||
        this.workers.some((o) => o !== w && o.job === job))
    )
      return false;
    w.job = job;
    w.work = 0;
    w.travel = 0;
    w.path = [];
    w.state = job ? "travel-to-job" : "idle";
    return true;
  }
  private route(start: number, goal: number): number[] | null {
    if (this.navigationRevision !== this.grid.revision) {
      for (let i = 0; i < this.grid.costs.length; i++)
        this.liveNavigation.setCell(
          i,
          !!this.grid.costs[i],
          this.grid.costs[i],
        );
      this.navigationRevision = this.grid.revision;
    }
    const id = this.liveNavigation.request(start, goal);
    if (id < 0) return null;
    this.liveNavigation.step();
    const result = this.liveNavigation.result(id);
    const path = result?.status === "complete" ? result.path.slice(1) : null;
    this.liveNavigation.retire(id);
    return path;
  }

  replan(): void {
    for (const w of this.workers) {
      w.path = [];
      w.travel = 0;
      if (w.job) w.state = w.payload ? "carry-to-storage" : "travel-to-job";
    }
  }
  step(
    dt: number,
    acceptDelivery: (resource: string, quantity: number) => boolean,
  ): ProductionEvent[] {
    if (!Number.isFinite(dt) || dt < 0 || dt > 1)
      throw Error("Invalid production delta");
    const events: ProductionEvent[] = [];
    if (dt === 0) return events;
    for (const w of this.workers) {
      const job = this.jobs.find((j) => j.id === w.job);
      if ((!job || !job.enabled) && !w.payload) {
        w.state = "idle";
        w.job = null;
        w.work = 0;
        continue;
      }
      const destination = w.payload ? this.storage : job!.cell;
      if (w.cell !== destination) {
        if (w.path.some((cell) => !this.grid.costs[cell])) {
          w.path = [];
          w.travel = 0;
        }
        if (!w.path.length) {
          const route = this.route(w.cell, destination);
          if (!route) {
            w.state = "blocked";
            continue;
          }
          w.path = route;
        }
        w.state = w.payload ? "carry-to-storage" : "travel-to-job";
        w.travel += dt;
        while (w.travel >= this.secondsPerCell && w.path.length) {
          w.cell = w.path.shift()!;
          w.travel -= this.secondsPerCell;
        }
        if (w.cell === destination) w.travel = 0;
        continue;
      }
      if (w.payload) {
        w.state = "carry-to-storage";
        if (
          commitCargoDelivery(
            { [w.payload.resource]: w.payload.quantity },
            w.payload.resource,
            w.payload.quantity,
            acceptDelivery,
          )
        ) {
          events.push({
            kind: "delivery",
            worker: w.id,
            job: w.job!,
            ...w.payload,
          });
          w.payload = null;
          w.work = 0;
          if (!job?.repeat || !job.enabled) {
            w.job = null;
            w.state = "idle";
          }
        }
        continue;
      }
      if (!job) continue;
      w.state = job.repeat ? "work" : "build/repair";
      w.work += dt;
      if (w.work >= job.workSeconds) {
        w.work = 0;
        if (job.quantity > 0) {
          w.payload = { resource: job.resource, quantity: job.quantity };
          w.path = [];
          w.state = "carry-to-storage";
        } else {
          events.push({
            kind: "complete",
            worker: w.id,
            job: job.id,
            resource: job.resource,
            quantity: 0,
          });
          w.job = null;
          w.state = "idle";
        }
      }
    }
    return events;
  }
  capture() {
    return {
      workers: structuredClone(this.workers),
      jobs: structuredClone(this.jobs),
    };
  }
  restore(value: ReturnType<ProductionJobs["capture"]>): void {
    const staged = new ProductionJobs(
      this.grid,
      this.storage,
      value.workers,
      value.jobs,
      this.secondsPerCell,
    );
    const validCell = (cell: number) =>
      Number.isInteger(cell) && cell >= 0 && cell < this.grid.costs.length;
    const assigned = value.workers
      .filter((w) => w.job !== null)
      .map((w) => w.job);
    if (
      new Set(assigned).size !== assigned.length ||
      value.workers.some(
        (w) =>
          ![
            "idle",
            "travel-to-job",
            "work",
            "carry-to-storage",
            "blocked",
            "build/repair",
          ].includes(w.state) ||
          !Number.isFinite(w.travel) ||
          w.travel < 0 ||
          !Number.isFinite(w.work) ||
          w.work < 0 ||
          !Array.isArray(w.path) ||
          w.path.some((cell) => !validCell(cell)) ||
          (w.job !== null &&
            !value.jobs.some((j) => j.id === w.job) &&
            !w.payload) ||
          (w.payload &&
            (!w.job ||
              !w.payload.resource ||
              !Number.isInteger(w.payload.quantity) ||
              w.payload.quantity <= 0)),
      )
    )
      throw Error("Invalid production snapshot");
    this.workers = structuredClone(value.workers);
    this.jobs = staged.jobs;
  }
}
