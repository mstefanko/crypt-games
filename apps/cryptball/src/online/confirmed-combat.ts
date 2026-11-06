import type { Observation } from "../contract";

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
    const changed =
      p.ball.state !== a.ball.state ||
      p.ball.holderId !== a.ball.holderId ||
      p.ball.throwId !== a.ball.throwId;
    return {
      ...predicted,
      possessionId: authority.possessionId,
      ball: changed ? { ...authority.ball } : predicted.ball,
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
          const changed =
            !local ||
            local.mode.state !== known.mode.state ||
            local.mode.holderId !== known.mode.holderId ||
            local.mode.throwId !== known.mode.throwId;
          return {
            ...known,
            mode: { ...known.mode },
            physical: { ...(changed ? known.physical : local.physical) },
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
        return {
          ...player,
          ...(p.athletes[player.id].lives !== a.athletes[player.id].lives
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
