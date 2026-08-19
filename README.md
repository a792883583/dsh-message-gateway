# dsh-message-gateway

[English](README.en.md) · [Español](README.es.md)

DSH Web GUI 的消息平台网关插件：在侧边栏「新会话」按钮下方提供「消息平台」入口，全屏管理多平台消息连接器——凭据保存、连接测试、状态监控，并内置企业微信智能机器人的常驻桥接：外部消息经专用 agent 会话驱动 DSH 助手，回复按 token 流式回发。

## 功能

- **侧边栏入口**：「新会话」按钮下方新增「📮 消息平台」按钮，点击打开全屏管理页（ESC / 点击遮罩关闭）
- **多平台连接器**：Telegram / Discord / QQ 机器人 / 企业微信 / 企业微信智能机器人 / 微信（外部 Wechaty 网关）/ 微信公众号 / WhatsApp / Email / Webhooks
  - **Telegram 机器人**：填 Bot Token 保存即启用长轮询，与机器人对话即可使用（流式回复：发送后渐进编辑，与 Web 一致）
  - **Discord 机器人**：填 Bot Token 保存即接入网关（需在开发者后台开启 MESSAGE CONTENT 意图），频道/私信直接对话
  - **QQ 机器人**：填 appId + secret 保存即连接开放平台网关（频道/群/私信），被动回复 + 流式编辑
  - **企业微信应用**：填 CorpID/AgentID/Secret + 回调 Token/EncodingAESKey，后台配置回调 URL（`/gateway/wecom/callback`）后发消息即自动对话
  - **微信公众号**：填 AppID/Secret + 回调 Token，后台配置服务器 URL（`/gateway/wechat-mp/callback`）后发消息即自动对话
  - **WhatsApp**：填 Token + Phone Number ID，Meta 后台配置 Webhook（`/gateway/whatsapp/webhook`）后发消息即自动对话
  - **Email**：填 IMAP（收件，993/143）+ SMTP（回复，465/587/25），按邮件线程自动归类会话，回复用 Re: 原主题
- **凭据管理**：明文只落盘 `~/.dsh/gateway.json`（权限 600，原子写入），`/gateway/list` 永不回传凭据明文，只返回 configured 标记
- **连接测试**：每个平台独立的真实连接测试——Telegram/Discord 走 Bot API、QQ 走 access_token、企微走 gettoken、微信公众号走 cgi-bin/token、WhatsApp 走 Graph API、Email 走 IMAP TCP banner、企微智能机器人走官方 SDK 长连接（认证成功即通过）
- **企业微信智能机器人常驻桥**：官方 SDK WebSocket 长连接，断线自动指数退避重连；收到文本消息 → 注入隔离的专用 agent 会话唤醒 DSH 驱动 → 回复按 chunk 流式回发，结束时经 response_url 定稿
  - **群聊 @提及剥离**：去掉开头的 @机器人名后交给助手
  - **斜杠命令**：`/help` / `/time` / `/status`（含中文别名：帮助/菜单/时间/状态）
  - **进入会话欢迎语**：用户当天首次进入单聊时自动回复欢迎消息
  - **主动发送通道**：`POST /gateway/send`（`{"chatid": "...", "content": "..."}`，单聊=userid，群聊=群 ID）以机器人身份主动发送 markdown 消息
- **Webhook 接收端点**：`POST /gateway/webhook/in` 接收外部系统消息（`text` / `content` / `message` 任一字段），注入专用 agent 会话并同步返回完整回复；可配置 HMAC-SHA256 签名密钥校验（契约见 [docs/webhooks.md](docs/webhooks.md)）
- **微信个人号（可选外部网关）**：对接本机 Wechaty HTTP 网关的扫码登录与状态轮询（契约见 [docs/wechaty-gateway.md](docs/wechaty-gateway.md)）
- **多语言**：中文 / English / Español，自动跟随 DSH Web 界面语言（西班牙语浏览器自动切换），默认简体中文
- 明暗主题跟随 DSH Web GUI

## 使用

1. 打开 DSH Web（`dsh web`），点击侧边栏「消息平台」按钮
2. 左侧选择平台，右侧填写凭据
3. 点击「保存」：凭据落盘并立即自动触发一次连接测试，状态即时刷新
4. 点击「测试连接」：用当前表单值只测不存
5. 企微智能机器人保存 `botId + secret` 后立即建立常驻连接；删除配置即断开

## 安装

```sh
# 从 npm 安装（通用插件，任何 DSH 用户可直接使用）
dsh plugin --profile web add dsh-message-gateway
```

重启 `dsh web`，侧边栏「新会话」按钮下方即出现「消息平台」按钮。打开页面，选择平台、
填入凭据并「保存」——企业微信智能机器人填 `botId + secret` 后立即建立常驻连接，即可
直接在企微里和机器人对话（与 Web 对话一致：每聊天独立会话 + 上下文自动压缩）。

## 配置

插件可通过 `dsh plugin config` 或 profile 配置文件调整（所有项均有默认值，开箱即用）：

| 配置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `botLocale` | `zh` \| `en` | `zh` | 机器人回复文案语言 |
| `maxChatAgents` | number | `40` | 每机器人最多保留的聊天会话数，超出自动淘汰最旧 |
| `botModel` | `{provider, model}` | 无 | 可选：机器人专用模型（优先于部署默认模型；不填则与 Web 对话一致） |
| `autoStartWecom` | boolean | `true` | 启动时自动用已保存的企业微信智能机器人凭据连接 |
| `groupReply` | boolean | `true` | 是否回复群聊消息（false 时只处理单聊） |

## 文档

- [架构与扩展指南](docs/architecture.md)（如何新增平台连接器）
- [Webhook 接收端点契约](docs/webhooks.md)
- [微信（Wechaty）HTTP 网关契约](docs/wechaty-gateway.md)

## 架构

- **host 半区**（`lib/index.js`）：`/gateway/*` 路由（list / save / delete / test / wechat-status）+ `BridgeManager`（agent 会话注入与事件流轮询）+ `WecomBridge`（SDK 长连接生命周期）+ `gateway-store`（凭据存储）
- **client 半区**（`lib/client.js`）：侧边栏按钮挂载 + 全屏平台管理页（React，经 `__ModuleLoader__` 闭包加载）

## License

MIT