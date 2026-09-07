# Changelog

本文件记录 `dsh-message-gateway` 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.25] - 2026-09-07

### Fixed

- **typecheck 修复**：`wecom_create_smartsheet` 工具向 `WecomSmartsheetClient` 传入了其构造函数签名中不存在的 `corpId`，导致 `npm run typecheck` 报错；现移除该多余属性，并对仅配置自建应用（corpId）凭据的情况返回明确的中文错误提示（当前底层 `@wecom/cli` 仅支持智能机器人 botId + secret 授权）

## [0.1.24] - 2026-09-04

### Fixed

- **构建产物与宿主 dsh API 兼容修复**：`@deepseek-ai/dsh-tools` 改为运行时 external 依赖，产物不再内联旧版 dsh-tools 代码（曾引用已从 `dsh-llm`/`dsh-session` 移除的 `CallId`/`assertNever` 等符号），宿主升级后 bundle 加载报 `SyntaxError`、dsh web 无法启动；改为由宿主运行时解析后与宿主 `0.1.2-rc.1` API 天然配套

## [0.1.23] - 2026-09-02

### Fixed

- client：主题色继承（inherit color），适配深色/浅色主题

## [0.1.22] - 2026-08-31

- `wecom_create_smartsheet` 工具参数 schema 细化：结构化字段定义（`fields.items`）与动态行记录（`records.items`），提升 LLM 工具调用遵循度

## [0.1.21] - 2026-08-31

- 重写企业微信智能表格客户端：改用官方 `@wecom/cli` 认证（botId + secret），修正原 corpId/gettoken 路径的 40013 问题

## [0.1.20] - 2026-08-31

### Added

- 新增 `wecom_create_smartsheet` Agent 工具（原生 fetch REST 实现，零外部依赖）

## [0.1.19] - 2026-08-29

### Fixed

- bridge-manager：消息流超时与收尾问题（turn/end 事件处理、fallback 超时缩短至 2m）

## [0.1.14] - 2026-08-27

### Fixed

- dispose：增加 1.5s 超时解耦，修复插件 reload 死锁；立即断开全部 bridge 监听

## [0.1.6] - 2026-08-19

### Fixed

- QQ bridge 启动重试：token / 网关拉取失败自动恢复

## [0.1.5] - 2026-08-19

### Fixed

- QQ bridge 断线重连健壮性：离线 bot 自动恢复

## [0.1.4] - 2026-08-19

### Added

- QQ C2C 流式回复：`stream_messages` 渐进输出

## [0.1.3] - 2026-08-19

### Added

- QQ webhook 回调模式；token 自动刷新

## [0.1.2] - 2026-08-19

### Fixed

- QQ bridge v2 协议（C2C / 群）+ 状态合并

## [0.1.1] - 2026-08-19

### Fixed

- 修复 QQ / Discord websocket `onerror` 崩溃

## [0.1.0] - 2026-08-19

- 首个版本：通用消息平台网关 —— 企业微信智能机器人 / Telegram / Discord / QQ / Email；每聊天独立 agent 会话 + 上下文自动压缩
