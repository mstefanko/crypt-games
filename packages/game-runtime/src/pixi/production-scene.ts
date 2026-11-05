/** Semantic production composition. Coordinates are world cells, never economy authority. */
export interface ProductionSceneState {
  variation: number;
  time: number;
  selected: number;
  pending: readonly string[];
  offset: { x: number; y: number };
  outcome?: string;
  sites: readonly {
    id: string;
    name: string;
    cell: number;
    kind: string;
    cost: number;
    repaired: boolean;
  }[];
  workers: readonly {
    id: string;
    cell: number;
    state: string;
    travel?: number;
    path?: readonly number[];
    payload?: { resource: string; quantity?: number } | null;
  }[];
}
export interface ProductionSceneStyle {
  atlasUrl: string;
  columns: number;
  rows: number;
  cellSize: number;
  secondsPerCell: number;
  terrain: { land: string; water: string; path: string; shoreColumn: number };
  sites: Readonly<
    Record<
      string,
      {
        frame: string;
        width: number;
        height: number;
        footprint: { width: number; height: number };
        repairedFrame?: string;
        foundationFrame?: string;
        constructionFrame?: string;
      }
    >
  >;
  worker: { role: string; width: number; height: number };
  cargo: Readonly<Record<string, string>>;
  ship: {
    frame: string;
    x: number;
    y: number;
    width: number;
    height: number;
    departureDistance: number;
  };
  limits?: { workers: number; sites: number };
}
export interface ProductionSceneEntity {
  id: string;
  frame: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  alpha?: number;
  label?: string;
}
export function productionFootprint(
  state: ProductionSceneState,
  style: ProductionSceneStyle,
  index = state.selected,
) {
  const site = state.sites[index];
  if (!site) return undefined;
  const art = style.sites[site.id] ?? style.sites[site.kind];
  if (!art) return undefined;
  const x = (site.cell % style.columns) * style.cellSize + style.cellSize / 2,
    y =
      Math.floor(site.cell / style.columns) * style.cellSize +
      style.cellSize / 2;
  return {
    x: x - art.footprint.width / 2,
    y: y - art.footprint.height / 2,
    width: art.footprint.width,
    height: art.footprint.height,
  };
}
export function productionActors(
  state: ProductionSceneState,
  style: ProductionSceneStyle,
  clips: Readonly<Record<string, readonly string[]>>,
  shipPhase: number,
): ProductionSceneEntity[] {
  if (
    state.workers.length > (style.limits?.workers ?? 64) ||
    state.sites.length > (style.limits?.sites ?? 64)
  )
    throw Error("Production presentation budget exceeded");
  const items: ProductionSceneEntity[] = [];
  const n = style.cellSize;
  state.sites.forEach((site, index) => {
    const art = style.sites[site.id] ?? style.sites[site.kind];
    if (!art) return;
    const x = (site.cell % style.columns) * n + n / 2,
      y = Math.floor(site.cell / style.columns) * n + n / 2;
    items.push({
      id: site.id,
      frame: site.repaired
        ? (art.repairedFrame ?? art.frame)
        : state.pending.includes(site.id)
          ? (art.constructionFrame ?? art.frame)
          : (art.foundationFrame ?? art.frame),
      x: x - art.width / 2,
      y: y - art.height + 12,
      width: art.width,
      height: art.height,
      depth: y,
      alpha: site.repaired ? 1 : 0.48,
      label:
        index === state.selected
          ? `${site.name}${state.pending.includes(site.id) ? " · BUILDING" : site.repaired ? " · READY" : ` · ${site.cost} S`}`
          : undefined,
    });
  });
  state.workers.forEach((worker) => {
    let x = worker.cell % style.columns,
      y = Math.floor(worker.cell / style.columns);
    const next = worker.path?.[0];
    const dx = next === undefined ? 0 : (next % style.columns) - x,
      dy = next === undefined ? 0 : Math.floor(next / style.columns) - y;
    const facing = dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "up" : "down";
    const phase = Math.max(
      0,
      Math.min(1, (worker.travel ?? 0) / style.secondsPerCell),
    );
    x += dx * phase;
    y += dy * phase;
    const action = worker.payload
      ? "carry"
      : worker.state === "work" || worker.state === "build/repair"
        ? "tool"
        : next !== undefined
          ? "walk"
          : "idle";
    const clip = clips[`${style.worker.role}.${action}.${facing}`] ?? [];
    const frame =
      clip[Math.floor(state.time / 0.12) % Math.max(1, clip.length)] ??
      `${style.worker.role}.idle.down.0`;
    const px = x * n + n / 2,
      py = y * n + n / 2;
    items.push({
      id: worker.id,
      frame,
      x: px - style.worker.width / 2,
      y: py - style.worker.height + 8,
      width: style.worker.width,
      height: style.worker.height,
      depth: py + 1,
      label: worker.state === "blocked" ? "!" : undefined,
    });
    const cargo = worker.payload && style.cargo[worker.payload.resource];
    if (cargo)
      items.push({
        id: `${worker.id}:cargo`,
        frame: cargo,
        x: px - 5,
        y: py - 13,
        width: 12,
        height: 12,
        depth: py + 2,
        label: worker.payload?.quantity
          ? String(worker.payload.quantity)
          : undefined,
      });
  });
  const ship = style.ship;
  items.push({
    id: "rescue-ship",
    frame: ship.frame,
    x: ship.x + Math.max(0, Math.min(1, shipPhase)) * ship.departureDistance,
    y: ship.y,
    width: ship.width,
    height: ship.height,
    depth: ship.y,
    alpha: 1 - Math.max(0, shipPhase - 0.7) / 0.3,
  });
  return items;
}

/** Input and highlight use the same world footprint; callers invert their camera once. */
export function pickProductionSite(
  state: ProductionSceneState,
  style: ProductionSceneStyle,
  x: number,
  y: number,
): number | undefined {
  for (let i = state.sites.length - 1; i >= 0; i--) {
    const f = productionFootprint(state, style, i);
    if (f && x >= f.x && y >= f.y && x <= f.x + f.width && y <= f.y + f.height)
      return i;
  }
  return undefined;
}
