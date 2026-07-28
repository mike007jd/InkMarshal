# InkMarshal

> Local-first AI 小说创作 Studio

[English](README.md)

InkMarshal 是基于 Tauri v2 的本地优先桌面写作环境：手稿保存在本机 SQLite，模型可使用内置引擎、本地服务或用户自有 API 凭据，不要求 InkMarshal 云账号。

## 下载

**[下载最新版已签名、公证的 Apple Silicon macOS 版本](https://github.com/mike007jd/InkMarshal/releases/latest)**

其他平台只有在完成签名与真实验证后才会公开发布。

## 快速开始

```bash
git clone https://github.com/mike007jd/InkMarshal.git
cd InkMarshal/novelcraft-ai
corepack enable
pnpm install --frozen-lockfile
pnpm desktop:dev
```

请使用 Node 24 和项目固定的 pnpm 10.15.1。完整工具链、命令、质量门禁和本地数据安全规则见英文 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 产品边界

- `novelcraft-ai/` 是真实桌面 Studio，包含 Next.js、Tauri、本地 SQLite 与推理引擎。
- `../AiNovelSite` 只负责官网、下载、示例与法律页面。
- 本仓库没有在线写作工作台、云端手稿数据库、平台积分或必需登录。
- Provider key 在桌面 UI 配置，并保存在本机/系统钥匙串。

## 文档

- 总索引：[docs/README.md](docs/README.md)
- 隐私：[PRIVACY.md](PRIVACY.md)
- 安全：[SECURITY.md](SECURITY.md)
- 开发上手：[CONTRIBUTING.md](CONTRIBUTING.md)
- 第三方归属：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

开发、设计、发布和 agent 文档统一使用英文；本文件是面向用户的中文简介。
