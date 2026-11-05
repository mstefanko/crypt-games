import { describe, expect, it } from "vitest";
import {
  createCourierRecipe,
  generatePlatformWorld,
  validatePlatformWorldRealization,
} from "./platform-world-generation";
import {
  platformPhaseCases,
  platformSemanticDigest,
  verifyPlatformCertificate,
} from "./platform-traversal";
describe("G2 generated campaign evidence", () => {
  it("replays physical joins, burst acquisition, delivery and return", () => {
    const r = generatePlatformWorld(createCourierRecipe(1, false));
    expect(verifyPlatformCertificate(r, r.certificates[0]).status).toBe(
      "valid",
    );
    expect(validatePlatformWorldRealization(r).digest).toBe(r.digest);
  });
  it("invalidates geometry and rules but not manifest display title", () => {
    const r = generatePlatformWorld(createCourierRecipe(2, false));
    const changed = structuredClone(r);
    (changed.definitions.levels[0].tiles as number[])[0] = 1;
    expect(verifyPlatformCertificate(changed, r.certificates[0]).status).toBe(
      "stale-certificate",
    );
    const cosmetic = structuredClone(r);
    Object.assign(cosmetic.definitions.manifest, { title: "Different title" });
    expect(platformSemanticDigest(cosmetic)).toBe(platformSemanticDigest(r));
  });
  it("counts phase orbits even when granularity does not divide period", () => {
    expect(platformPhaseCases(10, 4)).toEqual([0, 4, 8, 2, 6]);
  });
});

it("reserves the physical gate within four and eight room bounds and certifies static plus burst returns", () => {
  for (const rooms of [4, 8]) {
    const r = generatePlatformWorld({
      ...createCourierRecipe(3, false),
      rooms,
    });
    expect(r.rooms).toHaveLength(rooms);
    expect(r.rooms[rooms - 2].templateId).toBe("burst-gap");
    expect(r.certificates).toHaveLength(2);
    expect(JSON.parse(r.certificates[1].descriptor.topology)).toContain(
      rooms - 2,
    );
    expect(JSON.parse(r.certificates[0].descriptor.topology)).not.toContain(
      rooms - 2,
    );
    expect(r.certificates[1].descriptor.beats).toContain("burst");
  }
});
it("records the selected timed route through the production boarding policy", () => {
  const r = generatePlatformWorld(createCourierRecipe(1, true));
  expect(r.certificates[0].descriptor.beats).not.toContain("ride");
  expect(r.certificates.some((c) => c.descriptor.beats.includes("ride"))).toBe(
    true,
  );
  expect(
    Math.max(...r.certificates.map((c) => c.descriptor.waitRideTicks)),
  ).toBeGreaterThan(0);
});

describe("G2 proof trust boundary", () => {
  it("rejects forged route descriptors and reports the first failing command", () => {
    const r = generatePlatformWorld(createCourierRecipe(9, false));
    const forged = structuredClone(r.certificates[0]);
    forged.descriptor.beats.push("ride");
    expect(verifyPlatformCertificate(r, forged).status).toBe("failed-replay");
    const broken = structuredClone(r.certificates[0]);
    broken.tape[0] = { command: { kind: "pickup", id: "complete" }, repeat: 1 };
    const result = verifyPlatformCertificate(r, broken);
    expect(result.status).toBe("failed-replay");
    if (result.status !== "valid") expect(result.command).toBe(1);
  });
  it("invalidates each dependency category and never invokes hostile certificate accessors", () => {
    const r = generatePlatformWorld(createCourierRecipe(4, false));
    const mutations: ((draft: typeof r) => void)[] = [
      (d) => {
        Object.assign(d.definitions.archetypes[0], { speed: 513 });
      },
      (d) => {
        Object.assign(d.campaign.rooms[0].anchors![0], { settleTicks: 2 });
      },
      (d) => {
        Object.assign(d.campaign.traversal!, { distance: 8000 });
      },
      (d) => {
        d.identity = { ...d.identity, rulesBuildId: "changed-rules" };
      },
      (d) => {
        Object.assign(d.campaign.rooms[0].exits[0].area, { width: 100 });
      },
    ];
    for (const mutate of mutations) {
      const draft = structuredClone(r);
      mutate(draft);
      expect(verifyPlatformCertificate(draft, r.certificates[0]).status).toBe(
        "stale-certificate",
      );
    }
    const hostile = structuredClone(r.certificates[0]);
    let invoked = false;
    Object.defineProperty(hostile, "descriptor", {
      get() {
        invoked = true;
        return {};
      },
      enumerable: true,
    });
    expect(verifyPlatformCertificate(r, hostile).status).toBe("failed-replay");
    expect(invoked).toBe(false);
  });
});

it("qualifies every original static/drop/timed motif in both directions with and without acquired burst", async () => {
  const { qualifyPlatformRoomLibrary } = await import(
    "./platform-world-generation"
  );
  const result = qualifyPlatformRoomLibrary();
  expect(result.cases).toHaveLength(26);
  expect(result.ticks).toBeLessThanOrEqual(250000);
  for (const entry of result.cases) {
    expect(entry.ports).toBe("west-to-east-and-east-to-west");
    expect(entry.ticks).toBeGreaterThan(0);
    if (entry.capability === "none")
      expect(entry.descriptor.beats).not.toContain("burst");
  }
}, 20000);
