/** Single consumer: card-run. Stable instances and atomic, unique zone membership. */
export type CardSuit = "hearts" | "diamonds" | "clubs" | "spades";
export interface PlayingCard {
  id: string;
  rank: number;
  suit: CardSuit;
  enhancement?: "chips" | "mult";
  edition?: "foil";
  seal?: string;
}
export interface CardZones {
  draw: string[];
  hand: string[];
  discard: string[];
  played: string[];
}
export function standardDeck(): PlayingCard[] {
  return (["hearts", "diamonds", "clubs", "spades"] as CardSuit[]).flatMap(
    (suit, s) =>
      Array.from({ length: 13 }, (_, i) => ({
        id: `card-${s * 13 + i}`,
        rank: i + 2,
        suit,
      })),
  );
}
export function shuffleCards<T>(
  cards: readonly T[],
  draw: (max: number) => number,
): T[] {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i--) {
    const j = draw(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function transferCards(
  zones: CardZones,
  from: keyof CardZones,
  to: keyof CardZones,
  ids: readonly string[],
): CardZones {
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !zones[from].includes(id) || zones[to].includes(id))
  )
    throw Error("Invalid card transfer");
  const next = structuredClone(zones);
  next[from] = next[from].filter((id) => !ids.includes(id));
  next[to].push(...ids);
  return next;
}
