// Stage policy lives in its own module so client components can import it
// without dragging the server-only db layer (lib/db.ts) into the browser bundle.

export type NovelStage =
  | 'discovery_interview'
  | 'ready_for_greenlight'
  | 'autonomous_writing'
  | 'whole_book_unification'
  | 'completed';

export const STAGES_THAT_CAN_START_WRITING: readonly NovelStage[] = [
  'ready_for_greenlight',
  'autonomous_writing',
  'whole_book_unification',
];

export const STAGES_THAT_CAN_REGENERATE_BLUEPRINT: readonly NovelStage[] = [
  'ready_for_greenlight',
  'autonomous_writing',
];

export const STAGES_THAT_CAN_UNIFY: readonly NovelStage[] = [
  'autonomous_writing',
  'whole_book_unification',
  'completed',
];

export const STAGES_THAT_SHOW_UNIFICATION_PANEL: readonly NovelStage[] = [
  'whole_book_unification',
  'completed',
];

export const STAGES_THAT_SHOW_BLUEPRINT_PANEL: readonly NovelStage[] = [
  'ready_for_greenlight',
  'autonomous_writing',
  'whole_book_unification',
  'completed',
];

export function isInStages(stage: NovelStage, group: readonly NovelStage[]): boolean {
  return group.includes(stage);
}
