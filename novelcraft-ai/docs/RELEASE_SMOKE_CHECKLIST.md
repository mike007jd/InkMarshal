# Release Smoke Checklist（macOS 真机人工冒烟）

每次发布候选 DMG 必须在真机过完这份清单并留存记录。

已有自动化包装层：`pnpm release:mac` 会挂载**最终** DMG、从该挂载点只启动一个进程、并检查桌面 runtime health，通过后才保留 release 资产。另有桌面 boot smoke（`e2e/desktop-smoke`）覆盖无 GUI 的启动不变量。这些自动化是包装/启动 oracle，**不能替代**本清单中的真机人工路径（真实模型下载/Use、BYOK、物理断网、GUI 操作、导出与强杀恢复等）。

自动化门禁前置：`pnpm verify`（含 lint、typecheck、Knip、全量 Vitest、隔离 80 章 full-novel QA、production build）+ `pnpm verify:security` + `pnpm verify:desktop`，以及需要时的 `CHECK_LOCAL_MAC_BUNDLE=1 pnpm verify:release-desktop`。

## 记录头

- 日期 / 执行人:
- DMG: `dist/release/InkMarshal-mac-aarch64.dmg` 的 sha256:
- macOS 版本 / 机型:

## 安装与首启

- [ ] 从 DMG 拖入 /Applications，首次打开无 Gatekeeper 拦截（无「已损坏」「无法验证开发者」弹窗）
- [ ] 首启向导完整走通，落地到工作台主界面
- [ ] 退出后二次启动直接进入工作台（会话/数据库状态保留）

## 模型链路（核心路径）

- [ ] 模型管理器列出 starter shelf；下载一个真实模型到完成（进度、暂停/恢复正常）
- [ ] 下载完成后 Use → 引擎启动 → 新建小说 → 生成一个完整章节
- [ ] BYOK：配置一个真实云端 key，生成成功；删除 key 后不再可用
- [ ] 物理断网：本地模型生成仍工作；BYOK 路径给出明确错误而非挂死
- [ ] 小说 chat：发送一条消息，中途 Stop，确认半截回复只落库一次；随后重新发送/重试，线程继续正常

## 创作与数据

- [ ] 章节编辑、保存、重启后内容完好
- [ ] 中文小说导出 EPUB / TXT / DOCX / PDF / 导出 ZIP 各一次，打开确认中文渲染正常（PDF 不出现豆腐块）
- [ ] 强杀 app（活动监视器）后重启，无数据丢失、无迁移报错

## 系统集成

- [ ] 「报告问题」等外链只打开 GitHub 允许列表内地址
- [ ] 窗口缩放到最小尺寸布局不破；深/浅色外观切换正常
- [ ] 卸载验证：删除 app 后 `~/.inkmarshal/app` 数据目录仍在（local-first 数据不随 app 删除）

## 结果

- [ ] 全部通过 → 在发布记录中附本文件副本与 verify 输出
- 任一失败 → 阻断发布，回归修复后整单重跑
