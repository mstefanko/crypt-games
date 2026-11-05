import {
  compileBurstReturnGateRoom,
  validateBurstReturnGate,
  burstReturnGateCrossingCommands,
} from "./platform-burst-gate";
import {
  recordTimedFerryTraversal,
  enumeratePlatformWaitPhases,
} from "./platform-timed-traversal";
import {
  boundedJSON,
  canonical,
  integer,
  record,
  string,
} from "@onepage/game-project/runtime";
import { validateDefinitions } from "@onepage/game-project/validation";
import type { GameDefinitions } from "@onepage/game-project/runtime";
import {
  CampaignPlatformOwner,
  copyCampaignPlainData,
  type CampaignPlatformDefinition,
  type CampaignPlatformCommand,
} from "./campaign-platform";
import {
  neutralPlatformHeld,
  type PlatformActionV2,
  type PlatformHeldV2,
  type PlatformInputFrameV2,
} from "./platform-input-v2";
import {
  PLATFORM_ROOM_LIBRARY,
  compilePlatformRoom,
  platformTemplate,
} from "./platform-room-library";
import { DeterministicRandom, deriveRandomSeed } from "./rng";
import {
  certifyPlatformTape,
  platformDigest,
  platformSemanticDigest,
  platformRoutesDistinct,
  recordPlatformCommand,
  verifyPlatformCertificate,
  PlatformWorkBudget,
} from "./platform-traversal";
import {
  PLATFORM_WORLD_LIMITS,
  type PlatformWorldRecipe,
  type PlatformWorldRealization,
  type PlatformTraversalCertificate,
} from "./platform-world-types";
import {
  platformWorldObligations,
  createPlatformObligationObserver,
  type PlatformObligationId,
} from "./platform-world-obligations";
export * from "./platform-world-obligations";
export * from "./platform-world-types";
export const PLATFORM_WORLD_RULES = "switchback-courier-development-rules-v1";
export function createCourierRecipe(
  seed = 1,
  includeTimed = true,
): PlatformWorldRecipe {
  return {
    format: "platform-world-recipe-v1",
    seed,
    rooms: 6,
    includeTimed,
    gameId: "switchback-courier",
  };
}
export function validatePlatformRecipe(value: unknown): PlatformWorldRecipe {
  value = copyCampaignPlainData(value, 262144);
  const r = record(value, [
    "format",
    "seed",
    "rooms",
    "includeTimed",
    "gameId",
  ]);
  if (
    r.format !== "platform-world-recipe-v1" ||
    typeof r.includeTimed !== "boolean"
  )
    throw Error("Invalid platform recipe");
  integer(r.seed, 0, 4294967295);
  integer(r.rooms, 2, 8);
  string(r.gameId);
  return JSON.parse(canonical(value));
}
const U = 256;
const region = (x: number, y = 176, width = 32, height = 32) => ({
  x: x * U,
  y: y * U,
  width: width * U,
  height: height * U,
});
function compile(
  recipe: PlatformWorldRecipe,
  rulesBuildId: string,
  templates?: readonly string[],
): PlatformWorldRealization {
  const random = new DeterministicRandom([
    {
      name: "templates",
      owner: "platform",
      seed: deriveRandomSeed(recipe.seed, "platform.templates"),
    },
  ]);
  const rooms = Array.from({ length: recipe.rooms }, (_, i) => ({
    roomId: i === 0 ? "depot" : i === recipe.rooms - 1 ? "relay" : `ridge-${i}`,
    templateId:
      PLATFORM_ROOM_LIBRARY.templates[
        random.drawInteger("platform", "templates", 12)
      ].id,
    locked: false,
    originSeed: recipe.seed,
  }));
  // Every course teaches deliberate descent safely before consequences.
  rooms[0].templateId = "drop-lesson";
  if (recipe.includeTimed) rooms[1].templateId = "ferry-rest";
  const gateIndex = recipe.rooms >= 4 ? recipe.rooms - 2 : -1;
  const unlockIndex = recipe.rooms >= 4 ? Math.min(2, recipe.rooms - 3) : 2;
  if (gateIndex >= 0) rooms[gateIndex].templateId = "burst-gap";
  if (templates) {
    if (templates.length !== rooms.length)
      throw Error("Template assignment shape");
    for (let i = 0; i < rooms.length; i++) rooms[i].templateId = templates[i];
  }
  const spine = rooms.map((_, i) => i).filter((i) => i !== gateIndex);
  const levels = rooms.map((r) =>
    compilePlatformRoom(platformTemplate(r.templateId), r.roomId),
  );
  const body = { x: -6 * U, y: -24 * U, width: 12 * U, height: 24 * U };
  const definitions: GameDefinitions = {
    manifest: {
      schemaVersion: 1,
      gameId: recipe.gameId,
      title: "Switchback Courier",
      rulesModule: "platform-combat-v1",
      initialLevelId: "depot",
      initialScenarioId: "depot-start",
      levelIds: rooms.map((r) => r.roomId),
      archetypeIds: ["courier"],
      abilityIds: ["courier-wave"],
      scenarioIds: rooms.map((r) => `${r.roomId}-start`),
      viewport: { width: 640, height: 256 },
    },
    levels,
    archetypes: [
      {
        id: "courier",
        body,
        hurt: body,
        push: body,
        health: 3,
        speed: 2 * U,
        jumpSpeed: 7 * U,
        gravity: 96,
        maxFallSpeed: 8 * U,
        coyoteTicks: 6,
        jumpBufferTicks: 6,
        attackBufferTicks: 6,
        abilities: ["courier-wave"],
        ai: "none",
        aiRange: 0,
      },
    ],
    abilities: [
      {
        id: "courier-wave",
        startup: 2,
        active: 4,
        recovery: 8,
        hit: { x: 6 * U, y: -24 * U, width: 12 * U, height: 24 * U },
        damage: 1,
        knockbackX: 0,
        knockbackY: 0,
        stunTicks: 0,
        hitStopTicks: 0,
        guardDamage: 0,
        maxHits: 1,
        rehitTicks: 1,
      },
    ],
    scenarios: rooms.map((r, i) => ({
      id: `${r.roomId}-start`,
      levelId: r.roomId,
      seed: recipe.seed + i,
      playerSlots: [0],
      ticks: 1800,
      actions: [],
      assertions: [],
    })),
  };
  const campaign: CampaignPlatformDefinition = {
    id: recipe.gameId,
    initialRoom: "depot",
    initialAnchor: "west",
    inputCodec: "platform-input-v2",
    traversal: { flag: "burst", distance: 8192 },
    transactions: {
      id: "courier-ledger",
      resources: [{ id: "shards", initial: 0, capacity: 100 }],
      stats: [],
      flags: ["burst", "delivered", "complete"],
      outcomes: [
        "burst-earned",
        "parcel-delivered",
        "courier-complete",
        "express-shard",
      ],
      rewardSeed: recipe.seed,
    },
    rooms: rooms.map((r, i) => {
      const t = platformTemplate(r.templateId),
        end = t.width - 48;
      if (i === gateIndex)
        return {
          ...compileBurstReturnGateRoom(r.roomId),
          exits: [
            ...compileBurstReturnGateRoom(r.roomId).exits,
            {
              id: "retreat",
              area: region(16, 176, 24),
              to: rooms[unlockIndex].roomId,
              destinationAnchor: "west",
              requires: null,
              outcome: null,
            },
          ],
        };
      const spinePosition = spine.indexOf(i);
      const exits = [];
      if (i < rooms.length - 1)
        exits.push({
          id: "onward",
          area: region(t.width - 24, 176, 16),
          to: rooms[spine[spinePosition + 1]].roomId,
          destinationAnchor: "west",
          requires: null,
          outcome: null,
        });
      if (i > 0)
        exits.push({
          id: "return",
          area: region(16),
          to: rooms[spine[spinePosition - 1]].roomId,
          destinationAnchor: "east",
          requires: null,
          outcome: null,
        });
      if (i === 0 && rooms.length > 4)
        exits.push({
          id: "express",
          area: region(end - 48, 176, 24),
          to: rooms[2].roomId,
          destinationAnchor: "west",
          requires: null,
          outcome: {
            id: "express-shard",
            operations: [
              { kind: "grant" as const, resource: "shards", amount: 1 },
            ],
          },
        });
      // The physical optional gap has a separate entry and safe retreat.
      if (i === unlockIndex && gateIndex >= 0)
        exits.push({
          id: "burst-return",
          area: region(96, 176, 16),
          to: rooms[gateIndex].roomId,
          destinationAnchor: "approach",
          requires: null,
          outcome: null,
        });
      return {
        id: r.roomId,
        scenarioId: `${r.roomId}-start`,
        assets: [],
        permanentEnemies: [],
        defaultAnchor: "west",
        anchors: [
          {
            id: "west",
            x: 64 * U,
            y: (t.drop ? 144 : 208) * U,
            facing: 1 as const,
            settleTicks: 1,
          },
          {
            id: "east",
            x: (t.width - 48) * U,
            y: 208 * U,
            facing: -1 as const,
            settleTicks: 1,
          },
        ],
        checkpoint: region(48, 112, 32, 96),
        exits,
        pickups:
          i === unlockIndex
            ? [
                {
                  id: "burst",
                  area: region(end - 48),
                  outcome: {
                    id: "burst-earned",
                    operations: [
                      { kind: "flag" as const, flag: "burst", value: true },
                    ],
                  },
                },
              ]
            : i === rooms.length - 1
              ? [
                  {
                    id: "delivery",
                    area: region(end),
                    outcome: {
                      id: "parcel-delivered",
                      operations: [
                        {
                          kind: "flag" as const,
                          flag: "delivered",
                          value: true,
                        },
                      ],
                    },
                  },
                ]
              : i === 0
                ? [
                    {
                      id: "complete",
                      requires: "delivered",
                      area: region(16),
                      outcome: {
                        id: "courier-complete",
                        operations: [
                          {
                            kind: "flag" as const,
                            flag: "complete",
                            value: true,
                          },
                        ],
                      },
                    },
                  ]
                : [],
      };
    }),
  };
  const identity = {
    rulesBuildId,
    contentId: platformDigest({ definitions, campaign }),
  };
  return {
    format: "platform-world-realization-v1",
    identity,
    definitions,
    campaign,
    recipe,
    rooms,
    certificates: [],
    digest: "",
  };
}
/** Authoring recorder: policy emits ordinary inputs, all movement is executed by
 * CampaignPlatformOwner. Failed candidates never publish a realization. */
export function recordCourierRoute(
  content: PlatformWorldRealization,
  budget = new PlatformWorkBudget(),
  express = false,
  shortcut = false,
  rideTimed = false,
  acquireBurst = true,
) {
  const owner = new CampaignPlatformOwner(
    content.definitions,
    content.identity,
    content.campaign,
    { onSimulationTick: () => budget.charge() },
  );
  const tape: PlatformTraversalCertificate["tape"] = [];
  let held: PlatformHeldV2 = neutralPlatformHeld(),
    ticks = 0;
  const beats: PlatformTraversalCertificate["descriptor"]["beats"] = [];
  let distance = 0,
    waitRideTicks = 0;
  function command(c: CampaignPlatformCommand) {
    if (c.kind === "frame") {
      if (++ticks > 18000) throw Error("route-tick-cap");
    }
    owner.execute(c);
    recordPlatformCommand(tape, c);
    if (c.kind === "exit") held = neutralPlatformHeld();
  }
  function frame(axis = 0, actions: PlatformActionV2[] = []) {
    const next = neutralPlatformHeld();
    for (const a of actions) next[a] = true;
    const edges = (Object.keys(next) as PlatformActionV2[])
      .filter((a) => next[a] !== held[a])
      .map((action) => ({
        action,
        kind: next[action] ? ("pressed" as const) : ("released" as const),
      }));
    const input: PlatformInputFrameV2 = {
      slots: [{ slot: 0, held: next, axes: { moveX: axis }, edges }],
    };
    const before = owner.observation().platform.actors[0];
    command({ kind: "frame", input });
    held = next;
    distance += Math.abs(owner.observation().platform.actors[0].x - before.x);
  }
  function traverse(target: number) {
    let local = 0;
    while (local++ < 1800) {
      const o = owner.observation(),
        a = o.platform.actors[0],
        center = (a.x + a.width / 2) / U,
        feet = (a.y + a.height) / U;
      if (o.platform.status !== "playing")
        throw Error(`route-lost:${o.roomId}`);
      if (Math.abs(center - target) <= 2 && a.grounded) {
        frame();
        return;
      }
      const dir = center < target ? 1 : -1;
      const level = content.definitions.levels.find((l) => l.id === o.roomId)!;
      const obstacle = level.rectangles.some(
        (r) =>
          !r.oneWay &&
          r.y / U >= feet - 40 &&
          r.y / U < feet &&
          (dir > 0
            ? r.x / U - center >= 0 && r.x / U - center < 28
            : center - (r.x + r.width) / U >= 0 &&
              center - (r.x + r.width) / U < 28),
      );
      if (
        a.grounded &&
        feet < 200 &&
        level.rectangles.some(
          (r) =>
            r.oneWay &&
            r.y === a.y + a.height &&
            a.x < r.x + r.width &&
            a.x + a.width > r.x,
        ) &&
        !held.drop
      ) {
        frame(0, ["drop"]);
        beats.push("drop");
      } else if (a.grounded && obstacle && !held.jump) {
        frame(dir * 127, ["jump"]);
        beats.push("jump");
      } else frame(Math.abs(center - target) <= 2 ? 0 : dir * 127);
    }
    throw Error(`no-witness-within-budget:${owner.observation().roomId}`);
  }
  const gateIndex = content.rooms.findIndex(
    (r) => r.templateId === "burst-gap",
  );
  const spine = content.rooms.map((_, i) => i).filter((i) => i !== gateIndex);
  for (let pos = 0; pos < spine.length; pos++) {
    let i = spine[pos];
    const room = content.rooms[i],
      t = {
        ...platformTemplate(room.templateId),
        width: content.definitions.levels.find((l) => l.id === room.roomId)!
          .width,
      };
    if (i === 0) command({ kind: "checkpoint" });
    if (t.timed && rideTimed) {
      const evidence = recordTimedFerryTraversal(
        owner,
        frame,
        content.definitions.levels.find((l) => l.id === room.roomId)!
          .platforms[0],
      );
      waitRideTicks += evidence.waitTicks + evidence.rideTicks;
      beats.push("ride");
    }
    if (
      acquireBurst &&
      owner.observation().room.pickups.some((p) => p.id === "burst")
    ) {
      traverse(t.width - 80);
      command({ kind: "pickup", id: "burst" });
      frame(127, ["heavy"]);
      frame();
      beats.push("burst");
    }
    traverse(t.width - 16);
    if (i === content.rooms.length - 1) {
      command({ kind: "pickup", id: "delivery" });
      break;
    }
    if (express && i === 0) {
      traverse(t.width - 80);
      command({ kind: "exit", id: "express" });
      pos = spine.indexOf(2) - 1;
    } else command({ kind: "exit", id: "onward" });
  }
  for (let pos = spine.length - 1; pos >= 0; pos--) {
    const hasShortcut = owner
      .observation()
      .room.exits.some((e) => e.id === "burst-return");
    if (shortcut && hasShortcut) {
      traverse(104);
      command({ kind: "exit", id: "burst-return" });
      for (const c of burstReturnGateCrossingCommands()) {
        const before = owner.observation().platform.actors[0];
        command(c);
        distance += Math.abs(
          owner.observation().platform.actors[0].x - before.x,
        );
        if (c.kind === "frame")
          held = { ...c.input.slots[0].held } as PlatformHeldV2;
      }
      beats.push("jump", "burst");
      traverse(296);
      command({ kind: "exit", id: "shortcut" });
      traverse(32);
      break;
    }
    traverse(32);
    if (pos > 0) command({ kind: "exit", id: "return" });
  }
  command({ kind: "pickup", id: "complete" });
  frame();
  return {
    tape,
    destination: {
      roomId: "depot",
      region: region(8, 160, 64, 48),
      requiredOutcomes: [
        ...(acquireBurst ? ["burst-earned"] : []),
        "parcel-delivered",
        "courier-complete",
      ],
    },
    descriptor: {
      beats,
      topology: shortcut
        ? "burst-gap-return"
        : express
          ? "fork-rejoin-express"
          : "safe-spine-return",
      distance: Math.round(distance / (12 * U)),
      waitRideTicks,
      recoveryWidths: minimumRecoveryWidths(content),
    },
  };
}
/** Minimum contiguous floor landing after subtracting solid obstacles; body widths. */
function minimumRecoveryWidths(content: PlatformWorldRealization): number {
  let minimum = Infinity;
  for (const level of content.definitions.levels) {
    const floor = 208 * U,
      cols = level.width / level.tileSize,
      row = 208 / level.tileSize;
    let run: number | null = null;
    for (let col = 0; col <= cols; col++) {
      const x = col * level.tileSize * U;
      const clear =
        col < cols &&
        level.tiles[row * cols + col] === 1 &&
        !level.rectangles.some(
          (r) =>
            !r.oneWay &&
            r.y < floor &&
            r.y + r.height >= floor &&
            x < r.x + r.width &&
            x + level.tileSize * U > r.x,
        );
      if (clear && run === null) run = x;
      if (!clear && run !== null) {
        const width = x - run;
        if (width >= 12 * U) minimum = Math.min(minimum, width / (12 * U));
        run = null;
      }
    }
  }
  return Number.isFinite(minimum) ? Math.floor(minimum) : 0;
}
function validateGate(content: PlatformWorldRealization): void {
  for (const selection of content.rooms.filter(
    (r) => r.templateId === "burst-gap",
  )) {
    const room = content.campaign.rooms.find((r) => r.id === selection.roomId)!;
    const level = content.definitions.levels.find(
      (l) => l.id === selection.roomId,
    )!;
    validateBurstReturnGate(
      level,
      content.definitions.archetypes.find(
        (a) => a.id === level.spawns[0].archetypeId,
      )!,
      room,
    );
    for (const source of content.campaign.rooms)
      for (const exit of source.exits.filter((e) => e.to === room.id))
        if (exit.destinationAnchor !== "approach")
          throw Error("Burst gate entry must use restricted approach");
  }
}
export function generatePlatformWorld(
  value: PlatformWorldRecipe,
  options: { rulesBuildId?: string; budget?: PlatformWorkBudget } = {},
): PlatformWorldRealization {
  const recipe = validatePlatformRecipe(value);
  if (recipe.rooms < 4)
    throw Error(
      "Generated worlds require 4–8 rooms; use authored starter for two rooms",
    );
  const budget = options.budget ?? new PlatformWorkBudget();
  budget.select();
  const result = compile(recipe, options.rulesBuildId ?? PLATFORM_WORLD_RULES);
  return certifyPlatformWorld(result, budget);
}
/** Bounded production construction without asserting freshness of traversal proof. */
export function validatePlatformWorldDraft(
  value: unknown,
  options: { budget?: PlatformWorkBudget } = {},
): PlatformWorldRealization {
  value = copyCampaignPlainData(value, 262144);
  boundedJSON(canonical(value), PLATFORM_WORLD_LIMITS.realizationBytes);
  const v = record(value, [
    "format",
    "identity",
    "definitions",
    "campaign",
    "recipe",
    "rooms",
    "certificates",
    "digest",
  ]) as unknown as PlatformWorldRealization;
  if (v.format !== "platform-world-realization-v1")
    throw Error("Platform realization version");
  if (typeof v.digest !== "string")
    throw Error("Platform realization digest shape");
  validatePlatformRecipe(v.recipe);
  validateDefinitions(v.definitions);
  if (
    !Array.isArray(v.rooms) ||
    !Array.isArray(v.certificates) ||
    v.rooms.length !== v.recipe.rooms ||
    v.campaign.rooms.length !== v.rooms.length ||
    v.certificates.length > 3
  )
    throw Error("Platform realization shape");
  const ids = new Set<string>();
  for (const selection of v.rooms) {
    record(selection, ["roomId", "templateId", "locked", "originSeed"]);
    string(selection.roomId);
    platformTemplate(selection.templateId);
    integer(selection.originSeed, 0, 4294967295);
    if (typeof selection.locked !== "boolean" || ids.has(selection.roomId))
      throw Error("Invalid duplicate room selection");
    ids.add(selection.roomId);
    const room = v.campaign.rooms.find((r) => r.id === selection.roomId);
    const scenario = v.definitions.scenarios.find(
      (s) => s.id === room?.scenarioId,
    );
    if (
      !room ||
      !scenario ||
      scenario.levelId !== selection.roomId ||
      !v.definitions.levels.some((l) => l.id === selection.roomId)
    )
      throw Error("Platform selection/campaign/scenario mismatch");
  }
  platformWorldObligations(v);
  const budget = options.budget ?? new PlatformWorkBudget();
  new CampaignPlatformOwner(v.definitions, v.identity, v.campaign, {
    onSimulationTick: () => budget.charge(),
  });
  return v;
}
function checkPlatformCoverage(
  value: PlatformWorldRealization,
  budget: PlatformWorkBudget,
): void {
  const policy = platformWorldObligations(value),
    found = new Set<PlatformObligationId>(),
    tapes = new Set<string>();
  if (value.certificates.length < 1 || value.certificates.length > 3)
    throw Error("Platform evidence coverage missing");
  for (const [index, c] of value.certificates.entries()) {
    if (canonical(c.destination) !== canonical(policy.destination))
      throw Error(
        "Platform whole-route completion obligations missing or weak endpoint",
      );
    const tapeKey = platformDigest(c.tape);
    if (tapes.has(tapeKey)) throw Error("Platform duplicate route evidence");
    tapes.add(tapeKey);
    const observer = createPlatformObligationObserver(value, policy);
    const verified = verifyPlatformCertificate(value, c, budget, observer);
    if (verified.status !== "valid")
      throw Error(`${verified.status}: ${verified.reason}`);
    const ids = observer.finish();
    if (index === 0 && !ids.includes("static-completion"))
      throw Error("Platform certificate zero must prove static completion");
    if (!ids.length)
      throw Error("Platform certificate satisfies no trusted route obligation");
    for (const id of ids) found.add(id);
  }
  for (const required of policy.required)
    if (!found.has(required))
      throw Error(`Platform evidence coverage missing: ${required}`);
}

export function validatePlatformWorldRealization(
  value: unknown,
  options: { budget?: PlatformWorkBudget } = {},
): PlatformWorldRealization {
  const budget = options.budget ?? new PlatformWorkBudget();
  const v = validatePlatformWorldDraft(value, { budget });
  if (v.digest !== platformDigest({ ...v, digest: "" }))
    throw Error("Platform realization identity mismatch");
  checkPlatformCoverage(v, budget);
  assertPlatformWorldTimedQualified(v);
  return JSON.parse(canonical(v));
}

export function rebindPlatformWorldRules(
  value: PlatformWorldRealization,
  rulesBuildId: string,
): PlatformWorldRealization {
  const result = validatePlatformWorldRealization(value);
  result.identity = { ...result.identity, rulesBuildId };
  const budget = new PlatformWorkBudget();
  result.certificates = result.certificates.map((c) =>
    certifyPlatformTape(result, c.tape, c.destination, c.descriptor, budget),
  );
  result.digest = platformDigest({ ...result, digest: "" });
  return result;
}
function compilePlatformCandidate(
  recipe: PlatformWorldRecipe,
  rules: string,
  current?: PlatformWorldRealization,
  templates?: readonly string[],
): PlatformWorldRealization {
  const next = compile(recipe, rules, templates);
  if (recipe.rooms === 2) {
    const relay = next.campaign.rooms[1],
      width = next.definitions.levels[1].width;
    Object.assign(relay, {
      pickups: [
        {
          id: "burst",
          area: region(width - 80),
          outcome: {
            id: "burst-earned",
            operations: [{ kind: "flag", flag: "burst", value: true }],
          },
        },
        ...relay.pickups,
      ],
    });
  }
  if (current) {
    for (const previous of current.rooms.filter((r) => r.locked)) {
      const index = next.rooms.findIndex((r) => r.roomId === previous.roomId);
      if (index < 0)
        throw Error(`Locked room boundary missing: ${previous.roomId}`);
      const room = current.campaign.rooms.find(
        (r) => r.id === previous.roomId,
      )!;
      if (
        canonical(
          room.exits.map((e) => [
            e.id,
            e.to,
            e.destinationAnchor,
            e.requires,
            e.outcome,
          ]),
        ) !==
        canonical(
          next.campaign.rooms[index].exits.map((e) => [
            e.id,
            e.to,
            e.destinationAnchor,
            e.requires,
            e.outcome,
          ]),
        )
      )
        throw Error(`Locked room obligations incompatible: ${previous.roomId}`);
      next.rooms[index] = copyCampaignPlainData(previous);
      (next.campaign.rooms as unknown[])[index] = copyCampaignPlainData(
        room,
        262144,
      );
      (next.definitions.levels as unknown[])[index] = copyCampaignPlainData(
        current.definitions.levels.find((l) => l.id === previous.roomId)!,
        262144,
      );
      (next.definitions.scenarios as unknown[])[index] = copyCampaignPlainData(
        current.definitions.scenarios.find((s) => s.id === room.scenarioId)!,
        262144,
      );
    }
    if (current.rooms.some((r) => r.locked))
      Object.assign(next.campaign, {
        transactions: copyCampaignPlainData(
          current.campaign.transactions,
          262144,
        ),
      });
    assertPlatformWorldLocksPreserved(current, next);
  }
  return next;
}
export function assertPlatformWorldLocksPreserved(
  current: PlatformWorldRealization,
  next: PlatformWorldRealization,
): void {
  for (const selection of current.rooms.filter((r) => r.locked)) {
    const previousRoom = current.campaign.rooms.find(
      (r) => r.id === selection.roomId,
    )!;
    const nextRoom = next.campaign.rooms.find((r) => r.id === selection.roomId);
    const incoming = (value: PlatformWorldRealization) =>
      value.campaign.rooms
        .flatMap((room) =>
          room.exits
            .filter((exit) => exit.to === selection.roomId)
            .map((exit) => [
              room.id,
              exit.id,
              exit.to,
              exit.destinationAnchor,
              exit.requires,
              exit.outcome,
            ]),
        )
        .sort((a, b) =>
          canonical(a) < canonical(b)
            ? -1
            : canonical(a) > canonical(b)
              ? 1
              : 0,
        );
    if (
      canonical(selection) !==
        canonical(next.rooms.find((r) => r.roomId === selection.roomId)) ||
      canonical(previousRoom) !== canonical(nextRoom) ||
      canonical(
        current.definitions.levels.find((l) => l.id === selection.roomId),
      ) !==
        canonical(
          next.definitions.levels.find((l) => l.id === selection.roomId),
        ) ||
      canonical(
        current.definitions.scenarios.find(
          (s) => s.id === previousRoom.scenarioId,
        ),
      ) !==
        canonical(
          next.definitions.scenarios.find(
            (s) => s.id === previousRoom.scenarioId,
          ),
        ) ||
      canonical(incoming(current)) !== canonical(incoming(next))
    )
      throw Error(`Locked room dependency changed: ${selection.roomId}`);
  }
}
export function generatePlatformAlternatives(
  recipe: PlatformWorldRecipe,
  options: {
    budget?: PlatformWorkBudget;
    current?: PlatformWorldRealization;
  } = {},
) {
  const budget = options.budget ?? new PlatformWorkBudget(),
    alternatives: PlatformWorldRealization[] = [];
  const checked = validatePlatformRecipe(recipe),
    current = options.current
      ? validatePlatformWorldDraft(options.current, { budget })
      : undefined;
  let acceptedDescriptor:
    | PlatformTraversalCertificate["descriptor"]
    | undefined;
  if (
    current &&
    current.certificates[0]?.semanticDigest === platformSemanticDigest(current)
  ) {
    try {
      checkPlatformCoverage(current, budget);
      acceptedDescriptor = current.certificates[0].descriptor;
    } catch (error) {
      if (
        String(error).includes("budget") ||
        String(error).includes("cancelled")
      )
        throw error;
      // Unverified drafts can still propose repairs; stale descriptors never
      // establish mechanical distance from the current authored geometry.
    }
  }
  if (checked.rooms < 4 && !current)
    throw Error(
      "Generated alternatives require an authored current course for two rooms",
    );
  const mechanics = (value: PlatformWorldRealization) =>
    canonical({
      levels: value.definitions.levels,
      rooms: value.campaign.rooms,
      traversal: value.campaign.traversal,
      archetypes: value.definitions.archetypes,
    });
  const seenMechanics = new Set<string>();
  const acceptedMechanics =
    current && acceptedDescriptor ? mechanics(current) : undefined;
  const estimate = (value: PlatformWorldRealization) =>
    value.rooms
      .filter((r) => r.templateId !== "burst-gap")
      .reduce(
        (sum, r) =>
          sum +
          value.definitions.levels.find((l) => l.id === r.roomId)!.width -
          80,
        0,
      );
  const calibration =
    current && acceptedDescriptor
      ? acceptedDescriptor.distance / estimate(current)
      : 1 / 6;
  const candidates: {
    content: PlatformWorldRealization;
    distance: number;
    recovery: number;
    order: number;
  }[] = [];
  const narrowRecovery = new Set([
    "broad-rest",
    "triple-climb",
    "wide-terrace",
    "last-rise",
  ]);
  const add = (seed: number, templates?: readonly string[]) => {
    budget.select();
    if (templates) {
      const assignment = base.rooms
        .map(
          (room, i) =>
            `${room.roomId}:${room.locked ? room.templateId : templates[i]}`,
        )
        .join("|");
      if (seenMechanics.has(assignment)) return;
    }
    const content = compilePlatformCandidate(
      { ...checked, seed },
      current?.identity.rulesBuildId ?? PLATFORM_WORLD_RULES,
      current,
      templates,
    );
    // Within one request every unlocked slot comes from the pinned compiler,
    // and locked content is constant, so the assignment identifies its geometry.
    const signature = content.rooms
      .map((r) => `${r.roomId}:${r.templateId}`)
      .join("|");
    if (seenMechanics.has(signature)) return;
    seenMechanics.add(signature);
    if (
      acceptedMechanics &&
      content.rooms.every(
        (r, i) => r.templateId === current!.rooms[i]?.templateId,
      ) &&
      mechanics(content) === acceptedMechanics
    )
      return;
    // A ranking estimate only: exact production replay still decides admission.
    // Ranking hints from the pinned motif qualification corpus. These are
    // deliberately not certificate evidence: every admission still measures
    // actual recovery width in fresh production replay, including locked edits.
    const recovery = content.rooms.some(
      (r) => r.templateId !== "burst-gap" && narrowRecovery.has(r.templateId),
    )
      ? 1
      : 7;
    candidates.push({
      content,
      distance: estimate(content) * calibration,
      recovery,
      order: candidates.length,
    });
  };
  const base = compilePlatformCandidate(
    checked,
    current?.identity.rulesBuildId ?? PLATFORM_WORLD_RULES,
    current,
  );
  for (let i = 0; i < 32; i++) add((checked.seed + i) % 4294967296);
  const variable = base.rooms
    .map((room, i) => ({ room, i }))
    .filter(
      ({ room, i }) =>
        i > 0 &&
        room.templateId !== "burst-gap" &&
        !platformTemplate(room.templateId).timed &&
        !room.locked,
    );
  const staticTemplates = PLATFORM_ROOM_LIBRARY.templates.filter(
    (t) => !t.timed && t.id !== "burst-gap",
  );
  for (const { i } of variable)
    for (const template of staticTemplates) {
      const assignment = base.rooms.map((r) => r.templateId);
      assignment[i] = template.id;
      add(checked.seed, assignment);
    }
  // Multi-slot extremes cover wide/compact and broad/narrow recovery courses
  // directly instead of hoping a short random seed window happens to hit them.
  for (const template of staticTemplates) {
    const assignment = base.rooms.map((r) => r.templateId);
    for (const { i } of variable) assignment[i] = template.id;
    add(checked.seed, assignment);
  }
  // Compact courses with one changed motif supply distance/recovery combinations
  // that neither one-slot changes to a wide base nor uniform extremes can reach.
  for (const { i } of variable)
    for (const template of staticTemplates) {
      const assignment = base.rooms.map((r) => r.templateId);
      for (const slot of variable) assignment[slot.i] = "drop-lesson";
      assignment[i] = template.id;
      add(checked.seed, assignment);
    }
  const explored: PlatformTraversalCertificate["descriptor"][] =
    acceptedDescriptor ? [acceptedDescriptor] : [];
  let attempted = 0;
  while (candidates.length && alternatives.length < 3 && attempted++ < 32) {
    const score = (candidate: (typeof candidates)[number]) =>
      explored.length
        ? Math.min(
            ...explored.map((previous) =>
              Math.max(
                (5 * Math.abs(candidate.distance - previous.distance)) /
                  Math.max(candidate.distance, previous.distance),
                Math.abs(candidate.recovery - previous.recoveryWidths) / 2,
              ),
            ),
          )
        : 1 / candidate.distance;
    candidates.sort(
      (a, b) =>
        score(b) - score(a) ||
        a.distance - b.distance ||
        a.content.recipe.seed - b.content.recipe.seed ||
        a.order - b.order,
    );
    const choice = candidates.shift()!;
    try {
      const candidate = validatePlatformWorldDraft(choice.content, { budget });
      candidate.identity = {
        ...candidate.identity,
        contentId: platformDigest({
          definitions: candidate.definitions,
          campaign: candidate.campaign,
        }),
      };
      const policy = platformWorldObligations(candidate),
        route = recordCourierRoute(candidate, budget),
        observer = createPlatformObligationObserver(candidate, policy);
      const primary = certifyPlatformTape(
        candidate,
        route.tape,
        policy.destination,
        route.descriptor,
        budget,
        observer,
      );
      if (!observer.finish().includes("static-completion"))
        throw Error("Platform primary route failed trusted static completion");
      explored.push(primary.descriptor);
      if (
        acceptedDescriptor &&
        !platformRoutesDistinct(acceptedDescriptor, primary.descriptor)
      )
        continue;
      if (
        !alternatives.every((previous) =>
          platformRoutesDistinct(
            previous.certificates[0].descriptor,
            primary.descriptor,
          ),
        )
      )
        continue;
      // Rejected static routes never spend work recording the optional classes.
      // Admitted proposals still require every selected obligation before publish.
      const remaining: PlatformTraversalCertificate["tape"][] = [];
      if (policy.gateRoom)
        remaining.push(recordCourierRoute(candidate, budget, false, true).tape);
      if (policy.timedRoom)
        remaining.push(
          recordCourierRoute(candidate, budget, false, false, true).tape,
        );
      alternatives.push(
        certifyPlatformWorldManualInternal(
          candidate,
          remaining,
          budget,
          primary,
        ),
      );
    } catch (error) {
      if (String(error).includes("budget")) break;
      throw error;
    }
  }
  return {
    alternatives,
    ticks: budget.ticks,
    status:
      alternatives.length === 3
        ? ("complete" as const)
        : ("no-witness-within-budget" as const),
  };
}

export function createAuthoredPlatformStarter(
  options: { rulesBuildId?: string; budget?: PlatformWorkBudget } = {},
): PlatformWorldRealization {
  const recipe = {
    ...createCourierRecipe(1, false),
    rooms: 2,
    gameId: "courier-starter",
  };
  const result = compile(recipe, options.rulesBuildId ?? PLATFORM_WORLD_RULES);
  const relay = result.campaign.rooms[1];
  Object.assign(relay, {
    pickups: [
      {
        id: "burst",
        area: region(platformTemplate(result.rooms[1].templateId).width - 80),
        outcome: {
          id: "burst-earned",
          operations: [{ kind: "flag", flag: "burst", value: true }],
        },
      },
      ...relay.pickups,
    ],
  });
  return certifyPlatformWorld(result, options.budget);
}
/** Certifies the edited content as it stands; never repairs geometry silently. */
export function certifyPlatformWorld(
  value: PlatformWorldRealization,
  budget = new PlatformWorkBudget(),
): PlatformWorldRealization {
  const result = validatePlatformWorldDraft(value, { budget });
  const routes = [recordCourierRoute(result, budget).tape];
  const policy = platformWorldObligations(result);
  if (policy.gateRoom)
    routes.push(recordCourierRoute(result, budget, false, true).tape);
  if (policy.timedRoom)
    routes.push(recordCourierRoute(result, budget, false, false, true).tape);
  return certifyPlatformWorldManual(result, routes, budget);
}
/** Caller supplies commands only. Endpoints, descriptors and coverage come from the trusted policy and fresh production replay. */
export function certifyPlatformWorldManual(
  value: PlatformWorldRealization,
  tapes: PlatformTraversalCertificate["tape"][],
  budget = new PlatformWorkBudget(),
): PlatformWorldRealization {
  return certifyPlatformWorldManualInternal(value, tapes, budget);
}
/** Only this module may pass an already freshly replayed static certificate. */
function certifyPlatformWorldManualInternal(
  value: PlatformWorldRealization,
  tapes: PlatformTraversalCertificate["tape"][],
  budget: PlatformWorkBudget,
  primary?: PlatformTraversalCertificate,
): PlatformWorldRealization {
  // The private fast path follows bounded draft validation and fresh static
  // replay in this same request. Public manual callers always take validation.
  const result = primary
    ? copyCampaignPlainData(value, 262144)
    : validatePlatformWorldDraft(value, { budget });
  if (
    !Array.isArray(tapes) ||
    tapes.length + Number(Boolean(primary)) < 1 ||
    tapes.length + Number(Boolean(primary)) > 3
  )
    throw Error("Platform manual tape count");
  result.identity = {
    ...result.identity,
    contentId: platformDigest({
      definitions: result.definitions,
      campaign: result.campaign,
    }),
  };
  const policy = platformWorldObligations(result),
    coverage = new Set<PlatformObligationId>(),
    seen = new Set<string>();
  const certificates: {
    certificate: PlatformTraversalCertificate;
    ids: PlatformObligationId[];
  }[] = primary ? [{ certificate: primary, ids: ["static-completion"] }] : [];
  if (primary) {
    coverage.add("static-completion");
    seen.add(platformDigest(primary.tape));
  }
  for (const input of tapes) {
    const tape = copyCampaignPlainData(input, 262144);
    const digest = platformDigest(tape);
    if (seen.has(digest)) throw Error("Platform duplicate route evidence");
    seen.add(digest);
    const observer = createPlatformObligationObserver(result, policy);
    const certificate = certifyPlatformTape(
      result,
      tape,
      policy.destination,
      {
        beats: [],
        topology: "",
        distance: 0,
        waitRideTicks: 0,
        recoveryWidths: 0,
      },
      budget,
      observer,
    );
    const ids = observer.finish();
    if (!ids.length)
      throw Error("Platform tape satisfies no trusted route obligation");
    for (const id of ids) coverage.add(id);
    certificates.push({ certificate, ids });
  }
  for (const required of policy.required)
    if (!coverage.has(required))
      throw Error(`Platform evidence coverage missing: ${required}`);
  certificates.sort(
    (a, b) =>
      Number(b.ids.includes("static-completion")) -
      Number(a.ids.includes("static-completion")),
  );
  result.certificates = certificates.map((c) => c.certificate);
  result.digest = platformDigest({ ...result, digest: "" });
  return result;
}

export function regeneratePlatformWorld(
  current: PlatformWorldRealization,
  seed: number,
  options: { budget?: PlatformWorkBudget; recipe?: PlatformWorldRecipe } = {},
): PlatformWorldRealization {
  const budget = options.budget ?? new PlatformWorkBudget();
  current = validatePlatformWorldDraft(current, { budget });
  budget.select();
  const recipe = validatePlatformRecipe({
    ...(options.recipe ?? current.recipe),
    seed,
  });
  const next = compilePlatformCandidate(
    recipe,
    current.identity.rulesBuildId,
    current,
  );
  return certifyPlatformWorld(next, budget);
}

export {
  platformDigest,
  PlatformWorkBudget,
  platformRoutesDistinct,
  verifyPlatformCertificate,
  replayPlatformTape,
} from "./platform-traversal";
export { enumeratePlatformWaitPhases } from "./platform-timed-traversal";

/** Public authored course adapter for qualifying a selected original motif. */
export function createAuthoredTemplateCourse(
  templateId: string,
  options: { rulesBuildId?: string; budget?: PlatformWorkBudget } = {},
): PlatformWorldRealization {
  if (templateId === "burst-gap")
    throw Error("Burst gap uses its restricted optional corridor contract");
  const template = platformTemplate(templateId);
  const course = createAuthoredPlatformStarter(options);
  course.rooms[1].templateId = templateId;
  course.recipe.includeTimed = template.timed;
  (course.definitions.levels as unknown[])[1] = compilePlatformRoom(
    template,
    "relay",
  );
  const room = course.campaign.rooms[1];
  Object.assign(room, {
    anchors: [
      {
        id: "west",
        x: 64 * U,
        y: (template.drop ? 144 : 208) * U,
        facing: 1,
        settleTicks: 1,
      },
      {
        id: "east",
        x: (template.width - 48) * U,
        y: 208 * U,
        facing: -1,
        settleTicks: 1,
      },
    ],
    pickups: room.pickups.map((p) => ({
      ...p,
      area: {
        ...p.area,
        x: (template.width - (p.id === "burst" ? 80 : 48)) * U,
      },
    })),
  });
  return certifyPlatformWorld(course, options.budget);
}

/** Explicit motif/port/capability matrix; seeds do not substitute for these cases. */
export function qualifyPlatformRoomLibrary(
  options: { budget?: PlatformWorkBudget } = {},
) {
  const budget = options.budget ?? new PlatformWorkBudget();
  const cases = [];
  for (const template of PLATFORM_ROOM_LIBRARY.templates.filter(
    (t) => t.id !== "burst-gap",
  )) {
    budget.select();
    const course = createAuthoredTemplateCourse(template.id, { budget });
    for (const acquired of [false, true]) {
      const route = recordCourierRoute(
        course,
        budget,
        false,
        false,
        template.timed,
        acquired,
      );
      const certificate = certifyPlatformTape(
        course,
        route.tape,
        route.destination,
        route.descriptor,
        budget,
      );
      cases.push({
        templateId: template.id,
        ports: "west-to-east-and-east-to-west",
        capability: acquired ? "burst" : "none",
        ticks: certificate.ticks,
        descriptor: certificate.descriptor,
      });
    }
  }
  return { cases, ticks: budget.ticks };
}

/** Offline phase qualification has its own explicit aggregate budget, never a fresh interactive request budget per phase. */
export const PLATFORM_TIMED_PHASE_POLICY = "courier-timed-phases-v1";
const qualifiedTimedWorlds = new Map<string, true>();
function timedQualificationKey(value: PlatformWorldRealization): string {
  return `${PLATFORM_TIMED_PHASE_POLICY}:${platformSemanticDigest(value)}`;
}
function editedTimedLevel(value: PlatformWorldRealization) {
  const policy = platformWorldObligations(value);
  if (!policy.timedRoom) return null;
  const level = value.definitions.levels.find(
    (l) => l.id === policy.timedRoom,
  )!;
  const room = value.campaign.rooms.find((r) => r.id === policy.timedRoom)!;
  const pinned = compile(value.recipe, value.identity.rulesBuildId);
  const expectedAnchors = [
    { id: "west", x: 64 * U, y: 208 * U, facing: 1, settleTicks: 1 },
    {
      id: "east",
      x: (level.width - 48) * U,
      y: 208 * U,
      facing: -1,
      settleTicks: 1,
    },
  ];
  const scenario = value.definitions.scenarios.find(
    (s) => s.id === room.scenarioId,
  )!;
  const pristine =
    canonical(level) ===
      canonical(
        compilePlatformRoom(platformTemplate("ferry-rest"), level.id),
      ) &&
    canonical(room.anchors) === canonical(expectedAnchors) &&
    room.defaultAnchor === "west" &&
    canonical(value.definitions.archetypes) ===
      canonical(pinned.definitions.archetypes) &&
    scenario.actions.length === 0 &&
    scenario.playerSlots.length === 1 &&
    scenario.playerSlots[0] === 0;
  return pristine ? null : level;
}
export function assertPlatformWorldTimedQualified(
  value: PlatformWorldRealization,
): void {
  if (
    editedTimedLevel(value) &&
    !qualifiedTimedWorlds.has(timedQualificationKey(value))
  )
    throw Error(
      "timed-phase-qualification-required: edited timed geometry requires explicit offline qualification",
    );
}
export function qualifyPlatformWorldTimed(
  value: PlatformWorldRealization,
  options: { maxSimulationTicks?: number; cancelled?: () => boolean } = {},
) {
  const maximum = integer(options.maxSimulationTicks ?? 4000000, 1, 4000000);
  let ticks = 0;
  const charge = () => {
    if (options.cancelled?.()) throw Error("cancelled");
    if (++ticks > maximum) throw Error("timed-phase-budget-exhausted");
  };
  // Shape and campaign ingress checks are charged to this offline job too.
  const result = copyCampaignPlainData(value, 262144);
  validateDefinitions(result.definitions);
  const policy = platformWorldObligations(result);
  const key = timedQualificationKey(result);
  if (!policy.timedRoom)
    return {
      status: "qualified" as const,
      policy: PLATFORM_TIMED_PHASE_POLICY,
      semanticDigest: platformSemanticDigest(result),
      ticks,
      phases: 0,
      maximum,
    };
  const level = result.definitions.levels.find(
      (l) => l.id === policy.timedRoom,
    )!,
    mover = level.platforms[0];
  const schedule = enumeratePlatformWaitPhases(
    mover.endX - mover.x,
    mover.speed,
  );
  for (const phase of schedule.phases) {
    if (options.cancelled?.()) throw Error("cancelled");
    const campaign = {
      ...result.campaign,
      initialRoom: policy.timedRoom,
      initialAnchor: "west",
    };
    const owner = new CampaignPlatformOwner(
      result.definitions,
      result.identity,
      campaign,
      { onSimulationTick: charge },
    );
    let held = neutralPlatformHeld();
    const frame = (axis = 0, actions: PlatformActionV2[] = []) => {
      const next = neutralPlatformHeld();
      for (const action of actions) next[action] = true;
      const edges = (Object.keys(next) as PlatformActionV2[])
        .filter((action) => next[action] !== held[action])
        .map((action) => ({
          action,
          kind: next[action] ? ("pressed" as const) : ("released" as const),
        }));
      if (
        owner.observation().platform.platforms.find((p) => p.id === mover.id)
          ?.blocked
      )
        throw Error("Timed ferry blocked history is unsupported");
      owner.execute({
        kind: "frame",
        input: {
          slots: [{ slot: 0, held: next, axes: { moveX: axis }, edges }],
        },
      });
      if (
        owner.observation().platform.platforms.find((p) => p.id === mover.id)
          ?.blocked
      )
        throw Error("Timed ferry blocked history is unsupported");
      held = next;
    };
    for (let n = 0; n < phase; n++) frame();
    recordTimedFerryTraversal(owner, frame, mover);
  }
  qualifiedTimedWorlds.set(key, true);
  while (qualifiedTimedWorlds.size > 16)
    qualifiedTimedWorlds.delete(qualifiedTimedWorlds.keys().next().value!);
  return {
    status: "qualified" as const,
    policy: PLATFORM_TIMED_PHASE_POLICY,
    semanticDigest: platformSemanticDigest(result),
    ticks,
    phases: schedule.phaseCount,
    maximum,
  };
}
