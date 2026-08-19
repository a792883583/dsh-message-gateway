# dsh-message-gateway

[中文](README.md) · [Español](README.es.md)

A message-platform gateway plugin for the DSH Web GUI: a "Message platforms" entry below the "New session" button opens a full-screen manager for multi-platform message connectors — credential save, connection tests, status monitoring — plus a built-in persistent bridge for the WeCom AI bot: external messages drive the DSH assistant through a dedicated agent session, and replies stream back token by token.

## Features

- **Sidebar entry**: a "📮 Message platforms" button below "New session" opens the full-screen manager (close with ESC or by clicking the backdrop)
- **Multi-platform connectors**: Telegram / Discord / QQ bot / WeCom / WeCom AI bot / WeChat (external Wechaty gateway) / WeChat Official Account / WhatsApp / Email / Webhooks
  - **Telegram bot**: save a Bot Token to enable long polling instantly; chat with the bot directly (streaming replies via send + progressive edit, same as web)
  - **Discord bot**: save a Bot Token to connect to the gateway (enable the MESSAGE CONTENT privileged intent in the developer portal); chat in channels or DMs
  - **QQ bot**: save appId + secret to connect to the open-platform gateway (channels/groups/DMs); passive replies + streaming edits
  - **WeCom app**: fill in CorpID/AgentID/Secret plus the callback Token/EncodingAESKey, configure the callback URL (`/gateway/wecom/callback`) in the admin console, and users who message the app get auto replies
  - **WeChat Official Account**: fill in AppID/Secret plus the callback Token, configure the server URL (`/gateway/wechat-mp/callback`) in the console, and followers who message get auto replies
  - **WhatsApp**: fill in Token + Phone Number ID, configure the webhook (`/gateway/whatsapp/webhook`) in the Meta console, and users who message get auto replies
  - **Email**: fill in IMAP (receiving, 993/143) + SMTP (replying, 465/587/25); messages are grouped into per-thread sessions and replies use Re: original subject
- **Credential management**: plaintext is persisted only to `~/.dsh/gateway.json` (mode 600, atomic write); `/gateway/list` never returns credential plaintext, only a `configured` flag
- **Connection tests**: real per-platform checks — Telegram/Discord via Bot API, QQ via access_token, WeCom via gettoken, WeChat MP via cgi-bin/token, WhatsApp via Graph API, Email via IMAP TCP banner, WeCom AI bot via the official SDK long connection (authenticated = pass)
- **WeCom AI bot persistent bridge**: official SDK WebSocket long connection with exponential backoff reconnect; incoming text messages are injected into an isolated dedicated agent session that wakes the DSH driver; replies stream back as chunks and finalize via `response_url`
  - **Group-chat @mention stripping**: the leading `@bot-name` is removed before the assistant sees the message
  - **Slash commands**: `/help` / `/time` / `/status` (Chinese aliases: 帮助/菜单/时间/状态)
  - **Enter-chat welcome**: a welcome message is auto-replied when a user enters a single chat for the first time that day
  - **Proactive send channel**: `POST /gateway/send` (`{"chatid": "...", "content": "..."}`, single chat = userid, group chat = group id) sends markdown messages as the bot
- **Webhook receive endpoint**: `POST /gateway/webhook/in` accepts messages from external systems (any of `text` / `content` / `message`), injects them into the dedicated agent session and returns the full reply synchronously; an optional HMAC-SHA256 signing secret validates requests (contract: [docs/webhooks.md](docs/webhooks.md))
- **WeChat personal accounts (optional external gateway)**: QR login and status polling against a local Wechaty HTTP gateway (contract: [docs/wechaty-gateway.md](docs/wechaty-gateway.md))
- **Multilingual**: Chinese / English / Español, following the DSH Web UI language (Spanish browsers auto-switch); defaults to Simplified Chinese
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

## License

MIT