// Initial prompt template catalogue (server-only).
//
// Ten production prompts × three locales = 30 rows. Each is seeded with
// `INSERT OR IGNORE`, so re-running on an existing DB is a no-op. New prompt
// versions ship by bumping `version` and toggling `active`, not by editing
// these rows.
//
// These rows are the only production prompt source. Missing or corrupt prompt
// records fail closed instead of falling back to a second inline truth.

import type Database from 'better-sqlite3';
import { nowIso } from '@/lib/utils';

interface SeedRow {
  id: string;
  stage: string;
  role: 'user' | 'system';
  locale: 'en' | 'zh-CN' | 'zh-TW';
  template: string;
}

const SEED_VERSION = 1;
const VARIANT = 'default';

const SEED_ROWS: SeedRow[] = [
  // ── P01 greenlight pack (user) ─────────────────────────────────────────
  {
    id: 'pt_greenlight_user_en_1',
    stage: 'greenlight_pack',
    role: 'user',
    locale: 'en',
    template: `Based on the following conversation between the user and the AI novel producer, generate a comprehensive Writing Plan (Greenlight Pack).

CONVERSATION:
{{conversationText}}

Current novel metadata:
Title: {{title}}
Genre: {{genre}}
Story Direction: {{storySummary}}
Characters: {{characterSummary}}
Arc: {{arcSummary}}

Extract and synthesize all story information from the conversation to produce the greenlight pack.`,
  },
  {
    id: 'pt_greenlight_user_zhCN_1',
    stage: 'greenlight_pack',
    role: 'user',
    locale: 'zh-CN',
    template: `请根据下面用户与 AI 小说总编辑的对话，生成一份完整的写作方案（Greenlight Pack）。

对话内容：
{{conversationText}}

当前小说元数据：
标题：{{title}}
类型：{{genre}}
故事方向：{{storySummary}}
人物：{{characterSummary}}
故事弧线：{{arcSummary}}

请从对话中提炼并整合全部故事信息以生成 greenlight pack。`,
  },
  {
    id: 'pt_greenlight_user_zhTW_1',
    stage: 'greenlight_pack',
    role: 'user',
    locale: 'zh-TW',
    template: `請根據下面使用者與 AI 小說總編輯的對話，產出一份完整的寫作方案（Greenlight Pack）。

對話內容：
{{conversationText}}

目前的小說元資料：
標題：{{title}}
類型：{{genre}}
故事方向：{{storySummary}}
角色：{{characterSummary}}
故事弧線：{{arcSummary}}

請從對話中提煉並整合全部故事資訊以產出 greenlight pack。`,
  },

  // ── P02 book blueprint (user) ──────────────────────────────────────────
  {
    id: 'pt_book_blueprint_user_en_1',
    stage: 'book_blueprint',
    role: 'user',
    locale: 'en',
    template: `You are a professional novelist. Based on this novel blueprint, create a full-book chapter-by-chapter outline.

Novel details:
Title: {{title}}
Genre: {{genre}}
Target length: approximately {{targetWords}} words
Story: {{storySummary}}
Characters: {{characterSummary}}
Arc: {{arcSummary}}

{{langNote}}
Aim for {{chapterCount}} chapters covering the entire novel from opening hook through resolution. Each chapter should be self-contained but lead into the next. chapterNumber must start from 1 and increase sequentially. Respect any character/world facts provided in the system context — do not invent contradictions.`,
  },
  {
    id: 'pt_book_blueprint_user_zhCN_1',
    stage: 'book_blueprint',
    role: 'user',
    locale: 'zh-CN',
    template: `你是一位专业小说家。请根据下面的小说蓝图，生成完整的章节大纲。

小说信息：
标题：{{title}}
类型：{{genre}}
目标长度：约 {{targetWords}} 字
故事：{{storySummary}}
人物：{{characterSummary}}
故事弧线：{{arcSummary}}

{{langNote}}
目标约 {{chapterCount}} 章，覆盖从开篇到结局的完整故事。各章自成单元且能自然衔接到下一章。chapterNumber 从 1 开始顺序递增。严格遵守系统上下文中的人物/世界设定，禁止出现矛盾。`,
  },
  {
    id: 'pt_book_blueprint_user_zhTW_1',
    stage: 'book_blueprint',
    role: 'user',
    locale: 'zh-TW',
    template: `你是一位專業小說家。請根據下面的小說藍圖，產出完整的章節大綱。

小說資訊：
標題：{{title}}
類型：{{genre}}
目標長度：約 {{targetWords}} 字
故事：{{storySummary}}
角色：{{characterSummary}}
故事弧線：{{arcSummary}}

{{langNote}}
目標約 {{chapterCount}} 章，涵蓋從開頭鉤子到結局的完整故事。各章自成單元並能自然銜接到下一章。chapterNumber 從 1 開始順序遞增。嚴格遵守系統上下文中的角色／世界設定，不得出現矛盾。`,
  },

  // ── P03 chapter write (system + user) ──────────────────────────────────
  {
    id: 'pt_chapter_write_sys_en_1',
    stage: 'chapter_write',
    role: 'system',
    locale: 'en',
    template: 'You are a professional novelist.',
  },
  {
    id: 'pt_chapter_write_sys_zhCN_1',
    stage: 'chapter_write',
    role: 'system',
    locale: 'zh-CN',
    template: '你是一位专业小说家。',
  },
  {
    id: 'pt_chapter_write_sys_zhTW_1',
    stage: 'chapter_write',
    role: 'system',
    locale: 'zh-TW',
    template: '你是一位專業小說家。',
  },

  {
    id: 'pt_chapter_write_user_en_1',
    stage: 'chapter_write',
    role: 'user',
    locale: 'en',
    template: `You are writing Chapter {{chapterNumber}}: "{{title}}".

Novel: {{novelTitle}} ({{genre}})
Story context: {{storySummary}}
Characters: {{characterSummary}}

Chapter summary (what must happen): {{blueprintSummary}}

{{memorySections}}

{{langNote}}

Write the full chapter now. Use vivid prose, natural dialogue, and strong scene-setting. Do NOT include the chapter title in the text — start directly with the narrative. Stay strictly consistent with character names, world facts, and recent events shown above.`,
  },
  {
    id: 'pt_chapter_write_user_zhCN_1',
    stage: 'chapter_write',
    role: 'user',
    locale: 'zh-CN',
    template: `你正在写第 {{chapterNumber}} 章：「{{title}}」。

小说：{{novelTitle}}（{{genre}}）
故事上下文：{{storySummary}}
人物：{{characterSummary}}

本章梗概（必须发生的事）：{{blueprintSummary}}

{{memorySections}}

{{langNote}}

请立刻完整写出本章。文笔生动、对话自然、场景刻画到位。不要在正文中包含章节标题，直接从叙事开始。严格遵守上方的人物、世界与近期情节设定。`,
  },
  {
    id: 'pt_chapter_write_user_zhTW_1',
    stage: 'chapter_write',
    role: 'user',
    locale: 'zh-TW',
    template: `你正在撰寫第 {{chapterNumber}} 章：「{{title}}」。

小說：{{novelTitle}}（{{genre}}）
故事上下文：{{storySummary}}
角色：{{characterSummary}}

本章大綱（必須發生的事）：{{blueprintSummary}}

{{memorySections}}

{{langNote}}

請立刻完整寫出本章。筆觸生動、對話自然、場景描寫到位。請勿在內文中放入章節標題，直接從敘事開始。嚴格遵守上方的角色、世界與近期情節設定。`,
  },

  // ── P04 chapter continuation (user) ────────────────────────────────────
  {
    id: 'pt_chapter_continuation_user_en_1',
    stage: 'chapter_continuation',
    role: 'user',
    locale: 'en',
    template: `Chapter {{chapterNumber}}: "{{title}}" of "{{novelTitle}}" ({{genre}}).

Chapter summary (what must happen): {{blueprintSummary}}

The chapter so far:
---
{{existingContent}}
---

{{langNote}}

Continue from exactly where the text above ends. Do NOT repeat or summarise what already happened — just write the next paragraphs. Keep the voice, POV, and facts identical. Do not include the chapter title.`,
  },
  {
    id: 'pt_chapter_continuation_user_zhCN_1',
    stage: 'chapter_continuation',
    role: 'user',
    locale: 'zh-CN',
    template: `《{{novelTitle}}》（{{genre}}）第 {{chapterNumber}} 章：「{{title}}」。

本章梗概（必须发生的事）：{{blueprintSummary}}

当前进度：
---
{{existingContent}}
---

{{langNote}}

请精确接续上文继续写。不要重复或总结已经发生的内容，直接续写后续段落。保持人称、视角与事实一致，不要在正文中放入章节标题。`,
  },
  {
    id: 'pt_chapter_continuation_user_zhTW_1',
    stage: 'chapter_continuation',
    role: 'user',
    locale: 'zh-TW',
    template: `《{{novelTitle}}》（{{genre}}）第 {{chapterNumber}} 章：「{{title}}」。

本章大綱（必須發生的事）：{{blueprintSummary}}

目前進度：
---
{{existingContent}}
---

{{langNote}}

請精確接續上文繼續書寫。請勿重複或總結已經發生的內容，直接續寫後續段落。保持人稱、視角與事實一致，請勿在內文中放入章節標題。`,
  },

  // ── P05 chapter summarize (user) ───────────────────────────────────────
  {
    id: 'pt_chapter_summarize_user_en_1',
    stage: 'chapter_summarize',
    role: 'user',
    locale: 'en',
    template: `Summarise Chapter {{chapterNumber}} ("{{chapterTitle}}") below into a structured digest.

Chapter prose:
---
{{chapterContent}}
---

The chapter was planned to cover: {{blueprintSummary}}

{{langNote}}

Produce a 200–400 word "summary" capturing what actually happened (not what was planned), and fill keyFacts with the named characters present, locations used, plot-relevant items, and 1–10 short bullets describing what advanced.`,
  },
  {
    id: 'pt_chapter_summarize_user_zhCN_1',
    stage: 'chapter_summarize',
    role: 'user',
    locale: 'zh-CN',
    template: `请把下面的第 {{chapterNumber}} 章（「{{chapterTitle}}」）整理为结构化摘要。

章节正文：
---
{{chapterContent}}
---

本章原计划：{{blueprintSummary}}

{{langNote}}

请生成 200–400 字的 summary，记录实际发生的事而非原计划；并在 keyFacts 中记录登场命名角色、出现的地点、推动情节的道具，以及 1–10 条简短要点描述情节推进。`,
  },
  {
    id: 'pt_chapter_summarize_user_zhTW_1',
    stage: 'chapter_summarize',
    role: 'user',
    locale: 'zh-TW',
    template: `請將下面第 {{chapterNumber}} 章（「{{chapterTitle}}」）整理成結構化摘要。

章節正文：
---
{{chapterContent}}
---

本章原計畫：{{blueprintSummary}}

{{langNote}}

請產出 200–400 字的 summary，紀錄實際發生的事而非原計畫；並在 keyFacts 中列出出場具名角色、登場地點、推動情節的關鍵物件，以及 1–10 條簡短要點描述情節推進。`,
  },

  // ── P06 chapter validate (user) ────────────────────────────────────────
  {
    id: 'pt_chapter_validate_user_en_1',
    stage: 'chapter_validate',
    role: 'user',
    locale: 'en',
    template: `Review the chapter below for cross-context consistency. Flag only real problems — no stylistic nitpicks.

Chapter title: {{chapterTitle}}

Chapter prose:
---
{{chapterContent}}
---

{{knowledgeSection}}
{{previousFactsSection}}
{{targetWordsSection}}

{{langNote}}

Categorise each issue: character_name (mismatched/misspelled), setting (world facts wrong), timeline (date/order wrong), pov (POV slipped), length (significantly under target), or other. Severity 'major' = breaks reader trust; 'minor' = small drift. overallScore 0–100 where 100 is flawless.`,
  },
  {
    id: 'pt_chapter_validate_user_zhCN_1',
    stage: 'chapter_validate',
    role: 'user',
    locale: 'zh-CN',
    template: `请审阅下面的章节，仅标记真实的跨上下文一致性问题，不要做风格上的吹毛求疵。

章节标题：{{chapterTitle}}

章节正文：
---
{{chapterContent}}
---

{{knowledgeSection}}
{{previousFactsSection}}
{{targetWordsSection}}

{{langNote}}

为每个问题分类：character_name（角色名错乱）、setting（世界设定错）、timeline（时间/顺序错）、pov（视角跳脱）、length（远低于目标字数）或 other。severity 'major' 会破坏读者信任，'minor' 是微小偏差。overallScore 0–100，100 表示完美。`,
  },
  {
    id: 'pt_chapter_validate_user_zhTW_1',
    stage: 'chapter_validate',
    role: 'user',
    locale: 'zh-TW',
    template: `請審閱下面的章節，僅標記真實的跨上下文一致性問題，不要做風格上的吹毛求疵。

章節標題：{{chapterTitle}}

章節正文：
---
{{chapterContent}}
---

{{knowledgeSection}}
{{previousFactsSection}}
{{targetWordsSection}}

{{langNote}}

請為每個問題分類：character_name（角色名錯亂）、setting（世界設定錯）、timeline（時間／順序錯）、pov（視角跳脫）、length（遠低於目標字數）或 other。severity 'major' 會破壞讀者信任，'minor' 是微小偏差。overallScore 0–100，100 表示完美。`,
  },

  // ── P07 unification (user) ─────────────────────────────────────────────
  {
    id: 'pt_unification_user_en_1',
    stage: 'unification',
    role: 'user',
    locale: 'en',
    template: `You are unifying a complete novel "{{novelTitle}}" ({{genre}}). Identify and propose verbatim find/replace edits for cross-chapter inconsistencies only — character name spelling drift, contradictory facts, broken timeline, POV slips. Do NOT rewrite for style.

{{knowledgeSection}}

Manuscript:
---
{{chapterDump}}
---

{{langNote}}

For each issue: pick the chapter where the wrong text lives, set "original" to a verbatim substring (so it can be located by exact match), give the corrected "replacement", a short "rationale" (why this fixes a cross-chapter inconsistency), and severity 'major' (breaks reader trust) or 'minor' (small drift). Surface the most impactful first.`,
  },
  {
    id: 'pt_unification_user_zhCN_1',
    stage: 'unification',
    role: 'user',
    locale: 'zh-CN',
    template: `你正在统稿小说《{{novelTitle}}》（{{genre}}）。请仅针对跨章节不一致——角色名拼写漂移、事实矛盾、时间线错乱、视角跳脱——给出可精确定位的「逐字替换」编辑建议。不要做风格改写。

{{knowledgeSection}}

原稿：
---
{{chapterDump}}
---

{{langNote}}

每条问题：定位到错文所在的章节，"original" 填写章节中可精确匹配的逐字子串，"replacement" 给出修订后的文本，附一句"rationale"（说明它如何修复跨章节不一致），severity 标 'major'（破坏读者信任）或 'minor'（轻微偏差）。优先列出影响最大的几条。`,
  },
  {
    id: 'pt_unification_user_zhTW_1',
    stage: 'unification',
    role: 'user',
    locale: 'zh-TW',
    template: `你正在統稿小說《{{novelTitle}}》（{{genre}}）。請僅針對跨章節不一致——角色名拼字漂移、事實矛盾、時間線錯亂、視角跳脫——提出可精確定位的「逐字替換」編輯建議。請勿進行風格改寫。

{{knowledgeSection}}

原稿：
---
{{chapterDump}}
---

{{langNote}}

每條問題：定位到錯文所在的章節，"original" 填寫章節中可精確匹配的逐字子串，"replacement" 給出修訂後的文本，附一句 "rationale"（說明它如何修復跨章節不一致），severity 標 'major'（破壞讀者信任）或 'minor'（輕微偏差）。優先列出影響最大的幾條。`,
  },

  // ── P08 chapter edit (system) ──────────────────────────────────────────
  {
    id: 'pt_chapter_edit_sys_en_1',
    stage: 'chapter_edit',
    role: 'system',
    locale: 'en',
    template: `You are a professional novel editor. The user will give you an editing instruction for a chapter.

Rules:
- Each "original" must be an exact verbatim substring from the chapter text — copy it character-for-character so it can be located by string match.
- Make minimal targeted edits — only change what is necessary.
- If the user selected specific text (marked with <<<SELECTED>>>...<<<END_SELECTED>>>), focus edits on that region.
- "summary" should be 1-2 sentences describing what was changed and why.
{{langNote}}`,
  },
  {
    id: 'pt_chapter_edit_sys_zhCN_1',
    stage: 'chapter_edit',
    role: 'system',
    locale: 'zh-CN',
    template: `你是一位专业的小说编辑。用户会就一章正文提出编辑指令。

规则：
- "original" 必须是章节正文中的逐字子串——逐字逐句复制，便于按字符串精确定位。
- 编辑要最小化、有针对性，仅修改必要之处。
- 如果用户用 <<<SELECTED>>>...<<<END_SELECTED>>> 标出了具体片段，请将编辑重点放在该范围内。
- "summary" 用 1-2 句话说明改动内容与原因。
{{langNote}}`,
  },
  {
    id: 'pt_chapter_edit_sys_zhTW_1',
    stage: 'chapter_edit',
    role: 'system',
    locale: 'zh-TW',
    template: `你是一位專業的小說編輯。使用者會就一章正文提出編輯指令。

規則：
- "original" 必須是章節正文中的逐字子串——逐字逐句複製，以便依字串精確定位。
- 編輯要最小化、有針對性，僅修改必要之處。
- 若使用者以 <<<SELECTED>>>...<<<END_SELECTED>>> 標出特定段落，請將編輯重點放在該範圍內。
- "summary" 用 1-2 句話說明改動內容與原因。
{{langNote}}`,
  },

  // ── P09 chapter edit (user) ────────────────────────────────────────────
  {
    id: 'pt_chapter_edit_user_en_1',
    stage: 'chapter_edit',
    role: 'user',
    locale: 'en',
    template: `Novel: {{novelTitle}} ({{genre}})

Chapter text:
---
{{markedText}}
---

Editing instruction: {{instruction}}`,
  },
  {
    id: 'pt_chapter_edit_user_zhCN_1',
    stage: 'chapter_edit',
    role: 'user',
    locale: 'zh-CN',
    template: `小说：{{novelTitle}}（{{genre}}）

章节正文：
---
{{markedText}}
---

编辑指令：{{instruction}}`,
  },
  {
    id: 'pt_chapter_edit_user_zhTW_1',
    stage: 'chapter_edit',
    role: 'user',
    locale: 'zh-TW',
    template: `小說：{{novelTitle}}（{{genre}}）

章節正文：
---
{{markedText}}
---

編輯指令：{{instruction}}`,
  },

  // ── P10 interview system (system) ──────────────────────────────────────
  {
    id: 'pt_interview_sys_en_1',
    stage: 'interview_system',
    role: 'system',
    locale: 'en',
    template: `You are the AI novel producer's interviewer. Conduct a focused, conversational discovery interview to understand the story the user wants to write.

{{langInstruction}}

Current stage: {{stage}}
Novel snapshot:
- Title: {{title}}
- Genre: {{genre}}
- Target words: {{targetWords}}
- Story so far: {{storySummary}}
- Characters: {{characterSummary}}
- Arc: {{arcSummary}}

Stay on topic, ask one focused question at a time, summarize and reflect back the user's intent before moving on, and proactively surface trade-offs the user may not have considered.`,
  },
  {
    id: 'pt_interview_sys_zhCN_1',
    stage: 'interview_system',
    role: 'system',
    locale: 'zh-CN',
    template: `你是 AI 小说总编辑的访谈员。请以聚焦、对话式的方式进行发现性访谈，理解用户想写的故事。

{{langInstruction}}

当前阶段：{{stage}}
小说快照：
- 标题：{{title}}
- 类型：{{genre}}
- 目标字数：{{targetWords}}
- 故事概要：{{storySummary}}
- 人物：{{characterSummary}}
- 故事弧线：{{arcSummary}}

请保持话题集中，每次只问一个焦点问题，先复述/确认用户意图再继续，并主动指出用户可能未考虑到的取舍。`,
  },
  {
    id: 'pt_interview_sys_zhTW_1',
    stage: 'interview_system',
    role: 'system',
    locale: 'zh-TW',
    template: `你是 AI 小說總編輯的訪談員。請以聚焦、對話式的方式進行發現式訪談，瞭解使用者想寫的故事。

{{langInstruction}}

目前階段：{{stage}}
小說快照：
- 標題：{{title}}
- 類型：{{genre}}
- 目標字數：{{targetWords}}
- 故事概要：{{storySummary}}
- 角色：{{characterSummary}}
- 故事弧線：{{arcSummary}}

請保持話題聚焦，每次只問一個焦點問題，先複述／確認使用者意圖再繼續，並主動指出使用者可能未考量到的取捨。`,
  },

  // ── P11 chapter Ralph-revise (user) ────────────────────────────────────
  // Self-repair step of the autonomous-writing loop. Stored in the DB so the
  // stage is editable and versioned like every other AI operation.
  {
    id: 'pt_ralph_revise_user_en_1',
    stage: 'chapter_ralph_revise',
    role: 'user',
    locale: 'en',
    template: `You are running a Ralph-style long-form writing loop: draft, check, repair, continue.

Revise the chapter below so it passes the quality brief. Keep the same chapter, plot beats, POV, and prose intent. Make only the changes required to fix continuity, timeline, POV, setting, naming, or substantial length problems. Do not summarize. Do not add markdown. Return only the complete revised chapter prose.

Novel: {{novelTitle}} ({{genre}})
Chapter {{chapterNumber}}: {{chapterTitle}}

Chapter plan:
{{blueprintSummary}}

Quality brief:
{{revisionBrief}}

Current chapter:
---
{{chapterContent}}
---

{{langNote}}`,
  },
  {
    id: 'pt_ralph_revise_user_zhCN_1',
    stage: 'chapter_ralph_revise',
    role: 'user',
    locale: 'zh-CN',
    template: `你正在运行 Ralph 式长篇写作循环：起草、检查、修复、继续。

请修订下面的章节，使其通过质检要点。保持同一章节、相同情节节拍、视角与文风意图。只做修复连贯性、时间线、视角、设定、命名或显著篇幅问题所必需的改动。不要做摘要，不要加 markdown。只返回完整的修订后章节正文。

小说：{{novelTitle}}（{{genre}}）
第 {{chapterNumber}} 章：{{chapterTitle}}

章节计划：
{{blueprintSummary}}

质检要点：
{{revisionBrief}}

当前章节：
---
{{chapterContent}}
---

{{langNote}}`,
  },
  {
    id: 'pt_ralph_revise_user_zhTW_1',
    stage: 'chapter_ralph_revise',
    role: 'user',
    locale: 'zh-TW',
    template: `你正在執行 Ralph 式長篇寫作迴圈：起草、檢查、修復、繼續。

請修訂下面的章節，使其通過品質檢查要點。保持同一章節、相同情節節拍、視角與文風意圖。只做修復連貫性、時間線、視角、設定、命名或顯著篇幅問題所必需的改動。不要做摘要，不要加 markdown。只回傳完整的修訂後章節正文。

小說：{{novelTitle}}（{{genre}}）
第 {{chapterNumber}} 章：{{chapterTitle}}

章節計畫：
{{blueprintSummary}}

品質檢查要點：
{{revisionBrief}}

目前章節：
---
{{chapterContent}}
---

{{langNote}}`,
  },
];

export function seedPromptTemplates(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO prompt_templates
       (id, stage, role, locale, version, variant, template_text, variables_schema, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1, ?)`,
  );
  const createdAt = nowIso();
  const tx = db.transaction(() => {
    for (const row of SEED_ROWS) {
      stmt.run(row.id, row.stage, row.role, row.locale, SEED_VERSION, VARIANT, row.template, createdAt);
    }
  });
  tx();
}
