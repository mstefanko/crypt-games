import { validateDefinitions } from "../../../game-project/src/validate.ts";
import { snapshotDefinitions } from "./project.ts";
import type {
  GameDefinitions,
  CompatibilityIdentity,
  InputFrame,
} from "../../../game-project/src/types.ts";
import {
  createWorld,
  observe,
  step,
} from "../../../game-simulation/src/simulation.ts";
import {
  restoreCheckpoint,
  serializeCheckpoint,
} from "../../../game-simulation/src/checkpoint.ts";

/** Two local slots use the original platform/combat rules without a second combat implementation. */
export class DuelGame {
  private world;
  private readonly definitions: GameDefinitions;
  readonly identity: CompatibilityIdentity;
  constructor(definitions: GameDefinitions, identity: CompatibilityIdentity) {
    // Validate a detached copy; keep authored values for exact content identity.
    validateDefinitions(structuredClone(definitions));
    this.definitions = snapshotDefinitions(definitions);
    this.identity = snapshotDefinitions(identity);
    this.world = createWorld(this.definitions, this.identity);
  }
  step(frame: InputFrame) {
    return step(this.world, frame);
  }
  observation() {
    return observe(this.world);
  }
  get result(): "playing" | "draw" | "slot-0" | "slot-1" {
    const actors = this.observation().actors;
    if (actors.every((a) => a.health > 0)) return "playing";
    if (actors.every((a) => a.health === 0)) return "draw";
    return actors.find((a) => a.health > 0)!.slot === 0 ? "slot-0" : "slot-1";
  }
  checkpoint() {
    return serializeCheckpoint(this.world);
  }
  restore(bytes: string) {
    const next = restoreCheckpoint(this.definitions, this.identity, bytes);
    this.world = next;
  }
  restart() {
    this.world = createWorld(this.definitions, this.identity);
  }
}
