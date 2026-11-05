import type { CaveContent } from "@onepage/game-project/cave-types";
import type { TerrainField } from "./terrain-field";
export interface CaveZoneState {
  id: string;
  status: "supported" | "warning" | "collapsed";
  remaining: number;
}
export interface CaveSupportState {
  braces: string[];
  zones: CaveZoneState[];
}
export interface CaveSupportEvent {
  kind: "roof-warning" | "roof-supported" | "roof-collapse";
  zoneId: string;
}
export function caveSupportedNodes(
  content: CaveContent,
  field: TerrainField,
  braces: readonly string[],
): Set<string> {
  const active = new Set<string>();
  for (const n of content.roof.nodes)
    if (
      n.anchorCells.length &&
      n.anchorCells.every(
        (id) => field.cell(id % 128, Math.floor(id / 128)).solid,
      )
    )
      active.add(n.id);
  for (const id of braces) {
    const socket = content.roof.braceSockets.find((s) => s.id === id);
    if (socket) active.add(socket.nodeId);
  }
  for (let pass = 0; pass < 16; pass++)
    for (const [a, b] of content.roof.edges) {
      if (active.has(a)) active.add(b);
      if (active.has(b)) active.add(a);
    }
  return active;
}
export function createCaveSupport(
  content: CaveContent,
  field: TerrainField,
): CaveSupportState {
  const active = caveSupportedNodes(content, field, []);
  return {
    braces: [],
    zones: content.roof.zones.map((z) => ({
      id: z.id,
      status: z.nodeIds.some((id) => active.has(id)) ? "supported" : "warning",
      remaining: z.nodeIds.some((id) => active.has(id)) ? 0 : 120,
    })),
  };
}
/** Call after terrain edits and admitted brace placement, before warning expiry. */
export function stageCaveSupport(
  content: CaveContent,
  field: TerrainField,
  previous: CaveSupportState,
  brace: string | undefined,
): { state: CaveSupportState; events: CaveSupportEvent[] } {
  const braces = brace
    ? [...previous.braces, brace].sort()
    : [...previous.braces];
  const active = caveSupportedNodes(content, field, braces),
    events: CaveSupportEvent[] = [];
  const zones = previous.zones.map((old) => {
    if (old.status === "collapsed") return { ...old };
    const zone = content.roof.zones.find((z) => z.id === old.id)!;
    if (zone.nodeIds.some((id) => active.has(id))) {
      if (old.status === "warning")
        events.push({ kind: "roof-supported", zoneId: old.id });
      return { ...old, status: "supported" as const, remaining: 0 };
    }
    if (old.status === "supported") {
      events.push({ kind: "roof-warning", zoneId: old.id });
      return { ...old, status: "warning" as const, remaining: 120 };
    }
    if (old.remaining > 1) return { ...old, remaining: old.remaining - 1 };
    events.push({ kind: "roof-collapse", zoneId: old.id });
    return { ...old, status: "collapsed" as const, remaining: 0 };
  });
  return { state: { braces, zones }, events };
}
