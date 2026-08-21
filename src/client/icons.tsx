/**
 * 线性 SVG 图标集（iconfont 风格，24×24 viewBox，stroke 线条）。
 * 替代平台 emoji 与文本图标，视觉更精细统一。
 * @module dsh-message-gateway/client/icons
 */

import { createElement } from 'react'

/** 通用线性图标骨架。 */
function Icon(props: {
  d: string
  size?: number
  strokeWidth?: number
  fill?: string
  extra?: string
  title?: string
}): React.ReactElement {
  const { d, size = 18, strokeWidth = 1.6, fill = 'none', extra = '', title } = props
  return createElement(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill,
      stroke: 'currentColor',
      strokeWidth,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': title === undefined ? true : undefined,
      ...(extra !== '' ? { className: extra } : {}),
    },
    title !== undefined ? createElement('title', null, title) : null,
    createElement('path', { d }),
  )
}

/** 收件箱（侧边栏「消息平台」入口）。 */
export const InboxIcon = (props: { size?: number; title?: string }): React.ReactElement =>
  Icon({ d: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z', ...props })

/** Telegram 纸飞机。 */
export const TelegramIcon = (props: { size?: number }): React.ReactElement =>
  Icon({ d: 'M21.5 4.5l-18 7 5 1.8M21.5 4.5L15 20l-3.5-6.7M8.5 13.3L21.5 4.5', ...props })

/** Discord 游戏手柄。 */
export const DiscordIcon = (props: { size?: number }): React.ReactElement =>
  Icon({ d: 'M6 3l-3 4v11a1 1 0 0 0 1 1h3l1-2 2 1 2-1 2 1 2-1 1 2h3a1 1 0 0 0 1-1V7l-3-4H6zM9 12a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm6 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z', ...props })

/** QQ 聊天气泡。 */
export const QqIcon = (props: { size?: number }): React.ReactElement =>
  Icon({ d: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-.9 0-1.8-.1-2.6-.4L5 21l1-3.5A8.5 8.5 0 1 1 21 11.5zM8.5 10.5h.01M15.5 10.5h.01M8.5 14c.7.8 2 1.3 3.5 1.3s2.8-.5 3.5-1.3', ...props })

/** 企业微信（楼宇 + 气泡）。 */
export const WecomIcon = (props: { size?: number }): React.ReactElement =>
  Icon({ d: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01M12 9v.01M12 13v.01M12 17v.01', ...props })

/** 智能机器人。 */
export const BotIcon = (props: { size?: number }): React.ReactElement =>
  Icon({ d: 'M12 8V4M8 4h8M12 20c-4 0-6-2-6-5v-3c0-3 2-5 6-5s6 2 6 5v3c0 3-2 5-6 5zM9 13h.01M15 13h.01', ...props })

/** 微信（对话气泡 + 微信绿点）。 */
export const WechatIcon = (props: { size?: number }): React.ReactElement =>
  Icon({ d: 'M9 4a5 5 0 0 0 0 10 4.6 4.6 0 0 0 2-.5l2 .8-1-1.6a5 5 0 0 0 3-3.2A5 5 0 0 0 9 4zM17 11a5 5 0 0 0-4 2.1A5 5 0 0 1 9 11.6 5 5 0 0 1 14 8a5 5 0 0 1 3 3z', ...props })

/** 微信公众号（报纸 + 频道）。 */
export const MpIcon = (props: { size?: number }): React.ReactElement =>
  Icon({ d: 'M4 5h16v14H4zM4 9h16M8 13h5M8 16h8', ...props })

/** WhatsApp 电话气泡。 */
export const WhatsappIcon = (props: { size?: number }): React.ReactElement =>
  Icon({ d: 'M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3zM9 8c.3 1.5 1.5 3 3 4 .5.3 1 .6 1.6.7.4.1.9-.2 1.1-.6l.3-.6c.2-.4.6-.3 1-.1l1 .5c.4.2.6.6.5.9-.1.8-.9 1.5-1.7 1.4-2.4-.2-4.6-1.4-6-3.1A6 6 0 0 1 8 9c0-.8.6-1.5 1.4-1.7.3-.1.6.1.7.4L9 8z', ...props })

/** Email 信封。 */
export const EmailIcon = (props: { size?: number }): React.ReactElement =>
  Icon({ d: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm0 2l8 6 8-6', ...props })

/** Webhook 挂钩。 */
export const WebhookIcon = (props: { size?: number }): React.ReactElement =>
  Icon({ d: 'M18 8a3 3 0 0 1 3 3c0 1-.5 1.9-1.3 2.4M12 4l3 6M4 14l3-6M6 8a3 3 0 0 1 3 3c0 .8-.3 1.5-.8 2M4 14h8a2 2 0 0 1 2 2 2 2 0 0 1-2 2H4a2 2 0 0 1-2-2 2 2 0 0 1 2-2z', ...props })

/** 平台 id → 线性图标。 */
export const PlatformIcon = (props: { platform: string; size?: number }): React.ReactElement => {
  const { platform, size } = props
  switch (platform) {
    case 'telegram': return createElement(TelegramIcon, { size })
    case 'discord': return createElement(DiscordIcon, { size })
    case 'qq': return createElement(QqIcon, { size })
    case 'wecom': return createElement(WecomIcon, { size })
    case 'wecom-aibot': return createElement(BotIcon, { size })
    case 'wechat': return createElement(WechatIcon, { size })
    case 'wechat-mp': return createElement(MpIcon, { size })
    case 'whatsapp': return createElement(WhatsappIcon, { size })
    case 'email': return createElement(EmailIcon, { size })
    case 'webhooks': return createElement(WebhookIcon, { size })
    default: return createElement(InboxIcon, { size })
  }
}