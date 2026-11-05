import { expect, it } from "vitest";
import {
  CampaignPlatformOwner,
  type CampaignPlatformDefinition,
} from "./campaign-platform";
import {
  CAMPAIGN_PLATFORM_FIXTURE as authored,
  CAMPAIGN_PLATFORM_FIXTURE_DEFINITIONS as definitions,
  CAMPAIGN_PLATFORM_FIXTURE_IDENTITY as identity,
} from "./campaign-platform-fixture";
import {
  createPortableCampaignPlatformOwner,
  attachPlatformWorldSaveGuard,
  PLATFORM_WORLD_SAVE_LIMITS,
  serializePlatformWorldSave,
  restorePlatformWorldSave,
} from "./platform-world-save";
const U = 256;
function anchored(): CampaignPlatformDefinition {
  return {
    ...authored,
    initialAnchor: "west",
    rooms: authored.rooms.map((r) => ({
      ...r,
      anchors: [
        { id: "west", x: 80 * U, y: 144 * U, facing: -1, settleTicks: 2 },
        { id: "east", x: 240 * U, y: 144 * U, facing: 1, settleTicks: 2 },
      ],
      defaultAnchor: "west",
      exits: r.exits.map((e) => ({ ...e, destinationAnchor: "east" })),
    })),
  };
}
it("settles a validated anchor, exact restores without settling and durable restores at recovery", () => {
  const campaign = anchored();
  const owner = new CampaignPlatformOwner(definitions, identity, campaign);
  expect(owner.observation().platform.tick).toBe(2);
  expect(owner.observation().platform.actors.find((a) => a.slot === 0)!.x).toBe(
    74 * U,
  );
  owner.execute({ kind: "frame", input: { slots: [] } });
  const exact = owner.checkpoint();
  const imported = new CampaignPlatformOwner(definitions, identity, campaign);
  imported.restore(exact);
  expect(imported.checkpoint()).toBe(exact);
  imported.restoreProgress(owner.progress());
  expect(imported.observation().platform.tick).toBe(2);
  expect(JSON.parse(imported.checkpoint()).checkpointAnchorId).toBe("west");
});
it("rejects missing and obstructed ingress before admission", () => {
  const campaign = anchored();
  expect(
    () =>
      new CampaignPlatformOwner(definitions, identity, {
        ...campaign,
        initialAnchor: "missing",
      }),
  ).toThrow(/anchor/);
  const rooms = campaign.rooms.map((r) => ({
    ...r,
    anchors: r.anchors!.map((a) => ({ ...a, y: 160 * U })),
  }));
  expect(
    () =>
      new CampaignPlatformOwner(definitions, identity, { ...campaign, rooms }),
  ).toThrow(/collision/);
});
it("embeds exact content in both save forms and validates identity", () => {
  const validDefinitions = {
    ...definitions,
    archetypes: definitions.archetypes.map((a) => ({
      ...a,
      speed: Math.max(1, a.speed),
    })),
  };
  const content = {
    definitions: validDefinitions,
    campaign: anchored(),
    identity,
  };
  const owner = createPortableCampaignPlatformOwner(content);
  for (const kind of ["checkpoint", "progress"] as const) {
    const restored = restorePlatformWorldSave(
      serializePlatformWorldSave(content, owner, kind),
    );
    expect(restored.content).toEqual(content);
    expect(restored.owner.observation().platform).toEqual(
      owner.observation().platform,
    );
  }
  const tampered = JSON.parse(serializePlatformWorldSave(content, owner));
  tampered.content.identity.contentId = "other";
  expect(() => restorePlatformWorldSave(JSON.stringify(tampered))).toThrow(
    /compatibility/,
  );
});
it("rejects prospective state atomically", () => {
  const owner = new CampaignPlatformOwner(definitions, identity, anchored());
  const before = owner.checkpoint();
  owner.setPersistenceGuard((candidate) => {
    if (candidate.observation().platform.tick > 2) throw Error("aggregate cap");
  });
  expect(() => owner.execute({ kind: "frame", input: { slots: [] } })).toThrow(
    "aggregate cap",
  );
  expect(owner.checkpoint()).toBe(before);
});

it("preserves directional exit ingress and recorded checkpoint through progress", () => {
  const campaign = anchored();
  const rooms = campaign.rooms.map((r, i) => ({
    ...r,
    checkpoint:
      i === 1
        ? { x: 230 * U, y: 110 * U, width: 30 * U, height: 40 * U }
        : r.checkpoint,
    exits: r.exits.map((e) =>
      i === 0 && e.id === "to-shrine"
        ? {
            ...e,
            area: { x: 105 * U, y: 110 * U, width: 30 * U, height: 40 * U },
          }
        : e,
    ),
  }));
  const selected = { ...campaign, rooms };
  const owner = new CampaignPlatformOwner(definitions, identity, selected);
  for (let i = 0; i < 10; i++)
    owner.execute({
      kind: "frame",
      input: {
        slots: [
          {
            slot: 0,
            held: {
              left: false,
              right: false,
              jump: false,
              attack: false,
              heavy: false,
              guard: false,
            },
            axes: { moveX: 127 },
            edges: [],
          },
        ],
      },
    });
  owner.execute({ kind: "exit", id: "to-shrine" });
  expect(JSON.parse(owner.checkpoint()).anchorId).toBe("east");
  expect(owner.observation().platform.tick).toBe(2);
  owner.execute({ kind: "checkpoint" });
  const restored = new CampaignPlatformOwner(definitions, identity, selected);
  restored.restoreProgress(owner.progress());
  expect(JSON.parse(restored.checkpoint()).anchorId).toBe("east");
  expect(restored.observation().roomId).toBe("shrine");
});

it("rejects a gated objective pickup until its prerequisite is acquired", () => {
  const campaign: CampaignPlatformDefinition = {
    ...authored,
    rooms: authored.rooms.map((r, i) =>
      i
        ? r
        : {
            ...r,
            pickups: [
              {
                id: "premature",
                area: { x: 20 * U, y: 112 * U, width: 24 * U, height: 32 * U },
                requires: "phase",
                outcome: {
                  id: "vault-chest",
                  operations: [{ kind: "grant", resource: "coins", amount: 1 }],
                },
              },
            ],
          },
    ),
  };
  // Remove the old source: every outcome must have exactly one authored source.
  const selected = {
    ...campaign,
    rooms: campaign.rooms.map((r, i) => (i === 2 ? { ...r, pickups: [] } : r)),
  };
  const owner = new CampaignPlatformOwner(definitions, identity, selected);
  const before = owner.checkpoint();
  expect(() => owner.execute({ kind: "pickup", id: "premature" })).toThrow(
    /gate closed/,
  );
  expect(owner.checkpoint()).toBe(before);
  const invalid = {
    ...selected,
    rooms: selected.rooms.map((r, i) =>
      i
        ? r
        : {
            ...r,
            pickups: r.pickups.map((p) => ({ ...p, requires: "unknown" })),
          },
    ),
  };
  expect(
    () => new CampaignPlatformOwner(definitions, identity, invalid),
  ).toThrow(/gate flag/);
});

it("rejects hostile portable objects without running getters or changing authority", () => {
  const content = {
    definitions: {
      ...definitions,
      archetypes: definitions.archetypes.map((a) => ({
        ...a,
        speed: Math.max(1, a.speed),
      })),
    },
    campaign: anchored(),
    identity,
  };
  const owner = createPortableCampaignPlatformOwner(content);
  const before = owner.checkpoint();
  let invoked = false;
  const hostile = Object.defineProperty({ ...content }, "provenance", {
    enumerable: true,
    get() {
      invoked = true;
      return {};
    },
  });
  expect(() => createPortableCampaignPlatformOwner(hostile)).toThrow(
    /accessor/,
  );
  expect(invoked).toBe(false);
  const bytes = serializePlatformWorldSave(content, owner);
  const unknown = JSON.parse(bytes);
  unknown.extra = true;
  expect(() => restorePlatformWorldSave(JSON.stringify(unknown))).toThrow(
    /field/,
  );
  const wrongCodec = JSON.parse(bytes);
  wrongCodec.content.campaign.inputCodec = "platform-input-v99";
  expect(() => restorePlatformWorldSave(JSON.stringify(wrongCodec))).toThrow(
    /codec/,
  );
  expect(() =>
    restorePlatformWorldSave(
      '{"format":"platform-world-save-v1","kind":"progress","content":null,"state":"' +
        "x".repeat(2 * 1024 * 1024) +
        '"}',
    ),
  ).toThrow(/limit|cap|large|byte/i);
  expect(owner.checkpoint()).toBe(before);
});

it("fresh ingress requires new action edges and legacy campaign rejects selected drop", () => {
  const owner = new CampaignPlatformOwner(definitions, identity, anchored());
  const before = owner.checkpoint();
  const held = {
    left: false,
    right: false,
    jump: true,
    attack: false,
    heavy: false,
    guard: false,
  };
  expect(() =>
    owner.execute({
      kind: "frame",
      input: { slots: [{ slot: 0, held, axes: { moveX: 0 }, edges: [] }] },
    }),
  ).toThrow(/transitions/);
  expect(owner.checkpoint()).toBe(before);
  expect(() =>
    owner.execute({
      kind: "frame",
      input: {
        slots: [
          {
            slot: 0,
            held: { ...held, jump: false, drop: true },
            axes: { moveX: 0 },
            edges: [{ action: "drop", kind: "pressed" }],
          },
        ],
      },
    }),
  ).toThrow();
  expect(owner.checkpoint()).toBe(before);
});

it("requires named ingress to settle safely on support and rejects zero settle", () => {
  const campaign = anchored();
  for (const [x, y, settleTicks] of [
    [80 * U, 100 * U, 1],
    [304 * U, 144 * U, 1],
    [80 * U, 144 * U, 0],
  ]) {
    const rooms = campaign.rooms.map((r, i) =>
      i
        ? r
        : {
            ...r,
            anchors: r.anchors!.map((a) => ({ ...a, x, y, settleTicks })),
          },
    );
    expect(
      () =>
        new CampaignPlatformOwner(definitions, identity, {
          ...campaign,
          rooms,
        }),
    ).toThrow(/Unsafe ingress|integer/);
  }
});

it("counts canonical checkpoint/progress and embedded string bytes exactly through compaction and restore", () => {
  const validDefinitions = {
    ...definitions,
    manifest: {
      ...definitions.manifest,
      title: 'Courrier é 😀 "quoted" \\ path',
    },
    archetypes: definitions.archetypes.map((a) => ({
      ...a,
      speed: Math.max(1, a.speed),
    })),
  };
  const content = {
    definitions: validDefinitions,
    campaign: anchored(),
    identity,
    provenance: { author: 'é😀"\\', nested: ["日本語"] },
  };
  const owner = createPortableCampaignPlatformOwner(content);
  const utf8 = (s: string) => new TextEncoder().encode(s).byteLength;
  const check = (candidate: CampaignPlatformOwner) => {
    const sizes = candidate.persistenceByteSizes();
    for (const kind of ["checkpoint", "progress"] as const) {
      const bytes =
        kind === "checkpoint" ? candidate.checkpoint() : candidate.progress();
      expect(sizes[kind].bytes).toBe(utf8(bytes));
      expect(sizes[kind].quotedBytes).toBe(utf8(JSON.stringify(bytes)));
      const wrapper = serializePlatformWorldSave(content, candidate, kind);
      const blank = JSON.stringify({
        format: "platform-world-save-v1",
        kind,
        content,
        state: "",
      });
      expect(utf8(wrapper)).toBe(utf8(blank) - 2 + sizes[kind].quotedBytes);
    }
  };
  check(owner);
  for (let tick = 0; tick < 4100; tick++) {
    owner.execute({ kind: "frame", input: { slots: [] } });
    if ([0, 99, 4094, 4095, 4099].includes(tick)) check(owner);
  }
  const restored = createPortableCampaignPlatformOwner(content);
  restored.restore(owner.checkpoint());
  check(restored);
  expect(restored.checkpoint()).toBe(owner.checkpoint());
  restored.restoreProgress(owner.progress());
  check(restored);
  for (
    let tick = 0;
    tick < 200 && restored.observation().platform.status === "playing";
    tick++
  )
    restored.execute({
      kind: "frame",
      input: {
        slots: [
          {
            slot: 0,
            held: {
              left: false,
              right: false,
              jump: false,
              attack: false,
              heavy: false,
              guard: false,
            },
            axes: { moveX: 127 },
            edges: [],
          },
        ],
      },
    });
  expect(restored.observation().platform.status).toBe("lost");
  check(restored);
  restored.execute({ kind: "recover" });
  check(restored);
  restored.execute({ kind: "reset" });
  check(restored);
});

it("rejects a real near-limit aggregate progress transition and keeps the previous exact save", () => {
  const campaign = anchored();
  const rooms = campaign.rooms.map((r, i) =>
    i === 0
      ? {
          ...r,
          pickups: [
            {
              id: "near-cap",
              area: { x: 70 * U, y: 112 * U, width: 16 * U, height: 32 * U },
              outcome: {
                id: "phase-shrine",
                operations: [
                  { kind: "flag" as const, flag: "phase", value: true },
                ],
              },
            },
          ],
        }
      : i === 1
        ? { ...r, pickups: [] }
        : r,
  );
  const extra = Array.from({ length: 10 }, (_, index) => ({
    ...definitions.levels[0],
    id: `padding-${index}`,
    spawns: [],
    rectangles: Array.from({ length: 1024 }, (_, i) => ({
      id: "r" + "x".repeat(122) + String(i).padStart(4, "0"),
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      oneWay: false,
    })),
  }));
  const expanded = {
    ...definitions,
    manifest: {
      ...definitions.manifest,
      levelIds: [...definitions.manifest.levelIds, ...extra.map((l) => l.id)],
    },
    levels: [...definitions.levels, ...extra],
    archetypes: definitions.archetypes.map((a) => ({
      ...a,
      speed: Math.max(1, a.speed),
    })),
  };
  const content = {
    definitions: expanded,
    campaign: { ...campaign, rooms },
    identity,
    provenance: { padding: "" },
  };
  const owner = new CampaignPlatformOwner(expanded, identity, content.campaign);
  const actual = (s: string) => new TextEncoder().encode(s).byteLength;
  const initial = actual(
    serializePlatformWorldSave(content, owner, "progress"),
  );
  const padding = PLATFORM_WORLD_SAVE_LIMITS.progress - initial - 16;
  expect(padding).toBeGreaterThan(0);
  expect(padding).toBeLessThan(250000);
  content.provenance.padding = "x".repeat(padding);
  attachPlatformWorldSaveGuard(content, owner);
  expect(actual(serializePlatformWorldSave(content, owner, "progress"))).toBe(
    PLATFORM_WORLD_SAVE_LIMITS.progress - 16,
  );
  const before = owner.checkpoint();
  const sizes = owner.persistenceByteSizes();
  expect(() => owner.execute({ kind: "pickup", id: "near-cap" })).toThrow(
    /combined save byte cap/,
  );
  expect(owner.checkpoint()).toBe(before);
  expect(owner.persistenceByteSizes()).toEqual(sizes);
}, 20000);

it("rejects binding different production definitions under the same declared identity", () => {
  const expanded = {
    ...definitions,
    archetypes: definitions.archetypes.map((a) => ({
      ...a,
      speed: Math.max(1, a.speed),
    })),
  };
  const owner = new CampaignPlatformOwner(expanded, identity, anchored());
  const changed = {
    ...expanded,
    manifest: { ...expanded.manifest, title: "Different realized bytes" },
  };
  expect(() =>
    attachPlatformWorldSaveGuard(
      { definitions: changed, campaign: anchored(), identity },
      owner,
    ),
  ).toThrow(/content mismatch/);
});

it("rejects compact inner codec downgrade and upgrade atomically under the same content identity", () => {
  for (const selected of [false, true]) {
    const authored = anchored();
    const otherAuthored = anchored();
    if (selected) Object.assign(authored, { inputCodec: "platform-input-v2" });
    else Object.assign(otherAuthored, { inputCodec: "platform-input-v2" });
    const owner = new CampaignPlatformOwner(definitions, identity, authored),
      other = new CampaignPlatformOwner(definitions, identity, otherAuthored);
    owner.restoreProgress(owner.progress());
    other.restoreProgress(other.progress());
    const before = owner.checkpoint(),
      foreign = JSON.parse(other.checkpoint()),
      tampered = JSON.parse(before);
    tampered.platform = foreign.platform;
    tampered.base.platform = foreign.platform;
    expect(() => owner.restore(JSON.stringify(tampered))).toThrow(
      "Compact platform input codec mismatch",
    );
    expect(owner.checkpoint()).toBe(before);
  }
});
