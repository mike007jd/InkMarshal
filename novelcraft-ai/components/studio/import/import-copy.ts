// Self-contained i18n copy for the manuscript-import wizard (W2-1).
//
// Per the W2-1 hard constraint, the import feature must NOT touch the shared
// lib/i18n bundle. All wizard/editor strings live here as an inline locale table
// (en / zh-CN / zh-TW) the components select via `useLanguage().locale`.

import type { Locale } from '@/lib/i18n';

export interface ImportEditorCopy {
  expand: string;
  collapse: string;
  autoDetected: string;
  mergeUp: string;
  splitHere: string;
  emptyChapter: string;
  onConflict: string;
  actionSkip: string;
  actionOverwrite: string;
  actionAppend: string;
  statusNew: string;
  statusDuplicate: string;
  statusConflict: string;
  titlePlaceholder: (n: number) => string;
  wordCount: (n: number) => string;
  matchedWith: (n: number, title: string) => string;
}

export interface ImportWizardCopy extends ImportEditorCopy {
  entryLabel: string;
  dialogTitle: string;
  // step: pick
  pickHeading: string;
  pickBody: string;
  pickButton: string;
  pickHint: string;
  parsing: string;
  // step: preview
  previewHeading: (chapters: number, words: number) => string;
  novelTitleLabel: string;
  novelTitlePlaceholder: string;
  modeLabel: string;
  modeNew: string;
  modeMerge: string;
  mergeTargetLabel: string;
  mergeTargetPlaceholder: string;
  runKbLabel: string;
  runKbHint: string;
  conflictWarning: (n: number) => string;
  // footer
  back: string;
  cancel: string;
  confirmNew: string;
  confirmMerge: string;
  importing: string;
  // outcomes
  importedToast: (chapters: number) => string;
  importFailed: string;
  parseFailed: string;
  kbRunning: string;
  kbDone: (created: number) => string;
  kbFailed: string;
  noNovelsForMerge: string;
  desktopOnly: string;
}

const en: ImportWizardCopy = {
  // editor
  expand: 'Expand',
  collapse: 'Collapse',
  autoDetected: 'Auto-detected',
  mergeUp: 'Merge into previous',
  splitHere: 'Split chapter here',
  emptyChapter: 'No body text in this chapter yet.',
  onConflict: 'On match:',
  actionSkip: 'Skip',
  actionOverwrite: 'Overwrite',
  actionAppend: 'Append',
  statusNew: 'New',
  statusDuplicate: 'Duplicate',
  statusConflict: 'Conflict',
  titlePlaceholder: (n) => `Chapter ${n} title`,
  wordCount: (n) => `${n.toLocaleString()} words`,
  matchedWith: (n, title) => `Matches existing chapter ${n}: ${title}`,
  // wizard
  entryLabel: 'Import manuscript',
  dialogTitle: 'Import an existing manuscript',
  pickHeading: 'Bring in a draft you already have',
  pickBody: 'Import a .txt, .md, or .docx manuscript. Volumes and chapters are detected automatically — you preview and fix the splits before anything is saved.',
  pickButton: 'Choose a file…',
  pickHint: 'Supports .txt, .md, and .docx (up to 25 MB).',
  parsing: 'Reading and splitting the manuscript…',
  previewHeading: (chapters, words) => `${chapters.toLocaleString()} chapters · ${words.toLocaleString()} words`,
  novelTitleLabel: 'Novel title',
  novelTitlePlaceholder: 'Untitled manuscript',
  modeLabel: 'Import as',
  modeNew: 'A new novel',
  modeMerge: 'Merge into an existing novel',
  mergeTargetLabel: 'Target novel',
  mergeTargetPlaceholder: 'Select a novel…',
  runKbLabel: 'Extract characters, places & style into the knowledge base',
  runKbHint: 'Uses your recall model after import. Optional — runs in the background and never blocks the import.',
  conflictWarning: (n) => `${n} chapter${n === 1 ? '' : 's'} match existing chapters. Choose what to do with each below.`,
  back: 'Back',
  cancel: 'Cancel',
  confirmNew: 'Create novel & import',
  confirmMerge: 'Merge into novel',
  importing: 'Importing…',
  importedToast: (chapters) => `Imported ${chapters.toLocaleString()} chapter${chapters === 1 ? '' : 's'}.`,
  importFailed: 'Import failed. Nothing was changed.',
  parseFailed: 'Could not read that file.',
  kbRunning: 'Extracting knowledge base in the background…',
  kbDone: (created) => `Knowledge base updated (${created.toLocaleString()} entries).`,
  kbFailed: 'Knowledge extraction was skipped (no model or it failed). You can run it later.',
  noNovelsForMerge: 'You have no existing novels to merge into yet.',
  desktopOnly: 'Manuscript import is available in the desktop app.',
};

const zhCN: ImportWizardCopy = {
  expand: '展开',
  collapse: '收起',
  autoDetected: '自动识别',
  mergeUp: '并入上一章',
  splitHere: '在此拆分章节',
  emptyChapter: '本章暂无正文。',
  onConflict: '冲突时：',
  actionSkip: '跳过',
  actionOverwrite: '覆盖',
  actionAppend: '追加',
  statusNew: '新增',
  statusDuplicate: '重复',
  statusConflict: '冲突',
  titlePlaceholder: (n) => `第 ${n} 章标题`,
  wordCount: (n) => `${n.toLocaleString()} 字`,
  matchedWith: (n, title) => `匹配到现有第 ${n} 章：${title}`,
  entryLabel: '导入稿件',
  dialogTitle: '导入现有稿件',
  pickHeading: '带入你已有的稿子',
  pickBody: '导入 .txt、.md 或 .docx 稿件。自动识别卷与章节——保存前你可以先预览并修正切分。',
  pickButton: '选择文件…',
  pickHint: '支持 .txt、.md、.docx（最大 25 MB）。',
  parsing: '正在读取并切分稿件…',
  previewHeading: (chapters, words) => `${chapters.toLocaleString()} 章 · ${words.toLocaleString()} 字`,
  novelTitleLabel: '作品标题',
  novelTitlePlaceholder: '未命名稿件',
  modeLabel: '导入方式',
  modeNew: '建为新作品',
  modeMerge: '合并到现有作品',
  mergeTargetLabel: '目标作品',
  mergeTargetPlaceholder: '选择一部作品…',
  runKbLabel: '把角色、地点与风格提取进知识库',
  runKbHint: '导入后使用你的 recall 模型。可选——后台运行，不会阻断导入。',
  conflictWarning: (n) => `有 ${n} 章与现有章节匹配。请在下方逐章选择处理方式。`,
  back: '上一步',
  cancel: '取消',
  confirmNew: '创建作品并导入',
  confirmMerge: '合并到作品',
  importing: '导入中…',
  importedToast: (chapters) => `已导入 ${chapters.toLocaleString()} 章。`,
  importFailed: '导入失败，未做任何更改。',
  parseFailed: '无法读取该文件。',
  kbRunning: '正在后台提取知识库…',
  kbDone: (created) => `知识库已更新（${created.toLocaleString()} 条）。`,
  kbFailed: '已跳过知识提取（无可用模型或提取失败）。稍后可重新运行。',
  noNovelsForMerge: '你还没有可合并的现有作品。',
  desktopOnly: '稿件导入仅在桌面应用中可用。',
};

const zhTW: ImportWizardCopy = {
  expand: '展開',
  collapse: '收合',
  autoDetected: '自動辨識',
  mergeUp: '併入上一章',
  splitHere: '在此拆分章節',
  emptyChapter: '本章尚無正文。',
  onConflict: '衝突時：',
  actionSkip: '略過',
  actionOverwrite: '覆寫',
  actionAppend: '附加',
  statusNew: '新增',
  statusDuplicate: '重複',
  statusConflict: '衝突',
  titlePlaceholder: (n) => `第 ${n} 章標題`,
  wordCount: (n) => `${n.toLocaleString()} 字`,
  matchedWith: (n, title) => `對應現有第 ${n} 章：${title}`,
  entryLabel: '匯入稿件',
  dialogTitle: '匯入現有稿件',
  pickHeading: '帶入你已有的稿子',
  pickBody: '匯入 .txt、.md 或 .docx 稿件。自動辨識卷與章節——儲存前你可以先預覽並修正切分。',
  pickButton: '選擇檔案…',
  pickHint: '支援 .txt、.md、.docx（最大 25 MB）。',
  parsing: '正在讀取並切分稿件…',
  previewHeading: (chapters, words) => `${chapters.toLocaleString()} 章 · ${words.toLocaleString()} 字`,
  novelTitleLabel: '作品標題',
  novelTitlePlaceholder: '未命名稿件',
  modeLabel: '匯入方式',
  modeNew: '建立為新作品',
  modeMerge: '合併到現有作品',
  mergeTargetLabel: '目標作品',
  mergeTargetPlaceholder: '選擇一部作品…',
  runKbLabel: '把角色、地點與風格提取進知識庫',
  runKbHint: '匯入後使用你的 recall 模型。選用——背景執行，不會阻斷匯入。',
  conflictWarning: (n) => `有 ${n} 章與現有章節對應。請在下方逐章選擇處理方式。`,
  back: '上一步',
  cancel: '取消',
  confirmNew: '建立作品並匯入',
  confirmMerge: '合併到作品',
  importing: '匯入中…',
  importedToast: (chapters) => `已匯入 ${chapters.toLocaleString()} 章。`,
  importFailed: '匯入失敗，未做任何變更。',
  parseFailed: '無法讀取該檔案。',
  kbRunning: '正在背景提取知識庫…',
  kbDone: (created) => `知識庫已更新（${created.toLocaleString()} 條）。`,
  kbFailed: '已略過知識提取（無可用模型或提取失敗）。稍後可重新執行。',
  noNovelsForMerge: '你還沒有可合併的現有作品。',
  desktopOnly: '稿件匯入僅在桌面應用程式中可用。',
};

const TABLE: Record<Locale, ImportWizardCopy> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

export function importCopy(locale: Locale): ImportWizardCopy {
  return TABLE[locale] ?? en;
}
