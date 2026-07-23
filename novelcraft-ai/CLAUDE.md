# InkMarshal / novelcraft-ai

# 交付原则
- **禁止最小化交付，要完整交付**。任务不要做到一半就交，遇到阻塞必须先解决阻塞，把整条链路做完再回报。
- 不主动给"A 还是 B"让用户拍板的菜单，除非真的存在用户偏好/不可逆/账号绑定等只能用户决定的事；其余情况自己挑最稳妥路径直接做。
- 跑出阻塞（依赖缺失、配置坏、外部服务死了），先尝试自动修复，无法修复再回来报告 + 给一个推荐方案，而不是抛选项。

# 项目约定
- Next.js 16，使用 `proxy.ts`（不是 middleware）；它只负责桌面 session 握手与本地 API/页面鉴权。若误跑在生产 Web runtime，桌面页面重定向到 `https://www.inkmarshal.com/download`，但官网源码与 Vercel 构建只属于兄弟仓库 `../../AiNovelSite`。
- **项目已于 2026-07-23 公开上线**：已发布构建可能承载真实用户数据。此后凡涉及本地 SQLite schema、vault 结构、`~/.inkmarshal/app/` 数据布局、更新器 manifest、发布资产命名的改动，必须保护既有用户数据和已发布契约：schema 变更要带从每个已发布版本出发的前向迁移，更新链路要能从每个已发布版本升级上来。
- 上线不等于囤积投机性兼容债：没有已发布版本依赖的死代码、废配置、重复实现照旧直接删。破坏性本地清理仍只允许显式 reset 脚本；正常启动永远不得静默删除或丢弃用户数据。
- **无云端账号 / 无云数据库 / 无平台积分**。桌面端用本地 SQLite（`lib/db.ts`）。不要在本仓库引入 landing、Vercel、Supabase、Stripe 或任何云端用户态。
- 不分阶段开发，一步到位。
- Provider / Studio 相关工作必须先读仓库根 `spec/`（即 `../spec/`）下的 `LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md`；landing 工作在 `../../AiNovelSite` 处理。

# 产品形态（已转向，勿回退）
- **桌面端 = 真正的 Studio**：Tauri v2 是工作台运行环境（`src-tauri/`），内置 Next standalone + Node runtime；真正工作台只在 Tauri 内的 `/desktop-studio` 打开。
- **官网 = 独立仓库**：获客、下载、示例和法律页面只在 `../../AiNovelSite`；本仓库不再承载公开 Web 路由。
- **无平台经济**：平台 credits / Stripe / 平台代理模型 / `lib/platform-models*` / `lib/gateway-models` 均已删除，不要重新引入。
- **最终模型方向**：HuggingFace / 本地模型优先，BYOK 次之（对标 Jan / Osaurus）。**内置引擎是默认路径**：全平台打包 llama.cpp `llama-server`（GGUF）+ macOS 原生 MLX swift server（可用时）；Ollama / LM Studio 仅作"另外检测到"的可选项，OpenAI-compatible / Anthropic / Google key 只是末级兜底。`fetch-engines` 已接进 `beforeBuildCommand`。
- **当前进度**：底座 + local-first + 设计系统 + HF-first 模型管理器已完成；本地模型目录按 2026-06-02、供应商目录按 2026-06-03 当前资料刷新。当前推荐 starter shelf 只包含 Qwen3.5 4B / Qwen3.5 9B / Qwen3.6 27B；过时聊天/推理模型已移出产品可见目录和活跃 provider 列表，不作为 legacy/compatibility 货架保留。`lib/model-supply/catalog.ts` 与 `lib/providers.ts` 是来源链接、`lastVerifiedAt` 和过期阈值的单一入口。最近验证：`pnpm verify` 通过、clean aarch64 DMG 生成并通过 hdiutil/codesign/挂载内 app 校验；本机缺 Metal Toolchain 时 MLX Swift engine 会被跳过，GGUF/llama-server 仍可用。仍需 user-present GUI 实操验证：窗口化 app 目视、真实大模型下载→Use→章节生成、真 BYOK key、物理断网、多实例。遗留：Developer ID 签名+公证、Windows 真机包验证。
