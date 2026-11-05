import { expect, it } from "vitest";
import manifest from "../../../examples/game-m2/game.project.json";
import level from "../../../examples/game-m2/levels/lantern-path.json";
import hero from "../../../examples/game-m2/archetypes/hero.json";
import sentinel from "../../../examples/game-m2/archetypes/sentinel.json";
import quick from "../../../examples/game-m2/abilities/quick-strike.json";
import heavy from "../../../examples/game-m2/abilities/heavy-strike.json";
import start from "../../../examples/game-m2/scenarios/start.json";
import flow from "../../../examples/game-m2/flow.json";
import { M2Game } from "./m2-game.ts";
import { InputQueue } from "./input.ts";
import { hostCommand } from "../../game-project/src/flow.ts";
import { canonical } from "../../game-project/src/runtime.ts";
const definitions = {
  manifest,
  levels: [level],
  archetypes: [hero, sentinel],
  abilities: [quick, heavy],
  scenarios: [start],
};
const identity = {
  rulesBuildId: "m2-test-rules",
  contentId: "m2-test-content",
};
function game() {
  return new M2Game(definitions, flow, identity, "flow-rules-test", [
    "lantern-ending",
  ]);
}
function win(run: M2Game) {
  const input = new InputQueue();
  for (let i = 0; i < 500 && run.kind === "play"; i++) {
    input.set("right", 0, "right", true);
    input.set("jump", 0, "jump", false);
    input.set("attack", 0, "attack", false);
    input.set("heavy", 0, "heavy", i % 40 === 0);
    run.tick(input.consume());
  }
}
it("completes the authored one-level production simulation and freezes it throughout the cinematic", () => {
  const run = game();
  run.signal("start");
  win(run);
  expect(run.kind).toBe("cinematic");
  const world = run.gameplayCheckpoint(),
    tick = run.observation().tick;
  for (let i = 0; i < 360; i++) {
    run.cinematicStep();
    run.tick();
  }
  expect(run.observation().tick).toBe(tick);
  expect(run.gameplayCheckpoint()).toBe(world);
  run.signal("complete");
  expect(run.kind).toBe("result");
  run.signal("retry");
  expect(run.kind).toBe("result");
  run.signal("restart");
  expect(run.kind).toBe("title");
  expect(run.observation().tick).toBe(0);
});
it("loss retry prepares a fresh world before entering play", () => {
  const run = game();
  run.signal("start");
  const input = new InputQueue();
  for (let i = 0; i < 70; i++) {
    input.set("right", 0, "right", true);
    run.tick(input.consume());
  }
  input.set("right", 0, "right", false);
  for (let i = 0; i < 1500 && run.kind === "play"; i++)
    run.tick(input.consume());
  expect(run.kind).toBe("loss");
  run.signal("retry");
  expect(run.kind).toBe("play");
  expect(run.observation().status).toBe("playing");
  expect(run.observation().tick).toBe(0);
});
it("restores a before-slot checkpoint then re-enters the cinematic with a new epoch", () => {
  const run = game();
  run.signal("start");
  win(run);
  const saved = run.checkpointBeforeSlot()!;
  expect(saved).toBeTruthy();
  const old = run.command("complete"),
    world = run.gameplayCheckpoint();
  for (let i = 0; i < 30; i++) run.cinematicStep();
  expect(() => run.checkpoint()).toThrow("before or after");
  run.restore(saved);
  expect(run.kind).toBe("cinematic");
  expect(run.flow.cinematicTick).toBe(0);
  expect(run.gameplayCheckpoint()).toBe(world);
  expect(
    run.dispatch([{ ...old, sequence: run.flow.sequence + 1 }]),
  ).toHaveLength(0);
  run.signal("skip");
  expect(run.kind).toBe("result");
});
it("rejects inconsistent checkpoints atomically and preserves full gameplay bytes on normal restore", () => {
  const run = game();
  run.signal("start");
  run.tick();
  const saved = run.checkpoint();
  run.tick();
  run.restore(saved);
  expect(run.observation().tick).toBe(1);
  const before = run.gameplayCheckpoint(),
    bad = JSON.parse(saved);
  const flow = JSON.parse(bad.flow);
  flow.gameplayTick = 100;
  bad.flow = JSON.stringify(flow);
  expect(() => run.restore(JSON.stringify(bad))).toThrow("Inconsistent");
  expect(run.gameplayCheckpoint()).toBe(before);
});
it("rejects fabricated gameplay outcomes and flow counter exhaustion before simulation mutation", () => {
  const run = game();
  run.signal("start");
  expect(() => run.signal("won")).toThrow("disagrees");
  expect(() => run.signal("lost")).toThrow("disagrees");
  for (const key of ["sequence", "slotInstance"] as const) {
    const before = run.gameplayCheckpoint(),
      value = run.flow[key];
    run.flow[key] = Number.MAX_SAFE_INTEGER;
    expect(() => run.tick()).toThrow("counter exhausted");
    expect(run.gameplayCheckpoint()).toBe(before);
    run.flow[key] = value;
  }
});

it("rejects exhausted before-slot restore atomically across world and flow", () => {
  const source = game();
  source.signal("start");
  win(source);
  const saved = JSON.parse(source.checkpointBeforeSlot()!);
  for (const key of ["sequence", "slotInstance"] as const) {
    const target = game(),
      before = target.checkpoint(),
      state = JSON.parse(saved.flow);
    state[key] =
      key === "sequence"
        ? Number.MAX_SAFE_INTEGER
        : Number.MAX_SAFE_INTEGER - 1;
    expect(() =>
      target.restore(JSON.stringify({ ...saved, flow: JSON.stringify(state) })),
    ).toThrow();
    expect(target.checkpoint()).toBe(before);
    expect(target.kind).toBe("title");
    expect(target.checkpointBeforeSlot()).toBeUndefined();
  }
});

it("rejects chained future-slot gameplay outcomes before committing a batch", () => {
  const run = game(),
    before = run.checkpoint(),
    start = run.command("start");
  const fabricated = hostCommand(
    { ...run.flow, node: "play", slotInstance: 2, sequence: start.sequence },
    "won",
  );
  expect(() => run.dispatch([start, fabricated])).toThrow("Future slot");
  expect(run.checkpoint()).toBe(before);
  expect(run.kind).toBe("title");
  expect(run.checkpointBeforeSlot()).toBeUndefined();
});

it("canonicalizes restored won checkpoints at the new before-slot boundary", () => {
  const run = game();
  run.signal("start");
  win(run);
  const imported = JSON.parse(run.checkpointBeforeSlot()!);
  imported.flow = JSON.stringify(JSON.parse(imported.flow), null, 2);
  imported.world = JSON.stringify(JSON.parse(imported.world), null, 2);
  const noncanonical = JSON.stringify(imported, null, 2);
  const originalEpoch = run.flow.epoch;
  run.restore(noncanonical);
  expect(run.kind).toBe("cinematic");
  expect(run.flow.epoch).toBe(originalEpoch + 1);
  const saved = run.checkpointBeforeSlot()!;
  const decoded = JSON.parse(saved),
    savedFlow = JSON.parse(decoded.flow);
  expect(saved).not.toBe(noncanonical);
  expect(saved).toBe(canonical(decoded));
  expect(decoded.flow).toBe(canonical(savedFlow));
  expect(decoded.world).toBe(run.gameplayCheckpoint());
  expect(savedFlow).toEqual({
    ...run.flow,
    node: "play",
    sequence: run.flow.sequence - 1,
    slotInstance: run.flow.slotInstance - 1,
  });
  run.cinematicStep();
  run.restore(saved);
  expect(run.kind).toBe("cinematic");
  expect(run.flow.cinematicTick).toBe(0);
});

it("failed won restores retain world, flow and an existing before-slot checkpoint", () => {
  const run = game();
  run.signal("start");
  win(run);
  const before = {
    world: run.gameplayCheckpoint(),
    flow: { ...run.flow },
    slot: run.checkpointBeforeSlot(),
  };
  for (const fault of ["sequence", "world", "flowRulesId"] as const) {
    const bad = JSON.parse(before.slot!);
    if (fault === "sequence") {
      const state = JSON.parse(bad.flow);
      state.sequence = Number.MAX_SAFE_INTEGER;
      bad.flow = JSON.stringify(state);
    }
    if (fault === "world") {
      const world = JSON.parse(bad.world);
      world.tick++;
      bad.world = JSON.stringify(world);
    }
    if (fault === "flowRulesId") bad.flowRulesId = "obsolete-flow-rules";
    expect(() => run.restore(JSON.stringify(bad))).toThrow();
    expect(run.gameplayCheckpoint()).toBe(before.world);
    expect(run.flow).toEqual(before.flow);
    expect(run.checkpointBeforeSlot()).toBe(before.slot);
  }
});
