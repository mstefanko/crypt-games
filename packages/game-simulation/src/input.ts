import {
  ACTIONS,
  array,
  boolean,
  integer,
  record,
} from "../../game-project/src/runtime";
import type {
  Action,
  DecoderState,
  Edge,
  Held,
  InputFrame,
  InputRecord,
  SlotInput,
} from "../../game-project/src/runtime";
export function neutralHeld(): Held {
  return {
    left: false,
    right: false,
    jump: false,
    attack: false,
    heavy: false,
    guard: false,
  };
}
export function createInputDecoder(): DecoderState {
  return {
    slots: Array.from({ length: 4 }, () => ({
      held: neutralHeld(),
      axes: { moveX: 0 },
    })),
    lastTick: -1,
  };
}
function edge(v: unknown): Edge {
  const o = record(v, ["action", "kind"]);
  if (
    !ACTIONS.includes(o.action as Action) ||
    !["pressed", "released", "cancel"].includes(o.kind as string)
  )
    throw Error("Invalid input edge");
  return { action: o.action as Action, kind: o.kind as Edge["kind"] };
}
function applyEdges(held: Held, edges: Edge[]): Held {
  const next = { ...held };
  for (const e of edges) {
    if (e.kind === "pressed") {
      if (next[e.action]) throw Error("Pressed edge must change held state");
      next[e.action] = true;
    } else {
      if (e.kind === "released" && !next[e.action])
        throw Error("Release edge requires held action");
      next[e.action] = false;
    }
  }
  return next;
}
/** Records for exactly this tick; persistent patches, ordered transient edges. Atomic on errors. */
export function decodeInputRecords(
  decoder: DecoderState,
  tick: number,
  records: readonly InputRecord[],
): InputFrame {
  integer(tick, 0, Number.MAX_SAFE_INTEGER);
  if (tick <= decoder.lastTick) throw Error("Input tick must advance");
  array(records, 128);
  const slots = decoder.slots.map((s, slot) => ({
    slot,
    held: { ...s.held },
    axes: { ...s.axes },
    edges: [] as Edge[],
  }));
  const sequences = [-1, -1, -1, -1],
    counts = [0, 0, 0, 0];
  for (const v of records) {
    const source = v as unknown as Record<string, unknown>;
    const o = record(v, [
      "tick",
      "slot",
      "sequence",
      "edges",
      ...(Object.hasOwn(source, "heldPatch") ? ["heldPatch"] : []),
      ...(Object.hasOwn(source, "axesPatch") ? ["axesPatch"] : []),
    ]);
    if (o.tick !== tick) throw Error("Record tick mismatch");
    const slot = integer(o.slot, 0, 3),
      sequence = integer(o.sequence, 0, Number.MAX_SAFE_INTEGER);
    if (sequence <= sequences[slot])
      throw Error("Input sequences must increase per slot");
    sequences[slot] = sequence;
    const s = slots[slot],
      edges = array(o.edges, 32).map(edge);
    counts[slot] += edges.length;
    if (counts[slot] > 32) throw Error("Input transition limit exceeded");
    const expected = applyEdges(s.held, edges);
    if (Object.hasOwn(o, "heldPatch")) {
      const p = o.heldPatch;
      if (
        !p ||
        typeof p !== "object" ||
        Array.isArray(p) ||
        Object.keys(p).some((k) => !ACTIONS.includes(k as Action))
      )
        throw Error("Invalid held patch");
      for (const [k, v] of Object.entries(p)) {
        const key = k as Action;
        if (boolean(v) !== expected[key])
          throw Error("Held patch disagrees with transitions");
      }
    }
    if (Object.hasOwn(o, "axesPatch")) {
      const p = o.axesPatch;
      if (
        !p ||
        typeof p !== "object" ||
        Array.isArray(p) ||
        Object.keys(p).some((k) => k !== "moveX")
      )
        throw Error("Invalid axes patch");
      if (Object.hasOwn(p, "moveX"))
        s.axes.moveX = integer((p as Record<string, unknown>).moveX, -127, 127);
    }
    s.held = expected;
    s.edges.push(...edges);
  }
  decoder.slots = slots.map((s) => ({
    held: { ...s.held },
    axes: { ...s.axes },
  }));
  decoder.lastTick = tick;
  return { slots };
}
/** Live frames and replay frames take this same transition path. */
export function consumeFrame(
  decoder: DecoderState,
  tick: number,
  frame?: InputFrame,
): SlotInput[] {
  const next = createInputDecoder();
  next.slots = decoder.slots.map((s) => ({
    held: { ...s.held },
    axes: { ...s.axes },
  }));
  next.lastTick = decoder.lastTick;
  const seen = new Set<number>();
  const records: InputRecord[] = [];
  if (frame) {
    const src = frame as unknown as Record<string, unknown>;
    const f = record(frame, [
      "slots",
      ...(Object.hasOwn(src, "commands") ? ["commands"] : []),
    ]);
    for (const v of array(f.slots, 4)) {
      const s = record(v, ["slot", "held", "axes", "edges"]);
      const slot = integer(s.slot, 0, 3);
      if (seen.has(slot)) throw Error("Duplicate input slot");
      seen.add(slot);
      const held = record(s.held, ACTIONS),
        axes = record(s.axes, ["moveX"]);
      const p = neutralHeld();
      for (const a of ACTIONS) p[a] = boolean(held[a]);
      records.push({
        tick,
        slot,
        sequence: 0,
        heldPatch: p,
        axesPatch: { moveX: integer(axes.moveX, -127, 127) },
        edges: array(s.edges, 32).map(edge),
      });
    }
    if (Object.hasOwn(f, "commands"))
      for (const c of array(f.commands, 1)) {
        const cmd = record(c, ["type"]);
        if (cmd.type !== "restart") throw Error("Unknown simulation command");
      }
  }
  const result = decodeInputRecords(next, tick, records);
  decoder.slots = next.slots;
  decoder.lastTick = next.lastTick;
  return result.slots;
}
export function cancelFrame(decoder: DecoderState): InputFrame {
  return {
    slots: decoder.slots.map((s, slot) => ({
      slot,
      held: neutralHeld(),
      axes: { moveX: 0 },
      edges: ACTIONS.filter((a) => s.held[a]).map((action) => ({
        action,
        kind: "cancel" as const,
      })),
    })),
  };
}

export * from "./platform-input-v2";
