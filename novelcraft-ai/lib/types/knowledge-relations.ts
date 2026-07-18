// Wave 2 commit E — relation type vocabulary for KnowledgeEntryForm /
// RelationsEditor and the character detail "Relations" panel.
//
// `RELATION_PRESETS` is the curated list shown as quick-pick options in the
// Select dropdown. Users can still type a custom relation type via the
// "Custom" entry — frontmatter `relations:` accepts arbitrary strings, the
// curated list is just for ergonomics + i18n.

import type { StringKey } from '@/lib/i18n';

export const RELATION_PRESETS = [
  'friend',
  'family',
  'enemy',
  'ally',
  'mentor',
  'student',
  'romantic',
  'rival',
] as const;

export type RelationPreset = (typeof RELATION_PRESETS)[number];

/** Map each preset (and a `custom` sentinel) to its i18n key. */
export const RELATION_PRESET_I18N: Record<RelationPreset | 'custom', StringKey> = {
  friend:   'relationFriend',
  family:   'relationFamily',
  enemy:    'relationEnemy',
  ally:     'relationAlly',
  mentor:   'relationMentor',
  student:  'relationStudent',
  romantic: 'relationRomantic',
  rival:    'relationRival',
  custom:   'relationCustom',
};

export function isRelationPreset(value: string): value is RelationPreset {
  return (RELATION_PRESETS as readonly string[]).includes(value);
}
