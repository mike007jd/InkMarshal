type RequiredDeckType = 'character' | 'world' | 'outline';
export type DeckCounts = Record<RequiredDeckType, number>;

export const EMPTY_DECK_COUNTS: DeckCounts = {
  character: 0,
  world: 0,
  outline: 0,
};
