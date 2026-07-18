// W3-3 series workspace — inline i18n (en / zh-CN / zh-TW).
//
// Shipped self-contained rather than widening the shared i18n bag: that bundle
// is co-edited by every wave writer in parallel, so a standalone surface keeps
// its own copy to avoid merge churn (same convention as the usage / command-
// center panels).

import type { Locale } from '@/lib/i18n';

export interface SeriesCopy {
  title: string;
  subtitle: string;
  loadError: string;
  retry: string;
  refresh: string;
  // tabs
  tabMembers: string;
  tabShared: string;
  tabConflicts: string;
  // members
  members: string;
  addNovel: string;
  noMembers: string;
  removeMember: string;
  removeBlockedTitle: string;
  removeBlockedBody: (count: number) => string;
  transferTo: string;
  confirmRemove: string;
  cancel: string;
  alreadyInSeries: string;
  movePrompt: string;
  add: string;
  // shared entries
  sharedEntries: string;
  noShared: string;
  promote: string;
  promoteTitle: string;
  promoteFrom: string;
  promoteEntry: string;
  noShareable: string;
  share: string;
  unshare: string;
  editMain: string;
  editMainTitle: string;
  editMainWarn: (count: number) => string;
  affectedBooks: string;
  overrideDifferences: string;
  perNovelOverride: string;
  overrideTitle: string;
  overrideFor: string;
  overrideValue: string;
  clearOverride: string;
  save: string;
  crossBookState: string;
  age: string;
  status: string;
  relationsDelta: string;
  saveState: string;
  anchor: string;
  // conflicts
  conflicts: string;
  runCheck: string;
  noConflicts: string;
  conflictAge: string;
  conflictStatus: string;
  conflictRelation: string;
  major: string;
  minor: string;
  conflictSummary: (total: number, major: number, minor: number) => string;
  involves: string;
  suggestedFix: string;
  ageSuggestion: string;
  statusSuggestion: string;
  relationSuggestion: string;
  // types
  typeCharacter: string;
  typeWorld: string;
  typeTimeline: string;
  typeStyle: string;
  typeOutline: string;
}

const en: SeriesCopy = {
  title: 'Series workspace',
  subtitle: 'Share characters, places, rules and timelines across the books in this series.',
  loadError: 'Could not load this series.',
  retry: 'Retry',
  refresh: 'Refresh',
  tabMembers: 'Books',
  tabShared: 'Shared knowledge',
  tabConflicts: 'Cross-book check',
  members: 'Books in this series',
  addNovel: 'Add a book',
  noMembers: 'No books in this series yet.',
  removeMember: 'Remove',
  removeBlockedTitle: 'This book anchors shared entries',
  removeBlockedBody: (count) =>
    `This book is the anchor for ${count} shared ${count === 1 ? 'entry' : 'entries'}. Transfer them to another book before removing it.`,
  transferTo: 'Transfer shared entries to',
  confirmRemove: 'Remove from series',
  cancel: 'Cancel',
  alreadyInSeries: 'In another series',
  movePrompt: 'This book is in another series. Adding it here will move it.',
  add: 'Add',
  sharedEntries: 'Shared knowledge',
  noShared: 'Nothing is shared across the series yet. Promote an entry from a book to share it.',
  promote: 'Share an entry',
  promoteTitle: 'Share a knowledge entry',
  promoteFrom: 'From book',
  promoteEntry: 'Entry',
  noShareable: 'This book has no private entries left to share.',
  share: 'Share',
  unshare: 'Make private',
  editMain: 'Edit shared value',
  editMainTitle: 'Edit the shared (canonical) value',
  editMainWarn: (count) =>
    `This changes the entry for all ${count} ${count === 1 ? 'book' : 'books'} in the series.`,
  affectedBooks: 'Affected books',
  overrideDifferences: 'Book-specific differences',
  perNovelOverride: 'Per-book override',
  overrideTitle: 'Override for one book',
  overrideFor: 'Override in book',
  overrideValue: 'Override description (this book only)',
  clearOverride: 'Clear override',
  save: 'Save',
  crossBookState: 'Cross-book state',
  age: 'Age in this book',
  status: 'Status in this book',
  relationsDelta: 'Relationship change',
  saveState: 'Save state',
  anchor: 'Anchor',
  conflicts: 'Cross-book conflicts',
  runCheck: 'Run check',
  noConflicts: 'No cross-book conflicts found.',
  conflictAge: 'Age regression',
  conflictStatus: 'Status conflict',
  conflictRelation: 'Relationship conflict',
  major: 'Major',
  minor: 'Minor',
  conflictSummary: (total, major, minor) =>
    `${total} ${total === 1 ? 'conflict' : 'conflicts'} · ${major} major · ${minor} minor`,
  involves: 'Books',
  suggestedFix: 'Suggested next step',
  ageSuggestion: 'Verify the series order and the character age in both books, then edit the incorrect book-specific state.',
  statusSuggestion: 'Confirm whether the return is intentional. If it is, record the explanation; otherwise correct the conflicting book state.',
  relationSuggestion: 'Compare the two relationship notes and keep separate overrides only when the change is intentional.',
  typeCharacter: 'Character',
  typeWorld: 'World',
  typeTimeline: 'Timeline',
  typeStyle: 'Style',
  typeOutline: 'Outline',
};

const zhCN: SeriesCopy = {
  title: '系列工作区',
  subtitle: '在本系列的多部作品之间共享角色、地点、设定规则与时间线。',
  loadError: '无法加载该系列。',
  retry: '重试',
  refresh: '刷新',
  tabMembers: '作品',
  tabShared: '共享设定',
  tabConflicts: '跨书检查',
  members: '系列内作品',
  addNovel: '加入作品',
  noMembers: '该系列还没有作品。',
  removeMember: '移出',
  removeBlockedTitle: '该作品挂有共享条目',
  removeBlockedBody: (count) =>
    `该作品是 ${count} 个共享条目的归属本。移出前请先把它们转移到另一部作品。`,
  transferTo: '将共享条目转移到',
  confirmRemove: '移出系列',
  cancel: '取消',
  alreadyInSeries: '已属其它系列',
  movePrompt: '该作品已属其它系列，加入此处将会迁移它。',
  add: '加入',
  sharedEntries: '共享设定',
  noShared: '系列内还没有共享条目。从某部作品中提升一个条目即可共享。',
  promote: '共享条目',
  promoteTitle: '共享一个设定条目',
  promoteFrom: '来源作品',
  promoteEntry: '条目',
  noShareable: '该作品没有可共享的私有条目了。',
  share: '共享',
  unshare: '改为私有',
  editMain: '编辑共享主值',
  editMainTitle: '编辑共享（主）值',
  editMainWarn: (count) => `此修改会影响系列内全部 ${count} 部作品。`,
  affectedBooks: '受影响作品',
  overrideDifferences: '各书单独差异',
  perNovelOverride: '设本书覆盖',
  overrideTitle: '仅对某一本设置覆盖',
  overrideFor: '覆盖于作品',
  overrideValue: '覆盖描述（仅本书）',
  clearOverride: '清除覆盖',
  save: '保存',
  crossBookState: '跨书状态',
  age: '本书中的年龄',
  status: '本书中的状态',
  relationsDelta: '关系变化',
  saveState: '保存状态',
  anchor: '归属本',
  conflicts: '跨书冲突',
  runCheck: '运行检查',
  noConflicts: '未发现跨书冲突。',
  conflictAge: '年龄倒退',
  conflictStatus: '状态矛盾',
  conflictRelation: '关系冲突',
  major: '严重',
  minor: '轻微',
  conflictSummary: (total, major, minor) =>
    `${total} 处冲突 · ${major} 严重 · ${minor} 轻微`,
  involves: '涉及作品',
  suggestedFix: '建议处理',
  ageSuggestion: '核对系列顺序和两部作品中的角色年龄，然后只修改记录错误的本书状态。',
  statusSuggestion: '先确认角色恢复是否为有意设定；若是，请补充解释，否则修正冲突作品中的状态。',
  relationSuggestion: '对照两部作品的关系记录；只有变化确属有意时才保留各书覆盖。',
  typeCharacter: '角色',
  typeWorld: '世界',
  typeTimeline: '时间线',
  typeStyle: '风格',
  typeOutline: '大纲',
};

const zhTW: SeriesCopy = {
  ...zhCN,
  title: '系列工作區',
  subtitle: '在本系列的多部作品之間共享角色、地點、設定規則與時間線。',
  loadError: '無法載入該系列。',
  retry: '重試',
  refresh: '重新整理',
  tabMembers: '作品',
  tabShared: '共享設定',
  tabConflicts: '跨書檢查',
  members: '系列內作品',
  addNovel: '加入作品',
  noMembers: '該系列還沒有作品。',
  removeMember: '移出',
  removeBlockedTitle: '該作品掛有共享條目',
  removeBlockedBody: (count) =>
    `該作品是 ${count} 個共享條目的歸屬本。移出前請先把它們轉移到另一部作品。`,
  transferTo: '將共享條目轉移到',
  confirmRemove: '移出系列',
  alreadyInSeries: '已屬其它系列',
  movePrompt: '該作品已屬其它系列，加入此處將會遷移它。',
  add: '加入',
  sharedEntries: '共享設定',
  noShared: '系列內還沒有共享條目。從某部作品中提升一個條目即可共享。',
  promote: '共享條目',
  promoteTitle: '共享一個設定條目',
  promoteFrom: '來源作品',
  promoteEntry: '條目',
  noShareable: '該作品沒有可共享的私有條目了。',
  share: '共享',
  unshare: '改為私有',
  editMain: '編輯共享主值',
  editMainTitle: '編輯共享（主）值',
  editMainWarn: (count) => `此修改會影響系列內全部 ${count} 部作品。`,
  affectedBooks: '受影響作品',
  overrideDifferences: '各書單獨差異',
  perNovelOverride: '設本書覆蓋',
  overrideTitle: '僅對某一本設定覆蓋',
  overrideFor: '覆蓋於作品',
  overrideValue: '覆蓋描述（僅本書）',
  clearOverride: '清除覆蓋',
  save: '儲存',
  crossBookState: '跨書狀態',
  age: '本書中的年齡',
  status: '本書中的狀態',
  relationsDelta: '關係變化',
  saveState: '儲存狀態',
  anchor: '歸屬本',
  conflicts: '跨書衝突',
  runCheck: '執行檢查',
  noConflicts: '未發現跨書衝突。',
  conflictAge: '年齡倒退',
  conflictStatus: '狀態矛盾',
  conflictRelation: '關係衝突',
  major: '嚴重',
  minor: '輕微',
  conflictSummary: (total, major, minor) =>
    `${total} 處衝突 · ${major} 嚴重 · ${minor} 輕微`,
  involves: '涉及作品',
  suggestedFix: '建議處理',
  ageSuggestion: '核對系列順序和兩部作品中的角色年齡，然後只修改記錄錯誤的本書狀態。',
  statusSuggestion: '先確認角色恢復是否為有意設定；若是，請補充解釋，否則修正衝突作品中的狀態。',
  relationSuggestion: '對照兩部作品的關係記錄；只有變化確屬有意時才保留各書覆蓋。',
};

export function seriesCopy(locale: Locale): SeriesCopy {
  if (locale === 'zh-CN') return zhCN;
  if (locale === 'zh-TW') return zhTW;
  return en;
}
