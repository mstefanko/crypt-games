/** Trusted pure starter. Explicit app assembly is required before production use. */
import {
  record,
  integer,
  string,
  boundedJSON,
  canonical,
} from "@onepage/game-project/runtime";
export const CHARGE_DESCRIPTOR = Object.freeze({
  version: 1,
  id: "charge-starter-v1",
  clock: "ordered-commands",
  command: {
    kind: "charge",
    amount: { minimum: 1, maximum: 3 },
    revision: "current",
  },
  observation: ["revision", "charge", "rewards"],
  checkpointBytes: 4096,
  limits: { commands: 64, rewardThreshold: 5 },
  lab: { support: "adapter-required", queries: ["summary"] },
  authoring: {
    support: "trusted-typescript",
    field: "rewardPerThreshold",
    minimum: 1,
    maximum: 4,
  },
});
export interface ChargeIdentity {
  gameId: string;
  rulesBuildId: string;
  contentId: string;
}
export interface ChargeState {
  revision: number;
  charge: number;
  rewards: number;
}
export class ChargeRules {
  private readonly identity: ChargeIdentity;
  private readonly rewardPerThreshold: number;
  private state: ChargeState = { revision: 0, charge: 0, rewards: 0 };
  constructor(identity: ChargeIdentity, rewardPerThreshold = 1) {
    const source = record(identity, ["gameId", "rulesBuildId", "contentId"]);
    if (
      typeof source.rulesBuildId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(source.rulesBuildId) ||
      typeof source.contentId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(source.contentId)
    )
      throw Error("Expected full rules/content SHA-256 identities");
    this.identity = {
      gameId: string(source.gameId),
      rulesBuildId: string(source.rulesBuildId),
      contentId: string(source.contentId),
    };
    this.rewardPerThreshold = integer(rewardPerThreshold, 1, 4);
  }
  execute(value: unknown): ChargeState {
    const command = record(value, ["kind", "amount", "revision"]);
    if (
      command.kind !== "charge" ||
      integer(command.revision, 0, 63) !== this.state.revision
    )
      throw Error("Invalid or stale charge command");
    const amount = integer(command.amount, 1, 3);
    const total = this.state.charge + amount;
    // Change the bounded reward parameter to create a small trusted mechanic variant.
    const earned = total >= 5 ? this.rewardPerThreshold : 0;
    this.state = {
      revision: this.state.revision + 1,
      charge: total >= 5 ? total - 5 : total,
      rewards: this.state.rewards + earned,
    };
    return this.observe();
  }
  observe(): ChargeState {
    return { ...this.state };
  }
  checkpoint(): string {
    return canonical({
      format: "charge-starter-v1",
      identity: this.identity,
      rewardPerThreshold: this.rewardPerThreshold,
      state: this.state,
    });
  }
  restore(bytes: string): void {
    const value = record(boundedJSON(bytes, 4096), [
      "format",
      "identity",
      "rewardPerThreshold",
      "state",
    ]);
    if (
      value.format !== "charge-starter-v1" ||
      canonical(value.identity) !== canonical(this.identity) ||
      value.rewardPerThreshold !== this.rewardPerThreshold
    )
      throw Error("Incompatible charge checkpoint");
    const source = record(value.state, ["revision", "charge", "rewards"]);
    const next = {
      revision: integer(source.revision, 0, 64),
      charge: integer(source.charge, 0, 4),
      rewards: integer(source.rewards, 0, 152),
    };
    // A realizable prefix consists of N increments in [1,3], with each five
    // accumulated units yielding exactly the configured reward. This closes the
    // whole bounded future state without retaining an unbounded command history.
    if (next.rewards % this.rewardPerThreshold !== 0)
      throw Error("Invalid reward multiple");
    const total = next.charge + (next.rewards / this.rewardPerThreshold) * 5;
    if (total < next.revision || total > next.revision * 3)
      throw Error("Unreachable charge checkpoint");
    this.state = next;
  }
}
