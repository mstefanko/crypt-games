/** Development-only exact platform recorder. UI registration remains a separate Lab concern. */
import type {
  CompatibilityIdentity,
  GameDefinitions,
  InputFrame,
} from "@onepage/game-project/runtime";
import { ACTIONS } from "@onepage/game-project/runtime";
import {
  PlatformSession,
  validatePlatformFrame,
} from "../session/platform-session";
export type PlatformCommand =
  | { kind: "frame"; input: InputFrame }
  | { kind: "cancel" }
  | { kind: "restart" }
  | { kind: "restore"; bytes: string };
export class PlatformLabSession {
  readonly execution: PlatformSession;
  private pendingCancel = false;
  private commands: PlatformCommand[] = [];
  private retainedBytes = 0;
  constructor(
    definitions: GameDefinitions,
    identity: CompatibilityIdentity,
    scenarioId?: string,
  ) {
    this.execution = new PlatformSession(definitions, identity, scenarioId);
  }
  observation() {
    return this.execution.observation();
  }
  checkpoint() {
    return this.execution.checkpoint();
  }
  /** Authority-only exact restore preserves the pending live cancellation boundary. */
  restore(bytes: string) {
    this.step({ kind: "restore", bytes });
  }
  log(): PlatformCommand[] {
    return structuredClone(this.commands);
  }
  step(command: PlatformCommand): void {
    if (this.commands.length >= 10000)
      throw Error("Platform recording command ceiling reached");
    if (
      !command ||
      typeof command !== "object" ||
      !["frame", "cancel", "restart", "restore"].includes(command.kind)
    )
      throw Error("Invalid platform command");
    const keys =
      command.kind === "frame"
        ? ["kind", "input"]
        : command.kind === "restore"
          ? ["kind", "bytes"]
          : ["kind"];
    if (
      Object.keys(command).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(command, k))
    )
      throw Error("Invalid platform command fields");
    const accepted: PlatformCommand =
      command.kind === "frame"
        ? { kind: "frame", input: validatePlatformFrame(command.input) }
        : command.kind === "restore"
          ? { kind: "restore", bytes: command.bytes }
          : { kind: command.kind };
    if (
      accepted.kind === "restore" &&
      (typeof accepted.bytes !== "string" ||
        accepted.bytes.length > 2 * 1024 * 1024)
    )
      throw Error("Invalid platform restore bytes");
    if (accepted.kind === "frame") {
      if (this.pendingCancel)
        accepted.input = {
          ...accepted.input,
          slots: [0, 1, 2, 3].map((slot) => ({
            slot,
            held: Object.fromEntries(
              ACTIONS.map((a) => [a, false]),
            ) as InputFrame["slots"][number]["held"],
            axes: { moveX: 0 },
            edges: ACTIONS.map((action) => ({ action, kind: "cancel" })),
          })),
        };
      this.checkBudget(accepted);
      this.execution.step(accepted.input);
      this.pendingCancel = false;
    } else {
      this.checkBudget(accepted);
      if (accepted.kind === "restore") this.execution.restore(accepted.bytes);
      else if (accepted.kind === "cancel") this.pendingCancel = true;
      else {
        this.execution.restart();
        this.pendingCancel = true;
      }
    }
    this.retainedBytes += new TextEncoder().encode(
      JSON.stringify(accepted),
    ).length;
    this.commands.push(structuredClone(accepted));
  }
  private checkBudget(command: PlatformCommand): void {
    if (
      this.retainedBytes +
        new TextEncoder().encode(JSON.stringify(command)).length >
      24 * 1024 * 1024
    )
      throw Error("Platform recording byte ceiling reached");
  }
}
