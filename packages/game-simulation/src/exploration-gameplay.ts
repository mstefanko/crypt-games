/** Beacon's bounded static-target P1/P2 consumer. Moving enemies remain melee-only. */
import {
  boundedJSON,
  canonical,
  integer,
  record,
  type CompatibilityIdentity,
} from "@onepage/game-project/runtime";
import {
  BallisticWorld,
  canonicalBallisticData,
  type BallisticCheckpoint,
  type BallisticConfiguration,
  type BallisticTarget,
} from "./ballistics";
import { body } from "./collision";
import type { World } from "./types";
import { DamageableWorld, type DestructionCheckpoint } from "./destruction";
import { ExplorationCharacterOwner } from "./exploration-character";
import {
  CAMPAIGN_PLATFORM_LIMITS,
  type CampaignEntryPlan,
  type CampaignPlatformCommand,
  type CampaignPlatformDefinition,
} from "./campaign-platform";
import {
  EXPLORATION_CAMPAIGN,
  EXPLORATION_DEFINITIONS,
  EXPLORATION_IDENTITY,
} from "./exploration-rules";

const U = 256;
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
/** Selected gameplay content is included in production's generated content identity. */
export const EXPLORATION_GAMEPLAY_DEFINITION = immutable({
  schema: "beacon-static-spark-v1",
  roomId: "harbor",
  projectile: {
    speed: 6 * U,
    radius: 2 * U,
    lifetime: 48,
    liveCap: 1,
    staticCandidates: 5,
    contactsPerTick: 1,
  },
  destruction: {
    objects: [
      {
        id: "harbor-target",
        kind: "prop" as const,
        rect: { x: 208 * U, y: 120 * U, width: 16 * U, height: 20 * U },
        hp: 2,
        team: 1,
        brokenBlocking: false,
        reward: 0,
        blast: null,
      },
    ],
  },
});
interface Shot {
  roomId: string;
  world: BallisticWorld;
}
interface GameplayState {
  destruction: DamageableWorld;
  shot: Shot | null;
  impact: Shot | null;
}
function initial(): GameplayState {
  return {
    destruction: new DamageableWorld(
      EXPLORATION_GAMEPLAY_DEFINITION.destruction,
    ),
    shot: null,
    impact: null,
  };
}
function target(
  id: string,
  rect: { x: number; y: number; width: number; height: number },
): BallisticTarget {
  return {
    response: "solid",
    shape: {
      bodyId: id,
      shapeId: "body",
      owner: "beacon-scenery",
      category: "world",
      region: "body",
      sensor: false,
      priority: 0,
      kind: "rect",
      rect,
    },
  };
}
/** P1's static-target contract is deliberate: authored floor spans, two side
 * boundaries and the optional target only. No enemy/body collision is implied. */
function configuration(
  roomId: string,
  x: number,
  y: number,
  direction: -1 | 1,
  intact: boolean,
): BallisticConfiguration {
  const level = EXPLORATION_DEFINITIONS.levels.find(
    (level) => level.id === roomId,
  );
  if (!level) throw Error("Unknown spark room");
  const targets: BallisticTarget[] = [
    target("left-boundary", {
      x: -16 * U,
      y: -64 * U,
      width: 16 * U,
      height: 320 * U,
    }),
    target("right-boundary", {
      x: 320 * U,
      y: -64 * U,
      width: 16 * U,
      height: 320 * U,
    }),
  ];
  // Coalesce the authored floor's top row; collision candidates stay <= five.
  for (let tile = 0; tile < 20; ) {
    if (!level.tiles[9 * 20 + tile]) {
      tile++;
      continue;
    }
    const start = tile;
    while (tile < 20 && level.tiles[9 * 20 + tile]) tile++;
    targets.push(
      target(`floor-${start}`, {
        x: start * 16 * U,
        y: 144 * U,
        width: (tile - start) * 16 * U,
        height: 48 * U,
      }),
    );
  }
  if (roomId === EXPLORATION_GAMEPLAY_DEFINITION.roomId && intact)
    targets.push(
      target(
        "harbor-target",
        EXPLORATION_GAMEPLAY_DEFINITION.destruction.objects[0].rect,
      ),
    );
  if (
    targets.length > EXPLORATION_GAMEPLAY_DEFINITION.projectile.staticCandidates
  )
    throw Error("Spark static candidate cap");
  return {
    acceleration: { x: 0, y: 0 },
    bodies: [
      {
        id: "player-spark",
        x,
        y,
        radius: EXPLORATION_GAMEPLAY_DEFINITION.projectile.radius,
        vx: direction * EXPLORATION_GAMEPLAY_DEFINITION.projectile.speed,
        vy: 0,
        impact: "stop",
        restitution: 0,
        maxBounces: 0,
        catchable: false,
      },
    ],
    targets,
  };
}
function hp(state: GameplayState): number {
  return state.destruction.observe().objects[0].hp;
}
function hit(index: number) {
  return {
    hits: [
      {
        eventId: `target-hit-${index}`,
        sourceId: "player-spark",
        targetId: "harbor-target",
        damage: 1,
      },
    ],
    ignite: [],
  };
}
/** Order: step existing flight, admit one static contact, apply P2 damage, then
 * campaign frame and immediate accepted strike spawn. A new shot moves next tick.
 * Worlds are forked/staged; no extension mutation precedes campaign publication. */
function advance(state: GameplayState): GameplayState {
  if (!state.shot) return state;
  const world = state.shot.world.fork();
  const moved = world.step();
  const contact = moved.events[0];
  if (contact) {
    let destruction = state.destruction;
    if (contact.targetId === "harbor-target" && hp(state) > 0) {
      destruction = new DamageableWorld(
        EXPLORATION_GAMEPLAY_DEFINITION.destruction,
      );
      destruction.restore(state.destruction.capture());
      destruction.step(hit(destruction.observe().tick + 1));
    }
    return {
      destruction,
      shot: null,
      impact: { roomId: state.shot.roomId, world },
    };
  }
  return {
    ...state,
    shot:
      moved.tick >= EXPLORATION_GAMEPLAY_DEFINITION.projectile.lifetime
        ? null
        : { roomId: state.shot.roomId, world },
  };
}
function captureShot(shot: Shot | null) {
  return shot ? { roomId: shot.roomId, ballistic: shot.world.capture() } : null;
}
function capture(state: GameplayState, portable: boolean) {
  return {
    definition: EXPLORATION_GAMEPLAY_DEFINITION,
    destruction: state.destruction.capture(),
    ...(!portable
      ? { shot: captureShot(state.shot), impact: captureShot(state.impact) }
      : {}),
  };
}
function restoreShot(
  value: unknown,
  roomId: string,
  intact: boolean,
  impact: boolean,
): Shot | null {
  if (value === null) return null;
  const saved = record(value, ["roomId", "ballistic"]);
  if (saved.roomId !== roomId)
    throw Error("Spark room disagrees with campaign");
  // Validate all P1 fields, bounds and descriptors before reading configuration.
  canonicalBallisticData(saved.ballistic);
  const checkpoint = saved.ballistic as BallisticCheckpoint;
  const body = checkpoint.configuration?.bodies?.[0];
  if (!body) throw Error("Spark body required");
  // Match P1's admitted origin domain. Ordinary jumps/attacks can originate
  // beyond the visible room edges; a narrower viewport bound rejects live saves.
  integer(body.x, -262144, 262144);
  integer(body.y, -262144, 262144);
  if (
    body.vx !== EXPLORATION_GAMEPLAY_DEFINITION.projectile.speed &&
    body.vx !== -EXPLORATION_GAMEPLAY_DEFINITION.projectile.speed
  )
    throw Error("Invalid spark direction");
  const world = new BallisticWorld(
    configuration(roomId, body.x, body.y, body.vx > 0 ? 1 : -1, intact),
  );
  world.restore(checkpoint);
  const state = world.observe();
  if (
    (impact
      ? state.tick > EXPLORATION_GAMEPLAY_DEFINITION.projectile.lifetime
      : state.tick >= EXPLORATION_GAMEPLAY_DEFINITION.projectile.lifetime) ||
    state.bodies[0].status !== (impact ? "stopped" : "flying") ||
    (impact && (state.events.length !== 1 || state.tick === 0))
  )
    throw Error("Invalid spark lifetime/contact state");
  return { roomId, world };
}
function restoreGameplay(
  value: unknown,
  roomId: string,
  portable: boolean,
): GameplayState {
  const saved = record(value, [
    "definition",
    "destruction",
    ...(!portable ? ["shot", "impact"] : []),
  ]);
  if (
    canonical(saved.definition) !== canonical(EXPLORATION_GAMEPLAY_DEFINITION)
  )
    throw Error("Incompatible Beacon gameplay definition");
  const destruction = new DamageableWorld(
    EXPLORATION_GAMEPLAY_DEFINITION.destruction,
  );
  const checkpoint = saved.destruction as DestructionCheckpoint;
  if (
    !Array.isArray(checkpoint?.history) ||
    checkpoint.history.length > 2 ||
    checkpoint.history.some(
      (command, index) => canonical(command) !== canonical(hit(index + 1)),
    )
  )
    throw Error("Invalid Beacon target hit admission");
  destruction.restore(checkpoint);
  const state: GameplayState = { destruction, shot: null, impact: null };
  if (!portable) {
    state.shot = restoreShot(saved.shot, roomId, hp(state) > 0, false);
    // A retained impact may precede target destruction, so admit only the two
    // authored target sets and let P1 replay establish its actual contact.
    try {
      state.impact = restoreShot(saved.impact, roomId, true, true);
    } catch (error) {
      if (hp(state) > 0) throw error;
      state.impact = restoreShot(saved.impact, roomId, false, true);
    }
    if (
      state.impact?.world.observe().events[0]?.targetId === "harbor-target" &&
      destruction.observe().tick === 0
    )
      throw Error("Spark contact has no target damage receipt");
  }
  return state;
}
/** Exact v4/portable v3 explicitly reject all historical production envelopes.
 * Original text remains owned by the session/UI recovery path; no relabelled
 * legacy save can claim the new gameplay contract. */
export class ExplorationGameplayOwner extends ExplorationCharacterOwner {
  private gameplay = initial();
  constructor(
    authored: CampaignPlatformDefinition = EXPLORATION_CAMPAIGN,
    selectedIdentity: CompatibilityIdentity = EXPLORATION_IDENTITY,
  ) {
    super(authored, selectedIdentity);
  }
  override observation() {
    const base = super.observation();
    const shot = this.gameplay.shot?.world.observe().bodies[0];
    return {
      ...base,
      gameplay: {
        target: {
          roomId: EXPLORATION_GAMEPLAY_DEFINITION.roomId,
          ...EXPLORATION_GAMEPLAY_DEFINITION.destruction.objects[0],
          rect: {
            ...EXPLORATION_GAMEPLAY_DEFINITION.destruction.objects[0].rect,
          },
          hp: hp(this.gameplay),
        },
        projectile: shot ? { ...shot } : null,
        lastContact: this.gameplay.impact?.world.observe().events[0] ?? null,
      },
    };
  }
  protected override prepareFrameExtension(
    command: Extract<CampaignPlatformCommand, { kind: "frame" }>,
    before: Readonly<World>,
    after: Readonly<World>,
    roomId: string,
  ): () => void {
    const hero = before.actors.find((actor) => actor.slot === 0)!;
    const accepted = after.actors.find((actor) => actor.slot === 0)!;
    let candidate =
      before.status === "playing" ? advance(this.gameplay) : this.gameplay;
    const attack = command.input.slots
      .find((slot) => slot.slot === 0)
      ?.edges.some(
        (edge) => edge.action === "attack" && edge.kind === "pressed",
      );
    // Only an immediately accepted press launches. All input and platform state
    // have been validated, and projectile construction finishes before publication.
    if (after.status !== "playing")
      candidate = { ...candidate, shot: null, impact: null };
    else if (
      attack &&
      !candidate.shot &&
      !hero.execution &&
      hero.health > 0 &&
      before.status === "playing" &&
      accepted.execution?.abilityId === "strike" &&
      accepted.execution.tick === 1
    ) {
      const bounds = body(
        accepted,
        after.definitions.archetypes.find(
          (definition) => definition.id === accepted.archetypeId,
        )!,
      );
      candidate = {
        ...candidate,
        shot: {
          roomId,
          world: new BallisticWorld(
            configuration(
              roomId,
              bounds.x +
                bounds.width / 2 +
                accepted.facing * (bounds.width / 2 + 3 * U),
              bounds.y + bounds.height / 2,
              accepted.facing,
              hp(candidate) > 0,
            ),
          ),
        },
      };
    }
    return () => {
      this.gameplay = candidate;
    };
  }
  override executeFrames(
    input: Parameters<ExplorationCharacterOwner["executeFrames"]>[0],
    ticks = 1,
  ): void {
    const previous = this.gameplay;
    try {
      super.executeFrames(input, ticks);
    } catch (error) {
      this.gameplay = previous;
      throw error;
    }
  }
  override commitEntry(plan: CampaignEntryPlan): void {
    // Prepare reset state before the parent publishes anything.
    const next =
      plan.kind === "reset"
        ? initial()
        : { ...this.gameplay, shot: null, impact: null };
    super.commitEntry(plan);
    this.gameplay = next;
  }
  override checkpoint(): string {
    const bytes = canonical({
      ...JSON.parse(super.checkpoint()),
      format: "beacon-character-exact-v4",
      gameplay: capture(this.gameplay, false),
    });
    boundedJSON(bytes, CAMPAIGN_PLATFORM_LIMITS.bytes);
    return bytes;
  }
  override progress(): string {
    const bytes = canonical({
      ...JSON.parse(super.progress()),
      version: 3,
      gameplay: capture(this.gameplay, true),
    });
    boundedJSON(bytes, CAMPAIGN_PLATFORM_LIMITS.progressBytes);
    return bytes;
  }
  private reopenGameplay(bytes: string, portable: boolean): void {
    const parsed = boundedJSON(
      bytes,
      portable
        ? CAMPAIGN_PLATFORM_LIMITS.progressBytes
        : CAMPAIGN_PLATFORM_LIMITS.bytes,
      { rejectNegativeZero: true },
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (portable
        ? !("kind" in parsed) ||
          parsed.kind !== "beacon-character-progress" ||
          !("version" in parsed) ||
          parsed.version !== 3
        : !("format" in parsed) ||
          parsed.format !== "beacon-character-exact-v4")
    )
      throw Error(
        "Unsupported Beacon gameplay save; no migration is registered",
      );
    const root = record(
      parsed,
      portable
        ? ["kind", "version", "campaign", "character", "gameplay"]
        : ["format", "campaign", "character", "frameEquipment", "gameplay"],
    );
    if (
      portable
        ? root.kind !== "beacon-character-progress" || root.version !== 3
        : root.format !== "beacon-character-exact-v4"
    )
      throw Error(
        "Unsupported Beacon gameplay save; no migration is registered",
      );
    const { gameplay: saved, ...character } = root;
    // This is an internal projection of the recognized current composite schema,
    // after rejecting historical formats; identity checks remain strict in parent.
    if (portable) character.version = 2;
    else character.format = "beacon-character-exact-v3";
    const prepared = this.prepareCharacterRestore(
      canonical(character),
      portable,
    );
    const next = restoreGameplay(saved, prepared.roomId, portable);
    if (!portable) {
      // Read already validated metadata, without replaying campaign authority.
      const campaign = JSON.parse(JSON.parse(prepared.checkpoint).campaign);
      const platform = JSON.parse(campaign.platform) as {
        status: string;
        tick: number;
      };
      for (const transient of [next.shot, next.impact]) {
        if (!transient) continue;
        if (platform.status !== "playing")
          throw Error(
            "Nonplaying campaign cannot retain spark flight or contact",
          );
        if (transient.world.observe().tick >= platform.tick)
          throw Error("Spark age exceeds current campaign room lifetime");
      }
    }
    if (
      !portable &&
      canonical({
        ...JSON.parse(prepared.checkpoint),
        format: root.format,
        gameplay: capture(next, false),
      }) !== bytes
    )
      throw Error("Noncanonical Beacon gameplay moment");
    // All campaign, equipment and primitive validators finish before the same
    // staged campaign is adopted. No replay or throwing work follows adoption.
    prepared.adopt();
    this.gameplay = next;
  }
  override restore(bytes: string): void {
    this.reopenGameplay(bytes, false);
  }
  override restoreProgress(bytes: string): void {
    this.reopenGameplay(bytes, true);
  }
}
export function createExplorationGameplayGame(
  campaign: CampaignPlatformDefinition = EXPLORATION_CAMPAIGN,
  identity: CompatibilityIdentity = EXPLORATION_IDENTITY,
): ExplorationGameplayOwner {
  return new ExplorationGameplayOwner(campaign, identity);
}
export function isExplorationGameplayObservation(
  value: unknown,
): value is ReturnType<ExplorationGameplayOwner["observation"]> {
  return !!value && typeof value === "object" && "gameplay" in value;
}
