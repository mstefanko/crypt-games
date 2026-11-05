import {
  DeterministicRandom,
  deriveRandomSeed,
} from "@onepage/game-simulation/random";
import type { State } from "../../contract";
import {
  guardianDescriptor,
  distance,
  segmentDistance,
  GUARDIAN_RULES,
} from "./spec";
import { GUARDIAN_ATTACK_TIMES } from "./boss";
import { FIXED as F, aimHeading, headingVector } from "../../rules";
const fail = () => {
  throw Error("Invalid guardian state");
};
const int = (n: unknown, lo: number, hi: number) =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= lo && n <= hi;
const keys = (v: unknown, names: string[]) =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === names.length &&
  Object.keys(v).every((k) => names.includes(k));
const ids = ["player-0", "player-1"];
const kinds = [
  "shot",
  "fan",
  "hook",
  "sweep",
  "slam",
  "double-slam",
  "proximity",
];
const pos = (x: unknown) => int(x, -200 * F, 200 * F);
function origin(v: unknown) {
  if (v === undefined) return true;
  const o = v as {
    epoch: number;
    generation: number;
    participantId: string;
    seq: number;
  };
  return (
    keys(o, ["epoch", "generation", "participantId", "seq"]) &&
    int(o.epoch, 0, Number.MAX_SAFE_INTEGER) &&
    int(o.generation, 0, Number.MAX_SAFE_INTEGER) &&
    int(o.seq, 0, Number.MAX_SAFE_INTEGER) &&
    typeof o.participantId === "string" &&
    o.participantId.length > 0 &&
    o.participantId.length <= 96
  );
}
export function validateGuardianState(s: State) {
  const g = s.guardian;
  if (s.sportId !== "crypt-guardian") {
    if (g !== null) fail();
    return;
  }
  if (
    !g ||
    !keys(g, [
      "kind",
      "orbs",
      "activeOrbId",
      "descriptor",
      "rng",
      "hp",
      "guardHeading",
      "guard",
      "staggerUntil",
      "deflectUntil",
      "hostileUntil",
      "reboundCount",
      "maxHp",
      "elapsed",
      "stage",
      "transitionTicks",
      "attack",
      "nextAttack",
      "previousAttack",
      "lastTarget",
      "targetStreak",
      "athletes",
      "cover",
      "projectiles",
      "ballToken",
      "ballInside",
      "ballStuckTicks",
      "ballResetTicks",
      "outcome",
      "practice",
    ]) ||
    g.kind !== "crypt-guardian"
  )
    fail();
  if (!g) return;
  if (
    !Array.isArray(g.orbs) ||
    g.orbs.length !== 2 ||
    g.activeOrbId !== "guardian-0"
  )
    fail();
  const primary = g.orbs[0];
  if (
    !primary ||
    JSON.stringify(primary.ball) !== JSON.stringify(s.ball) ||
    primary.possessionId !== s.possessionId
  )
    fail();
  for (const key of [
    "ballToken",
    "ballInside",
    "ballStuckTicks",
    "ballResetTicks",
    "deflectUntil",
    "hostileUntil",
    "reboundCount",
  ] as const)
    if (JSON.stringify(primary[key]) !== JSON.stringify(g[key])) fail();
  const owners = new Set<string>();
  for (const [i, o] of g.orbs.entries()) {
    if (
      !keys(o, [
        "id",
        "ball",
        "possessionId",
        "ballToken",
        "ballInside",
        "ballStuckTicks",
        "ballResetTicks",
        "deflectUntil",
        "hostileUntil",
        "reboundCount",
      ]) ||
      o.id !== `guardian-${i}` ||
      !o.ball ||
      !keys(o.ball, Object.keys(s.ball))
    )
      fail();
    if (o.possessionId !== null) {
      if (
        !ids.includes(o.possessionId) ||
        owners.has(o.possessionId) ||
        g.athletes[o.possessionId].status !== "active" ||
        o.ballToken !== null
      )
        fail();
      owners.add(o.possessionId);
    }
    for (const k of [
      "x",
      "y",
      "vx",
      "vy",
      "rx",
      "ry",
      "z",
      "vz",
      "rz",
    ] as const)
      if (!int(o.ball[k], -400 * F, 400 * F)) fail();
    if (
      Math.abs(o.ball.x) > 163 * F ||
      Math.abs(o.ball.y) > 93 * F ||
      o.ball.z ||
      o.ball.vz ||
      o.ball.rz ||
      typeof o.ballInside !== "boolean" ||
      !int(o.ballStuckTicks, 0, 10800) ||
      !int(o.ballResetTicks, 0, 30)
    )
      fail();
    for (const k of ["deflectUntil", "hostileUntil", "reboundCount"] as const)
      if (!int(o[k], 0, Number.MAX_SAFE_INTEGER)) fail();
    for (const k of ["lastTouch", "passFrom", "passTarget"] as const)
      if (o.ball[k] !== null && !ids.includes(o.ball[k]!)) fail();
    if (
      ![null, 0, 1].includes(o.ball.passTeam) ||
      ![null, 0, 1].includes(o.ball.powerTeam) ||
      !int(o.ball.passTick, 0, 10000000) ||
      !int(o.ball.powerExpires, 0, 10000100) ||
      !int(o.ball.dragCarry, 0, 100000) ||
      !int(o.ball.bankBonusRemaining, 0, 1) ||
      !(
        o.ball.powerActionKey === null ||
        int(o.ball.powerActionKey, 1, s.nextAction)
      )
    )
      fail();
    const t = o.ballToken;
    if (
      t &&
      (!int(t.id, 1, s.nextAction - 1) ||
        !ids.includes(t.playerId) ||
        ![8, 12, 16].includes(t.damage) ||
        !origin(t.origin) ||
        o.ballInside)
    )
      fail();
  }
  if (!g.descriptor || !int(g.descriptor.seed, 0, 4294967295)) fail();
  const expected = guardianDescriptor(g.descriptor.seed);
  if (
    !keys(g.descriptor, Object.keys(expected)) ||
    Object.keys(expected).some(
      (k) =>
        g.descriptor[k as keyof typeof expected] !==
        expected[k as keyof typeof expected],
    )
  )
    fail();
  if (
    !int(g.guardHeading, 0, 255) ||
    !int(g.guard, 0, 100) ||
    !int(g.staggerUntil, 0, Number.MAX_SAFE_INTEGER) ||
    !int(g.deflectUntil, 0, Number.MAX_SAFE_INTEGER) ||
    !int(g.hostileUntil, 0, Number.MAX_SAFE_INTEGER) ||
    !int(g.reboundCount, 0, Number.MAX_SAFE_INTEGER) ||
    !int(g.hp, 0, 300) ||
    g.maxHp !== 300 ||
    !int(g.elapsed, 0, 10800) ||
    ![1, 2].includes(g.stage) ||
    !int(g.transitionTicks, 0, 60) ||
    !int(g.nextAttack, 0, Number.MAX_SAFE_INTEGER) ||
    !(g.previousAttack === null || kinds.includes(g.previousAttack)) ||
    !(g.lastTarget === null || ids.includes(g.lastTarget)) ||
    !int(g.targetStreak, 0, 10800) ||
    typeof g.ballInside !== "boolean" ||
    !int(g.ballStuckTicks, 0, 10800) ||
    !int(g.ballResetTicks, 0, 30) ||
    ![null, "victory", "defeat"].includes(g.outcome)
  )
    fail();
  const random = new DeterministicRandom([
    {
      owner: "cryptball",
      name: "guardian",
      seed: deriveRandomSeed(g.descriptor.seed, "guardian"),
    },
  ]);
  random.restore(g.rng);
  if (
    !keys(g.practice, ["weapon", "immortal"]) ||
    !(
      g.practice.weapon === null ||
      ["cannon", "hook", "maul"].includes(g.practice.weapon)
    ) ||
    typeof g.practice.immortal !== "boolean" ||
    (s.mode !== "practice" &&
      (g.practice.immortal || g.practice.weapon !== null))
  )
    fail();
  if (!keys(g.athletes, ids)) fail();
  for (const id of ids) {
    const a = g.athletes[id];
    if (
      !keys(a, [
        "hp",
        "catchUntil",
        "catchReady",
        "nearTicks",
        "status",
        "revives",
        "reviveBy",
        "reviveTicks",
        "immunityUntil",
        "assistUntil",
        "assistFrom",
      ]) ||
      !int(a.catchUntil, 0, Number.MAX_SAFE_INTEGER) ||
      !int(a.catchReady, 0, Number.MAX_SAFE_INTEGER) ||
      !int(a.hp, 0, 5) ||
      !int(a.nearTicks, 0, 60) ||
      !["active", "down", "out"].includes(a.status) ||
      ![0, 1].includes(a.revives) ||
      !int(a.reviveTicks, 0, 89) ||
      !(
        a.reviveBy === null ||
        (ids.includes(a.reviveBy) && a.reviveBy !== id)
      ) ||
      !int(a.immunityUntil, 0, Number.MAX_SAFE_INTEGER) ||
      !int(a.assistUntil, 0, Number.MAX_SAFE_INTEGER) ||
      !(
        a.assistFrom === null ||
        (ids.includes(a.assistFrom) && a.assistFrom !== id)
      ) ||
      (a.status === "active") !== a.hp > 0 ||
      (a.status === "out" && a.revives !== 1) ||
      (a.status === "down" && a.revives !== 0) ||
      (a.reviveTicks === 0) !== (a.reviveBy === null) ||
      (a.status !== "down" && a.reviveBy !== null)
    )
      fail();
  }
  if (
    !Array.isArray(g.cover) ||
    g.cover.length !== (g.descriptor.layout === "open" ? 0 : 2)
  )
    fail();
  for (const [i, c] of g.cover.entries())
    if (
      !keys(c, ["id", "x", "y", "radius", "hp"]) ||
      c.id !== `pillar-${i}` ||
      c.x !== [-65, 65][i] * F ||
      c.y !== 0 ||
      c.radius !== 11 * F ||
      !int(c.hp, 0, 3)
    )
      fail();
  const a = g.attack;
  if (a !== null) {
    if (
      !keys(a, [
        "id",
        "kind",
        "elapsed",
        "timing",
        "hits",
        "targetId",
        "locked",
        "shapes",
        "released",
      ]) ||
      !int(a.id, 1, s.nextAction - 1) ||
      !kinds.includes(a.kind) ||
      !int(a.elapsed, 0, 600) ||
      !ids.includes(a.targetId) ||
      typeof a.locked !== "boolean" ||
      typeof a.released !== "boolean" ||
      !keys(a.timing, ["tell", "active", "recover"]) ||
      !int(a.timing.tell, 42, 84) ||
      !int(a.timing.active, 6, 180) ||
      !int(a.timing.recover, 35, 66) ||
      !Array.isArray(a.hits) ||
      a.hits.length > 2 ||
      new Set(a.hits).size !== a.hits.length ||
      a.hits.some((id) => !ids.includes(id)) ||
      !Array.isArray(a.shapes) ||
      a.shapes.length < 1 ||
      a.shapes.length > 3
    )
      fail();
    if (a.elapsed >= a.timing.tell + a.timing.active + a.timing.recover) fail();
    const times = GUARDIAN_ATTACK_TIMES[a.kind];
    const allowed =
      g.descriptor.weapon === "cannon"
        ? ["shot", "fan", "proximity"]
        : g.descriptor.weapon === "hook"
          ? ["hook", "sweep", "proximity"]
          : ["slam", "double-slam", "proximity"];
    if (
      !allowed.includes(a.kind) ||
      (g.stage === 1 && ["fan", "sweep", "double-slam"].includes(a.kind)) ||
      a.timing.tell !== times[0] ||
      a.timing.active !== times[1] ||
      !(
        a.timing.recover === times[2] ||
        (g.elapsed >= 7200 && a.timing.recover === Math.ceil(times[2] * 0.85))
      )
    )
      fail();
    if (g.transitionTicks > 0 || (g.stage === 2 && g.hp > 150)) fail();
    const kind =
      a.kind === "shot" || a.kind === "fan" || a.kind === "hook"
        ? "lane"
        : a.kind === "sweep"
          ? "arc"
          : "disk";
    const count = a.kind === "fan" ? 3 : a.kind === "double-slam" ? 2 : 1;
    if (a.shapes.length !== count || a.shapes.some((sh) => sh.kind !== kind))
      fail();
    for (const [i, sh] of a.shapes.entries()) {
      if (sh.at !== (a.kind === "double-slam" && i === 1 ? 36 : 0)) fail();
      if (sh.kind === "disk") {
        if (sh.radius !== (a.kind === "proximity" ? 33 : 32) * F) fail();
        if (
          a.kind === "proximity" &&
          (sh.x !== g.descriptor.x || sh.y !== g.descriptor.y + 24 * F)
        )
          fail();
        if (
          a.kind !== "proximity" &&
          (Math.abs(sh.x) > 130 * F || sh.y < -28 * F || sh.y > 64 * F)
        )
          fail();
      } else {
        const oy =
          g.descriptor.y + Math.round((14 * F * g.descriptor.size) / 100);
        if (sh.x !== g.descriptor.x || sh.y !== oy) fail();
        if (
          sh.kind === "arc" &&
          (sh.radius !== 125 * F || sh.innerRadius !== 20 * F)
        )
          fail();
        if (
          sh.kind === "lane" &&
          (sh.radius !== (a.kind === "hook" ? 9 : 5) * F ||
            distance(sh, { x: sh.endX, y: sh.endY }) >
              (a.kind === "hook" ? 185 : 300) * F + 2 ||
            Math.abs(sh.endX) > 160 * F + 1 ||
            Math.abs(sh.endY) > 90 * F + 1)
        )
          fail();
      }
    }

    for (const sh of a.shapes) {
      if (
        !pos(sh.x) ||
        !pos(sh.y) ||
        !int(sh.radius, 5 * F, 125 * F) ||
        !int(sh.at, 0, 36)
      )
        fail();
      if (sh.kind === "disk") {
        if (!keys(sh, ["kind", "x", "y", "radius", "at"])) fail();
      } else if (sh.kind === "lane") {
        if (
          !keys(sh, ["kind", "x", "y", "endX", "endY", "radius", "at"]) ||
          !pos(sh.endX) ||
          !pos(sh.endY)
        )
          fail();
      } else if (sh.kind === "arc") {
        if (
          !keys(sh, ["kind", "x", "y", "radius", "innerRadius", "at"]) ||
          !int(sh.innerRadius, 0, sh.radius)
        )
          fail();
      } else fail();
    }
  }
  if (
    !Array.isArray(g.projectiles) ||
    g.projectiles.length > 3 ||
    new Set(g.projectiles.map((p) => p.id)).size !== g.projectiles.length
  )
    fail();
  for (const p of g.projectiles) {
    if (
      !keys(p, [
        "id",
        "attackId",
        "endX",
        "endY",
        "x",
        "y",
        "vx",
        "vy",
        "rx",
        "ry",
        "radius",
        "lifeTicks",
      ]) ||
      typeof p.id !== "string" ||
      !/^boss-\d+-[0-2]$/.test(p.id) ||
      !int(p.attackId, 1, s.nextAction - 1) ||
      !pos(p.endX) ||
      !pos(p.endY) ||
      !pos(p.x) ||
      !pos(p.y) ||
      !int(
        p.vx,
        -GUARDIAN_RULES.projectileSpeed,
        GUARDIAN_RULES.projectileSpeed,
      ) ||
      !int(
        p.vy,
        -GUARDIAN_RULES.projectileSpeed,
        GUARDIAN_RULES.projectileSpeed,
      ) ||
      !int(p.rx, -60, 60) ||
      !int(p.ry, -60, 60) ||
      p.radius !== 5 * F ||
      !int(p.lifeTicks, 1, 180) ||
      !a ||
      p.attackId !== a.id
    )
      fail();
  }
  for (const p of g.projectiles) {
    const index = Number(p.id.slice(p.id.lastIndexOf("-") + 1)),
      lane = a?.shapes[index];
    if (!a || p.id !== `boss-${a.id}-${index}` || lane?.kind !== "lane") fail();
    if (!lane || lane.kind !== "lane") continue;
    const h = aimHeading(lane.endX - lane.x, lane.endY - lane.y),
      v = headingVector(h);
    if (
      p.endX !== lane.endX ||
      p.endY !== lane.endY ||
      p.vx !== Math.round((v.x * GUARDIAN_RULES.projectileSpeed) / 65536) ||
      p.vy !== Math.round((v.y * GUARDIAN_RULES.projectileSpeed) / 65536) ||
      segmentDistance(p.x, p.y, lane.x, lane.y, lane.endX, lane.endY) > 8 ||
      p.lifeTicks >
        Math.max(
          1,
          Math.min(
            180,
            Math.ceil(
              (distance(lane, { x: lane.endX, y: lane.endY }) * 60) /
                GUARDIAN_RULES.projectileSpeed,
            ),
          ),
        )
    )
      fail();
  }

  if (
    g.projectiles.length &&
    (!a ||
      !["shot", "fan"].includes(a.kind) ||
      !a.released ||
      a.elapsed < a.timing.tell ||
      a.elapsed >= a.timing.tell + a.timing.active)
  )
    fail();
  for (const p of s.players) {
    const athlete = g.athletes[p.id];
    if (Math.abs(p.x) > 159 * F || Math.abs(p.y) > 89 * F) fail();
    const blockers = [
      ...g.cover.filter((c) => c.hp > 0),
      { ...g.descriptor, radius: g.descriptor.bodyRadius },
    ];
    const obstruction = blockers.find(
      (c) =>
        distance(p, c) <
        c.radius + (athlete.status === "active" ? 7 : 8) * F - 2,
    );
    if (obstruction)
      throw Error(
        `Invalid guardian actor geometry ${p.id} ${athlete.status} (${p.x},${p.y}) radius ${obstruction.radius} center (${obstruction.x},${obstruction.y}) distance ${distance(p, obstruction)}`,
      );
  }
  if (
    (s.possessionId !== null &&
      (!ids.includes(s.possessionId) ||
        g.athletes[s.possessionId].status !== "active" ||
        g.ballToken !== null)) ||
    s.ball.z !== 0 ||
    s.ball.vz !== 0 ||
    s.ball.rz !== 0 ||
    Math.abs(s.ball.x) > 163 * F ||
    Math.abs(s.ball.y) > 93 * F ||
    s.specials.some((t) => t.active) ||
    (g.stage === 2 && g.hp > 150) ||
    (g.transitionTicks > 0 &&
      (g.stage !== 2 || g.attack !== null || g.projectiles.length > 0))
  )
    fail();
  const t = g.ballToken;
  if (t !== null) {
    if (
      !keys(
        t,
        t.origin
          ? ["id", "playerId", "damage", "origin"]
          : ["id", "playerId", "damage"],
      ) ||
      !int(t.id, 1, s.nextAction - 1) ||
      !ids.includes(t.playerId) ||
      ![8, 12, 16].includes(t.damage) ||
      !origin(t.origin) ||
      g.ballInside
    )
      fail();
  }
  if (
    (g.outcome !== null && s.phase !== "results") ||
    (g.outcome === "victory" && g.hp !== 0) ||
    (g.outcome === "defeat" && g.hp === 0) ||
    (g.outcome === null && s.phase === "results") ||
    (g.outcome === "victory" &&
      (s.winner !== 0 || s.score[0] !== 1 || s.score[1] !== 0)) ||
    (g.outcome === "defeat" &&
      (s.winner !== 1 || s.score[0] !== 0 || s.score[1] !== 1))
  )
    fail();
}
