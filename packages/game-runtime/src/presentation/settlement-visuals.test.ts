import { expect, it } from "vitest";
import { settlementCitizenVisual } from "./settlement-visuals";
it("keeps moving cold residents in locomotion, and binds observed route/cargo phases", () => {
  const person = {
    queue: [{ kind: "move" as const, target: 4, request: 3 }],
    cargo: { logs: 1 },
    cold: 50,
  };
  expect(settlementCitizenVisual(person)).toEqual({
    mode: "carry",
    phase: "move",
    loaded: true,
    route: "searching",
  });
  expect(settlementCitizenVisual({ ...person, cargo: {} }).mode).toBe("walk");
  expect(settlementCitizenVisual({ ...person, queue: [] }).mode).toBe("cold");
  expect(
    settlementCitizenVisual({
      ...person,
      queue: [{ kind: "work", building: "b1", elapsed: 1 }],
    }).mode,
  ).toBe("work");
});
