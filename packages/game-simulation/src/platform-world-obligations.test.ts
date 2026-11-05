import { beforeAll, describe, expect, it } from "vitest";
import {
  createAuthoredPlatformStarter,
  createCourierRecipe,
  generatePlatformWorld,
  certifyPlatformWorld,
  certifyPlatformWorldManual,
  validatePlatformWorldDraft,
  validatePlatformWorldRealization,
  platformWorldObligations,
  platformDigest,
  generatePlatformAlternatives,
  platformRoutesDistinct,
  PlatformWorkBudget,
  assertPlatformWorldTimedQualified,
  qualifyPlatformWorldTimed,
  type PlatformWorldRealization,
} from "./platform-world-generation";
import { certifyPlatformTape } from "./platform-traversal";
import { neutralPlatformHeld } from "./platform-input-v2";
const U = 256;
let world: PlatformWorldRealization;
beforeAll(() => {
  world = generatePlatformWorld(createCourierRecipe(1, true));
}, 20000);
const refresh = (value: PlatformWorldRealization) => {
  value.digest = platformDigest({ ...value, digest: "" });
  return value;
};
describe("E3 trusted courier obligations", () => {
  it("derives the required static, physical and timed classes", () => {
    expect(platformWorldObligations(world).required).toEqual([
      "static-completion",
      "physical-shortcut",
      "timed-route",
    ]);
    expect(validatePlatformWorldRealization(world).digest).toBe(world.digest);
  });
  it("rejects missing and duplicated class evidence", () => {
    const missing = structuredClone(world);
    missing.certificates.pop();
    expect(() => validatePlatformWorldRealization(refresh(missing))).toThrow(
      /coverage missing/,
    );
    const duplicate = structuredClone(world);
    duplicate.certificates[2] = structuredClone(duplicate.certificates[0]);
    expect(() => validatePlatformWorldRealization(refresh(duplicate))).toThrow(
      /duplicate route evidence/,
    );
  });
  it("requires certificate zero to retain the real static spine", () => {
    const swapped = structuredClone(world);
    [swapped.certificates[0], swapped.certificates[2]] = [
      swapped.certificates[2],
      swapped.certificates[0],
    ];
    expect(() => validatePlatformWorldRealization(refresh(swapped))).toThrow(
      /certificate zero/,
    );
  });
  it("cannot hide capability obligations through recipe or template labels", () => {
    for (const mutate of [
      (v: PlatformWorldRealization) => {
        v.recipe.includeTimed = false;
      },
      (v: PlatformWorldRealization) => {
        v.rooms.find((r) => r.templateId === "ferry-rest")!.templateId =
          "meadow-step";
      },
      (v: PlatformWorldRealization) => {
        v.rooms.find((r) => r.templateId === "burst-gap")!.templateId =
          "meadow-step";
      },
      (v: PlatformWorldRealization) => {
        Object.assign(v.definitions.levels.find((l) => l.platforms.length)!, {
          platforms: [],
        });
      },
    ]) {
      const v = structuredClone(world);
      mutate(v);
      expect(() => validatePlatformWorldDraft(v)).toThrow(/courier-policy/);
    }
  });
  it("rejects inflated traversal and smuggled initial ledger mechanics", () => {
    for (const mutate of [
      (v: PlatformWorldRealization) =>
        Object.assign(v.campaign.traversal!, { distance: 65536 }),
      (v: PlatformWorldRealization) =>
        Object.assign(v.campaign.traversal!, { maxBonus: 8192 }),
      (v: PlatformWorldRealization) =>
        Object.assign(v.campaign.transactions.resources[0], { initial: 100 }),
    ]) {
      const draft = structuredClone(world);
      mutate(draft);
      expect(() => validatePlatformWorldDraft(draft)).toThrow(
        /courier-policy-(traversal|transaction)-contract/,
      );
    }
  });
  it("rejects valid replays with caller-weakened endpoints", () => {
    const v = createAuthoredPlatformStarter(),
      c = v.certificates[0];
    v.certificates[0] = certifyPlatformTape(
      v,
      c.tape,
      {
        ...c.destination,
        region: { x: 0, y: 0, width: 640 * U, height: 256 * U },
      },
      c.descriptor,
    );
    expect(() => validatePlatformWorldRealization(refresh(v))).toThrow(
      /weak endpoint/,
    );
  });
  it("allows stale evidence in a draft but never in shipping validation", () => {
    const v = structuredClone(world);
    Object.assign(v.definitions.levels[0].rectangles[0], { width: 87 * U });
    expect(validatePlatformWorldDraft(v).certificates).toHaveLength(3);
    expect(() => validatePlatformWorldRealization(v)).toThrow();
  });
  it("manual certification derives descriptors and restores static certificate ordering", () => {
    const result = certifyPlatformWorldManual(world, [
      world.certificates[2].tape,
      world.certificates[0].tape,
      world.certificates[1].tape,
    ]);
    expect(result.certificates[0].descriptor.beats).not.toContain("ride");
    expect(validatePlatformWorldRealization(result).digest).toBe(result.digest);
  });
  it("certifies a supported authored completion beyond the automatic recorder", () => {
    const original = createAuthoredPlatformStarter(),
      draft = structuredClone(original);
    Object.assign(
      draft.campaign.rooms[0].pickups.find((p) => p.id === "complete")!.area,
      { x: 112 * U },
    );
    expect(() => certifyPlatformWorld(draft)).toThrow();
    const tape = structuredClone(original.certificates[0].tape),
      index = tape.findIndex(
        (e) => e.command.kind === "pickup" && e.command.id === "complete",
      );
    tape.splice(index, 0, {
      command: {
        kind: "frame",
        input: {
          slots: [
            {
              slot: 0,
              held: neutralPlatformHeld(),
              axes: { moveX: 127 },
              edges: [],
            },
          ],
        },
      },
      repeat: 40,
    });
    const manual = certifyPlatformWorldManual(draft, [tape]);
    expect(validatePlatformWorldRealization(manual).digest).toBe(manual.digest);
  });
  it("retains locked bytes in alternatives and excludes accepted-equivalent static routes", () => {
    const base = structuredClone(world);
    base.rooms[1].locked = true;
    base.rooms[2].locked = true;
    refresh(base);
    const budget = new PlatformWorkBudget(40000);
    const result = generatePlatformAlternatives(base.recipe, {
      current: base,
      budget,
    });
    expect(result.ticks).toBe(budget.ticks);
    expect(result.ticks).toBeLessThanOrEqual(40000);
    expect(result.alternatives.length).toBeGreaterThan(0);
    for (const candidate of result.alternatives) {
      expect(
        platformRoutesDistinct(
          base.certificates[0].descriptor,
          candidate.certificates[0].descriptor,
        ),
      ).toBe(true);
      expect(validatePlatformWorldRealization(candidate).digest).toBe(
        candidate.digest,
      );
    }
    for (const candidate of result.alternatives)
      for (const selection of base.rooms.filter((r) => r.locked)) {
        expect(
          candidate.rooms.find((r) => r.roomId === selection.roomId),
        ).toEqual(selection);
        expect(
          candidate.definitions.levels.find((l) => l.id === selection.roomId),
        ).toEqual(
          base.definitions.levels.find((l) => l.id === selection.roomId),
        );
        expect(
          candidate.campaign.rooms.find((r) => r.id === selection.roomId),
        ).toEqual(base.campaign.rooms.find((r) => r.id === selection.roomId));
      }
  }, 20000);
  it("qualifies every reachable phase of an edited mover before shipping", () => {
    const draft = structuredClone(world);
    const level = draft.definitions.levels.find((l) => l.platforms.length)!;
    Object.assign(level.platforms[0], { endX: 112 * U });
    const certified = certifyPlatformWorld(draft);
    expect(() => validatePlatformWorldRealization(certified)).toThrow(
      /qualification-required/,
    );
    const result = qualifyPlatformWorldTimed(certified, {
      maxSimulationTicks: 100000,
    });
    expect(result.phases).toBe(32);
    expect(result.ticks).toBeGreaterThan(0);
    expect(result.ticks).toBeLessThanOrEqual(100000);
    expect(validatePlatformWorldRealization(certified).digest).toBe(
      certified.digest,
    );
  }, 20000);
  it("requires an explicit phase job for changed anchors or controller, with honest offline budget failure", () => {
    const draft = structuredClone(world);
    const room = draft.campaign.rooms.find((r) => r.id === "ridge-1")!;
    Object.assign(room.anchors!.find((a) => a.id === "west")!, {
      settleTicks: 2,
    });
    expect(() => assertPlatformWorldTimedQualified(draft)).toThrow(
      /qualification-required/,
    );
    expect(() =>
      qualifyPlatformWorldTimed(draft, { maxSimulationTicks: 1 }),
    ).toThrow(/phase-budget/);
    expect(() => assertPlatformWorldTimedQualified(draft)).toThrow(
      /qualification-required/,
    );
    expect(() =>
      qualifyPlatformWorldTimed(draft, { cancelled: () => true }),
    ).toThrow(/cancelled/);
  });
});
