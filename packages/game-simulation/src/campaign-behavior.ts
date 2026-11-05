/** M9 consumer of the B0 pattern. Geometry and damage stay in platform authority. */
import {
  createBehaviorActor,
  stepBehavior,
  type BehaviorActor,
  type BehaviorRole,
  type BehaviorParameters,
} from "./behavior";
import type { World } from "./types";
import type { PlatformNpcIntent } from "./simulation";
export interface CampaignBehaviorPlacement {
  readonly spawnId: string;
  readonly role: BehaviorRole;
  readonly parameters?: BehaviorParameters;
}
export interface CampaignBehaviorState extends CampaignBehaviorPlacement {
  readonly actor: BehaviorActor;
}
export function createCampaignBehaviors(
  placements: readonly CampaignBehaviorPlacement[],
): CampaignBehaviorState[] {
  return placements.map((placement) => ({
    ...placement,
    actor: { ...createBehaviorActor(placement.role), position: 0 },
  }));
}
export function validateCampaignBehaviors(
  value: unknown,
  placements: readonly CampaignBehaviorPlacement[],
): CampaignBehaviorState[] {
  if (!Array.isArray(value) || value.length !== placements.length)
    throw Error("Campaign behavior roster mismatch");
  return value.map((state, index) => {
    const placement = placements[index];
    if (
      !state ||
      Object.keys(state).length !== (placement.parameters ? 4 : 3) ||
      state.spawnId !== placement.spawnId ||
      state.role !== placement.role ||
      JSON.stringify(state.parameters) !==
        JSON.stringify(placement.parameters) ||
      state.actor?.role !== placement.role
    )
      throw Error("Campaign behavior placement mismatch");
    // B0 validates every field and role-specific timer before any state is adopted.
    stepBehavior(
      state.actor,
      { target: 0, threatened: false },
      placement.parameters,
    );
    return { ...placement, actor: { ...state.actor } };
  });
}
const cell = (x: number) =>
  Math.max(-32, Math.min(32, Math.floor(x / (16 * 256)) - 10));
export function campaignBehaviorIntents(
  world: World,
  saved: readonly CampaignBehaviorState[],
) {
  const intents = new Map<number, PlatformNpcIntent>();
  const target = world.actors.find(
    (actor) => actor.slot === 0 && actor.health > 0,
  );
  const states = saved.map((state) => {
    const actor = world.actors.find(
      (actor) => actor.spawnId === state.spawnId,
    )!;
    // Hit-stop, stun and an executing attack suspend decisions; the canonical
    // platform execution remains responsible for active hit and recovery timing.
    if (
      world.status !== "playing" ||
      !target ||
      !actor.health ||
      actor.freezeTicks ||
      actor.stunTicks ||
      actor.execution
    )
      return { ...state, actor: { ...state.actor } };
    const next = stepBehavior(
      { ...state.actor, position: cell(actor.x) },
      {
        target: cell(target.x),
        threatened:
          !!target.execution && Math.abs(target.x - actor.x) <= 48 * 256,
      },
      state.parameters,
    );
    const axis = (Math.sign(next.actor.position - cell(actor.x)) * 127) as
      | -127
      | 0
      | 127;
    // Face the actual target before winding up. No direct B0 damage is applied.
    if (next.actor.state === "windup")
      actor.facing = target.x >= actor.x ? 1 : -1;
    intents.set(actor.id, { axis, attack: next.damage > 0 });
    return { ...state, actor: next.actor };
  });
  return { states, intents };
}
