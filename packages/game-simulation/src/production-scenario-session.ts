import { canonicalJson } from "./session-protocol";
import { ProductionJobs, type ProductionJob } from "./production-jobs";
import { TransactionOwner, type TransactionOperation } from "./transactions";
import { deriveRandomSeed } from "./rng";
type DeepReadonlyScenario<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonlyScenario<T[K]> }
  : T;
const RULES = Object.freeze({
  deadline: 240,
  foodPeriod: 20,
  fishCost: 4,
  workshopCost: 4,
  lighthouseCost: 12,
  storageCost: 6,
  shipFood: 12,
  shipSupplies: 8,
});
type Site = {
  id: string;
  name: string;
  cell: number;
  cost: number;
  repaired: boolean;
  kind: "producer" | "lighthouse" | "storage" | "path" | "home" | "warehouse";
};
const at = (x: number, y: number) => y * 16 + x;
export type ProductionScenarioCommand =
  | { kind: "select"; index: number }
  | { kind: "repair" | "assign" | "release" | "speed" | "ship" };
export function createProductionScenario(seed: number) {
  if (!Number.isSafeInteger(seed)) throw Error("Invalid production seed");
  const variation = deriveRandomSeed(seed, "harbor-layout") % 3;
  const sites: Site[] = [
    {
      id: "fishery",
      name: "Fishery",
      cell: at(12, 2 + variation),
      cost: 4,
      repaired: false,
      kind: "producer",
    },
    {
      id: "workshop",
      name: "Workshop",
      cell: at(3, 6),
      cost: 4,
      repaired: false,
      kind: "producer",
    },
    {
      id: "lighthouse",
      name: "Lighthouse",
      cell: at(12, 7),
      cost: 12,
      repaired: false,
      kind: "lighthouse",
    },
    {
      id: "storage",
      name: "Extra warehouse",
      cell: at(7, 5),
      cost: 6,
      repaired: false,
      kind: "storage",
    },
    {
      id: "north-path",
      name: "North path",
      cell: at(7, 3),
      cost: 1,
      repaired: false,
      kind: "path",
    },
    {
      id: "south-path",
      name: "South path",
      cell: at(7, 7),
      cost: 1,
      repaired: false,
      kind: "path",
    },
    {
      id: "home-1",
      name: "West home",
      cell: at(4, 3),
      cost: 0,
      repaired: true,
      kind: "home",
    },
    {
      id: "home-2",
      name: "East home",
      cell: at(9, 6),
      cost: 0,
      repaired: true,
      kind: "home",
    },
    {
      id: "warehouse",
      name: "Warehouse",
      cell: at(6, 5),
      cost: 0,
      repaired: true,
      kind: "warehouse",
    },
  ];
  const grid = {
    width: 16,
    height: 10,
    revision: 0,
    costs: Array.from({ length: 160 }, (_, i) => (i % 16 < 13 ? 1 : 0)),
  };
  grid.costs[at(7, 3)] = 0;
  grid.costs[at(7, 7)] = 0;
  const jobs: ProductionJob[] = sites
    .filter((s) => s.kind !== "home" && s.kind !== "warehouse")
    .map((s) => ({
      id: s.id,
      cell: s.kind === "path" ? s.cell - 1 : s.cell,
      workSeconds:
        s.id === "fishery"
          ? 6
          : s.id === "workshop"
            ? 8
            : s.kind === "lighthouse"
              ? 12
              : 2,
      resource:
        s.id === "fishery" ? "food" : s.id === "workshop" ? "supplies" : "",
      quantity: s.id === "fishery" ? 2 : s.id === "workshop" ? 3 : 0,
      repeat: s.kind === "producer",
      enabled: false,
    }));
  const originalSites = structuredClone(sites);
  const originalJobs = structuredClone(jobs);
  let workers = new ProductionJobs(
    grid,
    at(6, 5),
    Array.from({ length: 4 }, (_, i) => ({
      id: `worker-${i + 1}`,
      cell: at(6, 5),
    })),
    jobs,
  );
  let ledger = new TransactionOwner({
    id: "little-harbor",
    resources: [
      { id: "food", initial: 0, capacity: 120 },
      { id: "supplies", initial: 12, capacity: 120 },
    ],
    stats: [],
    flags: [],
    outcomes: ["ship-supplied"],
    rewardSeed: seed,
  });
  let time = 0,
    speed = 1,
    selected = 0,
    wellbeing = 100,
    homesFed = false,
    nextMeal = 20,
    capacity = 80,
    outcome: "playing" | "won" | "lost" = "playing",
    message = "Repair both producers (4 supplies each), then assign a worker.",
    event: "discovery" | "win" | "lose" | "delivery" | undefined,
    receipts = 0;
  let history: { time: number; resource: string }[] = [],
    pending: string[] = [],
    roles = 0,
    desiredRoles = 0,
    roleIds: string[] = [],
    desiredRoleIds: string[] = [],
    stable = 0,
    dwell = 0;
  const amount = (resource: string) =>
    ledger.capture().resources.find((r) => r.id === resource)!.quantity;
  const transact = (
    operations: TransactionOperation[],
    outcome: string | null = null,
  ) => {
    const c = ledger.capture();
    ledger.execute({
      id: `harbor-${receipts++}`,
      revision: c.revision,
      outcome,
      operations,
    });
  };
  const chooseWorker = () => workers.workers.find((w) => !w.job && !w.payload);
  const assign = () => {
    const site = sites[selected]!,
      job = workers.jobs.find((j) => j.id === site.id);
    if (!job?.enabled) {
      message = "Repair this site before assigning a worker.";
      return;
    }
    if (workers.workers.some((w) => w.job === site.id)) {
      message = "A worker is already assigned here.";
      return;
    }
    const worker = chooseWorker();
    if (!worker) {
      message = "All four workers are busy. Release a producer worker first.";
      return;
    }
    workers.assign(worker.id, site.id);
    message = `${worker.id.replace("-", " ")} assigned to ${site.name}.`;
  };
  const repair = () => {
    const site = sites[selected]!;
    if (site.repaired || pending.includes(site.id)) {
      message = "This site is already restored or under repair.";
      return;
    }
    if (amount("supplies") < site.cost) {
      message = `Need ${site.cost} supplies to restore ${site.name}.`;
      return;
    }
    const worker = chooseWorker();
    if (!worker) {
      message = "A free worker is needed. Release a producer worker first.";
      return;
    }
    transact([{ kind: "consume", resource: "supplies", amount: site.cost }]);
    if (site.kind === "producer") {
      site.repaired = true;
      workers.jobs.find((j) => j.id === site.id)!.enabled = true;
      message = `${site.name} restored. Assign a worker to start deliveries.`;
      event = "discovery";
    } else {
      const job = workers.jobs.find((j) => j.id === site.id)!;
      job.enabled = true;
      pending.push(site.id);
      workers.assign(worker.id, site.id);
      message = `${site.name}: worker dispatched for repairs.`;
    }
  };
  const supply = () => {
    if (!sites.find((s) => s.id === "lighthouse")!.repaired) {
      message = "Restore the lighthouse before calling the rescue ship.";
      return;
    }
    if (amount("food") < 12 || amount("supplies") < 8) {
      message = "The ship needs 12 food and 8 supplies in storage.";
      return;
    }
    transact(
      [
        { kind: "consume", resource: "food", amount: 12 },
        { kind: "consume", resource: "supplies", amount: 8 },
      ],
      "ship-supplied",
    );
    outcome = "won";
    message = "Rescue ship supplied! Little Harbor shines again.";
    event = "win";
  };
  const session = {
    command(command: ProductionScenarioCommand): boolean {
      if (
        outcome !== "playing" ||
        !command ||
        !["select", "repair", "assign", "release", "speed", "ship"].includes(
          command.kind,
        )
      )
        return false;
      if (
        command.kind === "select" &&
        (!Number.isInteger(command.index) ||
          command.index < 0 ||
          command.index >= sites.length)
      )
        return false;
      event = undefined;
      if (command.kind === "select") {
        if (
          !Number.isInteger(command.index) ||
          command.index < 0 ||
          command.index >= sites.length
        )
          return false;
        selected = command.index;
      } else if (command.kind === "repair") repair();
      else if (command.kind === "assign") assign();
      else if (command.kind === "ship") supply();
      else if (command.kind === "speed") speed = speed === 1 ? 2 : 1;
      else if (command.kind === "release") {
        const w = workers.workers.find((w) => w.job === sites[selected]!.id);
        message = w
          ? workers.assign(w.id, null)
            ? "Worker released to the idle pool."
            : "Worker must deliver its current cargo before release."
          : "No worker assigned here.";
      } else return false;
      return true;
    },
    step(dt: number) {
      if (!Number.isFinite(dt) || dt < 0 || dt > 0.05)
        throw Error("Invalid production delta");
      if (outcome !== "playing") return;
      const simDt = dt * speed;
      time += simDt;
      const events = workers.step(simDt, (resource, quantity) => {
        if (amount(resource) + quantity > capacity) return false;
        transact([{ kind: "grant", resource, amount: quantity }]);
        return true;
      });
      for (const e of events) {
        if (e.kind === "delivery") {
          history.push({ time, resource: e.resource });
          event = "delivery";
          message = `${e.quantity} ${e.resource} delivered to the warehouse.`;
        } else {
          const site = sites.find((s) => s.id === e.job)!;
          site.repaired = true;
          pending = pending.filter((id) => id !== site.id);
          workers.jobs.find((j) => j.id === site.id)!.enabled = false;
          if (site.kind === "path") {
            grid.costs[site.cell] = 1;
            grid.revision++;
            workers.replan();
          }
          if (site.kind === "storage") capacity = 120;
          event = "discovery";
          message = `${site.name} restored!`;
        }
      }
      history = history.filter((h) => time - h.time <= 12);
      if (time >= nextMeal) {
        nextMeal += RULES.foodPeriod;
        const food = Math.min(2, amount("food"));
        if (food)
          transact([{ kind: "consume", resource: "food", amount: food }]);
        homesFed = food === 2;
        wellbeing = Math.max(0, Math.min(100, wellbeing + (homesFed ? 4 : -8)));
        if (!homesFed)
          message = "Homes need food. Restore and staff the fishery.";
      }
      const nextRoleIds = [
        ...(history.some((h) => h.resource === "food") ? ["fishery"] : []),
        ...(history.some((h) => h.resource === "supplies") ? ["workshop"] : []),
        ...(history.length >= 2 ? ["network"] : []),
        ...(homesFed ? ["homes"] : []),
        ...(sites[2]!.repaired ? ["lighthouse"] : []),
      ];
      if (nextRoleIds.join(",") !== desiredRoleIds.join(",")) {
        desiredRoleIds = nextRoleIds;
        stable = 0;
      } else stable += dt;
      desiredRoles = desiredRoleIds.length;
      if (
        desiredRoleIds.join(",") !== roleIds.join(",") &&
        stable > 2.61 &&
        dwell <= 0
      ) {
        roleIds = [...desiredRoleIds];
        roles = roleIds.length;
        dwell = 5.22;
      }
      dwell = Math.max(0, dwell - dt);
      if (time >= RULES.deadline) {
        outcome = "lost";
        message =
          "Day three ended. The harbor needs more work — retry with a new plan.";
        event = "lose";
      }
    },
    snapshot() {
      return structuredClone({
        kind: "production-scenario" as const,
        contentId: "little-harbor-v1",
        rulesBuildId: "harbor-rules-v1",
        version: 1 as const,
        seed,
        sites: structuredClone(sites),
        grid: structuredClone(grid),
        workers: workers.capture(),
        ledger: ledger.capture(),
        time,
        speed,
        selected,
        wellbeing,
        homesFed,
        nextMeal,
        capacity,
        outcome,
        message,
        receipts,
        event,
        history,
        pending,
        roles,
        desiredRoles,
        roleIds,
        desiredRoleIds,
        stable,
        dwell,
      });
    },
    restore(value: unknown) {
      canonicalJson(value);
      const v = structuredClone(value) as ReturnType<typeof session.snapshot>;
      if (
        !v ||
        v.kind !== "production-scenario" ||
        v.contentId !== "little-harbor-v1" ||
        v.rulesBuildId !== "harbor-rules-v1" ||
        v.version !== 1 ||
        v.seed !== seed ||
        !Array.isArray(v.sites) ||
        v.sites.length !== sites.length ||
        v.sites.some(
          (site, i) =>
            !site ||
            site.id !== sites[i]!.id ||
            site.cell !== sites[i]!.cell ||
            site.cost !== sites[i]!.cost ||
            site.kind !== sites[i]!.kind ||
            typeof site.repaired !== "boolean",
        ) ||
        !v.grid ||
        v.grid.width !== 16 ||
        v.grid.height !== 10 ||
        !Array.isArray(v.grid.costs) ||
        v.grid.costs.length !== 160 ||
        v.grid.costs.some((n) => n !== 0 && n !== 1) ||
        !Number.isSafeInteger(v.grid.revision) ||
        v.grid.revision < 0 ||
        ![v.time, v.wellbeing, v.nextMeal, v.stable, v.dwell].every(
          (n) => Number.isFinite(n) && n >= 0,
        ) ||
        v.wellbeing > 100 ||
        ![1, 2].includes(v.speed) ||
        ![80, 120].includes(v.capacity) ||
        !Number.isInteger(v.selected) ||
        v.selected < 0 ||
        v.selected >= sites.length ||
        !Number.isSafeInteger(v.receipts) ||
        v.receipts < 0 ||
        typeof v.homesFed !== "boolean" ||
        typeof v.message !== "string" ||
        !["playing", "won", "lost"].includes(v.outcome) ||
        !Array.isArray(v.pending) ||
        new Set(v.pending).size !== v.pending.length ||
        v.pending.some((id) => !sites.some((s) => s.id === id)) ||
        !Array.isArray(v.history) ||
        v.history.some(
          (h) =>
            !h ||
            !Number.isFinite(h.time) ||
            h.time < 0 ||
            h.time > v.time ||
            !["food", "supplies"].includes(h.resource),
        ) ||
        !Array.isArray(v.roleIds) ||
        !Array.isArray(v.desiredRoleIds) ||
        [v.roleIds, v.desiredRoleIds].some(
          (ids) =>
            new Set(ids).size !== ids.length ||
            ids.some(
              (id) =>
                ![
                  "fishery",
                  "workshop",
                  "network",
                  "homes",
                  "lighthouse",
                ].includes(id),
            ),
        ) ||
        v.roles !== v.roleIds.length ||
        v.desiredRoles !== v.desiredRoleIds.length
      )
        throw Error("Invalid production scenario checkpoint");
      if (
        v.event !== undefined &&
        !["discovery", "win", "lose", "delivery"].includes(v.event)
      )
        throw Error("Invalid production event");
      // Authored topology and production rates are identity, not mutable save data.
      for (let i = 0; i < originalSites.length; i++) {
        const source = originalSites[i]!,
          site = v.sites[i]!;
        if (site.name !== source.name || (source.repaired && !site.repaired))
          throw Error("Invalid production site");
      }
      const expectedCosts = Array.from({ length: 160 }, (_, i) =>
        i % 16 < 13 ? 1 : 0,
      );
      for (const site of v.sites)
        if (site.kind === "path" && !site.repaired)
          expectedCosts[site.cell] = 0;
      if (
        v.grid.costs.some((cost, i) => cost !== expectedCosts[i]) ||
        v.grid.revision !==
          v.sites.filter((site) => site.kind === "path" && site.repaired)
            .length ||
        v.capacity !== (v.sites[3]!.repaired ? 120 : 80)
      )
        throw Error("Invalid production topology");
      if (
        !v.workers ||
        !Array.isArray(v.workers.workers) ||
        v.workers.workers.length !== 4 ||
        !Array.isArray(v.workers.jobs) ||
        v.workers.jobs.length !== originalJobs.length
      )
        throw Error("Invalid production roster");
      for (let i = 0; i < originalJobs.length; i++) {
        const saved = v.workers.jobs[i]!,
          original = originalJobs[i]!,
          site = v.sites.find((site) => site.id === original.id)!;
        if (
          !saved ||
          typeof saved.enabled !== "boolean" ||
          canonicalJson({ ...saved, enabled: false }) !==
            canonicalJson({ ...original, enabled: false })
        )
          throw Error("Invalid production job definition");
        const pending = v.pending.includes(site.id);
        if (pending && (site.repaired || site.kind === "producer"))
          throw Error("Invalid pending production site");
        if (
          saved.enabled !== (site.kind === "producer" ? site.repaired : pending)
        )
          throw Error("Invalid production job enablement");
      }
      if (v.pending.some((id) => !originalJobs.some((job) => job.id === id)))
        throw Error("Invalid pending production job");
      for (let i = 0; i < 4; i++) {
        const worker = v.workers.workers[i]!;
        if (
          !worker ||
          worker.id !== `worker-${i + 1}` ||
          !v.grid.costs[worker.cell] ||
          !Array.isArray(worker.path)
        )
          throw Error("Invalid production worker");
        const job = v.workers.jobs.find((job) => job.id === worker.job);
        if (worker.job !== null && !job)
          throw Error("Invalid production assignment");
        if (
          worker.payload &&
          (!job ||
            !job.resource ||
            worker.payload.resource !== job.resource ||
            worker.payload.quantity !== job.quantity)
        )
          throw Error("Invalid production cargo");
        let prior = worker.cell;
        for (const cell of worker.path) {
          if (
            !Number.isInteger(cell) ||
            !v.grid.costs[cell] ||
            Math.abs((cell % 16) - (prior % 16)) +
              Math.abs(Math.floor(cell / 16) - Math.floor(prior / 16)) !==
              1
          )
            throw Error("Invalid production route");
          prior = cell;
        }
        if (
          worker.path.length &&
          prior !== (worker.payload ? at(6, 5) : job?.cell)
        )
          throw Error("Invalid production route destination");
        if (worker.travel >= 0.35 || (job && worker.work >= job.workSeconds))
          throw Error("Invalid production work cursor");
      }
      const stagedWorkers = new ProductionJobs(
        v.grid,
        at(6, 5),
        v.workers.workers,
        v.workers.jobs,
      );
      stagedWorkers.restore(v.workers);
      const stagedLedger = new TransactionOwner({
        id: "little-harbor",
        resources: [
          { id: "food", initial: 0, capacity: 120 },
          { id: "supplies", initial: 12, capacity: 120 },
        ],
        stats: [],
        flags: [],
        outcomes: ["ship-supplied"],
        rewardSeed: seed,
      });
      stagedLedger.restore(v.ledger);
      sites.splice(0, sites.length, ...structuredClone(v.sites));
      Object.assign(grid, structuredClone(v.grid));
      workers = new ProductionJobs(
        grid,
        at(6, 5),
        v.workers.workers,
        v.workers.jobs,
      );
      workers.restore(stagedWorkers.capture());
      ledger = stagedLedger;
      ({
        time,
        speed,
        selected,
        wellbeing,
        homesFed,
        nextMeal,
        capacity,
        outcome,
        message,
        receipts,
        event,
        history,
        pending,
        roles,
        desiredRoles,
        roleIds,
        desiredRoleIds,
        stable,
        dwell,
      } = structuredClone(v));
    },
    observe() {
      const observation = {
        ...session.snapshot(),
        variation,
        event,
        goals: {
          deadline: RULES.deadline,
          shipFood: RULES.shipFood,
          shipSupplies: RULES.shipSupplies,
        },
        food: amount("food"),
        supplies: amount("supplies"),
      };
      return observation as DeepReadonlyScenario<typeof observation>;
    },
  };
  return session;
}
