/** Production duel state and presentation history; clocks and input sources belong to the host. */
import type {
  GameDefinitions,
  CompatibilityIdentity,
} from "../../../game-project/src/runtime";
import type {
  Observation,
  TickEvent,
} from "../../../game-simulation/src/types";
import {
  createDuelExecution,
  restoreDuelExact,
  validateDuelFrame,
} from "./execution";

export interface DuelPresentation {
  previous: Observation;
  current: Observation;
  guardSlots: number[];
}
export class DuelSession {
  private readonly game;
  private previous: Observation;
  private guards: number[] = [];

  constructor(definitions: GameDefinitions, identity: CompatibilityIdentity) {
    this.game = createDuelExecution(definitions, identity);
    this.previous = this.game.observation();
  }
  get result(): "playing" | "draw" | "slot-0" | "slot-1" {
    return this.game.result;
  }
  observation(): Observation {
    return this.game.observation();
  }
  presentation(): DuelPresentation {
    return {
      previous: structuredClone(this.previous),
      current: this.game.observation(),
      guardSlots: [...this.guards],
    };
  }
  step(input: unknown): TickEvent[] {
    // Validate before touching either authority or history. The detached frame
    // also supplies the guards corresponding to the successfully consumed tick.
    const frame = validateDuelFrame(input);
    const previous = this.game.observation();
    // The shared validator has already detached this frame. Consume it once
    // through the same DuelGame adapter used by executeDuelFrame.
    const events = this.game.step(frame);
    this.previous = previous;
    this.guards = frame.slots
      .filter((slot) => slot.held.guard)
      .map((slot) => slot.slot);
    return events;
  }
  checkpoint(): string {
    return this.game.checkpoint();
  }
  restore(bytes: string): void {
    restoreDuelExact(this.game, bytes);
    this.previous = this.game.observation();
    this.guards = [];
  }
  restart(): void {
    this.game.restart();
    this.previous = this.game.observation();
    this.guards = [];
  }
  /** Presentation cancellation does not alter exact decoder continuation. */
  cancelControls(): void {
    this.guards = [];
  }
}
