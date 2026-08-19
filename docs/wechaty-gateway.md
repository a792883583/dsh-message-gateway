# 微信（Wechaty）HTTP 网关契约

本插件不内置微信个人号连接器（需第三方框架，如 Wechaty + wechaty-puppet-wechat 扫码登录），
而是通过一个**本机 HTTP 网关**对接。在「消息平台」页面配置微信平台的 `gatewayUrl` 与可选
`token` 后，插件会轮询该网关获取登录状态 / 二维码。

## 端点

### `GET {gatewayUrl}/status`

返回当前登录状态。`gatewayUrl` 以用户在表单中填写的值（结尾 `/` 会被去除）为准。

**请求头**

| 头 | 说明 |
| --- | --- |
| `Accept: application/json` | 固定发送 |
| `Authorization: Bearer <token>` | 仅在配置了 `token` 时发送 |

**响应（HTTP 200，`application/json`）**

```jsonc
{
  "loggedIn": false,          // 是否已登录
  "name": "",                 // 已登录时的微信昵称（未登录可为空）
  "qrcode": "base64...",      // 未登录时的登录二维码（base64 图片，可空）
  "qrcodeUrl": "https://..."  // 二维码图片 URL（可空，优先展示）
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `loggedIn` | boolean | 是否已登录 |
| `name` | string | 已登录时的账号昵称 |
| `qrcode` | string \| null | 登录二维码（base64） |
| `qrcodeUrl` | string \| null | 登录二维码图片 URL |

**非 200 响应**：插件记录 `HTTP <status>` 并标记为「未登录」；请求失败（网络错误 / 超时，
超时 8 秒）记录错误消息。

## 最小实现示例（Node）

```ts
import { createServer } from 'node:http'

let loggedIn = false
let name = ''
let qrcode = 'data:image/png;base64,...' // 由 wechaty getQrCode() 生成

createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ loggedIn, name, qrcode: loggedIn ? null : qrcode, qrcodeUrl: null }))
    return
  }
  res.writeHead(404).end()
}).listen(8787, () => console.log('wechaty gateway: http://127.0.0.1:8787'))
```

插件侧填入 `gatewayUrl = http://127.0.0.1:8787` 即可在「消息平台」页面看到扫码二维码与登录状态。

## 说明

- 状态由插件以请求驱动轮询（保存 / 打开页面时查询），不是推送
- `token` 为可选的网关访问令牌；网关需自行校验 `Authorization: Bearer` 头
- 凭据（含 `token`）只存 `~/.dsh/gateway.json`，不回传浏览器