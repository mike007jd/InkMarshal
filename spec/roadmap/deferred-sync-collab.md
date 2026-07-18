# 加密同步与协作 (P2.10) — 暂缓 / 需决策门 · effort XL

> **状态:本期不做。** 与项目硬约束(无云端账号/无云数据库/无 Supabase)直接冲突,且协作权限在纯本地架构下无法服务端强制。本文件记录设计方向与红线,供未来产品定位重新评估时启动。

## 目标(若启动)
让作者在自己的多台设备间安全同步同一部小说(正文+知识库+大纲+设置),并可把单部小说以加密包形式分享给受邀的编辑/校对者,受邀者按只读/批注/建议修改三档权限参与,评论带处理状态线程。全程零托管后端、零云账号,模型密钥永不离开本机。

## 我的判断(建议而非自行启动)
两条红线必须先对用户讲清:
1. **协作权限在纯本地架构下无法服务端强制**——拿到 editor 包的协作者本地可绕过 UI 软门禁直接改 DB。权限本质是「包内容裁剪 + 约定」,不是加密强制。
2. **真正的「邀请协作者+权限+评论线程」**要么接受这个软门禁现实,要么破本地优先约束上托管后端——后者与产品定位冲突,属于需用户拍板的真正分叉。

**建议拆分**:把「个人多设备同步」(纯加密文件包,无协作权限问题)作为未来候选先评估;「多人协作」整体推后到产品定位重新评估时再启动。

## 设计方向(本地优先路径,供未来参考)
- **数据层**:同步开关/目录/角色挂 `NovelSettings.sync?`;冲突落败版复用 `chapters.snapshots` FIFO(`label='conflict-<ts>'`);**新建 `sync_oplog` 表**(逐实体修订日志:`entity_type/entity_id/op/lamport/device_id/hash/payload_json`,做增量 diff + 三方合并 + 因果排序);**新建 `collab_comments` 表**(选区锚点/线程/kind/suggestion_payload/status)。
- **核心拍板**:用「用户自有文件同步目录(iCloud/Seafile/Dropbox 放 E2E 加密 `.inkmarshal` 包)+ 本地三方合并」,**零托管后端**;同步包用「每实体一加密分片 + oplog」而非整库对拷(避免同步到密钥/其它小说,支持 per-novel 增量);冲突解决章节正文逐段 + 标量 Lamport-LWW + 落败版进快照(不做实时 CRDT);模型密钥与 provider 凭证显式列入「永不同步」黑名单。
- **关键复用**:`NovelSettings` bag、`appendSafetySnapshot/restoreChapterFromSnapshot`、`UnificationEdit` 形状 + apply(建议改写=可应用 edit)、`reorderOutlineAtomic`(应用远端大纲变更必须经此事务路径)、`knowledge_index` vault 镜像(维持 per-novel 隔离)、`dialog.open()/saveBlob`、`fflate`、VACUUM 备份。新增 `src-tauri/src/sync_fs.rs`(读同步目录 + 原子写 temp+rename)。

## 关键风险(为何谨慎)
- **high**:权限无服务端强制(纯本地架构固有)→ 只能 UI 明示「协作权限是约定非加密强制」+ reader/proofreader 包生成期物理裁剪写凭证。
- **high**:文件同步工具整文件对拷可能产生 conflict 副本/半写文件 → 分片 content-addressed 文件名 + append-only oplog + 读取校验 manifest hash + Rust 端 temp+atomic rename。
- **medium**:passphrase 丢失即数据不可解 → 启用时强制二次确认 + 提示导出明文备份兜底。
- **medium**:同步应用阶段可能绕过跨小说隔离 → `apply.ts` 强制经 `reorderOutlineAtomic`/既有 knowledge query 层,禁裸 SQL,应用前断言 novel_id 一致。
- **low**:E2E 加密引入 libsodium 依赖 → 优先 `libsodium-wrappers`(wasm,纯 JS 侧)避免原生编译。

## 启动前置(若未来启动)
- 共享前置 #2 的 Tauri 读文件命令(扩展为读同步目录)。
- 建议先做「导出包扩展(`buildSubmissionBundle` 纳入 KB/大纲/快照)」,同步包分片复用其内容收集逻辑。
- 同步面板挂靠 `SettingsPanel`,需设置区已有可扩展容器。
