import { expect, it } from "vitest";
import {
  UNDERWORLD_PROJECTION,
  projectWithRecipe,
  unprojectWithRecipe,
} from "./isometric";
it("uses the same calibrated ground transform for bake placement and pointer inverse", () => {
  const point = projectWithRecipe(8.25, 12.5);
  expect(unprojectWithRecipe(point.x, point.y)).toEqual({ x: 8.25, y: 12.5 });
  expect(
    Math.sin((UNDERWORLD_PROJECTION.cameraElevationDegrees * Math.PI) / 180),
  ).toBeCloseTo(0.6);
});
