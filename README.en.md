# dsh-message-gateway

[中文](README.md) · [Español](README.es.md)

![dsh-message-gateway UI Preview](assets/screenshot.png)

A message-platform gateway plugin for the DSH Web GUI: a "Message platforms" entry below the "New session" button opens a full-screen manager for multi-platform message connectors — credential save, connection tests, status monitoring — plus a built-in persistent bridge for the WeCom AI bot: external messages drive the DSH assistant through a dedicated agent session, and replies stream back token by token. Also provides a universal proactive messaging API supporting Markdown text and native image attachments.

## Features

- **Sidebar entry**: a "📮 Message platforms" button below "New session" opens the full-screen manager (close with ESC or by clicking the backdrop)
- **Multi-platform connectors**: Telegram / Discord / QQ bot / WeCom / WeCom AI bot / WeChat (external Wechaty gateway) / WeChat Official Account / WhatsApp / Email / DingTalk / Feishu / Bark / ServerChan / Webhooks
  - **WeCom AI bot**: fill in `botId + secret` to establish an official SDK WebSocket connection; supports streaming replies, media upload, and **proactive image/file push**
  - **Telegram bot**: save a Bot Token to enable long polling, supporting text streaming and `sendPhoto` **proactive image push**
  - **Discord bot**: save a Bot Token to connect via Gateway, supporting channels/DMs and `files` attachment **proactive image push**
  - **DingTalk Bot**: configure custom bot Webhook & optional HMAC Secret; supports Markdown text and public image URL rendering
  - **Feishu / Lark Bot**: configure custom bot Webhook & optional Secret signature for text and card delivery
  - **Bark (iOS)**: fill in Device Key for instant push notifications with rich image banners (public URL)
  - **ServerChan**: fill in SendKey for push notifications to WeChat / mobile channels with Markdown image URLs
  - **QQ bot**: save appId + secret to connect to the open-platform gateway; passive replies + streaming edits
  - **WeCom app**: fill in CorpID/AgentID/Secret plus callback Token/EncodingAESKey for auto-dialogues
  - **WeChat Official Account**: fill in AppID/Secret plus callback Token for follower dialogues
  - **WhatsApp**: fill in Token + Phone Number ID for WhatsApp webhook dialogues
  - **Email**: fill in IMAP (993/143) + SMTP (465/587/25) for threaded email conversations
- **Universal proactive push channel**: `POST /gateway/push` (for cron jobs, automation scripts, and pipelines):
  - Request body:
    - `platform`: target platform (`wecom-aibot` / `telegram` / `discord` / `dingtalk` / `feishu` / `bark` / `serverchan` / `email`)
    - `target`: destination target (single-chat userid or group id for `wecom-aibot`; numeric chatId for `telegram`; channelId for `discord`; deviceKey for `bark`, etc.)
    - `content`: optional text content (supports Markdown)
    - `title`: optional title (email subject or notification prefix)
    - `image`: optional image data (**Base64** data or accessible `http(s)://` image URL)
    - `filename`: optional image filename (defaults to `image.png`)
  - Highlights:
    - Text and image can be pushed together or separately
    - `wecom-aibot`, `telegram`, and `discord` support uploading raw local binary buffers directly
    - `bark`, `dingtalk`, and `serverchan` automatically adapt to public image URLs
- **Credential management**: plaintext is persisted only to `~/.dsh/gateway.json` (mode 600, atomic write); `/gateway/list` never returns credential plaintext, only a `configured` flag
- **Secret redaction**: message content written to logs / console is automatically masked for likely secrets (`sk-` prefixed keys, GitHub tokens, `Bearer`, `password=` assignments, PEM private keys, and other common patterns), so secrets in bot conversations never leak into log files
- **Connection tests**: real per-platform checks — Telegram/Discord via Bot API, QQ via access_token, WeCom via gettoken, WeChat MP via cgi-bin/token, WhatsApp via Graph API, Email via IMAP TCP banner, WeCom AI bot via the official SDK long connection (authenticated = pass)
- **WeCom AI bot persistent bridge**: official SDK WebSocket long connection with exponential backoff reconnect; incoming text messages are injected into an isolated dedicated agent session that wakes the DSH driver; replies stream back as chunks and finalize via `response_url`
  - **Multi-step stream accumulation without overwrite**: in multi-step/complex agent tasks, earlier reasoning paragraphs are accumulated cleanly without being overwritten by later outputs; intermediate pauses display a dynamic status hint (`⏳ Processing, please wait…`) which is stripped upon completion
  - **Graceful shutdown & instant reconnect**: catches process termination signals to perform proper handshake disconnects across all platforms, eliminating 30-second zombie connection timeouts and allowing re-connections in 1–2 seconds
  - **Group-chat @mention stripping**: the leading `@bot-name` is removed before the assistant sees the message
  - **Slash commands**: `/help` / `/time` / `/status` / `/stats` (Chinese aliases: 帮助/菜单/时间/状态/统计)
  - **Enter-chat welcome**: optional configuration (`welcomeReply`, defaults to `false` for zero disturbance; when set to `true`, auto-replies a greeting when a user enters single chat for the first time that day)
  - **Proactive send channel**: `POST /gateway/send` (`{"chatid": "...", "content": "..."}`) sends markdown messages as the bot
  - **Message routing rules** (plugin config `routes`): route messages by "platform + keyword prefix" to a specific **agent preset** (isolated session) with an optional **dedicated model / skill**
  - **Agent push tool** (`send_chat_message`): automatically registers a universal message-pushing tool for DSH agents, allowing AI assistants to proactively send summaries, task results, or alerts (including screenshots and text) to WeCom, Telegram, Discord, DingTalk, etc.
- **Webhook receive endpoint**: `POST /gateway/webhook/in` accepts messages from external systems, injects them into the dedicated agent session and returns the full reply synchronously; optional HMAC-SHA256 signature validation
- **Multilingual**: Chinese / English / Español, following the DSH Web UI language; defaults to Simplified Chinese
- Light / dark theme follows the DSH Web GUI

## Usage

1. Open DSH Web (`dsh web`) and click the "Message platforms" button in the sidebar
2. Pick a platform on the left, fill in credentials on the right
3. Click **Save**: credentials are persisted and a connection test runs automatically, refreshing the status immediately
4. Click **Test connection**: tests the current form values without saving
5. Saving `botId + secret` for the WeCom AI bot establishes the persistent bridge right away; deleting the config disconnects it

## Install

```sh
# From npm (generic plugin, usable by any DSH user)
dsh plugin --profile web add dsh-message-gateway
```

Restart `dsh web` — the "Message platforms" button appears below "New session" in the sidebar. Open the page, pick a platform, fill in credentials and click **Save** — for the WeCom AI bot, saving `botId + secret` establishes the persistent bridge immediately and you can chat with the bot in WeCom right away (same as web: per-chat sessions + automatic context compression).

## Config

All options have defaults and the plugin works out of the box; tune them via `dsh plugin config` or the profile config file:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `botLocale` | `zh` \| `en` | `zh` | Bot reply language |
| `maxChatAgents` | number | `40` | Max chat sessions kept per bot; oldest is evicted beyond this |
| `autoStartWecom` | boolean | `true` | Auto-connect the WeCom AI bot from saved credentials at startup |
| `groupReply` | boolean | `true` | Reply to group messages (false = single chats only) |

## Docs

- [Architecture & extension guide](docs/architecture.md) (how to add a platform connector)
- [Webhook receive endpoint contract](docs/webhooks.md)
- [WeChat (Wechaty) HTTP gateway contract](docs/wechaty-gateway.md)

## Architecture

- **Host half** (`lib/index.js`): `/gateway/*` routes (list / save / delete / test / wechat-status) + `BridgeManager` (agent session injection and event-stream polling) + `WecomBridge` (SDK long-connection lifecycle) + `gateway-store` (credential persistence)
- **Client half** (`lib/client.js`): sidebar button mount + full-screen platform manager (React, loaded via the `__ModuleLoader__` closure)

## Feedback

Found a bug or have a feature request? Open an issue on [GitHub Issues](https://github.com/a792883583/dsh-message-gateway/issues) — your feedback helps us make the plugin better.

## License

MIT