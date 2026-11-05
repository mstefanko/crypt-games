/** Optional rigid worlds have exactly one owner. No backend handle crosses this boundary. */
export const RIGID_LIMITS = Object.freeze({
  dynamic: 16,
  kinematic: 1,
  fixed: 24,
  sensors: 4,
  colliders: 64,
  joints: 4,
  extent: 32,
  linearSpeed: 20,
  angularSpeed: 12,
  ticks: 36000,
  tapeBytes: 1048576,
  checkpointBytes: 4194304,
});
export interface RigidVector {
  readonly x: number;
  readonly y: number;
}
export type RigidShape =
  | { readonly kind: "box"; readonly hx: number; readonly hy: number }
  | { readonly kind: "circle"; readonly radius: number };
export interface RigidCollider {
  readonly shape: RigidShape;
  readonly offset?: RigidVector;
  readonly sensor?: boolean;
}
export interface RigidBodySpec {
  readonly id: string;
  readonly kind: "dynamic" | "kinematic" | "fixed";
  readonly position: RigidVector;
  readonly rotation?: number;
  readonly mass?: number;
  readonly ccd?: boolean;
  readonly colliders: readonly RigidCollider[];
}
export interface RigidJointSpec {
  readonly id: string;
  readonly kind: "revolute" | "rope";
  readonly a: string;
  readonly b: string;
  readonly anchorA: RigidVector;
  readonly anchorB: RigidVector;
  readonly length?: number;
  readonly limits?: readonly [number, number];
}
export interface RigidContent {
  readonly owner: "rapier-deterministic-2d";
  readonly id: string;
  readonly bodies: readonly RigidBodySpec[];
  readonly joints: readonly RigidJointSpec[];
}
export type RigidCommand =
  | { readonly kind: "createBody"; readonly body: RigidBodySpec }
  | {
      readonly kind: "removeBody";
      readonly id: string;
      readonly generation: number;
    }
  | {
      readonly kind: "velocity";
      readonly id: string;
      readonly generation: number;
      readonly velocity: RigidVector;
      readonly angular: number;
    }
  | {
      readonly kind: "motor";
      readonly id: string;
      readonly target: number;
      readonly torque: number;
    }
  | {
      readonly kind: "kinematic";
      readonly id: string;
      readonly generation: number;
      readonly position: RigidVector;
    }
  | { readonly kind: "removeJoint"; readonly id: string };
export interface RigidObservation {
  readonly tick: number;
  readonly bodies: readonly {
    readonly id: string;
    readonly generation: number;
    readonly position: RigidVector;
    readonly rotation: number;
    readonly velocity: RigidVector;
    readonly angular: number;
    readonly sleeping: boolean;
  }[];
  readonly events: readonly {
    readonly kind:
      | "contact-enter"
      | "contact-exit"
      | "sensor-enter"
      | "sensor-stay"
      | "sensor-exit";
    readonly a: string;
    readonly b: string;
  }[];
  readonly delivered: readonly string[];
}
