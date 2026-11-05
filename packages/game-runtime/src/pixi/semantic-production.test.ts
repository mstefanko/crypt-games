import { expect, it } from "vitest";
import { SemanticProductionPresenter } from "./semantic-production";

it("clears the previous departure when restoring a checkpoint without presentation", () => {
  // Check restore without creating a renderer or loading an atlas.
  const presenter = Object.create(
    SemanticProductionPresenter.prototype,
  ) as SemanticProductionPresenter;
  presenter.restore({ version: 1, shipPhase: 0.8, lastOutcome: "won" });
  presenter.restore(undefined);
  expect(presenter.snapshot()).toEqual({
    version: 1,
    shipPhase: 0,
    lastOutcome: undefined,
  });
});
