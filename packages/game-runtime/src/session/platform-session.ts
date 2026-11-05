/** Narrow platform authority shared by browser owners and headless tools.
 * Exact restore preserves decoder state; live device cancellation belongs to hosts.
 */
import type {
  CompatibilityIdentity,
  GameDefinitions,
  InputFrame,
} from "@onepage/game-project/runtime";
import {
  ACTIONS,
  record,
  array,
  integer,
  boolean,
} from "@onepage/game-project/runtime";
import {
  createWorld,
  observe,
  restoreCheckpoint,
  serializeCheckpoint,
  step,
} from "@onepage/game-simulation/platform";

export class PlatformSession {
  private world;
  constructor(
    private readonly definitions: GameDefinitions,
    private readonly identity: CompatibilityIdentity,
    scenarioId = definitions.manifest.initialScenarioId,
  ) {
    this.definitions = structuredClone(definitions);
    this.identity = structuredClone(identity);
    this.world = createWorld(this.definitions, this.identity, scenarioId);
  }
  get scenarioId(): string {
    return this.world.scenarioId;
  }
  observation(): ReturnType<typeof observe> {
    return observe(this.world);
  }
  step(frame: unknown) {
    return step(this.world, validatePlatformFrame(frame));
  }
  checkpoint(): string {
    return serializeCheckpoint(this.world);
  }
  restart(scenarioId = this.world.scenarioId): void {
    const next = createWorld(this.definitions, this.identity, scenarioId);
    this.world = next;
  }
  restore(bytes: string): void {
    const next = restoreCheckpoint(this.definitions, this.identity, bytes);
    this.world = next;
  }
}

/** Validate and detach the whole frame before mutable execution, including terminal no-ops. */
export function validatePlatformFrame(value: unknown): InputFrame {
  const f = record(value, [
    "slots",
    ...(Object.hasOwn(value ?? {}, "commands") ? ["commands"] : []),
  ]);
  const seen = new Set<number>();
  const slots = array(f.slots, 4).map((value) => {
    const s = record(value, ["slot", "held", "axes", "edges"]);
    const slot = integer(s.slot, 0, 3);
    if (seen.has(slot)) throw Error("Duplicate input slot");
    seen.add(slot);
    const h = record(s.held, ACTIONS);
    const held = Object.fromEntries(
      ACTIONS.map((a) => [a, boolean(h[a])]),
    ) as InputFrame["slots"][number]["held"];
    const a = record(s.axes, ["moveX"]);
    const edges = array(s.edges, 32).map((value) => {
      const e = record(value, ["action", "kind"]);
      if (
        !ACTIONS.includes(e.action as never) ||
        !["pressed", "released", "cancel"].includes(e.kind as string)
      )
        throw Error("Invalid input edge");
      return {
        action: e.action,
        kind: e.kind,
      } as InputFrame["slots"][number]["edges"][number];
    });
    return { slot, held, axes: { moveX: integer(a.moveX, -127, 127) }, edges };
  });
  const frame: InputFrame = { slots };
  if ("commands" in f)
    frame.commands = array(f.commands, 1).map((value) => {
      const c = record(value, ["type"]);
      if (c.type !== "restart") throw Error("Invalid frame command");
      return { type: "restart" };
    });
  return frame;
}
