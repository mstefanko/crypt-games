import type { PlayingCard } from "./card-zones";
export type PokerCategory =
  | "high-card"
  | "pair"
  | "two-pair"
  | "three-kind"
  | "straight"
  | "flush"
  | "full-house"
  | "four-kind"
  | "straight-flush";
export interface PokerHand {
  category: PokerCategory;
  contributing: string[];
  tieBreak: number[];
}
/** Strongest supported ordinary poker category, including duplicated deck instances. */
export function classifyPoker(cards: readonly PlayingCard[]): PokerHand {
  if (
    cards.length < 1 ||
    cards.length > 5 ||
    new Set(cards.map((c) => c.id)).size !== cards.length
  )
    throw Error("Choose one to five unique cards");
  const groups = new Map<number, PlayingCard[]>();
  for (const c of cards) groups.set(c.rank, [...(groups.get(c.rank) ?? []), c]);
  const sorted = [...groups].sort(
    (a, b) => b[1].length - a[1].length || b[0] - a[0],
  );
  const ranks = [...groups.keys()].sort((a, b) => b - a);
  const straight =
    cards.length === 5 &&
    ranks.length === 5 &&
    (ranks[0] - ranks[4] === 4 || ranks.join(",") === "14,5,4,3,2");
  const flush =
    cards.length === 5 && cards.every((c) => c.suit === cards[0].suit);
  const highStraight = ranks.join(",") === "14,5,4,3,2" ? 5 : ranks[0];
  let category: PokerCategory = "high-card",
    contributing: PlayingCard[] = [...cards]
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 1),
    tieBreak = ranks;
  if (straight && flush) {
    category = "straight-flush";
    contributing = [...cards];
    tieBreak = [highStraight];
  } else if (sorted[0][1].length >= 4) {
    category = "four-kind";
    contributing = sorted[0][1].slice(0, 4);
    tieBreak = sorted.map((x) => x[0]);
  } else if (sorted[0][1].length === 3 && sorted[1]?.[1].length === 2) {
    category = "full-house";
    contributing = [...cards];
    tieBreak = sorted.map((x) => x[0]);
  } else if (flush) {
    category = "flush";
    contributing = [...cards];
  } else if (straight) {
    category = "straight";
    contributing = [...cards];
    tieBreak = [highStraight];
  } else if (sorted[0][1].length >= 3) {
    category = "three-kind";
    contributing = sorted[0][1].slice(0, 3);
    tieBreak = sorted.map((x) => x[0]);
  } else if (sorted[0][1].length === 2 && sorted[1]?.[1].length === 2) {
    category = "two-pair";
    contributing = [...sorted[0][1], ...sorted[1][1]];
    tieBreak = sorted.map((x) => x[0]);
  } else if (sorted[0][1].length === 2) {
    category = "pair";
    contributing = sorted[0][1];
    tieBreak = sorted.map((x) => x[0]);
  }
  return {
    category,
    contributing: cards
      .filter((c) => contributing.includes(c))
      .map((c) => c.id),
    tieBreak,
  };
}
