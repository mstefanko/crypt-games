import { it, expect } from "vitest";
import { planExclusiveChokes } from "./expressive-soundfont";
import type { CompiledExpressiveNote } from "@onepage/music-core/expressive-performance";
const n = (
  id: string,
  start: number,
  partId = "drums",
  bindingId = "standard",
): CompiledExpressiveNote => ({
  id,
  partId,
  bindingId,
  startTick: Math.round(start * 960),
  keyReleaseTick: Math.round((start + 0.05) * 960),
  endTick: Math.round((start + 0.05) * 960),
  startSeconds: start,
  keyReleaseSeconds: start + 0.05,
  endSeconds: start + 0.05,
  pitch: 46,
  velocity: 1,
  priority: 128,
  optional: false,
});
it("plans exclusive releases by part/class, including old release tails across patches", () => {
  const notes = [
      n("released", 0),
      n("other-part", 0.1, "other"),
      n("other-preset", 0.2, "drums", "room"),
    ],
    p = planExclusiveChokes(notes, () => [0, 1, 1], 48000);
  expect(p.get("released")).toEqual([{ frame: 9600, classes: [1] }]);
  expect(p.get("other-part")).toEqual([]);
  expect(p.get("other-preset")).toEqual([]);
});
it("simultaneous quantized-frame notes do not choke one another and each voice class has its own next onset", () => {
  const notes = [n("a", 0), n("b", 0.000001), n("c", 0.2), n("d", 0.3)],
    p = planExclusiveChokes(
      notes,
      (n) => (n.id === "a" ? [1, 2] : n.id === "b" || n.id === "c" ? [1] : [2]),
      48000,
    );
  expect(p.get("a")).toEqual([
    { frame: 9600, classes: [1] },
    { frame: 14400, classes: [2] },
  ]);
  expect(p.get("b")).toEqual([{ frame: 9600, classes: [1] }]);
});
