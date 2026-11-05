import { describe, expect, it } from "vitest";
import { createStarter } from "@onepage/project";
import { scoreToExpressiveDocument } from "./expressive-performance";
import {
  createExpressiveProjectResource,
  serializeExpressiveProjectResource,
  parseExpressiveProjectResource,
  projectExpressiveResourceToScore,
} from "./expressive-project";
describe("expressive project resource", () => {
  it("round trips complete expression and rejects malformed payloads", () => {
    const document = scoreToExpressiveDocument(createStarter());
    document.controls.push({
      id: "bend",
      partId: document.parts[0]!.id,
      parameter: "pitchCents",
      timeSeconds: 0.1,
      value: 100,
      rampSeconds: 0.4,
    });
    const resource = createExpressiveProjectResource(
      document,
      "Retained expressive cue",
    );
    expect(
      parseExpressiveProjectResource(
        serializeExpressiveProjectResource(resource),
      ),
    ).toEqual(resource);
    expect(() =>
      parseExpressiveProjectResource(
        JSON.stringify({ ...resource, document: { ...document, ppq: 0 } }),
      ),
    ).toThrow();
    expect(() =>
      parseExpressiveProjectResource(
        JSON.stringify({ ...resource, surprise: true }),
      ),
    ).toThrow();
  });
  it("requires explicit projection, reports losses and never mutates source", () => {
    const resource = createExpressiveProjectResource(
      scoreToExpressiveDocument(createStarter()),
    );
    const before = serializeExpressiveProjectResource(resource);
    const { score, losses } = projectExpressiveResourceToScore(resource);
    expect(score.id).not.toBe(resource.id);
    expect(losses.length).toBeGreaterThan(0);
    score.patterns[0]!.notes.length = 0;
    expect(serializeExpressiveProjectResource(resource)).toBe(before);
  });
});
