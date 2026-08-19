/**
 * 机器人回复文案（host 侧 i18n）：语言由插件配置 botLocale 决定，
 * 让任何语言环境的安装者都能使用本插件。
 * @module dsh-message-gateway/host/bot-i18n
 */

import type { BotLocale } from '../core/config.ts'

type Messages = Record<string, string>

const MSGS: Record<BotLocale, Messages> = {
  zh: {
    ack: '正在处理…',
    busy: '⏳ 上一条消息还在处理中，请稍后再试',
    noAgent: '⚠️ DSH 助手暂不可用，请稍后再试',
    welcome:
      '您好！我是智能助手 🤖\n\n' +
      '- 直接发消息和我 AI 对话\n' +
      '- 每个聊天自动拥有独立会话，上下文超长自动压缩，和 Web 对话一致\n' +
      '- 输入 /help 查看全部指令',
    help:
      '🤖 **智能助手指令**\n' +
      '- 直接发消息 → AI 对话（与 Web 一致：独立会话 + 自动压缩）\n' +
      '- `/new` 或 `/clear` → 开启新会话（清空本聊天上下文）\n' +
      '- `/time` → 当前时间\n' +
      '- `/status` → 查看机器人状态\n' +
      '- `/help` → 查看指令',
    newOk: '✅ 已开启新会话，之前的对话上下文已清空',
    newIdle: 'ℹ️ 当前会话已是新会话',
    timeout: '⚠️ 回复超时了，请稍后再试一次',
    statusTitle: '📡 **机器人状态**',
    statusOnline: '✅ 在线',
    statusOffline: '❌ 离线',
    statusBotId: 'BotID',
    statusChats: '活跃会话',
    statusAgent: 'DSH 助手',
    statusTime: '时间',
    statusAvailable: '可用',
    statusUnavailable: '不可用',
    timePrefix: '🕐',
  },
  en: {
    ack: 'Processing…',
    busy: '⏳ Still processing your previous message, please wait',
    noAgent: '⚠️ DSH assistant is unavailable, please try again later',
    welcome:
      'Hi! I am your AI assistant 🤖\n\n' +
      '- Chat with me directly\n' +
      '- Each chat gets its own session; long contexts are auto-compressed, same as the web\n' +
      '- Type /help for all commands',
    help:
      '🤖 **Assistant commands**\n' +
      '- Send a message → AI chat (same as web: own session + auto compression)\n' +
      '- `/new` or `/clear` → start a new session (clear this chat context)\n' +
      '- `/time` → current time\n' +
      '- `/status` → bot status\n' +
      '- `/help` → this help',
    newOk: '✅ New session started, previous context cleared',
    newIdle: 'ℹ️ This chat already has a fresh session',
    timeout: '⚠️ Reply timed out, please try again in a moment',
    statusTitle: '📡 **Bot status**',
    statusOnline: '✅ Online',
    statusOffline: '❌ Offline',
    statusBotId: 'Bot ID',
    statusChats: 'Active chats',
    statusAgent: 'DSH assistant',
    statusTime: 'Time',
    statusAvailable: 'available',
    statusUnavailable: 'unavailable',
    timePrefix: '🕐',
  },
}

/** 取当前语言的文案。 */
export function botText(locale: BotLocale, key: string): string {
  return MSGS[locale][key] ?? MSGS.zh[key] ?? key
}