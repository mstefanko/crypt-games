import chargeContent from "./charge-content.json";
/** Explicit finite charge assembly: no dynamic rule registration or code loading. */
import { boundedJSON, canonical, record } from "@onepage/game-project/runtime";
import {
  ChargeRules,
  CHARGE_DESCRIPTOR,
  type ChargeIdentity,
} from "@onepage/game-simulation/charge";
export const CHARGE_ASSEMBLY_CONTENT = Object.freeze(chargeContent);
export const CHARGE_ASSEMBLY_DESCRIPTOR = {
  ...CHARGE_DESCRIPTOR,
  id: "charge-player-v1",
  lab: {
    support: "explicit-charge-assembly",
    queries: ["summary"],
    recording: "charge-recording-v1",
  },
} as const;
export class ChargeAssembly {
  private owner: ChargeRules;
  private initial: string;
  private commands: unknown[] = [];
  private readonly identity: ChargeIdentity;
  constructor(
    identity: ChargeIdentity,
    private readonly rewardPerThreshold = CHARGE_ASSEMBLY_CONTENT.rewardPerThreshold,
  ) {
    this.identity = { ...identity };
    this.owner = new ChargeRules(this.identity, rewardPerThreshold);
    this.initial = this.owner.checkpoint();
  }
  observe() {
    return this.owner.observe();
  }
  checkpoint() {
    return this.owner.checkpoint();
  }
  execute(command: unknown) {
    const staged = boundedJSON(canonical(command), 4096);
    const result = this.owner.execute(staged);
    this.commands.push(staged);
    return result;
  }
  restore(bytes: string) {
    this.owner.restore(bytes);
    this.initial = this.owner.checkpoint();
    this.commands = [];
  }
  recording() {
    return canonical({
      format: "charge-recording-v1",
      initial: this.initial,
      commands: this.commands,
      final: this.owner.checkpoint(),
    });
  }
  replay(bytes: string) {
    const value = record(boundedJSON(bytes, 32768), [
      "format",
      "initial",
      "commands",
      "final",
    ]);
    if (
      value.format !== "charge-recording-v1" ||
      typeof value.initial !== "string" ||
      typeof value.final !== "string" ||
      !Array.isArray(value.commands) ||
      value.commands.length > 64
    )
      throw Error("Invalid charge recording");
    const next = new ChargeRules(this.identity, this.rewardPerThreshold);
    next.restore(value.initial);
    for (const command of value.commands) next.execute(command);
    if (next.checkpoint() !== value.final)
      throw Error("Charge replay divergence");
    const commands = boundedJSON(canonical(value.commands), 32768) as unknown[];
    this.owner = next;
    this.initial = value.initial;
    this.commands = commands;
  }
}

export type { ChargeIdentity } from "@onepage/game-simulation/charge";
