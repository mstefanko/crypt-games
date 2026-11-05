import type { Observation, Ball } from "../contract";

export type EntityPose = {
  id: string;
  generation: string;
  x: number;
  y: number;
  z: number;
  owner?: string | null;
  /** Fixed-coordinate displacement per 60 Hz simulation tick. */
  speed: number;
  heading?: number;
};
export type PoseFrame = {
  tick: number;
  key: string;
  entities: Map<string, EntityPose>;
};
export const sceneKey = (s: Observation) =>
  JSON.stringify([
    s.sportId,
    s.phase,
    s.score,
    s.volley?.rally,
    s.volley?.serving,
    s.hockey?.faceoffLead,
    s.dodge?.round,
    s.dodge?.subphase,
    s.guardian?.stage,
    s.guardian?.outcome,
  ]);
/** Stable transport IDs, plus lifecycle/contact markers. No simulation objects are retained. */
export function extractPoses(s: Observation): PoseFrame {
  const entities = new Map<string, EntityPose>();
  const add = (
    id: string,
    value: {
      x: number;
      y: number;
      z?: number;
      vx?: number;
      vy?: number;
      vz?: number;
      heading?: number;
    },
    generation: unknown[],
    owner?: string | null,
  ) =>
    entities.set(id, {
      id,
      x: value.x,
      y: value.y,
      z: value.z ?? 0,
      generation: JSON.stringify(generation),
      owner,
      speed: Math.hypot(value.vx ?? 0, value.vy ?? 0, value.vz ?? 0) / 60,
      heading: value.heading,
    });
  for (const p of s.players)
    add(`player:${p.id}`, p, [
      s.dodge?.athletes[p.id]?.lives,
      s.guardian?.athletes[p.id]?.status,
    ]);
  const ball = (
    id: string,
    b: Ball,
    markers: unknown[],
    owner?: string | null,
  ) =>
    add(
      id,
      b,
      [
        ...markers,
        b.lastTouch,
        b.passTick,
        b.powerActionKey,
        Math.sign(b.vx),
        Math.sign(b.vy),
        Math.sign(b.vz),
      ],
      owner,
    );
  if (s.dodge)
    for (const b of s.dodge.balls)
      ball(
        `ball:${b.id}`,
        b.physical,
        [b.retired, b.mode.state, b.mode.throwId, b.mode.holderId],
        b.mode.holderId,
      );
  else if (s.guardian) {
    for (const orb of s.guardian.orbs)
      ball(
        `ball:${orb.id}`,
        orb.ball,
        [
          orb.possessionId,
          orb.ballToken?.id,
          orb.ballResetTicks > 0,
          orb.reboundCount,
        ],
        orb.possessionId,
      );
    add("guardian:boss", s.guardian.descriptor, [
      s.guardian.stage,
      s.guardian.outcome,
    ]);
    for (const p of s.guardian.projectiles)
      add(`projectile:${p.id}`, p, [p.attackId]);
  } else ball("ball:primary", s.ball, [s.possessionId], s.possessionId);
  return { tick: s.tick, key: sceneKey(s), entities };
}
/** Copy only modified drawing branches. Authoritative resources and timing are untouched. */
export function applyPoses(
  s: Observation,
  poses: Map<string, EntityPose>,
): Observation {
  const players = s.players.map((p) => {
    const v = poses.get(`player:${p.id}`);
    return v ? { ...p, x: v.x, y: v.y } : p;
  });
  const physical = (id: string, b: Ball): Ball => {
    const v = poses.get(id);
    if (!v) return b;
    const holder = v.owner && players.find((p) => p.id === v.owner),
      original = v.owner && s.players.find((p) => p.id === v.owner);
    return {
      ...b,
      x: holder && original ? b.x + holder.x - original.x : v.x,
      y: holder && original ? b.y + holder.y - original.y : v.y,
      z: v.z,
    };
  };
  const dodge = s.dodge && {
    ...s.dodge,
    balls: s.dodge.balls.map((b) => ({
      ...b,
      physical: physical(`ball:${b.id}`, b.physical),
    })),
  };
  const guardian = s.guardian && {
    ...s.guardian,
    orbs: s.guardian.orbs.map((o) => ({
      ...o,
      ball: physical(`ball:${o.id}`, o.ball),
    })),
    descriptor: {
      ...s.guardian.descriptor,
      ...(() => {
        const v = poses.get("guardian:boss");
        return v ? { x: v.x, y: v.y } : {};
      })(),
    },
    projectiles: s.guardian.projectiles.map((p) => {
      const v = poses.get(`projectile:${p.id}`);
      return v ? { ...p, x: v.x, y: v.y } : p;
    }),
  };
  const ball =
    dodge?.balls[0]?.physical ??
    guardian?.orbs.find((o) => o.id === guardian.activeOrbId)?.ball ??
    physical("ball:primary", s.ball);
  return { ...s, players, ball, dodge, guardian };
}
