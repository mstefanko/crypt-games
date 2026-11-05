import { expect, it } from "vitest";
import { NarrativeProtocol } from "./narrative-protocol";
import { NarrativeSession } from "./narrative";
import { tuesdayContent } from "../../../apps/audio-arcade/src/games/tuesday/content";
it("retains command metadata on rejected no-op and rejects sparse event checkpoints atomically", () => {
  const owner = new NarrativeProtocol(tuesdayContent, 743),
    before = owner.snapshot();
  expect(owner.command({ kind: "choose", id: "missing", sequence: 1 })).toBe(
    false,
  );
  expect(owner.snapshot()).toEqual(before);
  expect(owner.command({ kind: "choose", id: "begin", sequence: 1 })).toBe(
    true,
  );
  const saved = owner.snapshot(),
    malformed = structuredClone(saved);
  malformed.events = new Array(1);
  expect(() => owner.restore(malformed)).toThrow();
  expect(owner.snapshot()).toEqual(saved);
});
it("identifies narrative content beyond a reused title", () => {
  const original = new NarrativeSession(tuesdayContent, 743),
    changed = structuredClone(tuesdayContent);
  changed.nodes[0].text += " Different authored content.";
  const other = new NarrativeSession(changed, 743),
    before = other.snapshot();
  expect(() => other.restore(original.snapshot())).toThrow();
  expect(other.snapshot()).toEqual(before);
});

it("reports accepted navigation rescheduling when a repeated queued walk changes owner snapshot", () => {
  const owner = new NarrativeProtocol(tuesdayContent, 743);
  const target = owner.session.scene.hotspots[0];
  expect(
    owner.command({
      kind: "walk",
      cell: target.cell,
      hotspot: target.id,
      sequence: 1,
    }),
  ).toBe(true);
  const before = owner.snapshot();
  expect(
    owner.command({
      kind: "walk",
      cell: target.cell,
      hotspot: target.id,
      sequence: 2,
    }),
  ).toBe(true);
  expect(owner.snapshot()).not.toEqual(before);
  expect(owner.snapshot().sequence).toBe(2);
  const after = owner.snapshot();
  expect(
    owner.command({
      kind: "walk",
      cell: target.cell,
      hotspot: target.id,
      sequence: 2,
    }),
  ).toBe(false);
  expect(owner.snapshot()).toEqual(after);
});

it("rejects malformed legacy pending goals before publishing restored state", () => {
  const owner = new NarrativeSession(tuesdayContent, 743);
  const before = owner.snapshot();
  for (const pendingGoal of [
    -1,
    0.5,
    NaN,
    Infinity,
    owner.scene.width * owner.scene.height,
    "0",
  ]) {
    const legacy = structuredClone(before) as any;
    delete legacy.navigation;
    delete legacy.requestId;
    legacy.state.pendingGoal = pendingGoal;
    expect(() => owner.restore(legacy)).toThrow("Invalid narrative snapshot");
    expect(owner.snapshot()).toEqual(before);
  }
});
