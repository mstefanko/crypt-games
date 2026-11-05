import { expect, it } from "vitest";
import { layoutSpriteAtlas } from "./sprite-atlas";
it("preserves mixed terrain/character sizes and wraps without overlap", () => {
  const atlas = layoutSpriteAtlas(
    [
      { id: "tile", width: 18, height: 18 },
      { id: "actor", width: 24, height: 24 },
    ],
    32,
  );
  expect(atlas.frames[1]).toMatchObject({ x: 0, y: 19, width: 24, height: 24 });
  expect(atlas.height).toBe(43);
  expect(() =>
    layoutSpriteAtlas([{ id: "x", width: 33, height: 1 }], 32),
  ).toThrow();
});

import { editedClipPhase, spriteDirectionCount } from "./sprite-atlas";
it("retimes edited contact markers against authoritative action phases with legacy defaults", () => {
  expect(editedClipPhase("active", 0, { contact: 0.2, activeEnd: 0.7 })).toBe(
    0.2,
  );
  expect(editedClipPhase("recover", 0, { contact: 0.2, activeEnd: 0.7 })).toBe(
    0.7,
  );
  expect(editedClipPhase("tell", 1)).toBe(0.35);
  expect(spriteDirectionCount({}, "hero")).toBe(8);
  expect(
    spriteDirectionCount({ roles: { hero: { directionCount: 16 } } }, "hero"),
  ).toBe(16);
});
