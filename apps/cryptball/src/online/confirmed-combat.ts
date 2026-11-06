import type { Observation } from "../contract";

type DodgeMode = NonNullable<Observation["dodge"]>["ball"];

function usePredictedBallPose(local: DodgeMode, known: DodgeMode) {
  if (local.throwId !== known.throwId || local.holderId !== known.holderId)
    return false;
  if (local.state === known.state) return true;
  // The confirmed throw has reached a surface or athlete in the prediction.
  // Reusing the older airborne position here would replay its approach.
  return (
    known.state === "hostile-flight" &&
    local.state === "dead-loose" &&
    local.releaseTick === known.releaseTick
  );
}

/** Only drawing state is merged. Prediction checkpoints retain their complete
 * resources so reconciliation can replay normally; cues come from authority. */
export function confirmedCombatPresentation(
  predicted: Observation,
  authority: Observation,
): Observation {
  if (predicted.sportId !== authority.sportId) return predicted;
  if (predicted.dodge && authority.dodge) {
    const a = authority.dodge,
      p = predicted.dodge;
    return {
      ...predicted,
      possessionId: authority.possessionId,
      ball: usePredictedBallPose(p.ball, a.ball)
        ? predicted.ball
        : { ...authority.ball },
      dodge: {
        ...p,
        subphase: a.subphase,
        round: a.round,
        openingTeam: a.openingTeam,
        roundWinner: a.roundWinner,
        drawnRounds: a.drawnRounds,
        suddenDeathTicks: a.suddenDeathTicks,
        settleTicks: a.settleTicks,
        balls: a.balls.map((known) => {
          const local = p.balls.find((b) => b.id === known.id);
          const physical =
            local && local.retired === known.retired &&
            usePredictedBallPose(local.mode, known.mode)
              ? local.physical
              : known.physical;
          return {
            ...known,
            mode: { ...known.mode },
            physical: { ...physical },
          };
        }),
        ball: { ...a.ball },
        possessionTeam: a.possessionTeam,
        possessionDeadline: a.possessionDeadline,
        transferAt: a.transferAt,
        athletes: Object.fromEntries(
          Object.entries(p.athletes).map(([id, athlete]) => [
            id,
            { ...athlete, lives: a.athletes[id].lives },
          ]),
        ),
      },
      players: predicted.players.map((player) => {
        const known = authority.players.find((q) => q.id === player.id)!;
        const predictedOut = p.athletes[player.id].lives === 0;
        const confirmedOut = a.athletes[player.id].lives === 0;
        return {
          ...player,
          ...(predictedOut !== confirmedOut
            ? { x: known.x, y: known.y }
            : {}),
          immunityTicks: known.immunityTicks,
          staggerTicks: known.staggerTicks,
        };
      }),
    };
  }
  if (predicted.guardian && authority.guardian) {
    const a = authority.guardian,
      p = predicted.guardian;
    return {
      ...predicted,
      possessionId: authority.possessionId,
      ball:
        authority.possessionId !== predicted.possessionId
          ? { ...authority.ball }
          : predicted.ball,
      guardian: {
        ...p,
        hp: a.hp,
        maxHp: a.maxHp,
        outcome: a.outcome,
        stage: a.stage,
        transitionTicks: a.transitionTicks,
        orbs: a.orbs.map((known) => {
          const local = p.orbs.find((b) => b.id === known.id);
          return {
            ...known,
            ballToken: known.ballToken && {
              ...known.ballToken,
              ...(known.ballToken.origin
                ? { origin: { ...known.ballToken.origin } }
                : {}),
            },
            ball: {
              ...(local &&
              local.possessionId === known.possessionId &&
              local.ballToken?.id === known.ballToken?.id
                ? local.ball
                : known.ball),
            },
          };
        }),
        descriptor: { ...a.descriptor },
        guardHeading: a.guardHeading,
        guard: a.guard,
        staggerUntil: a.staggerUntil,
        deflectUntil: a.deflectUntil,
        hostileUntil: a.hostileUntil,
        reboundCount: a.reboundCount,
        athletes: Object.fromEntries(
          Object.entries(a.athletes).map(([id, athlete]) => [
            id,
            { ...athlete },
          ]),
        ),
        cover: a.cover.map((c) => ({ ...c })),
        attack: a.attack
          ? {
              ...a.attack,
              timing: { ...a.attack.timing },
              hits: [...a.attack.hits],
              shapes: a.attack.shapes.map((shape) => ({ ...shape })),
            }
          : null,
        projectiles: a.projectiles.map((known) => {
          const local = p.projectiles.find(
            (q) => q.id === known.id && q.attackId === known.attackId,
          );
          return { ...known, ...(local ? { x: local.x, y: local.y } : {}) };
        }),
      },
      players: predicted.players.map((player) => {
        const known = authority.players.find((q) => q.id === player.id)!,
          status = a.athletes[player.id].status;
        const changed = p.athletes[player.id].status !== status;
        return {
          ...player,
          ...(changed ? { x: known.x, y: known.y } : {}),
          immunityTicks: known.immunityTicks,
          staggerTicks: known.staggerTicks,
          ...(status !== "active"
            ? {
                action: null,
                charging: false,
                slideTicks: 0,
                slideRecovery: 0,
                dashTicks: 0,
              }
            : {}),
        };
      }),
    };
  }
  return predicted;
}
