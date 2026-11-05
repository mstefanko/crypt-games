import {
  parseRulesCue,
  rulesCueId,
} from "@onepage/game-simulation/time-policy";
import type { RulesCue } from "@onepage/game-simulation/time-policy";

export const CUE_DELIVERY_LIMITS = Object.freeze({
  runs: 16,
  recent: 64,
  epochs: 1_000_000,
});
export type CueDeliveryMode = "live" | "replay" | "resimulate";
export type CueDeliveryResult =
  | "delivered"
  | "duplicate"
  | "suppressed"
  | "stale"
  | "capacity";

/** Presentation-owned, host-session lifetime. Call after authoritative commit.
 * New runs must supply distinct rules identities, even if their seeds match.
 * Capacity is a presentation result, never a post-commit exception.
 * Per-run highwaters survive render/session epoch changes and recent-ID eviction.
 * Ordered cue intake deliberately closes skipped sequence numbers: an older cue
 * cannot arrive later and cause an external effect. No rule/reward mutation lives
 * in this owner; a callback exception cannot undo the committed cue identity. */
export class CueDeliveryGuard {
  private epoch = 0;
  private mode: CueDeliveryMode = "live";
  private readonly highwaters = new Map<string, number>();
  private recent: string[] = [];

  beginSession(mode: CueDeliveryMode): number {
    if (mode !== "live" && mode !== "replay" && mode !== "resimulate")
      throw Error("Invalid cue delivery mode");
    if (this.epoch === CUE_DELIVERY_LIMITS.epochs)
      throw Error("Cue session epoch cap exceeded");
    this.epoch++;
    this.mode = mode;
    return this.epoch;
  }

  deliver(
    value: RulesCue,
    sessionEpoch: number,
    effect: (cue: RulesCue, id: string) => void,
  ): CueDeliveryResult {
    if (
      !Number.isInteger(sessionEpoch) ||
      sessionEpoch < 0 ||
      sessionEpoch > CUE_DELIVERY_LIMITS.epochs
    )
      throw Error("Invalid cue session epoch");
    if (sessionEpoch !== this.epoch) return "stale";
    const cue = parseRulesCue(value);
    const key = `${cue.runId}:${cue.runEpoch}`;
    const highwater = this.highwaters.get(key);
    if (highwater !== undefined && cue.sequence <= highwater)
      return "duplicate";
    if (this.mode !== "live") return "suppressed";
    if (
      highwater === undefined &&
      this.highwaters.size === CUE_DELIVERY_LIMITS.runs
    )
      return "capacity";
    if (typeof effect !== "function")
      throw Error("Invalid cue effect callback");
    const id = rulesCueId(cue);
    // Consume only live attempts before invoking external code.
    // Fail-closed delivery provides at-most-once attempt, not guaranteed success.
    this.highwaters.set(key, cue.sequence);
    this.recent.push(id);
    if (this.recent.length > CUE_DELIVERY_LIMITS.recent) this.recent.shift();
    effect(cue, id);
    return "delivered";
  }

  inspect(): {
    readonly epoch: number;
    readonly mode: CueDeliveryMode;
    readonly runs: readonly {
      readonly key: string;
      readonly highwater: number;
    }[];
    readonly recent: readonly string[];
  } {
    return {
      epoch: this.epoch,
      mode: this.mode,
      runs: [...this.highwaters].map(([key, highwater]) => ({
        key,
        highwater,
      })),
      recent: [...this.recent],
    };
  }
}
