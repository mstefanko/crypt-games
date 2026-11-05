import { expect, it } from "vitest";
import { LuckyProtocol } from "../../../../apps/audio-arcade/src/games/lucky/simulation/session";
import { luckyContent } from "../../../../apps/audio-arcade/src/games/lucky/content";

it("drives full Lucky and a bounded short-table variation through the same protocol", () => {
  for (const definition of [
    luckyContent,
    {
      ...luckyContent,
      title: "Short Table",
      targets: [1, 1, 1],
      startingModifiers: ["short", "steel"],
    },
  ]) {
    const owner = new LuckyProtocol(definition, 12);
    owner.command({
      type: "select",
      id: owner.observe().cards[0].id,
      sequence: 1,
    });
    expect(owner.command({ type: "play", sequence: 1 }).reason).toBe(
      "stale-sequence",
    );
    expect(owner.command({ type: "play", revision: -1 }).reason).toBe(
      "stale-revision",
    );
    expect(owner.command({ type: "play", sequence: 2 }).accepted).toBe(true);
    const committed = owner.observe().state.lastResult;
    const restored = new LuckyProtocol(definition, 12);
    restored.restore(JSON.parse(JSON.stringify(owner.snapshot())));
    for (const protocol of [owner, restored]) {
      protocol.command({ type: "finish-reveal" });
      const after = protocol.snapshot();
      expect(protocol.command({ type: "finish-reveal" }).accepted).toBe(false);
      expect(protocol.snapshot()).toEqual(after);
      expect(protocol.observe().state.lastResult).toEqual(committed);
    }
    expect(restored.snapshot()).toEqual(owner.snapshot());
    expect(owner.drainEvents()).toEqual([]);
  }
});

it("finishes the bounded three-encounter variation without changing owner rules", () => {
  const owner = new LuckyProtocol(
    {
      ...luckyContent,
      title: "Short Table",
      targets: [1, 1, 1],
      startingModifiers: ["short", "steel"],
    },
    12,
  );
  for (let encounter = 0; encounter < 3; encounter++) {
    expect(
      owner.command({ type: "select", id: owner.observe().cards[0].id })
        .accepted,
    ).toBe(true);
    owner.command({ type: "play" });
    owner.command({ type: "finish-reveal" });
    if (encounter < 2) owner.command({ type: "next" });
  }
  expect(owner.observe().state.phase).toBe("won");
});
