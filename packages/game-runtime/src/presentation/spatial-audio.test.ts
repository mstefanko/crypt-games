import { it, expect } from "vitest";
import { spatialAudio } from "./spatial-audio";
it("walls attenuate and low-pass; mono preserves gain", () => {
  const source = { x: 4.5, y: 1.5 },
    listener = { x: 0.5, y: 1.5 },
    grid = { width: 6, height: 3, walls: new Set<number>() };
  const open = spatialAudio(source, listener, grid);
  const closed = spatialAudio(source, listener, {
    ...grid,
    walls: new Set([8]),
  });
  expect(closed.gain).toBeLessThan(open.gain);
  expect(closed.cutoff).toBeLessThan(open.cutoff);
  expect(closed.pan).toBeGreaterThan(0);
  expect(spatialAudio(source, listener, grid, 12, true)).toEqual({
    ...open,
    pan: 0,
  });
});
