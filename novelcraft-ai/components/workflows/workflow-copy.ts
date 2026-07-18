// Self-contained i18n copy for the workflow & template editor (W3-2).
//
// Per the W3-2 hard constraint, this feature must NOT touch the shared
// lib/i18n bundle. Every string the surface renders lives here as an inline
// locale table (en / zh-CN / zh-TW) selected via `useLanguage().locale`.

import type { Locale } from '@/lib/i18n';

export interface WorkflowCopy {
  // page / shell
  title: string;
  subtitle: string;
  // left rail
  workflowsHeading: string;
  variantsLabel: string;
  defaultVariant: string;
  cloneAction: string;
  clonePrompt: string;
  cloneNameLabel: string;
  cloneInvalidName: string;
  cloneExists: string;
  // tabs
  tabForm: string;
  tabHistory: string;
  tabTrial: string;
  tabBinding: string;
  tabPacks: string;
  tabIo: string;
  // form
  localeLabel: string;
  formHeading: string;
  formHint: string;
  noFields: string;
  advancedToggle: string;
  rawTemplateLabel: string;
  saveDraft: string;
  publishVersion: string;
  savedToast: string;
  publishedToast: string;
  readonlyDefault: string;
  fieldRequired: string;
  // history
  historyHeading: string;
  versionLabel: (n: number) => string;
  activeBadge: string;
  activateAction: string;
  rollbackToast: string;
  noHistory: string;
  // trial
  trialHeading: string;
  trialHint: string;
  sampleVarsHeading: string;
  dryRunAction: string;
  realRunAction: string;
  defaultColumn: string;
  variantColumn: string;
  outputHeading: string;
  trialNoModel: string;
  trialRunning: string;
  missingVarsNote: (vars: string) => string;
  // binding
  bindingHeading: string;
  bindingHint: string;
  // packs
  packsHeading: string;
  packsHint: string;
  applyPack: string;
  packAppliedToast: string;
  packNeedsNovel: string;
  // io
  ioHeading: string;
  exportHeading: string;
  exportHint: string;
  exportAction: string;
  exportedToast: string;
  importHeading: string;
  importHint: string;
  importAction: string;
  importedToast: (n: number) => string;
  importFailed: string;
  importNeedsDesktop: string;
  // global default
  globalDefaultHeading: string;
  globalDefaultHint: string;
  globalDefaultNone: string;
  globalDefaultSaved: string;
  // generic
  loading: string;
  deleteVariant: string;
  deleteConfirm: (v: string) => string;
  deleteBlocked: (n: number) => string;
  deletedToast: string;
  errorToast: string;
}

const en: WorkflowCopy = {
  title: 'Workflows & Templates',
  subtitle: 'Clone a built-in workflow, tune it with a safe form, trial it, and version every change.',
  workflowsHeading: 'Workflows',
  variantsLabel: 'Variants',
  defaultVariant: 'Default (built-in)',
  cloneAction: 'Clone as variant',
  clonePrompt: 'Name your custom variant',
  cloneNameLabel: 'Variant name',
  cloneInvalidName: 'Use letters, numbers, dot, dash or underscore (max 64).',
  cloneExists: 'A variant with that name already exists for this workflow.',
  tabForm: 'Variables',
  tabHistory: 'Versions',
  tabTrial: 'Trial run',
  tabBinding: 'Model binding',
  tabPacks: 'Genre packs',
  tabIo: 'Import / Export',
  localeLabel: 'Language',
  formHeading: 'Tune the variables',
  formHint: 'Edit the structured fields below. The full prompt text is in the Advanced section.',
  noFields: 'This template has no declared variables. Edit the raw text in Advanced.',
  advancedToggle: 'Advanced: raw template text',
  rawTemplateLabel: 'Template text',
  saveDraft: 'Save draft',
  publishVersion: 'Publish new version',
  savedToast: 'Draft saved.',
  publishedToast: 'New version published and activated.',
  readonlyDefault: 'The built-in default is read-only. Clone it to a variant to edit.',
  fieldRequired: 'Template text cannot be empty.',
  historyHeading: 'Version history',
  versionLabel: (n) => `Version ${n}`,
  activeBadge: 'Active',
  activateAction: 'Activate',
  rollbackToast: 'Version activated.',
  noHistory: 'No versions yet.',
  trialHeading: 'Trial run',
  trialHint: 'Compare the default and your variant. Dry render is free; running the model is opt-in.',
  sampleVarsHeading: 'Sample values',
  dryRunAction: 'Dry render',
  realRunAction: 'Run the model',
  defaultColumn: 'Default',
  variantColumn: 'Your variant',
  outputHeading: 'Model output',
  trialNoModel: 'No model bound for this role — bind one in the Model binding tab.',
  trialRunning: 'Running…',
  missingVarsNote: (vars) => `Unfilled variables: ${vars}`,
  bindingHeading: 'Model binding',
  bindingHint: 'Bind a model to each writing role (planning / draft / rewrite / recall). Shared with the Models page.',
  packsHeading: 'Genre packs',
  packsHint: 'Apply a curated style to the current novel. Each pack lands as a variant you can further tune.',
  applyPack: 'Apply to novel',
  packAppliedToast: 'Genre pack applied to the novel.',
  packNeedsNovel: 'Open a novel first to apply a genre pack to it.',
  ioHeading: 'Import / Export',
  exportHeading: 'Export a variant',
  exportHint: 'Download a variant as a portable JSON pack.',
  exportAction: 'Export pack',
  exportedToast: 'Pack exported.',
  importHeading: 'Import a pack',
  importHint: 'Load a JSON pack. It is validated and added as new versions — the built-in default is never overwritten.',
  importAction: 'Import pack…',
  importedToast: (n) => `Imported ${n} template row(s).`,
  importFailed: 'Import failed — the file is not a valid template pack.',
  importNeedsDesktop: 'Import is only available in the desktop app.',
  globalDefaultHeading: 'Global default variant',
  globalDefaultHint: 'New and unbound novels use this variant by default.',
  globalDefaultNone: 'Default (built-in)',
  globalDefaultSaved: 'Global default updated.',
  loading: 'Loading…',
  deleteVariant: 'Delete variant',
  deleteConfirm: (v) => `Delete the variant "${v}" and all its versions? This cannot be undone.`,
  deleteBlocked: (n) => `Still used by ${n} novel(s). Reassign them first.`,
  deletedToast: 'Variant deleted.',
  errorToast: 'Something went wrong.',
};

const zhCN: WorkflowCopy = {
  title: '工作流与模板',
  subtitle: '把内置工作流复制成自定义变体，用安全的表单微调、试运行，并为每次改动保留版本。',
  workflowsHeading: '工作流',
  variantsLabel: '变体',
  defaultVariant: '默认（内置）',
  cloneAction: '复制为变体',
  clonePrompt: '为你的自定义变体命名',
  cloneNameLabel: '变体名称',
  cloneInvalidName: '只能用字母、数字、点、连字符或下划线（最多 64 字符）。',
  cloneExists: '该工作流下已存在同名变体。',
  tabForm: '变量',
  tabHistory: '版本',
  tabTrial: '试运行',
  tabBinding: '模型绑定',
  tabPacks: '类型包',
  tabIo: '导入 / 导出',
  localeLabel: '语言',
  formHeading: '调整变量',
  formHint: '编辑下面的结构化字段。完整提示词正文在「高级」区。',
  noFields: '此模板未声明变量。请在「高级」区编辑正文。',
  advancedToggle: '高级：模板正文',
  rawTemplateLabel: '模板正文',
  saveDraft: '保存草稿',
  publishVersion: '发布新版本',
  savedToast: '草稿已保存。',
  publishedToast: '已发布并激活新版本。',
  readonlyDefault: '内置默认模板只读。请先复制成变体再编辑。',
  fieldRequired: '模板正文不能为空。',
  historyHeading: '版本历史',
  versionLabel: (n) => `第 ${n} 版`,
  activeBadge: '生效中',
  activateAction: '激活',
  rollbackToast: '已激活该版本。',
  noHistory: '尚无版本。',
  trialHeading: '试运行',
  trialHint: '对比默认与你的变体。纯渲染免费，真跑模型需手动触发。',
  sampleVarsHeading: '示例取值',
  dryRunAction: '纯渲染对比',
  realRunAction: '真跑模型',
  defaultColumn: '默认',
  variantColumn: '你的变体',
  outputHeading: '模型输出',
  trialNoModel: '该角色未绑定模型——请在「模型绑定」页绑定。',
  trialRunning: '运行中…',
  missingVarsNote: (vars) => `未填写的变量：${vars}`,
  bindingHeading: '模型绑定',
  bindingHint: '为每个写作角色（规划 / 初稿 / 润色 / 回忆）绑定模型。与「模型」页共享。',
  packsHeading: '类型小说包',
  packsHint: '为当前小说套用一套预置风格。每个包都会落成一个可继续微调的变体。',
  applyPack: '套用到小说',
  packAppliedToast: '已为小说套用类型包。',
  packNeedsNovel: '请先打开一本小说，再套用类型包。',
  ioHeading: '导入 / 导出',
  exportHeading: '导出变体',
  exportHint: '把变体导出为可移植的 JSON 模板包。',
  exportAction: '导出模板包',
  exportedToast: '模板包已导出。',
  importHeading: '导入模板包',
  importHint: '载入 JSON 模板包。会经严格校验并作为新版本写入——绝不覆盖内置默认。',
  importAction: '导入模板包…',
  importedToast: (n) => `已导入 ${n} 条模板行。`,
  importFailed: '导入失败——该文件不是合法的模板包。',
  importNeedsDesktop: '导入仅在桌面端可用。',
  globalDefaultHeading: '全局默认变体',
  globalDefaultHint: '新建及未绑定的小说默认使用此变体。',
  globalDefaultNone: '默认（内置）',
  globalDefaultSaved: '全局默认已更新。',
  loading: '加载中…',
  deleteVariant: '删除变体',
  deleteConfirm: (v) => `删除变体「${v}」及其全部版本？此操作不可撤销。`,
  deleteBlocked: (n) => `仍有 ${n} 本小说在用，请先改绑。`,
  deletedToast: '变体已删除。',
  errorToast: '出错了。',
};

const zhTW: WorkflowCopy = {
  ...zhCN,
  title: '工作流程與範本',
  subtitle: '把內建工作流程複製成自訂變體，用安全的表單微調、試運行，並為每次改動保留版本。',
  workflowsHeading: '工作流程',
  variantsLabel: '變體',
  defaultVariant: '預設（內建）',
  cloneAction: '複製為變體',
  clonePrompt: '為你的自訂變體命名',
  cloneNameLabel: '變體名稱',
  cloneInvalidName: '只能用字母、數字、點、連字號或底線（最多 64 字元）。',
  cloneExists: '此工作流程下已存在同名變體。',
  tabForm: '變數',
  tabHistory: '版本',
  tabTrial: '試運行',
  tabBinding: '模型綁定',
  tabPacks: '類型包',
  tabIo: '匯入 / 匯出',
  localeLabel: '語言',
  formHeading: '調整變數',
  formHint: '編輯下方的結構化欄位。完整提示詞內文在「進階」區。',
  noFields: '此範本未宣告變數。請在「進階」區編輯內文。',
  advancedToggle: '進階：範本內文',
  rawTemplateLabel: '範本內文',
  saveDraft: '儲存草稿',
  publishVersion: '發布新版本',
  savedToast: '草稿已儲存。',
  publishedToast: '已發布並啟用新版本。',
  readonlyDefault: '內建預設範本唯讀。請先複製成變體再編輯。',
  fieldRequired: '範本內文不能為空。',
  historyHeading: '版本歷史',
  versionLabel: (n) => `第 ${n} 版`,
  activeBadge: '生效中',
  activateAction: '啟用',
  rollbackToast: '已啟用該版本。',
  noHistory: '尚無版本。',
  trialHeading: '試運行',
  trialHint: '對比預設與你的變體。純渲染免費，真跑模型需手動觸發。',
  sampleVarsHeading: '範例取值',
  dryRunAction: '純渲染對比',
  realRunAction: '真跑模型',
  defaultColumn: '預設',
  variantColumn: '你的變體',
  outputHeading: '模型輸出',
  trialNoModel: '此角色未綁定模型——請在「模型綁定」頁綁定。',
  trialRunning: '執行中…',
  missingVarsNote: (vars) => `未填寫的變數：${vars}`,
  bindingHeading: '模型綁定',
  bindingHint: '為每個寫作角色（規劃 / 初稿 / 潤色 / 回憶）綁定模型。與「模型」頁共享。',
  packsHeading: '類型小說包',
  packsHint: '為目前小說套用一套預置風格。每個包都會落成一個可繼續微調的變體。',
  applyPack: '套用到小說',
  packAppliedToast: '已為小說套用類型包。',
  packNeedsNovel: '請先開啟一本小說，再套用類型包。',
  ioHeading: '匯入 / 匯出',
  exportHeading: '匯出變體',
  exportHint: '把變體匯出為可攜的 JSON 範本包。',
  exportAction: '匯出範本包',
  exportedToast: '範本包已匯出。',
  importHeading: '匯入範本包',
  importHint: '載入 JSON 範本包。會經嚴格校驗並作為新版本寫入——絕不覆蓋內建預設。',
  importAction: '匯入範本包…',
  importedToast: (n) => `已匯入 ${n} 條範本列。`,
  importFailed: '匯入失敗——此檔案不是合法的範本包。',
  importNeedsDesktop: '匯入僅在桌面端可用。',
  globalDefaultHeading: '全域預設變體',
  globalDefaultHint: '新建及未綁定的小說預設使用此變體。',
  globalDefaultNone: '預設（內建）',
  globalDefaultSaved: '全域預設已更新。',
  loading: '載入中…',
  deleteVariant: '刪除變體',
  deleteConfirm: (v) => `刪除變體「${v}」及其全部版本？此操作無法復原。`,
  deleteBlocked: (n) => `仍有 ${n} 本小說在用，請先改綁。`,
  deletedToast: '變體已刪除。',
  errorToast: '出錯了。',
};

const TABLE: Record<Locale, WorkflowCopy> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

export function workflowCopy(locale: Locale): WorkflowCopy {
  return TABLE[locale] ?? en;
}
