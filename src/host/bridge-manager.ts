/**
 * 桥接管理：维护各平台常驻连接（企业微信智能机器人 / Telegram / Discord 等）。
 * 所有平台消息走同一管线——每个聊天（平台:chatKey）自动创建独立 agent 会话，
 * 与 Web 对话完全一致：上下文超限时由 DSH 内置压缩服务（dsh-compaction-basic）
 * 自动摘要压缩；助手回复按 token 流（assistant/chunk）节流推送回平台，结束时定稿。
 * @module dsh-message-gateway/host/bridge-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { TextMessage, WsFrame } from '@wecom/aibot-node-sdk'
import type { StoredStatus } from './gateway-store.ts'
import type { GatewayConfig } from '../core/config.ts'
import { botText } from './bot-i18n.ts'
import { WecomBridge, type BridgeStatus } from './wecom-bridge.ts'
import { TelegramBridge } from './telegram-bridge.ts'
import { DiscordBridge } from './discord-bridge.ts'
import { QQBridge } from './qq-bridge.ts'
import { EmailBridge, type EmailCred } from './email-bridge.ts'

/** 每个聊天最多保留的独立会话数（超出后淘汰最早创建的，释放上下文）。 */
const DEFAULT_MAX_CHAT_AGENTS = 40

/** 流式推送合并间隔（毫秒）：避免逐 token 高频全量更新，保持平台端平滑。 */
const STREAM_PUSH_INTERVAL = 600

/** ack 心跳间隔（毫秒）：模型长思考期间周期性刷新回执，避免「假死」。 */
const ACK_HEARTBEAT_INTERVAL = 4000

/** 平台回复通道抽象：流式（send + edit 或原生流）+ 可选 HTTP 定稿（response_url 类）。 */
export interface ReplySink {
  /** 流式/完整回复。finish=true 表示定稿（流式平台结束编辑，非流式平台直接发送）。 */
  stream(frame: unknown, streamId: string, content: string, finish: boolean): void
  /** 可选：独立的 HTTP 定稿通道（如企业微信 response_url）。 */
  post?(frame: unknown, content: string): Promise<boolean>
  /** 平台是否需要「正在处理…」即时回执（邮件等会一封回一封的平台可关闭）。 */
  ack?: boolean
}

/** 一条外部消息的会话身份（跨平台唯一）。 */
export interface ChatIdentity {
  /** 跨平台唯一键：`${platform}:${chatKey}`（如 wecom:user:xxx / telegram:123 / discord:456）。 */
  key: string
  frame: unknown
  sink: ReplySink
  chatType: 'single' | 'group'
}

/** 一条等待回复的注入请求（每个聊天独立，互不阻塞）。 */
interface PendingReply {
  frame: unknown
  sink: ReplySink
  streamId: string
  buffer: string
  /** 已消费到的事件序号（事件快照按 seq 顺序推进）。 */
  cursor: number
  /** 轮询定时器。 */
  timer: ReturnType<typeof setInterval> | null
  /** 兜底清理定时器。 */
  fallback: ReturnType<typeof setTimeout> | null
  pushed: boolean
  httpDelivered: boolean
  /** 是否已发出「正在处理…」回执（用于超时兜底时收尾流式消息）。 */
  ackSent: boolean
  /** 上次流式推送时间戳（合并限频）。 */
  lastPush: number
  /** 请求发起时间戳（ack 心跳显示已等待秒数）。 */
  startedAt: number
  /** ack 心跳定时器（长思考期间周期性刷新「正在处理… N 秒」）。 */
  heartbeat: ReturnType<typeof setInterval> | null
}

/** 平台 id → 常驻桥。 */
export class BridgeManager {
  private wecom: WecomBridge | null = null
  private onStatusCallback: ((status: BridgeStatus) => void) | null = null
  /** 各聊天在途回复（key = 平台:chatKey）。 */
  private pendingMap = new Map<string, PendingReply>()
  /** Webhook 在途请求（同步等待完整回复；全局单槽位）。 */
  private awaiting: { resolve: (reply: string) => void } | null = null
  /** 各聊天的独立 agent 会话（key = 平台:chatKey；webhook 固定 'webhook'）。 */
  private agents = new Map<string, { agent: Agent; dispose: () => Promise<void> }>()

  constructor(
    private readonly ctx: Context,
    private readonly config: GatewayConfig,
  ) {
    // 回复回传通过轮询会话事件快照完成：scoped 事件（session/event）在全局
    // 上下文收不到，而 session.events 是 append-only 快照，按 seq 推进即可。
  }

  /** 当前语言的文案。 */
  private t(key: string): string {
    return botText(this.config.botLocale, key)
  }

  /** 轮询注入会话的事件流：chunk → 流式推送；assistant/message → 定稿 + HTTP。 */
  private pollPending(key: string, p: PendingReply, session: { events: readonly SessionEvent[] }): void {
    const events = session.events
    for (let i = p.cursor; i < events.length; i += 1) {
      p.cursor = i + 1
      const event = events[i]
      if (event.type === 'assistant/chunk') {
        const chunk = (event as SessionEvent<'assistant/chunk'>).data.chunk
        if (chunk.type === 'text-delta') {
          p.buffer += chunk.text
          this.scheduleStream(p)
        }
        continue
      }
      if (event.type === 'assistant/message') {
        const text = extractText((event as SessionEvent<'assistant/message'>).data.message)
        // 跳过空消息与纯工具调用消息：工具调用轮/中间步骤会产出空 assistant/message
        // 或整段 XML 工具调用文本，真正完成时才有可发送的正文。
        if (text === '' || isToolCallOnly(text)) continue
        p.buffer = text
        const streamed = p.pushed
        console.log('[dsh-message-gateway] assistant done', { key, seq: event.seq, len: p.buffer.length })
        void this.pushStream(p, true)
        void this.deliverHttp(p, streamed)
        this.finishPending(key)
        return
      }
      if (event.type === 'turn/end') {
        // 兜底定稿：有内容且未收到 assistant/message 时结束流；空则继续等下一轮。
        if (p.buffer !== '' && p.pushed) {
          void this.pushStream(p, true)
          this.finishPending(key)
          return
        }
      }
    }
  }

  /** 流式推送：随轮询节奏（每 400ms 一次）全量更新，避免高频发送。 */
  private scheduleStream(p: PendingReply): void {
    void this.pushStream(p, false)
  }

  private pushStream(p: PendingReply, finish: boolean): void {
    if (p.buffer === '' && !finish) return
    const now = Date.now()
    // 合并限频：距上次推送不足间隔时跳过本次，内容已累积在 buffer，
    // 由下一次推送（或定稿）全量带出——平台端更新平滑，不逐 token 轰炸。
    if (!finish && p.lastPush !== 0 && now - p.lastPush < STREAM_PUSH_INTERVAL) return
    p.lastPush = now
    p.pushed = true
    console.log('[dsh-message-gateway] stream push', { finish, len: p.buffer.length })
    p.sink.stream(p.frame, p.streamId, p.buffer, finish)
  }

  /** 经平台 HTTP 定稿通道发送完整回复（幂等；流式已投递时不重复发）。 */
  private async deliverHttp(p: PendingReply, streamed: boolean): Promise<void> {
    if (p.httpDelivered || p.sink.post === undefined || streamed) return
    p.httpDelivered = true
    try {
      await p.sink.post(p.frame, p.buffer)
    } catch (error) {
      console.error('[dsh-message-gateway] post delivery failed', error)
    }
  }

  private finishPending(key: string): void {
    const p = this.pendingMap.get(key)
    if (p === undefined) return
    if (p.timer !== null) {
      clearInterval(p.timer)
      p.timer = null
    }
    if (p.fallback !== null) {
      clearTimeout(p.fallback)
      p.fallback = null
    }
    if (p.heartbeat !== null) {
      clearInterval(p.heartbeat)
      p.heartbeat = null
    }
    this.pendingMap.delete(key)
    // 只发过「正在处理…」但从未产出内容 → 以超时文案收尾流式消息。
    if (p.ackSent && !p.pushed) {
      void p.sink.stream(p.frame, p.streamId, this.t('timeout'), true)
    }
  }

  /** 桥状态变化回调（供路由同步存储）。 */
  onStatus(fn: (status: BridgeStatus) => void): void {
    this.onStatusCallback = fn
  }

  /** 创建/获取某聊天的独立 agent：独立会话 + 模型配置（默认跟随部署，可被 botModel 覆盖）。 */
  private async ensureAgentForKey(key: string): Promise<Agent | null> {
    const existing = this.agents.get(key)
    if (existing !== undefined) return existing.agent
    // 模型来源：优先插件配置 botModel（机器人专用快速模型），其次部署默认模型选择
    // （agentDefaultModel，与 dsh-headless 同源），最后回退已注册根 agent 的配置。
    const override = this.config.botModel
    let selection: { provider: string; model: string } | undefined
    if (override !== undefined && override.provider !== '' && override.model !== '') {
      selection = { provider: override.provider, model: override.model }
    } else {
      const defaultModel = (this.ctx as { get?: (name: string) => unknown }).get?.('agentDefaultModel') as
        | { currentSelection(): { provider: string; model: string } }
        | undefined
      selection = defaultModel?.currentSelection()
    }
    let provider = selection?.provider ?? ''
    let model = selection?.model ?? ''
    // 兜底：服务不可用时回退已注册根 agent 的模型配置。
    if (provider === '' || model === '') {
      const root = this.ctx.agents.roots()[0] ?? this.ctx.agents.list()[0]
      provider = root?.options.provider ?? ''
      model = root?.options.model ?? ''
    }
    if (provider === '' || model === '') {
      console.warn('[dsh-message-gateway] no model selection available (botModel/agentDefaultModel/roots)')
      return null
    }
    // 上限保护：超出后淘汰最早创建的会话（Map 按插入序迭代）。
    if (this.agents.size >= (this.config.maxChatAgents > 0 ? this.config.maxChatAgents : DEFAULT_MAX_CHAT_AGENTS)) {
      const oldestKey = this.agents.keys().next().value as string | undefined
      if (oldestKey !== undefined) {
        const oldest = this.agents.get(oldestKey)
        this.agents.delete(oldestKey)
        void oldest?.dispose().catch(() => { /* 忽略 */ })
        console.log('[dsh-message-gateway] evict oldest chat session', { key: oldestKey })
      }
    }
    try {
      // 仿 dsh-headless：随机会话 id + 当前工作目录（persona 段依赖 {{cwd}}），
      // 由 agent 工厂的 sessions.prepare 创建会话。
      const sessionId = SessionId(`session-${randomUUID()}`)
      const handle: AgentHandle = await this.ctx.agents.create({
        sessionId,
        agentOptions: { provider, model },
        meta: { cwd: process.cwd(), origin: 'subagent' },
        setup: async (agentCtx) => {
          // 通用组合：挂载部署的默认 agent 预设（工具/提示词段/技能目录随预设而来），
          // 不写死预设 id 或路径；无预设服务的部署自动退化为全局层。
          const presets = (agentCtx as { get?: (name: string) => unknown }).get?.('agentPresets') as
            | { mount(agentCtx: unknown, id?: string): Promise<unknown> }
            | undefined
          if (presets !== undefined) {
            try {
              await presets.mount(agentCtx)
            } catch (error) {
              console.warn('[dsh-message-gateway] agent preset mount skipped', String(error))
            }
          }
          // 默认模型注入（与 dsh-headless 同源）。
          if (selection !== undefined) {
            installModelSelection(agentCtx, { current: selection, assembled: void 0 })
          }
        },
      })
      this.agents.set(key, { agent: handle.agent, dispose: () => handle.dispose() })
      console.log('[dsh-message-gateway] dedicated agent ready', { key, session: handle.agent.session.id, provider, model })
      return handle.agent
    } catch (error) {
      console.error('[dsh-message-gateway] create agent failed', error)
      return null
    }
  }

  /** 主动释放某聊天的会话（对应 Web 的「新会话」；下一条消息自动新建）。 */
  async resetChat(key: string): Promise<boolean> {
    const entry = this.agents.get(key)
    if (entry === undefined) return false
    this.finishPending(key)
    this.agents.delete(key)
    try {
      await entry.dispose()
    } catch (error) {
      console.error('[dsh-message-gateway] reset chat dispose failed', error)
    }
    console.log('[dsh-message-gateway] chat session reset', { key })
    return true
  }

  /** 插件卸载时释放全部聊天会话。 */
  async dispose(): Promise<void> {
    this.finishAllPending()
    const entries = [...this.agents.values()]
    this.agents.clear()
    await Promise.allSettled(entries.map((entry) => entry.dispose()))
    this.wecom?.stop()
    this.wecom = null
  }

  private finishAllPending(): void {
    for (const key of [...this.pendingMap.keys()]) this.finishPending(key)
  }

  /**
   * 外部平台消息统一入口：命令优先，否则注入该聊天独立 agent 会话，
   * 回复经 sink 流式回发。所有已打通的平台共用此管线。
   */
  async handleExternalMessage(id: ChatIdentity, rawText: string): Promise<void> {
    const text = stripMention(rawText)
    const reply = (content: string): void => {
      id.sink.stream(id.frame, `cmd-${Date.now().toString(36)}`, content, true)
    }
    try {
      // 配置：不回复群聊时只处理单聊。
      if (id.chatType === 'group' && !this.config.groupReply) return
      // 斜杠命令 / 关键词命令优先处理，不进入 agent。
      if (await this.handleCommand(text, id.key, reply)) return
      // Webhook 同步请求在途时丢弃（极少数并发场景）。
      if (this.awaiting !== null) {
        console.warn('[dsh-message-gateway] busy: webhook in flight, drop message')
        return
      }
      // 同一聊天上一轮还在处理 → 礼貌回执，避免回复串台。
      if (this.pendingMap.has(id.key)) {
        id.sink.stream(id.frame, `busy-${Date.now().toString(36)}`, this.t('busy'), true)
        return
      }
      // 每个聊天自动创建独立会话（与 Web 对话一致；超限自动压缩由会话层内置完成）。
      const agent = await this.ensureAgentForKey(id.key)
      if (agent === null) {
        console.warn('[dsh-message-gateway] no dedicated agent available')
        return
      }
      const message: UserMessage = {
        id: MessageId(`dsh-gateway-${Date.now().toString(36)}`),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-message-gateway', form: 'relay' },
      }
      const session = agent.session
      const p: PendingReply = {
        frame: id.frame,
        sink: id.sink,
        streamId: `gw-${Date.now().toString(36)}`,
        buffer: '',
        cursor: session.seq,
        timer: null,
        fallback: null,
        pushed: false,
        httpDelivered: false,
        ackSent: false,
        lastPush: 0,
        startedAt: Date.now(),
        heartbeat: null,
      }
      this.pendingMap.set(id.key, p)
      // 立即回执：复用流式 streamId（finish=false），回复内容就地在同一条消息里
      // 渐进更新（Telegram/Discord/QQ 编辑同一消息，企业微信流式消息同 id 更新）。
      if (id.sink.ack !== false) {
        p.ackSent = true
        id.sink.stream(id.frame, p.streamId, this.t('ack'), false)
        // 长思考心跳：每 4 秒刷新回执（显示已等待秒数），正文开始流式后自动退出。
        p.heartbeat = setInterval(() => {
          if (this.pendingMap.get(id.key) !== p || p.pushed) return
          const elapsed = Math.round((Date.now() - p.startedAt) / 1000)
          id.sink.stream(id.frame, p.streamId, `${this.t('ack')}（${elapsed}s）`, false)
        }, ACK_HEARTBEAT_INTERVAL)
        p.heartbeat.unref?.()
      }
      agent.send(message, 'next-turn', true)
      console.log('[dsh-message-gateway] sent to agent', { key: id.key, text: text.slice(0, 60), baseSeq: p.cursor })
      // 轮询事件快照：chunk 流式推送、assistant/message 定稿。
      p.timer = setInterval(() => {
        if (this.pendingMap.get(id.key) !== p) return
        this.pollPending(id.key, p, session)
      }, 400)
      // 兜底超时（10 分钟无完成事件 → 清理）。
      p.fallback = setTimeout(() => {
        if (this.pendingMap.get(id.key) === p) this.finishPending(id.key)
      }, 10 * 60 * 1000)
      p.fallback.unref?.()
    } catch (error) {
      console.error('[dsh-message-gateway] handleExternalMessage failed', error)
    }
  }

  // ==================== 企业微信智能机器人 ====================

  /** 把一条外部文本消息交给 Webhook 专用 agent 处理，同步等待完整回复（Webhook 通道）。 */
  async sendAndWait(text: string, timeoutMs = 90_000): Promise<{ ok: boolean; reply: string }> {
    if (this.pendingMap.size > 0 || this.awaiting !== null) {
      return { ok: false, reply: 'busy: another request is being processed' }
    }
    const agent = await this.ensureAgentForKey('webhook')
    if (agent === null) return { ok: false, reply: 'no dedicated agent available' }
    const session = agent.session
    const cursor = session.seq
    const message: UserMessage = {
      id: MessageId(`dsh-gw-webhook-${Date.now().toString(36)}`),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-message-gateway', form: 'relay' },
    }
    return await new Promise<{ ok: boolean; reply: string }>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      let poll: ReturnType<typeof setInterval>
      const settle = (ok: boolean, reply: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(poll)
        this.awaiting = null
        resolve({ ok, reply })
      }
      timer = setTimeout(() => settle(false, 'timeout waiting for reply'), timeoutMs)
      poll = setInterval(() => {
        if (this.awaiting === null) {
          clearInterval(poll)
          return
        }
        const events = session.events
        for (let i = cursor; i < events.length; i += 1) {
          const event = events[i]
          if (event.type === 'assistant/message') {
            const reply = extractText((event as SessionEvent<'assistant/message'>).data.message)
            // 跳过空消息与纯工具调用消息：工具调用轮/中间步骤不是最终回复。
            if (reply !== '' && !isToolCallOnly(reply)) {
              settle(true, reply)
              return
            }
          }
        }
      }, 400)
      this.awaiting = { resolve: (reply: string): void => settle(true, reply) }
      try {
        agent.send(message, 'next-turn', true)
        console.log('[dsh-message-gateway] webhook sent to agent', { text: text.slice(0, 60), baseSeq: cursor })
      } catch (error) {
        console.error('[dsh-message-gateway] webhook send failed', error)
        settle(false, 'send failed')
      }
    })
  }

  /** 启动企业微信桥（凭据变化时先停旧桥）。 */
  startWecom(cred: { botId: string; secret: string }): void {
    this.wecom?.stop()
    const bridge = new WecomBridge(cred, {
      onStatus: (status) => this.onStatusCallback?.(status),
      onText: (rawText, frame) => {
        const body = frame.body ?? ({} as Record<string, unknown>)
        const chattype = (body as { chattype?: string }).chattype ?? 'single'
        const userid = (body.from as { userid?: string } | undefined)?.userid ?? ''
        const chatid = (body.chatid as string | undefined) ?? ''
        const key = chatid !== '' ? `wecom:group:${chatid}` : `wecom:user:${userid}`
        const sink: ReplySink = {
          stream: (f, sid, content, finish) => void this.wecom?.streamReply(f as WsFrame<TextMessage>, sid, content, finish),
          // 企业微信走单一流式消息（ack → 内容 → 定稿同一条消息就地更新）；
          // 不再叠加 response_url 投递，避免出现重复消息。
        }
        void this.handleExternalMessage({ key, frame, sink, chatType: chattype === 'group' ? 'group' : 'single' }, rawText)
      },
      onEnter: (frame) => {
        // 用户当天首次进入单聊会话 → 欢迎语。
        const userid = frame.body?.from?.userid ?? ''
        console.log('[dsh-message-gateway] enter chat', { userid })
        void this.wecom?.welcome(frame, this.t('welcome'))
      },
    })
    this.wecom = bridge
    bridge.start()
  }

  /** 停止企业微信桥（保留各聊天会话上下文）。 */
  stopWecom(): void {
    this.finishAllPending()
    this.wecom?.stop()
    this.wecom = null
  }

  /** 当前桥状态（供路由展示）。 */
  wecomStatus(): BridgeStatus {
    return this.wecom?.status ?? { state: 'idle', detail: '', connectedAt: null }
  }

  /** 当前活跃聊天会话数（供状态展示）。 */
  chatCount(): number {
    return this.agents.size
  }

  /** 主动向会话发送 markdown 消息（单聊=userid，群聊=群 ID）。 */
  async sendToChat(chatid: string, content: string): Promise<boolean> {
    if (this.wecom === null) return false
    return this.wecom.sendMessage(chatid, content)
  }

  // ==================== Telegram / Discord / QQ / Email ====================

  private telegram: { start(): void; stop(): void; status: BridgeStatus } | null = null
  private discord: { start(): void; stop(): void; status: BridgeStatus } | null = null
  private qq: { start(): void; stop(): void; status: BridgeStatus } | null = null
  private email: { start(): void; stop(): void; status: BridgeStatus } | null = null

  /** 启动 Telegram 桥（长轮询）。 */
  startTelegram(cred: Record<string, string>): void {
    this.telegram?.stop()
    const bridge = new TelegramBridge(cred.token ?? '', {
      onStatus: (status) => this.onStatusCallback?.(status),
      onText: (text, identity) => void this.handleExternalMessage(identity, text),
    })
    this.telegram = bridge
    bridge.start()
  }

  /** 停止 Telegram 桥。 */
  stopTelegram(): void {
    this.telegram?.stop()
    this.telegram = null
  }

  /** 启动 Discord 桥（WebSocket 网关）。 */
  startDiscord(cred: Record<string, string>): void {
    this.discord?.stop()
    const bridge = new DiscordBridge(cred.token ?? '', {
      onStatus: (status) => this.onStatusCallback?.(status),
      onText: (text, identity) => void this.handleExternalMessage(identity, text),
    })
    this.discord = bridge
    bridge.start()
  }

  /** 停止 Discord 桥。 */
  stopDiscord(): void {
    this.discord?.stop()
    this.discord = null
  }

  /** 启动 QQ 桥（access_token + 网关）。 */
  startQQ(cred: Record<string, string>): void {
    this.qq?.stop()
    const bridge = new QQBridge(cred.appId ?? '', cred.secret ?? '', {
      onStatus: (status) => this.onStatusCallback?.(status),
      onText: (text, identity) => void this.handleExternalMessage(identity, text),
    })
    this.qq = bridge
    bridge.start()
  }

  /** 停止 QQ 桥。 */
  stopQQ(): void {
    this.qq?.stop()
    this.qq = null
  }

  /** 启动 Email 桥（IMAP 轮询 + SMTP 回复）。 */
  startEmail(cred: Record<string, string>): void {
    this.email?.stop()
    const emailCred: EmailCred = {
      imapHost: cred.imapHost ?? '',
      imapPort: cred.imapPort ?? '143',
      imapUser: cred.imapUser ?? '',
      imapPass: cred.imapPass ?? '',
      smtpHost: cred.smtpHost ?? undefined,
      smtpPort: cred.smtpPort ?? undefined,
      smtpUser: cred.smtpUser ?? undefined,
      smtpPass: cred.smtpPass ?? undefined,
    }
    const bridge = new EmailBridge(emailCred, {
      onStatus: (status) => this.onStatusCallback?.(status),
      onText: (text, identity) => void this.handleExternalMessage(identity, text),
    })
    this.email = bridge
    bridge.start()
  }

  /** 停止 Email 桥。 */
  stopEmail(): void {
    this.email?.stop()
    this.email = null
  }

  /** 任意桥接平台的状态（telegram/discord/qq/email）。 */
  bridgeStatus(id: string): BridgeStatus {
    if (id === 'telegram') return this.telegram?.status ?? { state: 'idle', detail: '', connectedAt: null }
    if (id === 'discord') return this.discord?.status ?? { state: 'idle', detail: '', connectedAt: null }
    if (id === 'qq') return this.qq?.status ?? { state: 'idle', detail: '', connectedAt: null }
    if (id === 'email') return this.email?.status ?? { state: 'idle', detail: '', connectedAt: null }
    return { state: 'idle', detail: '', connectedAt: null }
  }

  /** 将桥状态并入存储状态。 */
  mergeStatus(stored: StoredStatus | undefined, id = 'wecom-aibot'): StoredStatus {
    const live = id === 'wecom-aibot' ? this.wecomStatus() : this.bridgeStatus(id)
    if (live.state === 'connected') {
      return { state: 'connected', detail: live.detail, testedAt: live.connectedAt ?? stored?.testedAt ?? null }
    }
    if (live.state === 'error') {
      return { state: 'error', detail: live.detail, testedAt: stored?.testedAt ?? null }
    }
    if (live.state === 'connecting') {
      // 桥正在（重）连接时如实显示「连接中」，不要沿用存储的旧状态（否则出现"已连接 · 连接中"）。
      return { state: 'connecting', detail: live.detail || '连接中…', testedAt: stored?.testedAt ?? null }
    }
    return stored ?? { state: 'none', detail: '', testedAt: null }
  }

  /** 斜杠命令 / 关键词命令；已处理返回 true（不经 agent）。 */
  private async handleCommand(text: string, key: string, reply: (content: string) => void): Promise<boolean> {
    if (text === '/help' || text === '帮助' || text === '菜单' || text === '？' || text === '?') {
      reply(this.t('help'))
      return true
    }
    if (text === '/time' || text === '时间') {
      reply(`${this.t('timePrefix')} ${nowInShanghai()}（Asia/Shanghai）`)
      return true
    }
    if (text === '/new' || text === '/clear' || text === '新会话' || text === '清空会话') {
      const reset = await this.resetChat(key)
      reply(reset ? this.t('newOk') : this.t('newIdle'))
      return true
    }
    if (text === '/status' || text === '状态') {
      const dot = this.ctx.agents.list().length > 0 ? this.t('statusAvailable') : this.t('statusUnavailable')
      reply(
        `${this.t('statusTitle')}\n` +
        `- ${this.t('statusChats')}: ${this.chatCount()} 个\n` +
        `- ${this.t('statusAgent')}: ${dot}\n` +
        `- ${this.t('statusTime')}: ${nowInShanghai()}`
      )
      return true
    }
    return false
  }
}

/** 从 assistant 消息中提取纯文本（text 块拼接）。 */
function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
}

/** 整段消息是否只是 XML 工具调用（模型以文本形式输出工具调用时，不能当回复发出）。 */
function isToolCallOnly(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (trimmed.startsWith('<tool_calls>') && trimmed.endsWith('</tool_calls>')) return true
  // 宽松匹配：整段只有工具调用标签（允许前后少量空白）。
  return /^<tool_calls>[\s\S]*<\/tool_calls>\s*$/.test(trimmed)
}

/** 去掉消息开头的 @机器人名（群聊提及）。 */
function stripMention(content: string): string {
  const text = content.trim()
  if (text.startsWith('@')) {
    const space = text.indexOf(' ')
    // 只剥离开头的 @提及（token 不超过 64 字符），其余原样保留。
    if (space !== -1 && space <= 64) return text.slice(space + 1).trim()
  }
  return text
}

/** 当前上海时间（Asia/Shanghai）。 */
function nowInShanghai(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date())
}