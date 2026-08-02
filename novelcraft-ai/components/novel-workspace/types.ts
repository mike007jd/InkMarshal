type RequiredDeckType = 'character' | 'world' | 'outline';
export type DeckCounts = Record<RequiredDeckType, number>;

/**
 * Lifecycle of the deterministic Story Deck repair turn:
 * - `idle`: no repair requested (or the last one settled successfully).
 * - `queued`: the user asked for a repair; ChatArea has not consumed the
 *   request yet (chat busy, history loading, or model selection pending).
 * - `running`: ChatArea sent the repairStoryDeck turn; it is in flight.
 * - `failed`: the repair turn errored. The next activation retries.
 */
export type StoryDeckRepairPhase = 'idle' | 'queued' | 'running' | 'failed';

export const EMPTY_DECK_COUNTS: DeckCounts = {
  character: 0,
  world: 0,
  outline: 0,
};
