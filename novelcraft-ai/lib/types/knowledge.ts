import { z } from 'zod';

// --- Zod Schemas ---

export const KNOWLEDGE_FIELD_LIMITS = {
  shortText: 200,
  tagText: 100,
  mediumText: 1000,
  referenceId: 128,
  shortListItems: 20,
  referenceListItems: 50,
  characterDescription: 2000,
  characterBackstory: 3000,
  characterMotivation: 1000,
  characterArc: 2000,
  worldDescription: 3000,
  worldDetailValue: 1000,
  timelineDescription: 2000,
  outlineSynopsis: 2000,
  outlineNotes: 3000,
  styleSampleText: 5000,
  styleNotes: 2000,
} as const;

const shortTextSchema = z.string().max(KNOWLEDGE_FIELD_LIMITS.shortText);
const mediumTextSchema = z.string().max(KNOWLEDGE_FIELD_LIMITS.mediumText);
const referenceIdSchema = z.string().min(1).max(KNOWLEDGE_FIELD_LIMITS.referenceId);
const shortTextListSchema = z.array(shortTextSchema).max(KNOWLEDGE_FIELD_LIMITS.shortListItems).default([]);
const referenceListSchema = z.array(referenceIdSchema).max(KNOWLEDGE_FIELD_LIMITS.referenceListItems).default([]);

// --- W3-3 series / shared worldbuilding. A *shared* knowledge entry (one whose
//     `series_id` is set) carries the canonical "main value" in its normal data
//     fields. Two optional, sparse JSON bags layer per-member-novel divergence
//     on top of that single physical row, keyed by member novelId:
//       - `perNovelOverrides[novelId]` = a partial field patch the projection
//         shallow-merges over the shared main value when rendering that novel's
//         view (W3-3 "set a per-book override" path).
//       - `crossBookState[novelId]`    = the entity's per-book age/status and a
//         freeform relations delta, the input the cross-book consistency checker
//         scans for age regressions / contradictory statuses.
//     Both are optional with no `.default()` so every pre-W3-3 row parses
//     byte-for-byte unchanged (the keys are simply absent on legacy data, and a
//     standalone entry never writes them). The maps are bounded to keep a
//     malformed payload from bloating the `data` column. ---
const SERIES_OVERLAY_LIMITS = {
  maxMembers: 200,
  overrideValue: KNOWLEDGE_FIELD_LIMITS.mediumText,
} as const;

const perNovelOverridesSchema = z
  .record(referenceIdSchema, z.record(z.string().max(64), z.unknown()))
  .refine(map => Object.keys(map).length <= SERIES_OVERLAY_LIMITS.maxMembers, {
    message: 'Too many per-novel overrides',
  })
  .optional();

const crossBookStateEntrySchema = z.object({
  age: z.union([z.number().finite(), z.string().max(KNOWLEDGE_FIELD_LIMITS.shortText)]).optional(),
  status: z.string().max(KNOWLEDGE_FIELD_LIMITS.shortText).optional(),
  relationsDelta: z.string().max(SERIES_OVERLAY_LIMITS.overrideValue).optional(),
}).strict();

const crossBookStateSchema = z
  .record(referenceIdSchema, crossBookStateEntrySchema)
  .refine(map => Object.keys(map).length <= SERIES_OVERLAY_LIMITS.maxMembers, {
    message: 'Too many cross-book state entries',
  })
  .optional();

/** The two optional series-overlay fields, spread into every shareable data
 *  schema. Kept as a single object so the shape stays identical across types. */
const seriesOverlayFields = {
  perNovelOverrides: perNovelOverridesSchema,
  crossBookState: crossBookStateSchema,
} as const;

export type PerNovelOverrides = z.infer<typeof perNovelOverridesSchema>;
export type CrossBookStateEntry = z.infer<typeof crossBookStateEntrySchema>;
export type CrossBookState = z.infer<typeof crossBookStateSchema>;

export const characterDataSchema = z.object({
  role: z.enum(['protagonist', 'antagonist', 'supporting', 'minor']),
  description: z.string().max(KNOWLEDGE_FIELD_LIMITS.characterDescription).default(''),
  backstory: z.string().max(KNOWLEDGE_FIELD_LIMITS.characterBackstory).default(''),
  motivation: z.string().max(KNOWLEDGE_FIELD_LIMITS.characterMotivation).default(''),
  traits: shortTextListSchema,
  arc: z.string().max(KNOWLEDGE_FIELD_LIMITS.characterArc).default(''),
  /** Alternate spellings / nicknames for this character. Source of truth for the
   *  deterministic checker's name-consistency rule (W2-2). Optional with a
   *  `[]` default so pre-existing character entries parse unchanged (backward
   *  compatible — the field is simply absent on old rows and hydrates to []). */
  aliases: shortTextListSchema,
  ...seriesOverlayFields,
});

export const worldDataSchema = z.object({
  category: z.enum(['location', 'faction', 'magic_system', 'technology', 'culture', 'rule', 'item']),
  description: z.string().max(KNOWLEDGE_FIELD_LIMITS.worldDescription).default(''),
  details: z.record(z.string(), z.string().max(KNOWLEDGE_FIELD_LIMITS.worldDetailValue)).default({}),
  ...seriesOverlayFields,
});

export const timelineDataSchema = z.object({
  date: shortTextSchema.default(''),
  dateSort: z.number().finite(),
  eventType: z.enum(['plot', 'character', 'world', 'backstory']),
  description: z.string().max(KNOWLEDGE_FIELD_LIMITS.timelineDescription).default(''),
  chapterIds: referenceListSchema,
  characterRefs: referenceListSchema,
  importance: z.enum(['major', 'minor']).default('minor'),
  ...seriesOverlayFields,
});

/** Outline node level (W3-1 volume/chapter/scene/beat hierarchy). The legacy
 *  single-level outline is the `chapter` level; every pre-W3-1 row hydrates to
 *  `chapter` via the `.default()` so old data parses unchanged. */
export const OUTLINE_LEVELS = ['volume', 'chapter', 'scene', 'beat'] as const;
export type OutlineLevel = typeof OUTLINE_LEVELS[number];

/** Scene-level authored metadata. Optional as a whole (chapters/volumes/beats
 *  don't carry it) but each field defaults to '' so a partially-filled
 *  `sceneMeta` object still parses. */
export const sceneMetaSchema = z.object({
  pov: shortTextSchema.default(''),
  time: shortTextSchema.default(''),
  location: shortTextSchema.default(''),
  conflict: mediumTextSchema.default(''),
  outcome: mediumTextSchema.default(''),
}).default({ pov: '', time: '', location: '', conflict: '', outcome: '' });

export const outlineDataSchema = z.object({
  chapterId: z.string().max(128).default(''),
  chapterNumber: z.number().int().min(1).max(10_000).default(1),
  synopsis: z.string().max(KNOWLEDGE_FIELD_LIMITS.outlineSynopsis).default(''),
  keyEvents: shortTextListSchema,
  characters: shortTextListSchema,
  pov: mediumTextSchema.default(''),
  status: z.enum(['planned', 'drafted', 'revised', 'final']).default('planned'),
  wordCountTarget: z.number().int().min(0).max(1_000_000).default(0),
  notes: z.string().max(KNOWLEDGE_FIELD_LIMITS.outlineNotes).default(''),

  // --- W3-1 multi-level hierarchy. All `.default()` so legacy single-level
  //     rows (and the 0016 migration's json_set backfill) parse unchanged and
  //     every read path COALESCEs `level` back to 'chapter'. ---
  /** Tree level. Legacy rows = 'chapter'. */
  level: z.enum(OUTLINE_LEVELS).default('chapter'),
  /** Adjacency-list parent. '' = top-level node. */
  parentId: z.string().max(128).default(''),
  /** Scene-level POV/time/location/conflict/outcome. Present on any level but
   *  authored at the scene level; defaults keep volumes/chapters/beats valid. */
  sceneMeta: sceneMetaSchema,
  /** Plotline labels this node belongs to (for the aggregate view). */
  plotlineTags: shortTextListSchema,
  /** Character-arc labels this node advances (for the aggregate view). */
  characterArcTags: shortTextListSchema,
  /** Free-form author metadata bag (key → string). */
  customMeta: z.record(z.string(), z.string().max(KNOWLEDGE_FIELD_LIMITS.worldDetailValue)).default({}),
});

export const styleReferenceDataSchema = z.object({
  sampleText: z.string().max(KNOWLEDGE_FIELD_LIMITS.styleSampleText).default(''),
  styleNotes: z.string().max(KNOWLEDGE_FIELD_LIMITS.styleNotes).default(''),
  source: z.string().max(KNOWLEDGE_FIELD_LIMITS.shortText).default(''),
});

export const KNOWLEDGE_TYPES = ['character', 'world', 'timeline', 'outline', 'style_reference'] as const;
export type KnowledgeType = typeof KNOWLEDGE_TYPES[number];

const knowledgeTitleSchema = z.string().min(1).max(KNOWLEDGE_FIELD_LIMITS.shortText);
const knowledgeTagsInputSchema = z.array(z.string().max(KNOWLEDGE_FIELD_LIMITS.tagText)).max(KNOWLEDGE_FIELD_LIMITS.shortListItems);
const knowledgeTagsSchema = knowledgeTagsInputSchema.default([]);

export const createKnowledgeEntrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('character'), title: knowledgeTitleSchema, tags: knowledgeTagsSchema, data: characterDataSchema }),
  z.object({ type: z.literal('world'), title: knowledgeTitleSchema, tags: knowledgeTagsSchema, data: worldDataSchema }),
  z.object({ type: z.literal('timeline'), title: knowledgeTitleSchema, tags: knowledgeTagsSchema, data: timelineDataSchema }),
  z.object({ type: z.literal('outline'), title: knowledgeTitleSchema, tags: knowledgeTagsSchema, data: outlineDataSchema }),
  z.object({ type: z.literal('style_reference'), title: knowledgeTitleSchema, tags: knowledgeTagsSchema, data: styleReferenceDataSchema }),
]);

const DATA_SCHEMA_BY_TYPE = {
  character: characterDataSchema,
  world: worldDataSchema,
  timeline: timelineDataSchema,
  outline: outlineDataSchema,
  style_reference: styleReferenceDataSchema,
} satisfies Record<KnowledgeType, z.ZodType>;

export function parseKnowledgeEntryUpdate(
  type: KnowledgeType,
  updates: unknown,
): { title?: string; data?: unknown; tags?: string[] } {
  return z.object({
    title: knowledgeTitleSchema.optional(),
    data: DATA_SCHEMA_BY_TYPE[type].optional(),
    tags: knowledgeTagsInputSchema.optional(),
  }).strict().parse(updates);
}

export const knowledgeRelationSchema = z.object({
  sourceId: referenceIdSchema,
  targetId: referenceIdSchema,
  relationType: z.string().min(1).max(50),
  label: z.string().max(200).default(''),
}).refine(value => value.sourceId !== value.targetId, {
  path: ['targetId'],
  message: 'Knowledge relation source and target must differ',
});

/** The desired final outgoing-relation set for a source entry (KN-01 atomic
 *  sync). `relationType` defaults to 'friend' to mirror the drafts editor. */
export const knowledgeRelationDraftsSchema = z.array(
  z.object({
    targetId: referenceIdSchema,
    relationType: z.string().max(50).default(''),
    label: z.string().max(200).default(''),
  }),
).max(KNOWLEDGE_FIELD_LIMITS.referenceListItems);

// --- TypeScript Types (inferred from Zod) ---

export type CharacterData = z.infer<typeof characterDataSchema>;
export type WorldData = z.infer<typeof worldDataSchema>;
export type TimelineData = z.infer<typeof timelineDataSchema>;
export type OutlineData = z.infer<typeof outlineDataSchema>;
export type SceneMeta = z.infer<typeof sceneMetaSchema>;
export type StyleReferenceData = z.infer<typeof styleReferenceDataSchema>;
export type CreateKnowledgeEntryInput = z.infer<typeof createKnowledgeEntrySchema>;

export interface KnowledgeEntryBase {
  id: string;
  novelId: string;
  title: string;
  summary: string;
  sortOrder: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CharacterEntry extends KnowledgeEntryBase { type: 'character'; data: CharacterData; }
export interface WorldEntry extends KnowledgeEntryBase { type: 'world'; data: WorldData; }
export interface TimelineEntry extends KnowledgeEntryBase { type: 'timeline'; data: TimelineData; }
export interface OutlineEntry extends KnowledgeEntryBase { type: 'outline'; data: OutlineData; }
export interface StyleReferenceEntry extends KnowledgeEntryBase { type: 'style_reference'; data: StyleReferenceData; }

export type KnowledgeEntry = CharacterEntry | WorldEntry | TimelineEntry | OutlineEntry | StyleReferenceEntry;

export interface KnowledgeRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  label: string;
  createdAt: number;
}
