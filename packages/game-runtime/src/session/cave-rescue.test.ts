import { describe, it, expect } from "vitest";
import { CaveSession } from "./cave-rescue";
import site from "../../../../examples/game-cave-rescue/site.json";
import type { CaveContent } from "@onepage/game-project/cave-types";
describe("portable cave recovery", () => {
  it("embeds authored content and restores exact live continuation", () => {
    const session = new CaveSession(site as CaveContent, "test-rules");
    for (let i = 0; i < 80; i++)
      session.owner.step({ moveX: 1, drill: true, aim: "right" });
    const bytes = session.export();
    const restored = new CaveSession(site as CaveContent, "test-rules");
    restored.import(bytes);
    for (let i = 0; i < 20; i++) {
      session.owner.step({ moveX: 1, drill: true });
      restored.owner.step({ moveX: 1, drill: true });
    }
    expect(restored.export()).toBe(session.export());
  });
  it("rejects wrong rules and malformed import without replacing authority", () => {
    const s = new CaveSession(site as CaveContent, "test-rules"),
      old = s.owner;
    expect(() => s.import("{")).toThrow();
    expect(() =>
      s.import('{"format":"cave-portable-v1","format":"cave-portable-v1"}'),
    ).toThrow(/Duplicate/);
    const v = JSON.parse(s.export());
    v.rulesBuildId = "other";
    expect(() => s.import(JSON.stringify(v))).toThrow();
    expect(s.owner).toBe(old);
  });
});
