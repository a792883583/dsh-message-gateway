# Changelog

本文件记录 `dsh-message-gateway` 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.29] - 2026-09-08

### Added

- **全外部消息通道自主免审批授权机制**：为企业微信、Telegram、Discord、Email、Webhook 等无头消息通道注入专属 `approval/policy: 'never'` 策略，彻底解除调用本地命令与开发工具时因网页端无人审批而无限死锁挂起的阻断，实现全自动化工具调用与执行闭环
- **长程任务滑动保活机制 (Sliding Idle Timeout)**：将旧版死板的 2 分钟固定超时重构为滑动保活模型，只要 Agent 持续有事件推进即自动顺延 90 秒静默超时，保障多工具复杂长程任务平稳执行至终局

### Fixed

- **多步骤流式消息累加防覆盖优化**：重构 `PendingReply` 流式聚合模型，各阶段思考与工具分析结论按步骤段落累加，杜绝后文覆盖冲刷前文历史
- **三语动态状态指示**：中间步骤停顿时动态展示状态感知提示（中：`⏳ 正在处理中，请稍候…` / 英：`⏳ Processing, please wait…` / 西：`⏳ Procesando, por favor espere…`），定稿时自动无痕剥离
- **全平台优雅关机与秒速重连**：系统级捕获退出信号向各平台远端主动发送 Close 帧，消除 30 秒连接互斥排队锁，实现 1~2 秒秒速重新上线

## [0.1.28] - 2026-09-08

### Added

- **多步骤动态进度感知与三语支持**：在复杂长程任务（如调研、代码重构、多工具联动）执行期间，AI 在中间步骤停顿等待工具执行时，流式输出底部自动展示优雅的斜体状态感知提示（中：`⏳ 正在处理中，请稍候…` / 英：`⏳ Processing, please wait…` / 西：`⏳ Procesando, por favor espere…`），任务完全收敛定稿（`turn/end`）时自动无痕剥离，杜绝用户误判 AI 已中断或卡死

### Fixed

- **跨步骤流式消息累加防覆盖修复**：重构 `PendingReply` 流式聚合模型，引入 `stepMessages` 步骤数组机制；AI 在各阶段输出的中间思考过程与后续工具分析结论分段持久化累加，彻底根除后续消息覆盖冲刷掉前文历史的问题
- **全平台进程级优雅退出与秒速重连**：注册系统退出信号监听（`SIGTERM` / `SIGINT` / `beforeExit`），在重启或关闭时全量平台（企业微信、Telegram、Discord、Email、QQ）并发主动发送断开握手帧，瞬间释放第三方服务端的连接互斥锁，彻底告别重启后长达 30 秒的僵尸连接排队等待期，实现 1~2 秒内秒速上线

## [0.1.27] - 2026-09-08

### Fixed

- **会话事件流适配官方 `snapshotEvents()` 接口**：DSH 内部 `Session` 实例无 `session.events` 属性，应调用官方 `session.snapshotEvents()` 读取不可变事件快照；修复后企微机器人能即时感知 AI 思考及回复流，彻底恢复秒级响应与正常回传

## [0.1.26] - 2026-09-08

### Fixed

- **企微机器人消息轮询崩溃修复**：`pollPending` 在会话刚初始化或异步未就绪时直接读取 `session.events.length` 导致 `TypeError: Cannot read properties of undefined (reading 'length')`，进而在未捕获异步定时器中导致 Node.js 主进程崩溃重启；现增加安全空值断言、类型收窄与定时器内部 `try...catch` 兜底保护，彻底根治发消息触发 dsh web 重启问题

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
