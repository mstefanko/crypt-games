import type { CommandFrame, Observation, SportId } from "./contract";
import { RULES } from "../sim/rules";
import { groundContactReach } from "../sim/sports-spec";
import { volleyReach } from "../sim/modes/rift-volley";
import { reviveTarget } from "../sim/modes/crypt-guardian/damage";

export type CourtAction = { press: CommandFrame; held: CommandFrame };
const edge = (press: CommandFrame): CourtAction => ({ press, held: {} });
const slide = (level: boolean) => ({
  press: { slide: true },
  held: level ? { slide: true } : {},
});
/** Resolve once against local prediction, before the command enters the transport.
 * Held commands retain that decision until release, even if possession changes. */
export const COURT_ACTIONS: Record<
  SportId,
  { commit: CommandFrame; level: boolean }
> = {
  cryptball: { commit: { slide: true }, level: true },
  cryptkick: { commit: { slide: true }, level: true },
  "rift-volley": { commit: { slide: true }, level: true },
  cryptcheck: { commit: { check: true }, level: false },
  "crypt-dodge": { commit: { slide: true }, level: false },
  "crypt-guardian": { commit: { slide: true }, level: false },
};
export function resolveCourtAction(
  state: Observation,
  intent: "contextual" | "commit",
): CourtAction {
  const policy = COURT_ACTIONS[state.sportId];
  if (intent === "commit") return edge(policy.commit);
  const p = state.players.find((p) => p.id === state.controlledId);
  if (!p) return edge({});
  switch (state.sportId) {
    case "crypt-dodge":
      return edge(
        state.dodge?.balls.some(
          (b) =>
            !b.retired && b.mode.state === "held" && b.mode.holderId === p.id,
        )
          ? { pass: true }
          : { strikePressed: true },
      );
    case "crypt-guardian": {
      if (state.guardian?.orbs.some((b) => b.possessionId === p.id))
        return edge({ pass: true });
      if (
        state.guardian?.athletes[p.id]?.status === "active" &&
        reviveTarget(state, p)
      )
        return { press: {}, held: { passHeld: true } };
      return slide(false);
    }
    case "rift-volley": {
      const ball = state.ball;
      const distance = Math.hypot(ball.x - p.x, ball.y - p.y);
      const canReach = (kind: "serve" | "set" | "dig") => {
        const reach = volleyReach(kind);
        return distance <= reach.radius && ball.z <= reach.maxHeight;
      };
      // A serve is a primary contact. In rallies, reserve dives for low,
      // descending balls; a rising ball can still be set from a standstill.
      if (state.volley?.serving)
        return edge(canReach("serve") ? { strikePressed: true } : {});
      if (ball.vz < 0 && canReach("dig")) return slide(policy.level);
      // Do not turn an unreachable high ball into an unrelated diving action.
      // Explicit defense/commit inputs remain available outside contact reach.
      return edge(canReach("set") ? { pass: true } : {});
    }
    case "cryptball":
      return Math.hypot(state.ball.x - p.x, state.ball.y - p.y) <=
        groundContactReach(state.sportId, RULES.reach)
        ? edge({ pass: true })
        : slide(policy.level);
    default:
      return state.possessionId === p.id
        ? edge({ pass: true })
        : slide(policy.level);
  }
}
