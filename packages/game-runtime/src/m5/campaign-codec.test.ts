import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ADVENTURE_FIXTURE as defs } from "../../../../examples/game-m3/project";
import {
  createAdventure,
  serializeCampaign,
  applyAdventureCommand,
  prepareAdventureTransition,
  commitAdventureTransition,
} from "../../../game-simulation/src/m3/adventure";
import {
  prepareCampaignRecovery,
  makeBackup,
  encodeBackup,
  entryFor,
  encodeBase64,
  BACKUP_BYTES,
  CAMPAIGN_BYTES,
  inputBytes,
} from "./campaign-codec";
import { sha256 } from "./hash";
const minimal = readFileSync(
  "tests/game/fixtures/m5-campaign/minimal-v1.json",
  "utf8",
);
const rewarded = readFileSync(
  "tests/game/fixtures/m5-campaign/reward-return-v1.json",
  "utf8",
);
const json = (source: string) => JSON.parse(source);
describe("M5 finite campaign recovery codec", () => {
  it("matches Node base64 for padding, all byte values and deterministic random inputs", () => {
    let seed = 0x12345678;
    for (const length of [
      ...Array.from({ length: 258 }, (_, i) => i),
      1024,
      1048576,
    ]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        bytes[i] = length === 256 ? i : seed & 255;
      }
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
    expect(() => encodeBase64(new Uint8Array(CAMPAIGN_BYTES + 1))).toThrow(
      /LIMIT/,
    );
  });
  it("has portable exact-byte SHA256 vectors and bounded hash input", () => {
    for (const source of ["", "abc", "unicode 💡", "x".repeat(1048576)]) {
      const bytes = new TextEncoder().encode(source);
      expect(sha256(bytes)).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
    expect(() => sha256(new Uint8Array(8 * 1048576 + 1))).toThrow(
      /limit|exceeds/,
    );
  });
  it("wraps unchanged original v1 bytes, preserves every durable field and authored entrance, and current validation has no effects", () => {
    for (const source of [minimal, rewarded]) {
      const legacy = prepareCampaignRecovery(defs, source);
      expect(legacy.original).toBe(source);
      expect(legacy.state.campaign).toEqual(json(source).campaign);
      const container = encodeBackup(
        makeBackup(defs, legacy.payload, minimal, source, 7),
      );
      const current = prepareCampaignRecovery(defs, container);
      expect(current.migrated).toBe(false);
      expect(current.payload).toBe(source);
      expect(current.state.active.entranceId).toBe(
        json(source).campaign.checkpoint.entranceId,
      );
      expect(
        encodeBackup(makeBackup(defs, current.payload, minimal, source, 7)),
      ).toBe(container);
    }
  });
  it("accepts the declared synthetic near-cap bounded corpus without weakening individual campaign caps", () => {
    const synthetic = json(
      readFileSync(
        "tests/game/fixtures/m5-campaign/synthetic-near-cap-definitions.json",
        "utf8",
      ),
    );
    const source = readFileSync(
      "tests/game/fixtures/m5-campaign/synthetic-near-cap-v1.json",
      "utf8",
    );
    expect(source.length).toBeGreaterThan(900000);
    expect(source.length).toBeLessThan(CAMPAIGN_BYTES);
    const container = encodeBackup(
      makeBackup(synthetic, source, source, source),
    );
    expect(container.length).toBeLessThan(BACKUP_BYTES);
    expect(prepareCampaignRecovery(synthetic, container).payload).toBe(source);
    expect(() => entryFor("x".repeat(CAMPAIGN_BYTES + 1))).toThrow(/LIMIT/);
    expect(() => inputBytes("x".repeat(BACKUP_BYTES + 1))).toThrow(/LIMIT/);
  });
  it("rejects unsupported version, exact data, wrong identities and every missing authored reference without altering input", () => {
    const original = json(rewarded);
    const mutations = [
      (v: any) => (v.version = 99),
      (v: any) => (v.kind = "adventure-exact"),
      (v: any) => (v.compatibilityVersion = 2),
      (v: any) => (v.campaign.gameId = "another-game"),
      (v: any) => (v.campaign.characterId = "another-character"),
      (v: any) => (v.campaign.checkpoint.mapId = "missing"),
      (v: any) => (v.campaign.checkpoint.entranceId = "missing"),
      (v: any) => (v.campaign.inventory[0].itemId = "missing"),
      (v: any) => (v.campaign.quests.missing = "complete"),
      (v: any) => (v.campaign.removedPickups[0].placementId = "missing"),
      (v: any) => (v.campaign.sequence = Number.MAX_SAFE_INTEGER + 1),
      (v: any) => (v.campaign.checkpoint.mapId = null),
      (v: any) => (v.campaign.extra = true),
      (v: any) => (v.campaign.inventory[1].instanceId = null),
      (v: any) => (v.campaign.flags["flower-found"] = false),
      (v: any) => (v.campaign.stats.renown = 0),
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(original);
      mutate(candidate);
      expect(() =>
        prepareCampaignRecovery(defs, JSON.stringify(candidate)),
      ).toThrow();
    }
    expect(original).toEqual(json(rewarded));
  });
  it("rejects duplicate decoded keys, negative zero, null, nesting/count/byte overflow and corrupt containers", () => {
    for (const source of [
      "null",
      '{"version":1,"\\u0076ersion":2}',
      "[".repeat(33) + "0" + "]".repeat(33),
      minimal.replace('"revision":0', '"revision":-0'),
      minimal.replace(
        '"tokens":[]',
        `"tokens":${JSON.stringify(Array(2049).fill("same"))}`,
      ),
    ])
      expect(() => prepareCampaignRecovery(defs, source)).toThrow();
    for (const mutate of [
      (v: any) => (v.current.hash = "sha256:" + "0".repeat(64)),
      (v: any) => (v.current.data = "!".repeat(v.current.data.length)),
      (v: any) => v.current.bytes++,
      (v: any) => (v.extra = 1),
      (v: any) => (v.generation = -1),
      (v: any) => (v.gameId = "other"),
      (v: any) => (v.characterId = "other"),
      (v: any) => (v.slot = "other"),
      (v: any) =>
        (v.previous = { ...v.current, hash: "sha256:" + "0".repeat(64) }),
      (v: any) => (v.original = { ...v.current, bytes: CAMPAIGN_BYTES + 1 }),
    ]) {
      const backup = makeBackup(defs, rewarded, minimal, minimal);
      mutate(backup);
      expect(() =>
        prepareCampaignRecovery(defs, JSON.stringify(backup)),
      ).toThrow();
    }
    expect(() =>
      prepareCampaignRecovery(defs, new Uint8Array([0xff, 0xfe])),
    ).toThrow(/UTF8/);
  });
  it("only explicit previous recovery bypasses corrupt current integrity and never accepts corrupt previous", () => {
    const backup = makeBackup(defs, rewarded, minimal);
    backup.current.hash = "sha256:" + "0".repeat(64);
    expect(() => prepareCampaignRecovery(defs, encodeBackup(backup))).toThrow(
      /HASH/,
    );
    expect(
      prepareCampaignRecovery(defs, encodeBackup(backup), "main", "previous")
        .payload,
    ).toBe(minimal);
    backup.current = entryFor("x");
    backup.current.data = "/w==";
    backup.current.bytes = 1;
    expect(
      prepareCampaignRecovery(defs, encodeBackup(backup), "main", "previous")
        .payload,
    ).toBe(minimal);
    backup.previous!.hash = "sha256:" + "0".repeat(64);
    expect(() =>
      prepareCampaignRecovery(defs, encodeBackup(backup), "main", "previous"),
    ).toThrow(/HASH/);
  });
  it("rejects nested backup originals even with BOM or negative zero", () => {
    const nested = encodeBackup(makeBackup(defs, minimal));
    for (const original of [
      "\uFEFF" + nested,
      nested.replace('"generation":0', '"generation":-0'),
    ]) {
      expect(() => makeBackup(defs, minimal, null, original)).toThrow(
        /ORIGINAL/,
      );
      const backup = makeBackup(defs, minimal);
      backup.original = entryFor(original);
      expect(() => prepareCampaignRecovery(defs, encodeBackup(backup))).toThrow(
        /ORIGINAL/,
      );
    }
  });
  it("reports oversized raw campaigns as campaign limits before full JSON parsing", () => {
    const source = minimal + " ".repeat(CAMPAIGN_BYTES);
    expect(() => prepareCampaignRecovery(defs, source)).toThrow(
      /CAMPAIGN_LIMIT/,
    );
    // A malformed suffix would be CAMPAIGN_JSON if the full parser ran first.
    expect(() => prepareCampaignRecovery(defs, source + "!")).toThrow(
      /CAMPAIGN_LIMIT/,
    );
    const escapedKind = source.replace('"kind"', '"\\u006bind"');
    expect(() => prepareCampaignRecovery(defs, escapedKind + "!")).toThrow(
      /CAMPAIGN_LIMIT/,
    );
  });
  it("receipt expiry and repeated recovery cannot replay a completed unique reward", () => {
    let state = prepareCampaignRecovery(defs, rewarded).state;
    for (let i = 0; i < 80; i++) {
      const proposed = prepareAdventureTransition(defs, state, {
        kind: "travel",
        exitId: state.active.mapId === "meadow" ? "to-lodge" : "to-meadow",
        token: `expiry-${i}`,
        revision: state.campaign.revision,
        sequence: state.campaign.sequence + 1,
      });
      if (!proposed.ok) throw Error(proposed.error);
      const committed = commitAdventureTransition(
        defs,
        state,
        proposed.transition,
        proposed.transition.targetMapId,
      );
      if (!committed.ok) throw Error(committed.error);
      state = committed.state;
    }
    expect(state.campaign.tokens).toHaveLength(64);
    expect(state.campaign.tokens).not.toContain("route-reward");
    const source = serializeCampaign(defs, state.campaign);
    const restored = prepareCampaignRecovery(
      defs,
      encodeBackup(makeBackup(defs, source)),
    ).state;
    expect(
      restored.campaign.inventory.filter(
        (i) => i.instanceId === "keeper-medal-unique",
      ),
    ).toHaveLength(1);
    expect(restored.campaign.quests["keeper-errand"]).toBe("complete");
    expect(prepareCampaignRecovery(defs, source).payload).toBe(source);
    const proposed = prepareAdventureTransition(defs, restored, {
      kind: "travel",
      exitId: "to-lodge",
      token: "after-expiry",
      revision: restored.campaign.revision,
      sequence: restored.campaign.sequence + 1,
    });
    if (!proposed.ok) throw Error(proposed.error);
    const committed = commitAdventureTransition(
      defs,
      restored,
      proposed.transition,
      "lodge",
    );
    if (!committed.ok) throw Error(committed.error);
    let atKeeper = committed.state;
    for (let i = 0; i < 2; i++) {
      const moved = applyAdventureCommand(defs, atKeeper, {
        kind: "move",
        direction: "right",
        revision: atKeeper.campaign.revision,
        sequence: atKeeper.campaign.sequence + 1,
      });
      if (!moved.ok) throw Error(moved.error);
      atKeeper = moved.state;
    }
    const prior = serializeCampaign(defs, atKeeper.campaign);
    const repeat = applyAdventureCommand(defs, atKeeper, {
      kind: "dialogue",
      dialogueId: "keeper",
      choiceId: "accept-medal",
      token: "route-reward",
      revision: atKeeper.campaign.revision,
      sequence: atKeeper.campaign.sequence + 1,
    });
    expect(repeat.ok).toBe(false);
    expect(serializeCampaign(defs, repeat.state.campaign)).toBe(prior);
    expect(createAdventure(defs).campaign.inventory).toEqual([]);
  });
});
