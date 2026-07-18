// Self-contained copy for the usage/cost panel (W2-3). Ships its own locale-keyed
// strings (en / zh-CN / zh-TW) instead of widening the shared i18n bag, which is
// co-edited by every Wave 2 writer in parallel — same convention as the
// command-center panel. zh-TW reuses the shared Chinese phrasing where the two
// variants don't differ.

import type { Locale } from '@/lib/i18n';

export type TimeWindow = '7d' | '30d' | 'all';

interface UsageCopy {
  title: string;
  refresh: string;
  novelSelectLabel: string;
  allNovels: string;
  windowLabel: string;
  windows: Record<TimeWindow, string>;
  loadError: string;
  empty: string;
  localTitle: string;
  localHint: string;
  localRuns: string;
  localComputeTime: string;
  localModels: string;
  onlineTitle: string;
  onlineHint: string;
  onlineSpend: string;
  onlineCalls: string;
  onlineModels: string;
  noLocalUsage: string;
  noOnlineUsage: string;
  costPerKWordTitle: string;
  costPerKWordHint: string;
  noAcceptedYet: string;
  bestValue: string;
  perKWord: string;
  acceptedWordsUnit: string;
  partialPrice: string;
  advancedDiagnostics: string;
  breakdownTitle: string;
  colOperation: string;
  colModel: string;
  colRuns: string;
  colSuccess: string;
  colFailTrunc: string;
  colTokens: string;
  colFirstToken: string;
  colDuration: string;
  colCost: string;
  costNote: string;
  unknown: string;
  unknownModel: string;
  notApplicable: string;
  operations: Record<string, string>;
  kinds: Record<string, string>;
}

export function usageCopy(locale: Locale): UsageCopy {
  if (locale === 'en') return EN;
  if (locale === 'zh-TW') return ZH_TW;
  return ZH_CN;
}

const EN: UsageCopy = {
  title: 'Usage & Cost',
  refresh: 'Refresh',
  novelSelectLabel: 'Filter by novel',
  allNovels: 'All novels',
  windowLabel: 'Time window',
  windows: { '7d': 'Last 7 days', '30d': 'Last 30 days', 'all': 'All time' },
  loadError: 'Could not load usage data.',
  empty: 'No AI calls recorded yet. Generate a chapter and the cost data shows up here.',
  localTitle: 'On this device',
  localHint: 'Local work uses your own hardware, so it is tracked as activity and compute time—not as a made-up dollar saving.',
  localRuns: 'Generations',
  localComputeTime: 'Compute time',
  localModels: 'Models used',
  onlineTitle: 'Online providers',
  onlineHint: 'Estimated provider charges in the selected time window. Your provider dashboard remains the billing source of truth.',
  onlineSpend: 'Estimated spend',
  onlineCalls: 'Calls',
  onlineModels: 'Models used',
  noLocalUsage: 'No on-device generations in this time window.',
  noOnlineUsage: 'No online-provider calls in this time window.',
  costPerKWordTitle: 'Cost per 1k accepted words',
  costPerKWordHint:
    'Estimated online-provider cost for every 1,000 words you actually keep. On-device generations are intentionally excluded.',
  noAcceptedYet: 'No accepted words attributed yet — keep writing and this fills in.',
  bestValue: 'Best value',
  perKWord: '/ 1k words',
  acceptedWordsUnit: 'accepted words',
  partialPrice: 'Some prices unknown',
  advancedDiagnostics: 'Advanced diagnostics',
  breakdownTitle: 'By operation & model',
  colOperation: 'Operation',
  colModel: 'Model',
  colRuns: 'Runs',
  colSuccess: 'Success',
  colFailTrunc: 'Fail/trunc/cancel',
  colTokens: 'Tokens',
  colFirstToken: 'First token',
  colDuration: 'Avg time',
  colCost: 'Est. cost',
  costNote:
    'Online cost uses provider-reported tokens when available, otherwise a character estimate. A model with no price on file shows "unknown". On-device rows show no dollar value.',
  unknown: 'Unknown',
  unknownModel: 'Unknown model',
  notApplicable: '—',
  operations: {
    chat: 'Chat',
    outline: 'Outline',
    chapter: 'Chapter',
    polish: 'Polish',
    summarize: 'Summarize',
    validate: 'Validate',
    unify: 'Unify',
  },
  kinds: { local: 'Local', provider: 'Provider', custom: 'Custom', unknown: 'Unknown' },
};

const ZH_CN: UsageCopy = {
  title: '用量与成本',
  refresh: '刷新',
  novelSelectLabel: '按小说筛选',
  allNovels: '全部小说',
  windowLabel: '时间窗',
  windows: { '7d': '近 7 天', '30d': '近 30 天', 'all': '全部' },
  loadError: '无法加载用量数据。',
  empty: '还没有 AI 调用记录。生成一章后,成本数据会显示在这里。',
  localTitle: '这台设备',
  localHint: '本地生成使用你自己的硬件,这里只记录生成活动和计算时间,不虚构成省下的金额。',
  localRuns: '生成次数',
  localComputeTime: '计算时间',
  localModels: '使用模型',
  onlineTitle: '在线供应商',
  onlineHint: '所选时间窗内的供应商预估费用。最终账单以供应商控制台为准。',
  onlineSpend: '预估费用',
  onlineCalls: '调用次数',
  onlineModels: '使用模型',
  noLocalUsage: '这个时间窗内没有本地生成。',
  noOnlineUsage: '这个时间窗内没有在线供应商调用。',
  costPerKWordTitle: '每千字接受成本',
  costPerKWordHint:
    '你真正保留的每 1000 字对应的在线供应商预估成本。本地生成不参与此排名。',
  noAcceptedYet: '还没有归属到模型的接受字数 —— 继续写作,这里会自动填充。',
  bestValue: '最划算',
  perKWord: '/ 千字',
  acceptedWordsUnit: '接受字数',
  partialPrice: '部分价格未知',
  advancedDiagnostics: '高级诊断',
  breakdownTitle: '按操作与模型',
  colOperation: '操作',
  colModel: '模型',
  colRuns: '调用',
  colSuccess: '成功率',
  colFailTrunc: '失败/截断/取消',
  colTokens: 'Token',
  colFirstToken: '首字延迟',
  colDuration: '平均耗时',
  colCost: '估算成本',
  costNote:
    '在线成本优先用供应商回传的 token,否则按字符估算。没有价格记录的模型显示「未知」;本地记录不显示金额。',
  unknown: '未知',
  unknownModel: '未知模型',
  notApplicable: '—',
  operations: {
    chat: '对话',
    outline: '大纲',
    chapter: '章节',
    polish: '润色',
    summarize: '摘要',
    validate: '校验',
    unify: '统稿',
  },
  kinds: { local: '本地', provider: '供应商', custom: '自定义', unknown: '未知' },
};

const ZH_TW: UsageCopy = {
  ...ZH_CN,
  title: '用量與成本',
  refresh: '重新整理',
  novelSelectLabel: '依小說篩選',
  allNovels: '全部小說',
  windowLabel: '時間範圍',
  windows: { '7d': '近 7 天', '30d': '近 30 天', 'all': '全部' },
  loadError: '無法載入用量資料。',
  empty: '還沒有 AI 呼叫紀錄。生成一章後,成本資料會顯示在這裡。',
  localTitle: '這台裝置',
  localHint: '本地生成使用你自己的硬體,這裡只記錄生成活動和運算時間,不虛構成省下的金額。',
  localRuns: '生成次數',
  localComputeTime: '運算時間',
  localModels: '使用模型',
  onlineTitle: '線上供應商',
  onlineHint: '所選時間範圍內的供應商預估費用。最終帳單以供應商控制台為準。',
  onlineSpend: '預估費用',
  onlineCalls: '呼叫次數',
  onlineModels: '使用模型',
  noLocalUsage: '這個時間範圍內沒有本地生成。',
  noOnlineUsage: '這個時間範圍內沒有線上供應商呼叫。',
  costPerKWordTitle: '每千字接受成本',
  costPerKWordHint:
    '你真正保留的每 1000 字對應的線上供應商預估成本。本地生成不參與此排名。',
  noAcceptedYet: '還沒有歸屬到模型的接受字數 —— 繼續寫作,這裡會自動填充。',
  bestValue: '最划算',
  perKWord: '/ 千字',
  acceptedWordsUnit: '接受字數',
  partialPrice: '部分價格未知',
  advancedDiagnostics: '進階診斷',
  breakdownTitle: '依操作與模型',
  colOperation: '操作',
  colModel: '模型',
  colRuns: '呼叫',
  colSuccess: '成功率',
  colFailTrunc: '失敗/截斷/取消',
  colTokens: 'Token',
  colFirstToken: '首字延遲',
  colDuration: '平均耗時',
  colCost: '估算成本',
  costNote:
    '線上成本優先用供應商回傳的 token,否則按字元估算。沒有價格紀錄的模型顯示「未知」;本地記錄不顯示金額。',
  notApplicable: '—',
  unknown: '未知',
  unknownModel: '未知模型',
  operations: {
    chat: '對話',
    outline: '大綱',
    chapter: '章節',
    polish: '潤色',
    summarize: '摘要',
    validate: '校驗',
    unify: '統稿',
  },
  kinds: { local: '本地', provider: '供應商', custom: '自訂', unknown: '未知' },
};
