# Webhook 接收端点契约

「消息平台」的 Webhooks 平台提供一个本地 HTTP 接收端点：外部系统 POST 一条文本消息，
插件将其注入隔离的专用 agent 会话，驱动 DSH 助手生成回复，并在同一 HTTP 响应中同步返回。

## 端点

### `POST /gateway/webhook/in`

**请求体（`application/json`）**——三种字段任选其一：

```jsonc
{ "text": "帮我总结一下这个仓库的 README" }
// 或 { "content": "..." }
// 或 { "message": "..." }
```

**请求头**

| 头 | 说明 |
| --- | --- |
| `Content-Type: application/json` | 必填 |
| `X-Gateway-Signature` | 配置了签名密钥时必填：`hex(HMAC-SHA256(secret, 原始请求体))` |

**响应（成功，HTTP 200）**

```jsonc
{ "ok": true, "value": { "reply": "这是助手生成的完整回复……" } }
```

**错误响应**

| HTTP | 场景 |
| --- | --- |
| `400` | 请求体为空 / 缺少 `text` / `content` / `message` 字段或全部为空 |
| `401` | 配置了签名密钥但 `X-Gateway-Signature` 缺失或不匹配 |
| `409` | 另一条外部消息正在处理中（单槽位，请求被拒绝） |
| `500` | 专用 agent 不可用等内部错误 |

## 签名校验

- 在「消息平台」页面为 **Webhooks** 平台保存「签名密钥」后，端点要求每个请求携带
  `X-Gateway-Signature` 头
- 签名 = `HMAC-SHA256(secret, rawBody)` 的十六进制小写字符串（对**原始请求体**计算，不是 JSON 序列化后的字符串）
- 未配置签名密钥时端点完全开放（任何请求体都会被处理）

### 签名示例（Node）

```ts
import { createHmac } from 'node:crypto'

const secret = 'your-saved-signing-secret'
const body = JSON.stringify({ text: '你好' })
const signature = createHmac('sha256', secret).update(body).digest('hex')

await fetch('http://127.0.0.1:3080/gateway/webhook/in', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-gateway-signature': signature },
  body,
})
```

### 签名示例（curl）

```sh
SECRET='your-saved-signing-secret'
BODY='{"text":"你好"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -X POST http://127.0.0.1:3080/gateway/webhook/in \
  -H 'content-type: application/json' \
  -H "x-gateway-signature: $SIG" \
  -d "$BODY"
```

## 说明

- 回复为同步等待：插件轮询专用 agent 会话的事件流直至出现完整回复（默认 90 秒超时）
- 同一时间只处理一条外部消息：Webhook 与企微智能机器人共享同一个专用 agent 会话与单槽位
- 端点挂在 DSH Web 的共享 webserver 上（默认 `http://127.0.0.1:3080`）；如需接收公网请求，
  需自行配置反代 / 内网穿透