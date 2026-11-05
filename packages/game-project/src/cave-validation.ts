import { CAVE_LIMITS as L } from "./cave-types";
import type { CaveContent, CaveRect } from "./cave-types";
import {
  assertCavePlainData,
  caveRecord as record,
  caveArray as array,
  caveInteger as n,
  caveId as id,
  caveClone,
  caveFreeze,
} from "./cave-data";
export function validateCaveContent(value: unknown): CaveContent {
  assertCavePlainData(value, L.contentBytes);
  const o = record(
    value,
    [
      "version",
      "id",
      "width",
      "height",
      "cellSize",
      "chunkSize",
      "materials",
      "cells",
      "protected",
      "player",
      "drones",
      "extraction",
      "roof",
      "tools",
    ],
    "/",
  );
  if (o.version !== "cave-content-v1")
    throw Error("/version: expected cave-content-v1");
  id(o.id, "/id");
  for (const [key, expected] of Object.entries({
    width: L.width,
    height: L.height,
    cellSize: L.cellSize,
    chunkSize: L.chunkSize,
  }))
    n(o[key], expected, expected, `/${key}`);
  const materials = array(o.materials, L.materials, "/materials");
  if (materials.length < 2) throw Error("/materials: need air and solid");
  const ids = new Set<string>();
  const unique = (v: unknown, path: string) => {
    const s = id(v, path);
    if (ids.has(s)) throw Error(`${path}: duplicate ID`);
    ids.add(s);
    return s;
  };
  materials.forEach((v, i) => {
    const m = record(
      v,
      [
        "id",
        "solid",
        "hp",
        "drillResistance",
        "blastResistance",
        "oreYield",
        "cue",
      ],
      `/materials/${i}`,
    );
    unique(m.id, `/materials/${i}/id`);
    if (m.solid !== (i !== 0))
      throw Error(`/materials/${i}/solid: only material 0 is air`);
    n(m.hp, i ? 1 : 0, i ? 65535 : 0, `/materials/${i}/hp`);
    n(m.drillResistance, 0, 1024, `/materials/${i}/drillResistance`);
    n(m.blastResistance, 0, 1024, `/materials/${i}/blastResistance`);
    n(m.oreYield, 0, i ? 65535 : 0, `/materials/${i}/oreYield`);
    id(m.cue, `/materials/${i}/cue`);
  });
  const cells = array(o.cells, 16384, "/cells"),
    protectedCells = array(o.protected, 16384, "/protected");
  if (cells.length !== 16384 || protectedCells.length !== 16384)
    throw Error("/cells: expected 16384 cells and protected bits");
  cells.forEach((c, i) => n(c, 0, materials.length - 1, `/cells/${i}`));
  protectedCells.forEach((c, i) => {
    if (typeof c !== "boolean")
      throw Error(`/protected/${i}: expected boolean`);
  });
  const rect = (v: unknown, path: string): CaveRect => {
    const r = record(v, ["x", "y", "width", "height"], path);
    const x = n(r.x, 0, L.extent - 1, `${path}/x`),
      y = n(r.y, 0, L.extent - 1, `${path}/y`),
      width = n(r.width, 1, L.extent - x, `${path}/width`),
      height = n(r.height, 1, L.extent - y, `${path}/height`);
    return { x, y, width, height };
  };
  const clear = (r: CaveRect, path: string) => {
    for (
      let y = Math.floor(r.y / 1024);
      y < Math.ceil((r.y + r.height) / 1024);
      y++
    )
      for (
        let x = Math.floor(r.x / 1024);
        x < Math.ceil((r.x + r.width) / 1024);
        x++
      )
        if (cells[y * 128 + x] !== 0)
          throw Error(`${path}: embedded in terrain`);
  };
  const spawn = (v: unknown, path: string, player = false) => {
    const a = record(
      v,
      player ? ["id", "x", "y", "hp"] : ["id", "x", "y"],
      path,
    );
    unique(a.id, `${path}/id`);
    const x = n(a.x, 0, L.extent - L.actorSize, `${path}/x`),
      y = n(a.y, 0, L.extent - L.actorSize, `${path}/y`);
    if (player) n(a.hp, 1, 65535, `${path}/hp`);
    clear({ x, y, width: 2048, height: 2048 }, path);
    return { x, y };
  };
  const p = spawn(o.player, "/player", true);
  const drones = array(o.drones, 7, "/drones");
  if (drones.length < 1)
    throw Error("/drones: at least one rescue objective required");
  drones.forEach((d, i) => spawn(d, `/drones/${i}`));
  const extraction = rect(o.extraction, "/extraction");
  clear(extraction, "/extraction");
  if (
    extraction.width < 2048 ||
    extraction.height < 2048 ||
    p.x < extraction.x ||
    p.y < extraction.y ||
    p.x + 2048 > extraction.x + extraction.width ||
    p.y + 2048 > extraction.y + extraction.height
  )
    throw Error("/player: spawn must fit extraction pad");
  const requireProtected = (r: CaveRect, path: string) => {
    for (
      let y = Math.floor(r.y / 1024);
      y < Math.ceil((r.y + r.height) / 1024);
      y++
    )
      for (
        let x = Math.floor(r.x / 1024);
        x < Math.ceil((r.x + r.width) / 1024);
        x++
      )
        if (!protectedCells[y * 128 + x])
          throw Error(`${path}: objective cells must be protected`);
  };
  requireProtected(extraction, "/extraction");
  drones.forEach((d, i) => {
    const a = d as { x: number; y: number };
    requireProtected({ ...a, width: 2048, height: 2048 }, `/drones/${i}`);
  });
  const roof = record(
      o.roof,
      ["nodes", "edges", "zones", "braceSockets"],
      "/roof",
    ),
    nodeIds = new Set<string>();
  let anchors = 0;
  array(roof.nodes, 16, "/roof/nodes").forEach((v, i) => {
    const a = record(v, ["id", "anchorCells"], `/roof/nodes/${i}`);
    nodeIds.add(unique(a.id, `/roof/nodes/${i}/id`));
    const refs = array(a.anchorCells, 256, `/roof/nodes/${i}/anchorCells`);
    anchors += refs.length;
    if (new Set(refs).size !== refs.length)
      throw Error("/roof/nodes: duplicate anchor reference");
    refs.forEach((c, j) => {
      const k = n(c, 0, 16383, `/roof/nodes/${i}/anchorCells/${j}`);
      if (cells[k] === 0)
        throw Error("/roof/nodes: anchor must reference initial solid");
    });
  });
  if (anchors > 256) throw Error("/roof/nodes: anchor reference cap");
  const ref = (v: unknown, path: string) => {
    if (!nodeIds.has(id(v, path))) throw Error(`${path}: unknown support node`);
  };
  const edges = new Set<string>();
  array(roof.edges, 32, "/roof/edges").forEach((v, i) => {
    const e = array(v, 2, `/roof/edges/${i}`);
    if (e.length !== 2 || e[0] === e[1])
      throw Error("/roof/edges: expected two distinct nodes");
    ref(e[0], `/roof/edges/${i}/0`);
    ref(e[1], `/roof/edges/${i}/1`);
    const k = [e[0], e[1]].sort().join("|");
    if (edges.has(k)) throw Error("/roof/edges: duplicate edge");
    edges.add(k);
  });
  array(roof.zones, 8, "/roof/zones").forEach((v, i) => {
    const z = record(v, ["id", "rect", "nodeIds"], `/roof/zones/${i}`);
    unique(z.id, `/roof/zones/${i}/id`);
    const bounds = rect(z.rect, `/roof/zones/${i}/rect`);
    if (
      bounds.x < extraction.x + extraction.width &&
      bounds.x + bounds.width > extraction.x &&
      bounds.y < extraction.y + extraction.height &&
      bounds.y + bounds.height > extraction.y
    )
      throw Error(
        `/roof/zones/${i}/rect: roof hazards cannot overlap extraction`,
      );
    const refs = array(z.nodeIds, 16, `/roof/zones/${i}/nodeIds`);
    if (!refs.length || new Set(refs).size !== refs.length)
      throw Error("/roof/zones: empty/duplicate nodes");
    refs.forEach((r) => ref(r, `/roof/zones/${i}/nodeIds`));
  });
  array(roof.braceSockets, 16, "/roof/braceSockets").forEach((v, i) => {
    const s = record(v, ["id", "nodeId", "x", "y"], `/roof/braceSockets/${i}`);
    unique(s.id, `/roof/braceSockets/${i}/id`);
    ref(s.nodeId, `/roof/braceSockets/${i}/nodeId`);
    const x = n(s.x, 512, L.extent - 512, `/roof/braceSockets/${i}/x`),
      y = n(s.y, 512, L.extent - 512, `/roof/braceSockets/${i}/y`);
    clear(
      { x: x - 512, y: y - 512, width: 1024, height: 1024 },
      `/roof/braceSockets/${i}`,
    );
  });
  const t = record(
    o.tools,
    [
      "drillDamage",
      "drillReach",
      "drillInterval",
      "chargeDamage",
      "chargeRadius",
      "chargeFuse",
      "charges",
      "braces",
      "braceReach",
      "roofWarningTicks",
      "roofDamage",
    ],
    "/tools",
  );
  for (const k of ["drillDamage", "chargeDamage", "roofDamage"])
    n(t[k], 1, 1024, `/tools/${k}`);
  n(t.drillReach, 1024, 4096, "/tools/drillReach");
  n(t.drillInterval, 6, 6, "/tools/drillInterval");
  n(t.chargeRadius, 1024, 4096, "/tools/chargeRadius");
  n(t.chargeFuse, 1, 3600, "/tools/chargeFuse");
  n(t.charges, 0, 4, "/tools/charges");
  n(t.braces, 0, 16, "/tools/braces");
  n(t.braceReach, 1024, 4096, "/tools/braceReach");
  n(t.roofWarningTicks, 120, 120, "/tools/roofWarningTicks");
  return caveFreeze(caveClone(value as CaveContent));
}
