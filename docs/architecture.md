# dsh-message-gateway 架构与扩展指南

本插件是一个**通用 DSH 消息平台网关**：任何 DSH 用户安装后即可使用——在侧边栏
「消息平台」页面填入各平台凭据，即可保存凭据、测试连接、查看状态；其中
**企业微信智能机器人**（`wecom-aibot`）与 **Webhooks** 提供真实的消息收发能力，
其余平台（Telegram / Discord / QQ / 企业微信 / 微信 / 微信公众号 / WhatsApp / Email）
当前提供凭据管理与连接测试，可作为后续常驻连接的接入点。

## 模块结构

```
src/
├── index.ts                 # 插件入口：Config schema、路由挂载、桥自启动
├── core/
│   ├── config.ts            # 插件配置（schemastery，安装者可配置）
│   └── types.ts             # host 与 client 共享的类型（平台定义/状态/测试结果）
├── host/
│   ├── gateway-store.ts     # 凭据与状态存储 ~/.dsh/gateway.json（0600，原子写）
│   ├── platforms.ts         # 平台定义表 + 各平台连接测试（Node fetch/net）
│   ├── routes.ts            # /gateway/* 路由（list/save/delete/test/send/webhook）
│   ├── bridge-manager.ts    # 常驻桥管理：每聊天独立 agent 会话 + 流式回发
│   ├── wecom-bridge.ts      # 企业微信智能机器人 SDK 长连接生命周期
│   └── bot-i18n.ts          # 机器人回复文案（zh/en，由配置 botLocale 决定）
└── client/                  # 浏览器半区：侧边栏按钮 + 全屏管理页（React）
```

## 两半区

- **host 半区**（`lib/index.js`，Node）：路由、存储、连接测试、常驻桥。所需服务
  `webServer` / `sessions` / `agents`。
- **client 半区**（`lib/client.js`，浏览器）：侧边栏「消息平台」按钮 + 全屏管理页，
  经 `window.__ModuleLoader__` 闭包加载，三语（zh/en/es）。

## 数据流（企业微信智能机器人）

```
企业微信消息 → WS 长连接 (wecom-bridge)
  → 按 chatid/userid 路由（每聊天独立，自动新建会话）
  → 命令 (/help /time /status /new) 直接回复
  → 否则注入该聊天的独立 agent 会话 (agents.create，继承 root agent 配置)
  → agent 驱动 DSH 助手（与 Web 同一模型/工具）
  → 上下文超限时由 dsh-compaction-basic 自动摘要压缩（与 Web 一致）
  → 回复按 assistant/chunk 流式回发（replyStream），定稿 + response_url
```

## 配置项

| 配置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `botLocale` | `zh` \| `en` | `zh` | 机器人回复文案语言 |
| `maxChatAgents` | number | `40` | 每机器人最多保留的聊天会话数，超出自动淘汰最旧 |
| `botModel` | `{provider, model}` | 无 | 可选：机器人专用模型（优先于部署默认模型；不填则与 Web 对话一致） |
| `autoStartWecom` | boolean | `true` | 启动时用已保存的企业微信智能机器人凭据自动连接 |
| `autoStartTelegram` | boolean | `true` | 启动时用已保存的 Telegram Bot Token 自动连接 |
| `autoStartDiscord` | boolean | `true` | 启动时用已保存的 Discord Bot Token 自动连接 |
| `autoStartQQ` | boolean | `true` | 启动时用已保存的 QQ appId/secret 自动连接 |
| `autoStartEmail` | boolean | `true` | 启动时用已保存的 Email 凭据自动连接（IMAP 轮询） |
| `groupReply` | boolean | `true` | 是否回复群聊消息（false 时只处理单聊） |

## 扩展指南：新增一个平台连接器

把某个平台从「凭据 + 测试」升级为「常驻机器人」只需三步：

1. **常驻连接类**：仿照 `src/host/wecom-bridge.ts` 写一个 `XxxBridge`——持有平台
   SDK/长连接生命周期（`start/stop/status`），消息事件通过回调上抛：
   ```ts
   export interface XxxBridgeCallbacks {
     onStatus(status: BridgeStatus): void
     onText(text: string, frame: unknown): void
   }
   ```
2. **桥管理接入**：在 `src/host/bridge-manager.ts` 增加对应字段与方法
   （`startXxx(cred)` / `stopXxx()` / `xxxStatus()`），并在 `onText` 里复用
   现有的「每聊天独立会话 + 流式回发」管线（`ensureAgentForKey` + `pendingMap`），
   回复通道换成该平台的 `replyStream` 等价物。
3. **存储联动**：在 `src/host/routes.ts` 的 `/gateway/save` 与 `/gateway/delete`
   分支中，仿照 `wecom-aibot` 增加「保存即启动 / 删除即停止」；`src/index.ts` 的
   `autoStartXxx` 与平台配置开关同理。

测试函数在 `src/host/platforms.ts` 的 `testPlatform` 中增加 case，client 侧无需改动
（平台表单由 `PlatformDef` 表自动渲染）。

## 各平台能力矩阵

| 平台 | 凭据保存 | 连接测试 | 常驻机器人 |
| --- | :-: | :-: | :-: |
| 企业微信智能机器人 `wecom-aibot` | ✅ | ✅ | ✅ 对话/欢迎语/指令/群聊/主动推送 |
| Telegram | ✅ | ✅ | ✅ 长轮询 + 流式编辑回复 |
| Discord | ✅ | ✅ | ✅ WebSocket 网关 + 流式编辑回复（需开启 MESSAGE CONTENT 意图） |
| QQ | ✅ | ✅ | ✅ access_token + WebSocket 网关 + 被动回复/流式编辑 |
| 企业微信应用 `wecom` | ✅ | ✅ | ✅ 回调式（应用消息 API 回复；需公网 URL 配置回调） |
| 微信公众号 `wechat-mp` | ✅ | ✅ | ✅ 回调式（客服消息 API 回复；需公网 URL 配置回调） |
| WhatsApp | ✅ | ✅ | ✅ Webhook 式（Meta Cloud API 回复；需公网 URL 配置 Webhook） |
| Email | ✅ | ✅ | ✅ IMAP 轮询收件（993/143，TLS/STARTTLS）+ SMTP 回复（465/587/25）；按邮件线程归类会话，Re: 原主题 |
| Webhooks | ✅（可选签名） | — | ✅ `POST /gateway/webhook/in` 同步回复 |
| 微信（个人号） | ✅（外部 Wechaty 网关） | 状态轮询 | 需外部网关（[契约](wechaty-gateway.md)） |

> 所有常驻机器人的消息都走同一管线：每聊天独立 agent 会话 + 上下文自动压缩 +
> 斜杠命令 + @提及剥离，与 Web 对话一致。Telegram/Discord/QQ 的"流式回复"通过
> 先发送后渐进编辑（send + edit）实现，受平台限频保护（约 1 次/秒）。

## 回调型平台（企业微信应用 / 公众号 / WhatsApp）

这三类平台无长连接，由平台服务器向插件注册的回调端点推送消息（`src/host/callback-bridges.ts`）：

| 平台 | 端点 | 验证 | 回复通道 |
| --- | --- | --- | --- |
| 企业微信应用 | `GET/POST /gateway/wecom/callback` | `msg_signature`（SHA1 排序拼接）+ AES 解密 | 应用消息 API（`message/send`，access_token 缓存） |
| 微信公众号 | `GET/POST /gateway/wechat-mp/callback` | `signature`（SHA1 排序拼接） | 客服消息 API（`custom/send`） |
| WhatsApp | `GET/POST /gateway/whatsapp/webhook` | `hub.verify_token` | Meta Graph API `messages` |

用法：在消息平台页保存凭据（企业微信需额外填回调 Token 与 EncodingAESKey；公众号填回调 Token；
WhatsApp 的 Token 即 verify token）→ 在对应平台后台把回调 URL 指向 `公网地址 + 端点路径` →
用户发消息即自动对话（回执 + 完整回复经发送 API 异步送达；`/gateway/list` 显示端点路径）。
回调端点无需常驻连接，凭据保存即随时可用。

## 对外 HTTP 端点

| 端点 | 说明 |
| --- | --- |
| `POST /gateway/list` | 平台定义 + 状态（不含凭据明文） |
| `POST /gateway/save` / `delete` / `test` | 凭据管理 |
| `POST /gateway/send` | 以机器人身份主动推送 markdown 消息 |
| `POST /gateway/webhook/in` | Webhook 接收（签名校验，见 [webhooks.md](webhooks.md)） |
| `POST /gateway/wechat-status` | 外部 Wechaty 网关状态轮询 |

## 安全

- 凭据明文只落盘 `~/.dsh/gateway.json`（权限 0600，原子写入），`/gateway/list` 永不回传
- Webhook 可配置 HMAC-SHA256 签名密钥，constant-time 校验
- 机器人与网页会话完全隔离（独立 agent 会话），互不污染上下文