import { describe, expect, it } from "vitest";
import { CardRunSession } from "./card-run";
import { luckyContent } from "../../../apps/audio-arcade/src/games/lucky/content";

function play(session: CardRunSession): void {
  session.toggle(session.cards[0].id);
  session.play();
}

describe("CardRunSession authority", () => {
  it("detaches state, card, definition, preview and checkpoint observations", () => {
    const definition = structuredClone(luckyContent);
    const session = new CardRunSession(definition, 12);
    const initial = session.snapshot();
    definition.targets = [1];
    (session.state as any).zones.hand.length = 0;
    (session.state as any).deck[0].rank = 2;
    (session.cards as any)[0].rank = 2;
    (session.definition as any).modifiers[0].value = 999;
    (initial as any).state.money = 999;
    expect(session.state.money).toBe(8);
    expect(session.cards).toHaveLength(8);
    expect(session.definition.targets[0]).toBe(luckyContent.targets[0]);
    session.toggle(session.cards[0].id);
    const preview = session.preview()!;
    (preview as any).score = 999999;
    session.play();
    expect(session.state.lastResult?.score).not.toBe(999999);
    const result = session.state.lastResult as any;
    result.trace[0].after = 999;
    expect(session.state.lastResult?.trace[0].after).not.toBe(999);
  });

  it("accepts validated legacy Lucky saves and upgrades their identity", () => {
    const session = new CardRunSession(luckyContent, 12);
    play(session);
    const saved = session.snapshot() as any;
    const resumed = new CardRunSession(luckyContent, 12);
    resumed.restore({ state: saved.state, random: saved.random });
    expect(resumed.snapshot()).toEqual(saved);
    expect(() =>
      new CardRunSession(luckyContent, 13).restore({
        state: saved.state,
        random: saved.random,
      }),
    ).toThrow();
  });

  it("rejects malformed state and RNG atomically", () => {
    const session = new CardRunSession(luckyContent, 12);
    play(session);
    const before = session.snapshot();
    const corruptions = [
      (s: any) => {
        s.state.money = NaN;
      },
      (s: any) => {
        s.state.zones.hand.push(s.state.zones.draw[0]);
      },
      (s: any) => {
        s.state.selected = ["missing"];
      },
      (s: any) => {
        s.state.modifiers[0].definitionId = "missing";
      },
      (s: any) => {
        s.state.lastResult.trace[0].after = Infinity;
      },
      (s: any) => {
        s.state.postRevealPhase = "won";
      },
      (s: any) => {
        s.random.streams[0].state ^= 1;
      },
      (s: any) => {
        s.seed++;
      },
      (s: any) => {
        s.identity = "different content";
      },
    ];
    for (const corrupt of corruptions) {
      const candidate = structuredClone(before);
      corrupt(candidate);
      expect(() => session.restore(candidate)).toThrow();
      expect(session.snapshot()).toEqual(before);
    }
  });

  it("replays reveal, purchases, rerolls and the next blind from a valid checkpoint", () => {
    const definition = structuredClone(luckyContent);
    definition.targets = [1, 1];
    const session = new CardRunSession(definition, 29);
    play(session);
    const checkpoint = session.snapshot();
    const resumed = new CardRunSession(definition, 29);
    resumed.restore(checkpoint);
    (checkpoint as any).state.money = 999;
    for (const owner of [session, resumed]) {
      owner.advanceReveal(0, true);
      expect(owner.state.phase).toBe("shop");
      owner.restore(owner.snapshot());
      owner.buy(owner.state.offers[0]);
      owner.reroll();
      owner.next();
      owner.discard();
      play(owner);
      owner.advanceReveal(0, true);
    }
    expect(resumed.snapshot()).toEqual(session.snapshot());
    expect(session.state.phase).toBe("won");
  });
});
