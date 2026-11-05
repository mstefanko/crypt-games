import {
  dispatchFlow,
  createFlow,
  restoreFlow,
  hostCommand,
  flowKind,
  type FlowDocument,
  type HostCommand,
} from "../../game-project/src/flow.ts";
import type { M2Game } from "./m2-game.ts";
import { InputQueue } from "./input.ts";
export type M2ReplayEvent =
  | { type: "command"; command: HostCommand }
  | { type: "restore"; flow: string };
/** Replays the exact ordered host stream independently of renderer/gameplay stepping. */
export function replayM2FlowLog(
  document: FlowDocument,
  log: readonly M2ReplayEvent[],
) {
  if (log.length > 128) throw Error("M2 replay command cap exceeded");
  let state = createFlow(document);
  for (const event of log) {
    if (event.type === "restore") {
      state = restoreFlow(document, state, event.flow);
      continue;
    }
    const command = event.command;
    if (
      command.flowEpoch === state.epoch &&
      command.slotInstance === state.slotInstance
    ) {
      if (
        flowKind(document, state) === "cinematic" &&
        command.gameplayTick !== state.gameplayTick
      )
        throw Error("Gameplay advanced within cinematic command stream");
      if (
        command.gameplayTick < state.gameplayTick ||
        command.cinematicTick < state.cinematicTick
      )
        throw Error("Replay clocks went backward");
      state.gameplayTick = command.gameplayTick;
      state.cinematicTick = command.cinematicTick;
    }
    const transitions = dispatchFlow(document, state, [command]);
    if (
      transitions.some((transition) =>
        ["start", "retry", "restart", "cancel"].includes(transition.signal),
      )
    )
      state.gameplayTick = 0;
  }
  return state;
}
/** Authored production rules, ordered host controls and frozen-time slot replay. */
export function replayM2(game: M2Game, schedule: readonly number[] = [1]) {
  if (
    !schedule.length ||
    schedule.length > 32 ||
    schedule.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 5)
  )
    throw Error("Invalid replay display schedule");
  const checkpoints: string[] = [],
    transitions: string[] = [],
    commandLog: M2ReplayEvent[] = [];
  let scheduleIndex = 0;
  const control = (signal: Parameters<M2Game["signal"]>[0]) => {
    commandLog.push({ type: "command", command: game.command(signal) });
    game.signal(signal);
    transitions.push(game.kind);
  };
  const play = (strategy: "lose" | "quick" | "heavy") => {
    const input = new InputQueue();
    let tick = 0;
    while (game.kind === "play" && tick < 1800) {
      const count = schedule[scheduleIndex++ % schedule.length];
      for (let i = 0; i < count && game.kind === "play"; i++, tick++) {
        input.set("right", 0, "right", strategy !== "lose" || tick < 70);
        input.set(
          "attack",
          0,
          "attack",
          strategy === "quick" && tick % 25 === 0,
        );
        input.set("heavy", 0, "heavy", strategy === "heavy" && tick % 40 === 0);
        const before = { ...game.flow };
        game.tick(input.consume());
        if (game.flow.slotInstance !== before.slotInstance)
          commandLog.push({
            type: "command",
            command: hostCommand(
              { ...before, gameplayTick: game.observation().tick },
              game.observation().status === "won" ? "won" : "lost",
            ),
          });
      }
    }
    if (game.kind === "play")
      throw Error("Replay failed to finish authored encounter");
    transitions.push(game.kind);
    checkpoints.push(game.gameplayCheckpoint());
  };
  control("start");
  play("lose");
  if (game.kind !== "loss") throw Error("Loss path did not lose");
  control("retry");
  play("quick");
  if ((game.kind as string) !== "cinematic")
    throw Error("Quick path did not win");
  const before = game.checkpointBeforeSlot()!,
    stale = game.command("complete"),
    frozen = game.gameplayCheckpoint();
  for (let tick = 0; tick < 90; tick++) {
    game.cinematicStep();
    game.tick();
  }
  if (game.gameplayCheckpoint() !== frozen)
    throw Error("Cinematic advanced gameplay");
  const beforeFlow = JSON.parse(before).flow as string,
    restored = restoreFlow(game.document, game.flow, beforeFlow);
  commandLog.push({ type: "restore", flow: beforeFlow });
  game.restore(before);
  commandLog.push({ type: "command", command: hostCommand(restored, "won") });
  if (game.flow.cinematicTick !== 0)
    throw Error("Restore entered a partial cinematic");
  const staleCommand = { ...stale, sequence: game.flow.sequence + 1 };
  commandLog.push({ type: "command", command: staleCommand });
  if (game.dispatch([staleCommand]).length)
    throw Error("Stale callback committed");
  for (let tick = 0; tick < 300; tick++) game.cinematicStep();
  control("complete");
  checkpoints.push(game.checkpoint());
  control("restart");
  control("start");
  play("heavy");
  control("skip");
  checkpoints.push(game.checkpoint());
  if (
    JSON.stringify(replayM2FlowLog(game.document, commandLog)) !==
    JSON.stringify(game.flow)
  )
    throw Error("Ordered host stream differs from production flow");
  return {
    commandLog,
    format: "m2-full-checkpoint-replay-v1",
    transitions,
    checkpoints,
    frozenGameplayTick: JSON.parse(frozen).tick,
    finalFlow: { ...game.flow },
  };
}
