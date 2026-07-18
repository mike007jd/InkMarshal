// Client-safe stage display labels (W3-2). Kept OUT of lib/prompt-genre-packs
// (which is server-only — it imports the DB layer / better-sqlite3) so the
// workflows client surface can label stages without dragging node:fs into the
// browser bundle. Pure data + a lookup; no imports.
export type StageLabelLocale = 'en' | 'zh-CN' | 'zh-TW';

export const STAGE_LABELS: Record<string, { en: string; 'zh-CN': string; 'zh-TW': string }> = {
  greenlight_pack: { en: 'Greenlight pack', 'zh-CN': '立项方案', 'zh-TW': '立項方案' },
  book_blueprint: { en: 'Book blueprint', 'zh-CN': '全书大纲', 'zh-TW': '全書大綱' },
  chapter_write: { en: 'Chapter writing', 'zh-CN': '章节写作', 'zh-TW': '章節寫作' },
  chapter_continuation: { en: 'Chapter continuation', 'zh-CN': '章节续写', 'zh-TW': '章節續寫' },
  chapter_summarize: { en: 'Chapter summary', 'zh-CN': '章节摘要', 'zh-TW': '章節摘要' },
  chapter_validate: { en: 'Chapter validation', 'zh-CN': '章节校验', 'zh-TW': '章節校驗' },
  unification: { en: 'Unification pass', 'zh-CN': '统稿', 'zh-TW': '統稿' },
  chapter_edit: { en: 'Chapter editing', 'zh-CN': '章节编辑', 'zh-TW': '章節編輯' },
  interview_system: { en: 'Discovery interview', 'zh-CN': '发现访谈', 'zh-TW': '發現訪談' },
  chapter_ralph_revise: { en: 'Auto-revise loop', 'zh-CN': '自动修订', 'zh-TW': '自動修訂' },
};

/** Friendly per-locale label for a stage; used by the workflows surface's tree. */
export function stageLabel(stage: string, locale: StageLabelLocale): string {
  const entry = STAGE_LABELS[stage];
  return entry ? entry[locale] : stage;
}
