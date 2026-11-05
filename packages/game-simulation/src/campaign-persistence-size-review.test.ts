import { describe, expect, it } from "vitest";
import { canonical } from "@onepage/game-project/runtime";
import {
  CampaignPlatformOwner,
  campaignJSONByteSize,
  CAMPAIGN_PLATFORM_LIMITS,
} from "./campaign-platform";
import {
  CAMPAIGN_PLATFORM_FIXTURE as campaign,
  CAMPAIGN_PLATFORM_FIXTURE_DEFINITIONS as definitions,
  CAMPAIGN_PLATFORM_FIXTURE_IDENTITY as identity,
} from "./campaign-platform-fixture";
import { neutralHeld } from "./input";
const utf8 = (value: string) => new TextEncoder().encode(value).length;
function assertExact(owner: CampaignPlatformOwner) {
  const sizes = owner.persistenceByteSizes();
  for (const kind of ["checkpoint", "progress"] as const) {
    const bytes = kind === "checkpoint" ? owner.checkpoint() : owner.progress();
    expect(sizes[kind]).toEqual({
      bytes: utf8(bytes),
      quotedBytes: utf8(JSON.stringify(bytes)),
    });
  }
  return sizes;
}
describe("independent campaign persistence size review", () => {
  it("matches actual UTF-8 and string-quoted JSON for escaping, Unicode and lone surrogates", () => {
    const atoms = [
      "",
      '"',
      "\\",
      "\n\t\r\u0000",
      "é",
      "💌",
      "\ud800",
      "\udfff",
      "\u2028\u2029",
    ];
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      -123,
      Number.MAX_SAFE_INTEGER,
      {},
      [],
    ];
    for (const a of atoms)
      for (const b of atoms) values.push({ [a]: [a, b, { text: a + b }] });
    for (const value of values) {
      const json = canonical(value);
      expect(campaignJSONByteSize(value)).toEqual({
        bytes: utf8(json),
        quotedBytes: utf8(JSON.stringify(json)),
      });
    }
  });
  it("keeps exact cached sizes across rejected compaction, successful compaction and restores", () => {
    const owner = new CampaignPlatformOwner(definitions, identity, campaign);
    assertExact(owner);
    for (let n = 0; n < 4095; n++)
      owner.execute({ kind: "frame", input: { slots: [] } });
    const before = owner.checkpoint(),
      sizes = assertExact(owner);
    expect(JSON.parse(before).history).toHaveLength(4095);
    let reject = true;
    // During an ordinary guarded frame candidate===owner; use the staged count
    // to reject precisely the publication which would compact its retained tail.
    owner.setPersistenceGuard((candidate) => {
      assertExact(candidate);
      if (
        reject &&
        JSON.parse(candidate.checkpoint()).history.length === 0 &&
        candidate.checkpoint() !== before
      )
        throw Error("review-size-rejection");
    });
    expect(() =>
      owner.execute({ kind: "frame", input: { slots: [] } }),
    ).toThrow(/review-size/);
    expect(owner.checkpoint()).toBe(before);
    expect(assertExact(owner)).toEqual(sizes);
    reject = false;
    owner.execute({ kind: "frame", input: { slots: [] } });
    expect(JSON.parse(owner.checkpoint()).history).toHaveLength(0);
    assertExact(owner);
    const copied = new CampaignPlatformOwner(definitions, identity, campaign);
    copied.restore(owner.checkpoint());
    assertExact(copied);
    expect(copied.checkpoint()).toBe(owner.checkpoint());
    owner.execute({ kind: "frame", input: { slots: [] } });
    assertExact(owner);
    owner.restoreProgress(copied.progress());
    assertExact(owner);
    owner.execute({ kind: "reset" });
    assertExact(owner);
  });
  it("keeps exact sizes when the byte cap compacts before the command cap", () => {
    const owner = new CampaignPlatformOwner(definitions, identity, campaign);
    const command = {
      kind: "frame" as const,
      input: {
        slots: Array.from({ length: 4 }, (_, slot) => ({
          slot,
          held: neutralHeld(),
          axes: { moveX: 0 },
          edges: [],
        })),
      },
    };
    const frameBytes = utf8(canonical(command)),
      count = Math.ceil(CAMPAIGN_PLATFORM_LIMITS.historyBytes / frameBytes);
    expect(count).toBeLessThan(CAMPAIGN_PLATFORM_LIMITS.commands);
    for (let n = 0; n < count - 1; n++) owner.execute(command);
    expect(JSON.parse(owner.checkpoint()).history).toHaveLength(count - 1);
    assertExact(owner);
    owner.execute(command);
    expect(JSON.parse(owner.checkpoint()).history).toHaveLength(0);
    assertExact(owner);
    owner.execute(command);
    assertExact(owner);
  });
  it("rejects exact and durable imports before adopting cached counters or authority", () => {
    const owner = new CampaignPlatformOwner(definitions, identity, campaign),
      next = new CampaignPlatformOwner(definitions, identity, campaign);
    next.executeFrames({ slots: [] }, 3);
    const before = owner.checkpoint(),
      sizes = assertExact(owner);
    owner.setPersistenceGuard((candidate) => {
      assertExact(candidate);
      if (candidate !== owner) throw Error("review-import-rejection");
    });
    expect(() => owner.restore(next.checkpoint())).toThrow(/review-import/);
    expect(owner.checkpoint()).toBe(before);
    expect(assertExact(owner)).toEqual(sizes);
    expect(() => owner.restoreProgress(next.progress())).toThrow(
      /review-import/,
    );
    expect(owner.checkpoint()).toBe(before);
    expect(assertExact(owner)).toEqual(sizes);
    owner.setPersistenceGuard(assertExact);
    owner.restore(next.checkpoint());
    assertExact(owner);
    owner.restoreProgress(next.progress());
    assertExact(owner);
  });
  it("rolls byte counters back with an atomic multi-frame rejection", () => {
    const owner = new CampaignPlatformOwner(definitions, identity, campaign);
    const before = owner.checkpoint(),
      sizes = assertExact(owner),
      limit = owner.observation().platform.tick + 2;
    owner.setPersistenceGuard((candidate) => {
      assertExact(candidate);
      if (candidate.observation().platform.tick >= limit)
        throw Error("review-batch-rejection");
    });
    expect(() => owner.executeFrames({ slots: [] }, 3)).toThrow(/review-batch/);
    expect(owner.checkpoint()).toBe(before);
    expect(assertExact(owner)).toEqual(sizes);
  });
});
