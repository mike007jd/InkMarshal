# InkMarshal

> Local-first AI 小说创作 Studio

**新机器 / 给 AI 上手？** 先看 [CONTRIBUTING.md](CONTRIBUTING.md)（英文，命令可直接照抄）：前置依赖、安装步骤、验证命令。

English: [README.md](README.md)

## 下载

**[下载最新版已签名、公证的 InkMarshal macOS DMG（Apple Silicon）](https://github.com/mike007jd/InkMarshal/releases/latest)**

## 当前产品形态

InkMarshal 是 **local-first 桌面写作 Studio**（Tauri v2）；官网位于兄弟仓库 `../AiNovelSite`。

- **桌面端（Tauri v2，`novelcraft-ai/src-tauri/`）**：真正的工作台。内置 Next.js standalone、本地 SQLite（`~/.inkmarshal/app/inkmarshal.db`）、推理引擎（GGUF：`llama-server`；Apple Silicon 可用时：`mlx-server`）。
- **官网（`../AiNovelSite`）**：负责 landing、下载、示例、法律页面和 Vercel。**没有**在线工作台、登录、云数据库、平台积分。
- **模型**：HuggingFace / 本地引擎优先；云厂商 API key 仅作 UI 内 BYOK 兜底。

## 前置依赖

| 需要 | 说明 |
|------|------|
| 平台 | 桌面 Studio 目前仅 **macOS Apple Silicon** |
| Node.js | **24.x**（见 `novelcraft-ai/.node-version`；`>=24 <25`） |
| pnpm | **10.15.1**（Corepack），不要用 pnpm 11 |
| Rust | Stable `>= 1.77.2`（仅桌面） |
| Xcode CLT | `xcode-select --install`（仅桌面） |

## 快速开始

```bash
git clone https://github.com/mike007jd/InkMarshal.git
cd InkMarshal/novelcraft-ai
corepack enable && corepack prepare pnpm@10.15.1 --activate
pnpm install
pnpm desktop:dev      # 桌面 Studio（主产品）
```

## 打桌面包（本机未签名）

```bash
cd novelcraft-ai
pnpm fetch-engines    # 拉取 llama-server（有 Metal/Xcode 时再编 mlx-server）
pnpm desktop:build    # 产物在 src-tauri/target/release/bundle/macos/
```

`fetch-engines` 已挂在 `beforeBuildCommand`。本地开发**不需要**签名/公证。

## 常用命令（在 `novelcraft-ai/` 下）

```bash
pnpm dev                # 桌面 Next runtime
pnpm desktop:dev        # 桌面 Studio
pnpm desktop:build      # 本机 .app + .dmg
pnpm build              # Next.js 桌面 runtime 构建
pnpm lint
pnpm typecheck
pnpm test
pnpm verify             # lint + typecheck + test + build
pnpm verify:desktop     # rustfmt + clippy + cargo test
```

## 环境变量

Provider key 在**桌面 UI**配置；官网 `NEXT_PUBLIC_*` 变量只属于 `../AiNovelSite`。

## 仓库结构

```text
InkMarshal/
├── README.md / README_zh-CN.md
├── CONTRIBUTING.md      ← 新机器上手（优先读）
├── LICENSE              ← Apache-2.0
├── spec/
├── docs/                ← 仅文档策略
└── novelcraft-ai/       ← 全部应用代码（pnpm 在这里跑）
    ├── app/
    ├── lib/
    ├── src-tauri/
    ├── .env.example
    └── package.json
```

## 文档地图

- 上手：[CONTRIBUTING.md](CONTRIBUTING.md)
- 隐私与联网行为：[PRIVACY.md](PRIVACY.md)
- 安全支持与私密报告：[SECURITY.md](SECURITY.md)
- 应用脚本 / 维护者发布笔记：[novelcraft-ai/README.md](novelcraft-ai/README.md)
- 系统框架：[spec/SYSTEM_FRAMEWORK.md](spec/SYSTEM_FRAMEWORK.md)
- 已交付表面：[novelcraft-ai/docs/LIVE_SURFACE_MATRIX.md](novelcraft-ai/docs/LIVE_SURFACE_MATRIX.md)
- 产品方向：[spec/LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md](spec/LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md)
- 上线就绪：[novelcraft-ai/docs/LAUNCH_READINESS.md](novelcraft-ai/docs/LAUNCH_READINESS.md)

`docs/` 只保留策略；过期计划直接删。
