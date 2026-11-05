import { it, expect } from "vitest";
import { createWorld, step, cancelFrame } from "./index";
import { launchPlatformSpring } from "./platform-spring";
import {
  CAMPAIGN_PLATFORM_FIXTURE_DEFINITIONS as definitions,
  CAMPAIGN_PLATFORM_FIXTURE_IDENTITY as identity,
} from "./campaign-platform-fixture";
it("launches grounded actors through the existing motor and rejects repeated aerial impulses", () => {
  const world = createWorld(definitions, identity);
  for (let i = 0; i < 3; i++) step(world, cancelFrame(world.decoder));
  const a = world.actors[0]!;
  expect(a.grounded).toBe(true);
  expect(launchPlatformSpring(world, a.id, 2816)).toBe(true);
  expect(launchPlatformSpring(world, a.id, 2816)).toBe(false);
  const y = a.y;
  step(world, cancelFrame(world.decoder));
  expect(a.y).toBeLessThan(y);
  expect(() => launchPlatformSpring(world, a.id, 99999)).toThrow();
});
