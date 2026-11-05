/** Beacon Return's C1 loadout consumer. Campaign owns all motion and combat. */
import {
  array,
  boundedJSON,
  canonical,
  integer,
  record,
  type CompatibilityIdentity,
} from "@onepage/game-project/runtime";
import { validateCharacterCatalog } from "@onepage/game-project/characters";
import { validateCharacterBuildDefinition } from "@onepage/game-project/character-build";
import {
  CampaignPlatformOwner,
  CAMPAIGN_PLATFORM_LIMITS,
  type CampaignPlatformDefinition,
  type CampaignPlatformCommand,
  type CampaignEntryPlan,
} from "./campaign-platform";
import {
  CharacterSessionOwner,
  type CharacterSessionCommand,
} from "./character-session";
import {
  EXPLORATION_DEFINITIONS,
  EXPLORATION_IDENTITY,
  EXPLORATION_CAMPAIGN,
} from "./exploration-rules";

export const EXPLORATION_CHARACTER_CATALOG = validateCharacterCatalog(
  {
    schemaVersion: 1,
    archetypes: [
      {
        id: "wayfarer",
        controller: "platform-combat-v1",
        definitionId: "hero",
      },
    ],
    appearances: ["warm", "cool"].flatMap((palette) =>
      [false, true].map((cape) => ({
        id: `${palette}-${cape ? "cape" : "plain"}`,
        assetId: "hero-atlas",
        partIds: cape ? ["cape", "body"] : ["body"],
        paletteIds: [palette],
        portraitId: null,
        displayName: "Wayfarer",
        animations: { "platform-combat-v1": "hero-arena" },
      })),
    ),
    bindings: [
      {
        placementId: "player",
        archetypeId: "wayfarer",
        appearanceId: "warm-cape",
      },
    ],
  },
  {
    definitions: { "arena-v1": [], "platform-combat-v1": ["hero"] },
    placements: { "arena-v1": [], "platform-combat-v1": ["player"] },
    assets: ["hero-atlas"],
    parts: ["cape", "body"],
    palettes: ["warm", "cool"],
    portraits: [],
    animationSets: { "arena-v1": [], "platform-combat-v1": ["hero-arena"] },
  },
);
const LEGACY_CHARACTER_BUILDS = validateCharacterBuildDefinition(
  {
    schemaVersion: 1,
    id: "beacon-wardrobe-v1",
    stats: [{ id: "style", min: 0, max: 1 }],
    slots: ["cloak"],
    items: [
      {
        id: "travel-cape",
        slotId: "cloak",
        archetypeIds: ["wayfarer"],
        requirements: [],
        modifiers: [],
      },
    ],
    builds: ["traveler", "pilgrim"].map((id) => ({
      id,
      archetypeId: "wayfarer",
      appearanceIds: ["warm-cape", "cool-cape", "warm-plain", "cool-plain"],
      baseStats: [{ statId: "style", value: 0 }],
      grants: [{ itemId: "travel-cape", quantity: 1 }],
      equipment:
        id === "traveler" ? [{ slotId: "cloak", itemId: "travel-cape" }] : [],
    })),
  },
  EXPLORATION_CHARACTER_CATALOG,
);
/** The gameplay contract is pinned by both full definitions and versioned composite envelopes.
 * This item changes only acquired phase-burst distance, never ordinary movement. */
export const EXPLORATION_CHARACTER_BUILDS = validateCharacterBuildDefinition(
  {
    ...LEGACY_CHARACTER_BUILDS,
    id: "beacon-loadout-v2",
    stats: [
      ...LEGACY_CHARACTER_BUILDS.stats,
      { id: "phaseReach", min: 0, max: 2048 },
    ],
    slots: [...LEGACY_CHARACTER_BUILDS.slots, "charm"],
    items: [
      ...LEGACY_CHARACTER_BUILDS.items,
      {
        id: "phase-focus",
        slotId: "charm",
        archetypeIds: ["wayfarer"],
        requirements: [],
        modifiers: [{ statId: "phaseReach", delta: 2048 }],
      },
    ],
    builds: LEGACY_CHARACTER_BUILDS.builds.map((build) => ({
      ...build,
      baseStats: [...build.baseStats, { statId: "phaseReach", value: 0 }],
      grants: [...build.grants, { itemId: "phase-focus", quantity: 1 }],
    })),
  },
  EXPLORATION_CHARACTER_CATALOG,
);
function character(legacy = false) {
  return new CharacterSessionOwner(
    legacy ? LEGACY_CHARACTER_BUILDS : EXPLORATION_CHARACTER_BUILDS,
    EXPLORATION_CHARACTER_CATALOG,
  );
}
function defaultCharacter() {
  const owner = character();
  owner.execute({
    id: "initial-character",
    revision: 0,
    action: {
      kind: "create",
      buildId: "traveler",
      appearanceId: "warm-cape",
      displayName: "Wayfarer",
    },
  });
  return owner;
}
function gameplayCampaign(
  campaign: CampaignPlatformDefinition,
  identity: CompatibilityIdentity,
): CampaignPlatformDefinition {
  // Reuse the campaign's plain-data and reference validators before reading input.
  const prepared = JSON.parse(
    new CampaignPlatformOwner(
      EXPLORATION_DEFINITIONS,
      identity,
      campaign,
    ).checkpoint(),
  ).definition as CampaignPlatformDefinition;
  // Do not silently reinterpret caller-authored equipment capabilities.
  if (!prepared.traversal || Object.hasOwn(prepared.traversal, "maxBonus"))
    throw Error(
      "Beacon loadout requires the original phase traversal contract",
    );
  return { ...prepared, traversal: { ...prepared.traversal, maxBonus: 2048 } };
}
/** Exact v3 binds the retained campaign tail to C1 equipment revisions. Portable
 * v2 carries durable progress and current equipment. Legacy
 * original campaign/v1 wardrobe envelopes are validated before explicit upgrade. */
export class ExplorationCharacterOwner extends CampaignPlatformOwner {
  private characterOwner = defaultCharacter();
  private readonly phaseFocusBonus = this.characterOwner
    .capture()
    .definition.items.find((item) => item.id === "phase-focus")!
    .modifiers.find((modifier) => modifier.statId === "phaseReach")!.delta;
  private readonly campaign: CampaignPlatformDefinition;
  private readonly compatibilityIdentity: CompatibilityIdentity;
  private frameEquipment: [number, number][] = [];
  constructor(
    campaign: CampaignPlatformDefinition = EXPLORATION_CAMPAIGN,
    identity: CompatibilityIdentity = EXPLORATION_IDENTITY,
  ) {
    super(
      EXPLORATION_DEFINITIONS,
      identity,
      gameplayCampaign(campaign, identity),
    );
    this.compatibilityIdentity = { ...identity };
    this.campaign = JSON.parse(
      JSON.stringify(campaign),
    ) as CampaignPlatformDefinition;
  }
  characterObservation() {
    const state = this.characterOwner.inspect();
    const selected = state.character!;
    const palette = selected.appearanceId.startsWith("cool") ? "cool" : "warm";
    const cape = selected.equipment.some((e) => e.slotId === "cloak");
    const bonus = state.stats.find(
      (stat) => stat.statId === "phaseReach",
    )!.value;
    return {
      ...state,
      loadout: {
        basePhaseDistance: this.campaign.traversal!.distance,
        phaseFocusBonus: this.phaseFocusBonus,
        phaseBonus: bonus,
        phaseDistance: this.campaign.traversal!.distance + bonus,
      },
      selection: {
        archetypeId: "wayfarer",
        appearanceId: `${palette}-${cape ? "cape" : "plain"}`,
        displayName: selected.displayName,
      },
    };
  }
  override observation() {
    return { ...super.observation(), character: this.characterObservation() };
  }
  /** The C1 stat is the sole source of equipment commands. Callers cannot grant
   * a bonus through either single frames or inherited atomic executeFrames. */
  override execute(command: CampaignPlatformCommand): void {
    // Spreading a command must not evaluate accessors before campaign validation.
    if (
      !command ||
      Object.getPrototypeOf(command) !== Object.prototype ||
      Reflect.ownKeys(command).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(command, key)!;
        return (
          typeof key !== "string" ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        );
      })
    )
      throw Error("Beacon campaign plain command required");
    if (command.kind !== "frame") {
      super.execute(command);
      if (this.campaignHistoryLength === 0) this.frameEquipment = [];
      return;
    }
    if (Object.hasOwn(command, "traversalBonus"))
      throw Error("Beacon traversal bonus is derived from equipped inventory");
    const selected = this.characterObservation();
    const bonus = selected.loadout.phaseBonus;
    const index = this.campaignHistoryLength;
    super.execute(bonus ? { ...command, traversalBonus: bonus } : command);
    if (this.campaignHistoryLength === 0) this.frameEquipment = [];
    else this.frameEquipment.push([index, selected.revision]);
  }
  override executeFrames(
    input: Parameters<CampaignPlatformOwner["executeFrames"]>[0],
    ticks = 1,
  ): void {
    const previous = this.frameEquipment;
    const previousLength = previous.length;
    try {
      super.executeFrames(input, ticks);
    } catch (error) {
      this.frameEquipment = previous;
      this.frameEquipment.length = previousLength;
      throw error;
    }
  }
  override commitEntry(plan: CampaignEntryPlan): void {
    super.commitEntry(plan);
    if (this.campaignHistoryLength === 0) this.frameEquipment = [];
  }
  executeCharacter(command: CharacterSessionCommand) {
    return this.characterOwner.execute(command);
  }
  /** Explicit starter recreation changes the loadout, preserving active gameplay. */
  chooseCharacter(
    buildId: string,
    appearanceId: string,
    displayName: string,
  ): void {
    const staged = character();
    staged.execute({
      id: "initial-character",
      revision: 0,
      action: { kind: "create", buildId, appearanceId, displayName },
    });
    // A new starter replaces the C1 command epoch. Retire the old campaign tail
    // before publishing it, preserving the complete current platform/progress.
    this.rebaseCampaignHistory();
    this.frameEquipment = [];
    this.characterOwner = staged;
  }
  override checkpoint(): string {
    const bytes = canonical({
      format: "beacon-character-exact-v3",
      campaign: super.checkpoint(),
      character: this.characterOwner.capture(),
      frameEquipment: this.frameEquipment,
    });
    boundedJSON(bytes, CAMPAIGN_PLATFORM_LIMITS.bytes);
    return bytes;
  }
  override progress(): string {
    const bytes = canonical({
      kind: "beacon-character-progress",
      version: 2,
      campaign: super.progress(),
      character: this.characterOwner.capture(),
    });
    boundedJSON(bytes, CAMPAIGN_PLATFORM_LIMITS.progressBytes);
    return bytes;
  }
  /** Validate the full character/campaign composite without publishing it. A
   * gameplay extension may validate its own state before single-use adoption. */
  protected prepareCharacterRestore(bytes: string, portable: boolean) {
    const value = boundedJSON(
      bytes,
      portable
        ? CAMPAIGN_PLATFORM_LIMITS.progressBytes
        : CAMPAIGN_PLATFORM_LIMITS.bytes,
      { rejectNegativeZero: true },
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid Beacon save envelope");
    const root = value as Record<string, unknown>;
    if (!portable && root.format === "beacon-character-exact-v2")
      throw Error(
        "Beacon exact v2 has no equipment interleaving witness; no migration is registered",
      );
    const composite = portable
      ? root.kind === "beacon-character-progress"
      : root.format === "beacon-character-exact-v1" ||
        root.format === "beacon-character-exact-v3";
    let legacy = true;
    let selected = defaultCharacter();
    let campaign = bytes;
    if (composite) {
      const envelope = record(
        value,
        portable
          ? ["kind", "version", "campaign", "character"]
          : [
              "format",
              "campaign",
              "character",
              ...(root.format === "beacon-character-exact-v3"
                ? ["frameEquipment"]
                : []),
            ],
      );
      if (portable && envelope.version !== 1 && envelope.version !== 2)
        throw Error(
          "Unsupported Beacon character progress version; no migration is registered",
        );
      legacy = portable
        ? envelope.version === 1
        : envelope.format === "beacon-character-exact-v1";
      if (typeof envelope.campaign !== "string")
        throw Error("Campaign bytes required");
      campaign = envelope.campaign;
      const saved = character(legacy);
      saved.restore(envelope.character);
      if (!saved.inspect().character) throw Error("Beacon character required");
      if (legacy) {
        // Replay validated old commands against the explicitly expanded grants.
        selected = character();
        for (const command of saved.capture().commands)
          selected.execute(command);
      } else selected = saved;
    }
    let prepared = this.prepareCampaignRestore(
      campaign,
      portable,
      legacy ? this.campaign : undefined,
    );
    if (!portable && prepared.checkpoint !== campaign)
      throw Error("Noncanonical exact campaign bytes");
    // The legacy authority was fully checked with its original authored definition.
    // Only the pinned, additive capability changes; old frame semantics are intact.
    if (legacy) {
      const upgraded = JSON.parse(
        portable ? prepared.progress : prepared.checkpoint,
      );
      upgraded.definition = gameplayCampaign(
        this.campaign,
        this.compatibilityIdentity,
      );
      campaign = canonical(upgraded);
      prepared = this.prepareCampaignRestore(campaign, portable);
    }
    const frames: [number, number][] = [];
    if (!portable) {
      const history = prepared.history;
      const references = legacy
        ? history.flatMap((command, index) =>
            command.kind === "frame" ? [[index, 1]] : [],
          )
        : array(root.frameEquipment, CAMPAIGN_PLATFORM_LIMITS.commands);
      const replay = character();
      const bonuses = [0];
      for (const command of selected.capture().commands) {
        replay.execute(command);
        bonuses.push(
          replay.inspect().stats.find((stat) => stat.statId === "phaseReach")!
            .value,
        );
      }
      let cursor = 0,
        previousRevision = 1;
      for (const [index, command] of history.entries()) {
        if (command.kind !== "frame") continue;
        const reference = array(references[cursor++], 2);
        if (reference.length !== 2)
          throw Error("Invalid equipment interleaving reference");
        const frameIndex = integer(
          reference[0],
          0,
          CAMPAIGN_PLATFORM_LIMITS.commands - 1,
        );
        const revision = integer(
          reference[1],
          previousRevision,
          selected.inspect().revision,
        );
        if (
          frameIndex !== index ||
          (command.traversalBonus ?? 0) !== bonuses[revision]
        )
          throw Error(
            "Campaign frame disagrees with equipment interleaving witness",
          );
        previousRevision = revision;
        frames.push([frameIndex, revision]);
      }
      if (cursor !== references.length)
        throw Error("Extra equipment interleaving reference");
    }
    const currentCharacter = this.characterOwner;
    const currentRevision = currentCharacter.inspect().revision;
    const checkpoint = canonical({
      format: "beacon-character-exact-v3",
      campaign: prepared.checkpoint,
      character: selected.capture(),
      frameEquipment: frames,
    });
    const progress = canonical({
      kind: "beacon-character-progress",
      version: 2,
      campaign: prepared.progress,
      character: selected.capture(),
    });
    boundedJSON(checkpoint, CAMPAIGN_PLATFORM_LIMITS.bytes);
    boundedJSON(progress, CAMPAIGN_PLATFORM_LIMITS.progressBytes);
    return {
      roomId: prepared.roomId,
      checkpoint,
      progress,
      adopt: () => {
        if (
          this.characterOwner !== currentCharacter ||
          this.characterOwner.inspect().revision !== currentRevision
        )
          throw Error("Stale prepared character restore");
        // All campaign, character and retained-tail provenance checks finished.
        prepared.adopt();
        this.characterOwner = selected;
        this.frameEquipment = frames;
      },
    };
  }
  override restore(bytes: string): void {
    this.prepareCharacterRestore(bytes, false).adopt();
  }
  override restoreProgress(bytes: string): void {
    this.prepareCharacterRestore(bytes, true).adopt();
  }
}
export function createExplorationCharacterGame(
  campaign: CampaignPlatformDefinition = EXPLORATION_CAMPAIGN,
  identity: CompatibilityIdentity = EXPLORATION_IDENTITY,
): ExplorationCharacterOwner {
  return new ExplorationCharacterOwner(campaign, identity);
}

/** Narrow detached observations produced by the selected campaign session. */
export function isExplorationCharacterObservation(
  value: unknown,
): value is ReturnType<ExplorationCharacterOwner["observation"]> {
  return (
    !!value &&
    typeof value === "object" &&
    "character" in value &&
    !!value.character &&
    typeof value.character === "object" &&
    "selection" in value.character
  );
}
