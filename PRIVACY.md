# Privacy Policy

Effective date: July 18, 2026

InkMarshal is a local-first desktop writing application. It does not require an InkMarshal account, does not operate a cloud database for manuscripts, and does not include telemetry, analytics, advertising trackers, or automatic crash reporting.

## Data stored on your device

InkMarshal stores application data under `~/.inkmarshal/app/` by default. This includes the local SQLite database (`inkmarshal.db` and its WAL/SHM files), manuscripts and vault data, downloaded models, preferences, logs, and local fallback secret storage. `INKMARSHAL_HOME` can move the root directory.

Manuscript and settings data are stored in ordinary local files and SQLite without application-level encryption. They are protected by your operating-system account, filesystem permissions, disk encryption, and device security. Provider credentials use the operating-system keychain when available; environments that cannot use the keychain may use local fallback secret files. Protect your device and local backups accordingly.

InkMarshal does not upload this local data to an InkMarshal-operated service. Exports and backups go only to locations you choose.

## Network connections

InkMarshal makes the following network connections:

| Destination | When it is contacted | Data sent or received |
| --- | --- | --- |
| GitHub Releases | Automatic update checking is enabled by default and runs shortly after startup; you can disable it in Settings or check manually. Update files are downloaded only when you choose to install an update. | Standard network metadata and the installed app version/platform needed to retrieve signed update metadata or files. Manuscript content is not sent. |
| Hugging Face | When you search the model catalog, inspect model files, or download a model. | Search terms, model repository/file identifiers, and standard network metadata. Manuscript content and provider credentials are not sent. |
| Your selected AI provider or custom endpoint | Only when you run an AI-assisted writing action using that connection. | The instruction plus relevant manuscript text, outlines, conversation history, knowledge entries, style context, and attachments needed for the requested action. The provider's own privacy and retention terms apply. |
| Local AI runtimes | When you use a loopback endpoint such as the bundled engine, Ollama, or LM Studio. | The same task context may be sent to that process on your device, but a loopback connection does not send it to the public internet. A non-loopback custom endpoint is controlled by you and should be treated like an external AI provider. |
| External project/support links | Only when you click a link that opens GitHub in your browser. | Your browser makes a normal page request. InkMarshal does not append manuscript content. |

InkMarshal does not sell personal information and does not use manuscript content to train an InkMarshal model.

## Your controls

- Disable automatic update checks in **Settings → General**; manual checks remain available.
- Use an on-device model to keep AI prompts on your machine.
- Review a provider's privacy terms before connecting its API.
- Delete local InkMarshal data with the repository's explicit reset tool, or remove selected projects/models through the app. Normal startup does not silently erase or migrate unpublished local data.

## Changes and contact

Material policy changes will be documented in the repository and release notes. For a privacy question, open a GitHub Discussion or use the project contact channel listed in the repository.

## 中文摘要

InkMarshal 是本地优先的桌面写作工具：不要求 InkMarshal 账号，没有云端手稿数据库，也不包含遥测、分析、广告追踪或自动崩溃上报。手稿、设置、日志与模型默认以未做应用层加密的本地文件/SQLite 形式保存在 `~/.inkmarshal/app/`，请依靠系统账户、磁盘加密与设备安全进行保护。

联网出口只有：GitHub 更新检查与下载、Hugging Face 模型搜索与下载、你主动配置的 AI 供应商/自定义端点，以及你点击后由浏览器打开的项目链接。使用外部 AI 时，为完成任务所需的手稿片段、指令、上下文和附件会发送给该供应商；使用本机回环引擎时，这些内容不会离开设备。自动检查更新默认开启，可在设置中关闭，手动检查始终保留。
