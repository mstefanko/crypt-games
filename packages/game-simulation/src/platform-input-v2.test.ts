import { describe, it, expect } from "vitest";
import raw from "../../../examples/game-m1/definitions.json";
import { UNIT, validateDefinitions } from "../../game-project/src/index";
import { createWorld, step } from "./simulation";
import { serializeCheckpoint, restoreCheckpoint } from "./checkpoint";
import { cancelFrame } from "./input";
import {
  cancelPlatformFrame,
  createPlatformInputDecoder,
  decodePlatformInputRecords,
} from "./platform-input-v2";
const identity = { rulesBuildId: "test", contentId: "test" };
function course(selected = true) {
  const data = structuredClone(raw);
  const l = data.levels[0];
  l.tiles.fill(0);
  l.platforms = [];
  l.rectangles = [
    {
      id: "upper",
      x: 20 * UNIT,
      y: 80 * UNIT,
      width: 100 * UNIT,
      height: 8 * UNIT,
      oneWay: true,
    },
    {
      id: "lower",
      x: 20 * UNIT,
      y: 128 * UNIT,
      width: 100 * UNIT,
      height: 8 * UNIT,
      oneWay: true,
    },
    {
      id: "floor",
      x: 0,
      y: 176 * UNIT,
      width: 256 * UNIT,
      height: 16 * UNIT,
      oneWay: false,
    },
  ];
  l.spawns[0].y = 80 * UNIT;
  l.spawns[1].y = 176 * UNIT;
  data.archetypes[1].ai = "none";
  const defs = validateDefinitions(data);
  return createWorld(
    defs,
    identity,
    undefined,
    selected ? { inputCodec: "platform-input-v2" } : undefined,
  );
}
function drop(w: ReturnType<typeof course>, jump = false) {
  const f = cancelPlatformFrame(w.decoder);
  f.slots[0].held.drop = true;
  f.slots[0].edges.push({ action: "drop", kind: "pressed" });
  if (jump) {
    f.slots[0].held.jump = true;
    f.slots[0].edges.push({ action: "jump", kind: "pressed" });
  }
  return f;
}
describe("selected production platform input v2", () => {
  it("drops only the contacted support, wins over jump, restores mid-drop exactly and lands below without repeating held drop", () => {
    const w = course();
    const a = w.actors[0];
    expect(a.platformMotion?.supportId).toBe("rect:upper");
    expect(step(w, drop(w, true)).some((e) => e.type === "jump")).toBe(false);
    expect(a.platformMotion?.ignoredSupportId).toBe("rect:upper");
    const restored = restoreCheckpoint(
      w.definitions,
      identity,
      serializeCheckpoint(w),
    );
    for (let n = 0; n < 45; n++) {
      step(w);
      step(restored);
      expect(serializeCheckpoint(restored)).toBe(serializeCheckpoint(w));
    }
    expect(a.y).toBe(128 * UNIT);
    expect(a.grounded).toBe(true);
    expect(a.platformMotion).toEqual({
      supportId: "rect:lower",
      ignoredSupportId: null,
    });
  });
  it("release and cancellation preserve ignore until underside clearance", () => {
    const w = course();
    step(w, drop(w));
    step(w, cancelPlatformFrame(w.decoder));
    expect(w.actors[0].platformMotion?.ignoredSupportId).toBe("rect:upper");
  });
  it("retains valid jump when drop is ineligible and keeps legacy rejection and shape", () => {
    const w = course();
    const a = w.actors[0];
    a.platformMotion!.supportId = null;
    expect(step(w, drop(w, true)).some((e) => e.type === "jump")).toBe(true);
    const legacy = course(false),
      bytes = serializeCheckpoint(legacy);
    expect(bytes).not.toContain("platformMotion");
    expect(bytes).not.toContain("inputCodec");
    expect(() => step(legacy, drop(legacy))).toThrow();
    expect(serializeCheckpoint(legacy)).toBe(bytes);
    step(legacy, cancelFrame(legacy.decoder));
  });
  it("treats a contiguous tile ledge as one support and retains lower ledge collision", () => {
    const original = course();
    const data = structuredClone(original.definitions) as unknown as typeof raw;
    const l = data.levels[0];
    l.rectangles = l.rectangles.filter((r) => r.id !== "upper");
    for (let col = 1; col < 8; col++) l.tiles[5 * 40 + col] = 2;
    const w = createWorld(validateDefinitions(data), identity, undefined, {
      inputCodec: "platform-input-v2",
    });
    expect(w.actors[0].platformMotion?.supportId).toBe("tile:00000201");
    step(w, drop(w));
    expect(w.motionResults?.get(w.actors[0].id)?.departure).toBe("drop");
    for (let n = 0; n < 45; n++) step(w);
    expect(w.actors[0].y).toBe(128 * UNIT);
  });
  it("disallows drop on movers, preserves jump, and validates imported ignore identities", () => {
    const original = course();
    const data = structuredClone(original.definitions) as unknown as typeof raw;
    data.levels[0].rectangles = data.levels[0].rectangles.filter(
      (r) => r.id !== "upper",
    );
    data.levels[0].platforms = [
      {
        id: "ride",
        x: 20 * UNIT,
        y: 80 * UNIT,
        width: 100 * UNIT,
        height: 8 * UNIT,
        endX: 100 * UNIT,
        speed: UNIT,
      },
    ];
    const w = createWorld(validateDefinitions(data), identity, undefined, {
      inputCodec: "platform-input-v2",
    });
    for (let n = 0; n < 5; n++) step(w);
    const restored = restoreCheckpoint(
      w.definitions,
      identity,
      serializeCheckpoint(w),
    );
    for (let n = 0; n < 12; n++) {
      step(w);
      step(restored);
      expect(serializeCheckpoint(restored)).toBe(serializeCheckpoint(w));
    }
    step(w, drop(w, true));
    expect(w.actors[0].platformMotion?.ignoredSupportId).toBe(null);
    expect(w.motionResults?.get(w.actors[0].id)?.departure).toBe("jump");
    const bad = JSON.parse(serializeCheckpoint(w));
    bad.actors[0].platformMotion.ignoredSupportId = "rect:missing";
    expect(() =>
      restoreCheckpoint(w.definitions, identity, JSON.stringify(bad)),
    ).toThrow();
  });
  it("retains each uncleared ignored ledge across tightly stacked drops and exact restore", () => {
    const original = course(),
      data = structuredClone(original.definitions) as unknown as typeof raw;
    data.levels[0].rectangles.find((r) => r.id === "lower")!.y = 84 * UNIT;
    const w = createWorld(validateDefinitions(data), identity, undefined, {
      inputCodec: "platform-input-v2",
    });
    step(w, drop(w));
    for (let n = 0; n < 5; n++) step(w);
    expect(w.actors[0].platformMotion?.supportId).toBe("rect:lower");
    expect(w.actors[0].platformMotion?.ignoredSupportId).toBe("rect:upper");
    step(w, cancelPlatformFrame(w.decoder));
    step(w, drop(w));
    expect(w.actors[0].platformMotion?.ignoredSupportIds).toEqual([
      "rect:upper",
    ]);
    const bytes = serializeCheckpoint(w),
      restored = restoreCheckpoint(w.definitions, identity, bytes);
    const invalid = JSON.parse(bytes);
    invalid.actors[0].platformMotion.ignoredSupportIds = [
      "rect:upper",
      "rect:upper",
    ];
    expect(() =>
      restoreCheckpoint(w.definitions, identity, JSON.stringify(invalid)),
    ).toThrow(/ordering/);
    for (let n = 0; n < 40; n++) {
      step(w);
      step(restored);
      expect(serializeCheckpoint(restored)).toBe(serializeCheckpoint(w));
    }
    expect(w.actors[0].platformMotion?.ignoredSupportId).toBe(null);
    expect(w.actors[0].platformMotion?.ignoredSupportIds).toBeUndefined();
  });
  it("restores cumulative ignores beyond 512 on a valid densely stacked authored course", () => {
    const original = course(),
      data = structuredClone(original.definitions) as unknown as typeof raw;
    data.levels[0].rectangles = [
      ...Array.from({ length: 516 }, (_, i) => ({
        id: `ledge-${String(i).padStart(4, "0")}`,
        x: 20 * UNIT,
        y: 80 * UNIT + i,
        width: 100 * UNIT,
        height: 1,
        oneWay: true,
      })),
      data.levels[0].rectangles.find((r) => r.id === "floor")!,
    ];
    const w = createWorld(validateDefinitions(data), identity, undefined, {
      inputCodec: "platform-input-v2",
    });
    for (let n = 0; n < 514; n++) {
      step(w, drop(w));
      if (n < 513) step(w, cancelPlatformFrame(w.decoder));
    }
    expect(w.actors[0].platformMotion?.ignoredSupportIds).toHaveLength(513);
    const bytes = serializeCheckpoint(w),
      restored = restoreCheckpoint(w.definitions, identity, bytes);
    expect(serializeCheckpoint(restored)).toBe(bytes);
    for (let n = 0; n < 4; n++) {
      step(w);
      step(restored);
      expect(serializeCheckpoint(restored)).toBe(serializeCheckpoint(w));
    }
  }, 20000);
  it("round-trips maximum-length authored static and moving support IDs with namespaces", () => {
    const original = course(),
      data = structuredClone(original.definitions) as unknown as typeof raw;
    const staticId = "u".repeat(128),
      movingId = "m".repeat(128);
    data.levels[0].rectangles.find((r) => r.id === "upper")!.id = staticId;
    data.levels[0].rectangles.find((r) => r.id === "lower")!.y = 84 * UNIT;
    const w = createWorld(validateDefinitions(data), identity, undefined, {
      inputCodec: "platform-input-v2",
    });
    expect(w.actors[0].platformMotion?.supportId).toBe(`rect:${staticId}`);
    expect(
      serializeCheckpoint(
        restoreCheckpoint(w.definitions, identity, serializeCheckpoint(w)),
      ),
    ).toBe(serializeCheckpoint(w));
    step(w, drop(w));
    expect(w.actors[0].platformMotion?.ignoredSupportId).toBe(
      `rect:${staticId}`,
    );
    expect(
      serializeCheckpoint(
        restoreCheckpoint(w.definitions, identity, serializeCheckpoint(w)),
      ),
    ).toBe(serializeCheckpoint(w));
    for (let n = 0; n < 5; n++) step(w);
    step(w, cancelPlatformFrame(w.decoder));
    step(w, drop(w));
    expect(w.actors[0].platformMotion?.ignoredSupportIds).toEqual([
      `rect:${staticId}`,
    ]);
    expect(
      serializeCheckpoint(
        restoreCheckpoint(w.definitions, identity, serializeCheckpoint(w)),
      ),
    ).toBe(serializeCheckpoint(w));
    data.levels[0].rectangles = data.levels[0].rectangles.filter(
      (r) => r.id !== staticId,
    );
    data.levels[0].platforms = [
      {
        id: movingId,
        x: 20 * UNIT,
        y: 80 * UNIT,
        width: 100 * UNIT,
        height: 8 * UNIT,
        endX: 100 * UNIT,
        speed: UNIT,
      },
    ];
    const ride = createWorld(validateDefinitions(data), identity, undefined, {
      inputCodec: "platform-input-v2",
    });
    expect(ride.actors[0].platformMotion?.supportId).toBe(
      `platform:${movingId}`,
    );
    const restored = restoreCheckpoint(
      ride.definitions,
      identity,
      serializeCheckpoint(ride),
    );
    for (let n = 0; n < 8; n++) {
      step(ride);
      step(restored);
      expect(serializeCheckpoint(restored)).toBe(serializeCheckpoint(ride));
    }
  });
  it("decodes ordinary pressed, release and cancel transitions atomically", () => {
    const d = createPlatformInputDecoder();
    decodePlatformInputRecords(d, 0, [
      {
        tick: 0,
        slot: 0,
        sequence: 0,
        edges: [{ action: "drop", kind: "pressed" }],
      },
    ]);
    expect(d.slots[0].held.drop).toBe(true);
    expect(() =>
      decodePlatformInputRecords(d, 1, [
        {
          tick: 1,
          slot: 0,
          sequence: 0,
          edges: [{ action: "drop", kind: "pressed" }],
        },
      ]),
    ).toThrow();
    expect(d.lastTick).toBe(0);
    decodePlatformInputRecords(d, 1, [
      {
        tick: 1,
        slot: 0,
        sequence: 0,
        edges: [
          { action: "drop", kind: "released" },
          { action: "drop", kind: "cancel" },
        ],
      },
    ]);
    expect(d.slots[0].held.drop).toBe(false);
  });
});
