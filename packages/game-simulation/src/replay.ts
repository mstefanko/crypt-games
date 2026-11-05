import { integer } from "../../game-project/src/runtime";
import type {
  Action,
  CompatibilityIdentity,
  GameDefinitions,
  InputRecord,
} from "../../game-project/src/runtime";
import {
  firstDifference,
  restoreCheckpoint,
  serializeCheckpoint,
} from "./checkpoint";
import { createInputDecoder, decodeInputRecords } from "./input";
import { createWorld, step } from "./simulation";
export function createReplayFixtureRecords(ticks = 10000): InputRecord[] {
  integer(ticks, 1, 200000);
  const records: InputRecord[] = [];
  const held = {
    left: false,
    right: false,
    jump: false,
    attack: false,
    heavy: false,
    guard: false,
  };
  let sequence = 0;
  for (let tick = 0; tick < ticks; tick++) {
    const local = tick % 300;
    const desired = {
      left: local >= 190 && local < 265,
      right: local < 180,
      jump: (Math.floor(tick / 300) % 2 === 0
        ? [34, 75, 115, 145, 210]
        : [115, 145, 210]
      ).some((t) => local >= t && local < t + 8),
      attack: local % 24 < 2,
      heavy: local % 71 < 2,
      guard: local % 50 >= 35,
    };
    const edges: InputRecord["edges"] = [];
    const patch: InputRecord["heldPatch"] = {};
    for (const action of Object.keys(held) as Action[]) {
      if (desired[action] !== held[action]) {
        edges.push({ action, kind: desired[action] ? "pressed" : "released" });
        held[action] = desired[action];
        patch[action] = held[action];
      }
    }
    if (local === 285) {
      for (const action of Object.keys(held) as Action[]) {
        edges.push({ action, kind: "cancel" });
        held[action] = false;
        patch[action] = false;
      }
    }
    if (edges.length)
      records.push({
        tick,
        slot: 0,
        sequence: sequence++,
        heldPatch: patch,
        edges,
      });
  }
  return records;
}
export interface ReplayFixtureResult {
  checkpoints: { tick: number; bytes: string }[];
  final: string;
  coverage: {
    jumps: number;
    hits: number;
    guards: number;
    freezeTicks: number;
    carriedTicks: number;
    restores: number;
    activeRestores: number;
    restarts: number;
    levelTransitions: number;
  };
}
/** Same semantic log in Node and every browser; exact restores recur during active mechanics. */
export function runReplayFixture(
  definitions: GameDefinitions,
  identity: CompatibilityIdentity,
  ticks = 10000,
  schedule: readonly number[] = [1],
): ReplayFixtureResult {
  integer(ticks, 1, 200000);
  if (!schedule.length) throw Error("Empty replay schedule");
  for (const n of schedule) integer(n, 0, 5);
  if (!schedule.some((n) => n > 0))
    throw Error("Replay schedule never advances");
  const records = createReplayFixtureRecords(ticks),
    decoder = createInputDecoder(),
    checkpoints: ReplayFixtureResult["checkpoints"] = [],
    coverage = {
      jumps: 0,
      hits: 0,
      guards: 0,
      freezeTicks: 0,
      carriedTicks: 0,
      restores: 0,
      activeRestores: 0,
      restarts: 0,
      levelTransitions: 0,
    };
  let world = createWorld(definitions, identity),
    cursor = 0,
    tick = 0,
    frameIndex = 0;
  while (tick < ticks) {
    const count = schedule[frameIndex++ % schedule.length];
    for (let i = 0; i < count && tick < ticks; i++, tick++) {
      const batch: InputRecord[] = [];
      while (cursor < records.length && records[cursor].tick === tick)
        batch.push(records[cursor++]);
      const frame = decodeInputRecords(decoder, tick, batch);
      if (tick > 0 && tick % 300 === 0) frame.commands = [{ type: "restart" }];
      const events = step(world, frame);
      for (const e of events) {
        if (e.type === "jump") coverage.jumps++;
        if (e.type === "hit") coverage.hits++;
        if (e.type === "guard") coverage.guards++;
        if (e.type === "restart") coverage.restarts++;
        if (e.type === "level") coverage.levelTransitions++;
      }
      if (world.actors.some((a) => a.freezeTicks > 0)) coverage.freezeTicks++;
      if (world.actors.some((a) => a.riderId !== null)) coverage.carriedTicks++;
      if (
        tick % 37 === 0 ||
        world.actors.some((a) => a.freezeTicks > 0) ||
        world.actors.some((a) => a.riderId !== null)
      ) {
        const bytes = serializeCheckpoint(world),
          restored = restoreCheckpoint(definitions, identity, bytes),
          after = serializeCheckpoint(restored);
        if (bytes !== after)
          throw Error(`Restore divergence at ${firstDifference(bytes, after)}`);
        coverage.restores++;
        if (
          world.actors.some(
            (a) => a.execution || a.freezeTicks || a.riderId || a.vy < 0,
          )
        )
          coverage.activeRestores++;
        world = restored;
      }
      if (world.tick % 1000 === 0)
        checkpoints.push({
          tick: world.tick,
          bytes: serializeCheckpoint(world),
        });
    }
  }
  return { checkpoints, final: serializeCheckpoint(world), coverage };
}
