import { validateDefinitions } from "../../game-project/src/index.ts";
import {
  boundedJSON,
  canonical,
  record,
} from "../../game-project/src/runtime.ts";
import {
  createFlow,
  dispatchFlow,
  flowKind,
  hostCommand,
  restoreFlow,
  saveFlow,
  validateFlow,
  type FlowDocument,
  type FlowSignal,
  type FlowState,
  type HostCommand,
} from "../../game-project/src/flow.ts";
import type {
  CompatibilityIdentity,
  GameDefinitions,
  InputFrame,
} from "../../game-project/src/types.ts";
import {
  createWorld,
  observe,
  restoreCheckpoint,
  serializeCheckpoint,
  step,
} from "../../game-simulation/src/index.ts";

/** Renderer-free production runner. Browser and Node use this same transition path. */
export class M2Game {
  readonly definitions: GameDefinitions;
  readonly document: FlowDocument;
  flow: FlowState;
  private world: ReturnType<typeof createWorld>;
  private beforeSlot: string | undefined;
  constructor(
    definitions: unknown,
    flow: unknown,
    readonly identity: CompatibilityIdentity,
    readonly flowRulesId: string,
    sceneIds: readonly string[],
  ) {
    this.definitions = validateDefinitions(definitions);
    this.document = validateFlow(flow);
    if (!flowRulesId || flowRulesId.length > 128)
      throw Error("Invalid flow rules identity");
    for (const node of this.document.nodes) {
      if (
        node.kind === "play" &&
        (node.levelId !== this.definitions.manifest.initialLevelId ||
          !this.definitions.levels.some((level) => level.id === node.levelId))
      )
        throw Error("Unknown flow level binding");
      if (node.kind === "cinematic" && !sceneIds.includes(node.sceneId!))
        throw Error("Unknown flow scene binding");
    }
    this.flow = createFlow(this.document);
    this.world = createWorld(this.definitions, identity);
  }
  get kind() {
    return flowKind(this.document, this.flow);
  }
  observation() {
    return observe(this.world);
  }
  command(signal: FlowSignal): HostCommand {
    return hostCommand(this.flow, signal);
  }
  /** Prepare gameplay before entering a new slot, so presentation never sees the old world. */
  dispatch(commands: readonly HostCommand[]) {
    if (
      commands.some(
        (command) =>
          command.flowEpoch === this.flow.epoch &&
          command.slotInstance > this.flow.slotInstance,
      )
    )
      throw Error("Future slot commands require slot entry");
    if (
      commands.some(
        (command) =>
          command.flowEpoch === this.flow.epoch &&
          command.slotInstance === this.flow.slotInstance &&
          ((command.signal === "won" && this.world.status !== "won") ||
            (command.signal === "lost" && this.world.status !== "lost")),
      )
    )
      throw Error("Gameplay outcome disagrees with world");
    const next = { ...this.flow };
    const transitions = dispatchFlow(this.document, next, commands);
    let replacement: ReturnType<typeof createWorld> | undefined;
    if (
      transitions.some((transition) =>
        ["start", "retry", "restart", "cancel"].includes(transition.signal),
      )
    ) {
      replacement = createWorld(this.definitions, this.identity);
      next.gameplayTick = replacement.tick;
    }
    if (replacement) {
      this.world = replacement;
      this.beforeSlot = undefined;
    }
    this.flow = next;
    return transitions;
  }
  signal(signal: FlowSignal) {
    return this.dispatch([this.command(signal)]);
  }
  tick(frame: InputFrame = { slots: [] }): void {
    if (this.kind !== "play") return;
    if (
      this.flow.sequence >= Number.MAX_SAFE_INTEGER ||
      this.flow.slotInstance >= Number.MAX_SAFE_INTEGER
    )
      throw Error("Flow counter exhausted before gameplay step");
    step(this.world, frame);
    this.flow.gameplayTick = this.world.tick;
    if (this.world.status !== "playing") {
      if (this.world.status === "won") this.beforeSlot = this.checkpoint();
      this.signal(this.world.status === "won" ? "won" : "lost");
    }
  }
  cinematicStep(): void {
    if (this.kind !== "cinematic") return;
    if (this.flow.cinematicTick === Number.MAX_SAFE_INTEGER)
      throw Error("Cinematic tick exhausted");
    this.flow.cinematicTick++;
  }
  checkpoint(): string {
    return canonical({
      version: 1,
      flowRulesId: this.flowRulesId,
      document: canonical(this.document),
      flow: saveFlow(this.document, this.flow),
      world: serializeCheckpoint(this.world),
    });
  }
  checkpointBeforeSlot(): string | undefined {
    return this.beforeSlot;
  }
  restore(json: string): void {
    const saved = record(
      boundedJSON(json, 3 * 1024 * 1024, { rejectNegativeZero: true }),
      ["version", "flowRulesId", "document", "flow", "world"],
    );
    if (
      saved.version !== 1 ||
      saved.flowRulesId !== this.flowRulesId ||
      saved.document !== canonical(this.document) ||
      typeof saved.flow !== "string" ||
      typeof saved.world !== "string"
    )
      throw Error("Incompatible M2 checkpoint");
    // Validate both halves before replacing either; cinematic saves deliberately reject.
    const nextFlow = restoreFlow(this.document, this.flow, saved.flow);
    const nextWorld = restoreCheckpoint(
      this.definitions,
      this.identity,
      saved.world,
    );
    const kind = flowKind(this.document, nextFlow);
    if (
      (kind === "title" &&
        (nextWorld.status !== "playing" || nextWorld.tick !== 0)) ||
      nextFlow.gameplayTick !== nextWorld.tick ||
      (kind === "play" && nextWorld.status === "lost") ||
      (kind === "loss" && nextWorld.status !== "lost") ||
      (kind === "result" && nextWorld.status !== "won")
    )
      throw Error("Inconsistent M2 checkpoint");
    const entersSlot = kind === "play" && nextWorld.status === "won";
    // Re-encode the validated, restored world/flow at the entry boundary. The
    // imported JSON may be noncanonical and has the pre-restore epoch/instance.
    const beforeSlot = entersSlot
      ? canonical({
          version: 1,
          flowRulesId: this.flowRulesId,
          document: canonical(this.document),
          flow: saveFlow(this.document, nextFlow),
          world: serializeCheckpoint(nextWorld),
        })
      : undefined;
    // dispatchFlow mutates only this proposed nextFlow. Exhaustion must reject
    // before world, flow or the before-slot checkpoint are committed together.
    if (entersSlot)
      dispatchFlow(this.document, nextFlow, [hostCommand(nextFlow, "won")]);
    this.world = nextWorld;
    this.flow = nextFlow;
    this.beforeSlot = beforeSlot;
  }
  gameplayCheckpoint(): string {
    return serializeCheckpoint(this.world);
  }
}
