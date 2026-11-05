import type { ActionInstance } from "@onepage/game-simulation/action-timeline";
import type { CommandOrigin } from "../../contract";
export type GuardianWeapon = "cannon" | "hook" | "maul";
export type GuardianAttackKind =
  | "shot"
  | "fan"
  | "hook"
  | "sweep"
  | "slam"
  | "double-slam"
  | "proximity";
export interface GuardianDescriptor {
  generatorVersion: 1;
  seed: number;
  weapon: GuardianWeapon;
  palette: "violet" | "verdigris" | "ember";
  size: 90 | 100 | 110;
  name: string;
  layout: "pillars" | "open";
  x: number;
  y: number;
  bodyRadius: number;
  hurtRadius: number;
}
export type GuardianShape =
  | { kind: "disk"; x: number; y: number; radius: number; at: number }
  | {
      kind: "lane";
      x: number;
      y: number;
      endX: number;
      endY: number;
      radius: number;
      at: number;
    }
  | {
      kind: "arc";
      x: number;
      y: number;
      radius: number;
      innerRadius: number;
      at: number;
    };
export interface GuardianAttack extends ActionInstance {
  kind: GuardianAttackKind;
  targetId: string;
  locked: boolean;
  shapes: GuardianShape[];
  released: boolean;
}
export interface GuardianAthlete {
  catchUntil: number;
  catchReady: number;
  hp: number;
  nearTicks: number;
  status: "active" | "down" | "out";
  revives: 0 | 1;
  reviveBy: string | null;
  reviveTicks: number;
  immunityUntil: number;
  assistUntil: number;
  assistFrom: string | null;
}
export interface GuardianCover {
  id: string;
  x: number;
  y: number;
  radius: number;
  hp: number;
}
export interface GuardianProjectile {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  lifeTicks: number;
  attackId: number;
  endX: number;
  endY: number;
  rx: number;
  ry: number;
}
export interface GuardianOrb {
  id: "guardian-0" | "guardian-1";
  ball: import("../../contract").Ball;
  possessionId: string | null;
  ballToken: CryptGuardianState["ballToken"];
  ballInside: boolean;
  ballStuckTicks: number;
  ballResetTicks: number;
  deflectUntil: number;
  hostileUntil: number;
  reboundCount: number;
}
export interface CryptGuardianState {
  orbs: GuardianOrb[];
  activeOrbId: "guardian-0" | "guardian-1";

  kind: "crypt-guardian";
  descriptor: GuardianDescriptor;
  rng: import("@onepage/game-simulation/random").RandomSnapshot;
  hp: number;
  guardHeading: number;
  guard: number;
  staggerUntil: number;
  deflectUntil: number;
  hostileUntil: number;
  reboundCount: number;
  maxHp: 300;
  elapsed: number;
  stage: 1 | 2;
  transitionTicks: number;
  attack: GuardianAttack | null;
  nextAttack: number;
  previousAttack: GuardianAttackKind | null;
  lastTarget: string | null;
  targetStreak: number;
  athletes: Record<string, GuardianAthlete>;
  cover: GuardianCover[];
  projectiles: GuardianProjectile[];
  ballToken: {
    id: number;
    playerId: string;
    damage: number;
    origin?: CommandOrigin;
  } | null;
  ballInside: boolean;
  ballStuckTicks: number;
  ballResetTicks: number;
  outcome: "victory" | "defeat" | null;
  practice: { weapon: GuardianWeapon | null; immortal: boolean };
}
