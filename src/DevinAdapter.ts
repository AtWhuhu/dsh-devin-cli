import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  createToolResultMessage,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { AcpStdioClient } from './acp/AcpStdioClient.ts'
import type {
  AcpAgentMessageChunk,
  AcpPermissionRequestParams,
  AcpPromptContent,
  AcpSessionNewParams,
  AcpSessionUpdate,
  AcpUsageUpdate,
} from './acp/protocol.ts'
import { globalDevinRegistry } from './models.ts'

export const PROVIDER = 'devin'

export interface DevinModelConfig {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  supportsImages?: boolean
}

export interface DevinModelInfo extends LlmModelInfo {
  contextWindow?: number
  maxTokens?: number
}

export interface DevinAdapterConfig {
  ctx?: any
  bin: string
  cwd: string
  streamIdleTimeoutMs: number
  models: DevinModelConfig[]
  defaultContextWindow: number
  defaultMaxTokens: number
  token?: string
  retryPolicy?: ResolvedRetryPolicy
  discoverModels?: () => Promise<Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number }>>
}

/**
 * 将 Devin 的工具调用归一化映射为 DSH 原生 UI 组件（@deepseek-ai/dsh-client-ui-tool）识别的标准工具名称与参数
 * 从而在 DSH 聊天界面中渲染为独立原生的工具卡片（Grep · ... / 读取 · ... / Pwsh · ... / 编辑 · ...）
 */
export function mapDevinToolNameToDsh(tc: {
  kind?: string
  title?: string
  rawInput?: Record<string, unknown>
  _meta?: Record<string, unknown>
}): { name: string; args: Record<string, unknown> } {
  const kind = (tc.kind || '').toLowerCase()
  const title = (tc.title || '').toLowerCase()
  const metaName = String(tc._meta?.['cognition.ai/inferenceToolName'] || '').toLowerCase()
  const raw = { ...(tc.rawInput || {}) }

  // 1. 命令执行 (pwsh / bash)
  if (kind === 'exec' || kind === 'bash' || kind === 'pwsh' || metaName === 'exec' || raw.command) {
    const isWindows = process.platform === 'win32'
    return {
      name: isWindows ? 'pwsh' : 'bash',
      args: {
        command: raw.command || tc.title || '',
        description: tc.title || raw.description,
        ...raw,
      },
    }
  }

  // 2. 读取文件 (read)
  if (kind === 'read' || metaName === 'read' || title.includes('read')) {
    return {
      name: 'read',
      args: {
        file_path: raw.file_path || raw.path || '',
        ...raw,
      },
    }
  }

  // 3. 搜索内容 (grep)
  if (kind === 'grep' || metaName === 'grep' || title.includes('grep')) {
    return {
      name: 'grep',
      args: {
        query: raw.query || raw.pattern || '',
        ...raw,
      },
    }
  }

  // 4. 查找文件 (glob)
  if (kind === 'glob' || kind === 'find' || metaName === 'glob' || title.includes('find file') || title.includes('glob')) {
    return {
      name: 'glob',
      args: {
        pattern: raw.pattern || raw.query || '',
        ...raw,
      },
    }
  }

  // 5. 编辑/修改文件 (edit)
  if (
    kind === 'edit' ||
    kind === 'write' ||
    metaName === 'edit' ||
    metaName === 'write' ||
    title.includes('edit') ||
    title.includes('write')
  ) {
    return {
      name: 'edit',
      args: {
        file_path: raw.file_path || raw.path || '',
        ...raw,
      },
    }
  }

  // 6. 网络搜索 (web_search)
  if (kind === 'web_search' || metaName === 'web_search' || title.includes('web search')) {
    return {
      name: 'web_search',
      args: {
        query: raw.query || '',
        ...raw,
      },
    }
  }

  // 其他情况保持原样或 fallback 到 generic
  return {
    name: metaName || kind || 'generic',
    args: raw,
  }
}

class AsyncQueue<T> {
  private items: T[] = []
  private waiters: Array<(item: T | undefined) => void> = []

  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  next(timeoutMs?: number): Promise<T | undefined> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve(item)
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const onDone = (res: T | undefined) => {
        if (timer) clearTimeout(timer)
        resolve(res)
      }
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = this.waiters.indexOf(onDone)
          if (idx !== -1) this.waiters.splice(idx, 1)
          resolve(undefined)
        }, timeoutMs)
      }
      this.waiters.push(onDone)
    })
  }
}

function formatMessages(options: GenerateOptions): string {
  const parts: string[] = []
  if (options.system) {
    parts.push(`[system]\n${options.system}`)
  }
  const messages = Array.isArray(options.messages) ? options.messages : []
  for (const message of messages) {
    if (!message) continue
    const role = message.role === 'assistant' ? 'assistant' : message.source?.kind === 'tool' ? 'tool' : 'user'
    parts.push(`[${role}]`)
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text') {
        if (typeof block.text === 'string') parts.push(block.text)
      } else if (block.type === 'reasoning') {
        if (typeof block.text === 'string') parts.push(`[thinking]\n${block.text}`)
      } else if (block.type === 'tool-call') {
        parts.push(`[tool-call ${block.id || ''}: ${block.name || ''}]\n${block.arguments || ''}`)
      } else if (block.type === 'tool-result') {
        const texts: string[] = []
        if (Array.isArray(block.content)) {
          for (const sub of block.content) {
            if (sub && typeof sub === 'object' && sub.type === 'text' && typeof sub.text === 'string') {
              texts.push(sub.text)
            } else if (sub) {
              try {
                texts.push(JSON.stringify(sub))
              } catch {
                // ignore
              }
            }
          }
        }
        const errPrefix = block.isError ? 'ERROR: ' : ''
        parts.push(`[Tool Result for ${block.toolCallId || ''}]: ${errPrefix}${texts.join('\n')}`)
      } else {
        // 其他未知块（如 image 等）安全序列化为文本
        try {
          parts.push(JSON.stringify(block))
        } catch {
          // ignore
        }
      }
    }
  }
  return parts.join('\n\n')
}

function toAcpPrompt(options: GenerateOptions): AcpPromptContent[] {
  return [{ type: 'text', text: formatMessages(options) }]
}

/**
 * Devin CLI 专有 DSH LlmAdapter。
 * 直接通过 stdio 交互调用本机的 `devin acp` 服务，零多余协议代理。
 */
export class DevinAdapter extends LlmAdapter {
  private cachedModels: readonly DevinModelInfo[] | null = null

  constructor(private readonly config: DevinAdapterConfig) {
    super()
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: PROVIDER, name: 'Devin' }
  }

  clearCache(): void {
    this.cachedModels = null
  }

  override async listModels(_provider?: string): Promise<readonly DevinModelInfo[]> {
    if (this.cachedModels && this.cachedModels.length > 0) {
      return this.cachedModels
    }

    if (globalDevinRegistry.getBaseModels().length === 0) {
      if (this.config.discoverModels) {
        await this.config.discoverModels()
      } else {
        await globalDevinRegistry.init(this.config.bin)
      }
    }

    const { loadSettings } = await import('./storage.ts')
    const userSettings = loadSettings()
    const rawActive = userSettings.activeModelIds || []

    // 归一化激活集：同时支持原 ID、规范化基础 ID 以及去除点和连字符的模糊 key
    const activeSet = new Set<string>()
    if (rawActive.length > 0) {
      for (const id of rawActive) {
        const lower = id.toLowerCase().trim()
        activeSet.add(lower)
        activeSet.add(lower.replace(/[._-]/g, ''))
        const baseId = globalDevinRegistry.normalizeToBaseId(lower).toLowerCase()
        activeSet.add(baseId)
        activeSet.add(baseId.replace(/[._-]/g, ''))
      }
    }

    const baseModels = globalDevinRegistry.getBaseModels()
    const list: DevinModelInfo[] = []

    for (const m of baseModels) {
      // 若用户指定了激活模型，则只列出已激活的基础模型（自动涵盖其全部推理等级）
      const mLower = m.id.toLowerCase()
      const mCompact = mLower.replace(/[._-]/g, '')
      if (activeSet.size > 0 && !activeSet.has(mLower) && !activeSet.has(mCompact)) continue

      list.push({
        provider: PROVIDER,
        id: m.id,
        name: m.name,
        ...m.contextWindow ? { contextWindow: m.contextWindow } : {},
        ...m.maxTokens ? { maxTokens: m.maxTokens } : {},
        inputModalities: m.supportsImages
          ? (['text' as const, 'image' as const])
          : (['text' as const]),
      })
    }

    this.cachedModels = list
    return list
  }

  override async resolveModel(_provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (globalDevinRegistry.getBaseModels().length === 0) {
      if (this.config.discoverModels) {
        await this.config.discoverModels()
      } else {
        await globalDevinRegistry.init(this.config.bin)
      }
    }

    const route = globalDevinRegistry.resolveRoute(
      model,
      undefined,
      this.config.defaultContextWindow,
      this.config.defaultMaxTokens,
    )
    return {
      provider: PROVIDER,
      id: model,
      name: route.displayName,
      inputModalities: route.supportsImages ? (['text' as const, 'image' as const]) : (['text' as const]),
      context: { contextWindow: route.contextWindow },
      defaultMaxTokens: route.maxTokens,
      ...route.supportedEfforts.length > 1
        ? {
            reasoning: {
              efforts: route.supportedEfforts.map((e) => ({
                id: ReasoningEffortId(e.id),
                name: e.name,
              })),
              defaultEffort: route.currentEffort ? ReasoningEffortId(route.currentEffort) : ReasoningEffortId('high'),
            },
          }
        : {},
    }
  }

  /**
   * 满足 DSH Desktop 新版 dsh-llm 对 prepareCall 的契约要求。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    const resolved = await this.resolveModel(provider, model, signal)
    return {
      model: resolved,
      stream: (options: GenerateOptions) => this.stream(options, options.signal ?? signal),
    }
  }

  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.config.retryPolicy
  }

  override async *stream(options: GenerateOptions, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    const queue = new AsyncQueue<AcpSessionUpdate | { done: true; usage?: TokenUsage; cancelled?: boolean }>()
    let acpSessionId: string | undefined

    if (globalDevinRegistry.getBaseModels().length === 0) {
      if (this.config.discoverModels) {
        await this.config.discoverModels()
      } else {
        await globalDevinRegistry.init(this.config.bin)
      }
    }

    // 根据用户选择的推理等级 (options.reasoningEffort)，在模型族内动态匹配对应后缀变体与上下文大小
    const effortStr = options.reasoningEffort ? String(options.reasoningEffort) : undefined
    const route = globalDevinRegistry.resolveRoute(
      options.model,
      effortStr,
      this.config.defaultContextWindow,
      this.config.defaultMaxTokens,
    )
    const targetModel = route.resolvedModelUid

    const argv = [this.config.bin, 'acp']
    if (targetModel) argv.push('--model', targetModel)
    const token = this.config.token ?? ''

    console.log(`[dsh-devin-cli] Starting stream for model: ${options.model}, targetModel: ${targetModel}`)

    const client = new AcpStdioClient({
      argv,
      cwd: this.config.cwd,
      env: token ? { WINDSURF_API_KEY: token } : undefined,
      onUpdate: (update) => queue.push(update),
      onPermissionRequest: (request) => this.handlePermission(request),
    })

    let promptDone = false
    let promptUsage: TokenUsage | undefined

    try {
      if (signal?.aborted) throw new LlmError('Devin ACP request aborted before start', 'ABORTED')

      // 初始化 ACP 服务握手（给予 30s 缓冲以应对冷启动）
      const init = await client.initialize({ name: 'dsh-devin-cli', version: '0.3.0' }, 30_000)

      // 仅当存在明确的 api_key 类型认证方法且传入了 token 时才调用 authenticate，避免触发 devin-browser 阻塞
      if (token && init.authMethods?.length) {
        const apiKeyMethod = init.authMethods.find((m) => m.type === 'api_key' && m.id)
        if (apiKeyMethod) {
          try {
            await client.authenticate(apiKeyMethod.id, { api_key: token }, 10_000)
          } catch {
            // 如果显式认证失败，回退到本机 CLI 凭据
          }
        }
      }

      // 获取当前 DSH 会话对象（用于发射原生 tool/call 和 tool/result 独立消息体）
      const dshSessionId = (options as { sessionId?: string }).sessionId
      let dshSession: any = (options as { session?: any }).session
      if (!dshSession && dshSessionId && this.config.ctx) {
        try {
          const ctxAny = this.config.ctx as any
          const sessions = typeof ctxAny.get === 'function'
            ? ctxAny.get('sessions')
            : (typeof ctxAny.reflect?.get === 'function' ? ctxAny.reflect.get('sessions') : undefined)
          dshSession = sessions?.get?.(dshSessionId)
        } catch (err) {
          console.warn('[dsh-devin-cli] Failed to safely resolve session from ctx:', err)
          dshSession = undefined
        }
      }

      let effectiveCwd = this.config.cwd
      if (dshSession?.header?.cwd) {
        effectiveCwd = dshSession.header.cwd
      } else if ((options as any).cwd) {
        effectiveCwd = (options as any).cwd
      }

      const sessionParams: AcpSessionNewParams = {
        cwd: effectiveCwd,
        mcpServers: [],
      }
      const acpSession = await client.sessionNew(sessionParams, 15_000)
      acpSessionId = acpSession.sessionId

      const promptPayload = toAcpPrompt(options)
      console.log(`[dsh-devin-cli] Prompting Devin ACP (session: ${acpSessionId}, length: ${promptPayload[0]?.text?.length || 0}, cwd: ${effectiveCwd})`)

      let promptError: Error | undefined
      client.prompt(acpSessionId, promptPayload)
        .then((response) => {
          promptUsage = response.usage
            ? {
                inputTokens: response.usage.inputTokens ?? 0,
                outputTokens: response.usage.outputTokens ?? 0,
              }
            : undefined
        })
        .catch((err: unknown) => {
          promptError = err instanceof Error ? err : new Error(String(err))
          queue.push({ done: true, usage: undefined, cancelled: false })
          // 严禁在此 throw err！否则未 await 的 Promise 会触发全局 unhandledRejection 导致 DSH 的 installFailLoud 强杀宿主！
        })
        .finally(() => {
          promptDone = true
        })

      let lastActivity = Date.now()

      let blockIndex = 0
      let currentBlock: { type: 'reasoning' | 'text'; index: number; content: string } | null = null

      let currentTurn = 0
      let currentStep = 0
      if (dshSession) {
        try {
          const events = dshSession.snapshotEvents ? dshSession.snapshotEvents() : (dshSession.log || [])
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i]
            if (ev.type === 'step/start') {
              currentStep = ev.data.step
              currentTurn = ev.data.turn
              break
            }
            if (ev.type === 'turn/start') {
              currentTurn = ev.data.turn
              break
            }
          }
        } catch {
          // ignore
        }
      }

      // 跟踪在途工具调用：toolCallId -> { callSeq, name }
      const activeToolCalls = new Map<string, { callSeq: number; name: string }>()

      // 跟踪是否发生过工具调用，以保证调用轨迹自上而下正确排列（杜绝正文超前锚定导致工具沉底）
      let hasToolCalls = false
      let initialThoughtBuffer = ''
      let initialTextBuffer = ''
      let bypassToolBuffering = false

      // 安全收敛所有在途工具卡片（用于正文输出前或流收尾时批量回填完成，彻底防止工具计数异常阻塞正文输出）
      const settleActiveToolCalls = () => {
        if (dshSession && typeof dshSession.append === 'function' && activeToolCalls.size > 0) {
          for (const [toolCallId, active] of activeToolCalls) {
            try {
              const message = createToolResultMessage({
                callId: ToolCallId(toolCallId),
                content: [{ type: 'text', text: 'Done' }],
                isError: false,
              })
              dshSession.append('tool/result', {
                turn: currentTurn,
                step: currentStep,
                message,
              }, {
                surfaceOp: 'append',
                sourceEventSeqs: active.callSeq ? [active.callSeq] : [],
              })
            } catch {
              // ignore
            }
          }
        }
        activeToolCalls.clear()
      }

      const flushInitialBuffers = function* (): Generator<StreamChunk, void, unknown> {
        if (bypassToolBuffering) return
        bypassToolBuffering = true
        if (initialThoughtBuffer) {
          const { index, startChunk, endChunk } = ensureBlock('reasoning')
          if (endChunk) yield endChunk
          if (startChunk) yield startChunk
          currentBlock!.content += initialThoughtBuffer
          yield { type: 'reasoning-delta', index, text: initialThoughtBuffer }
          initialThoughtBuffer = ''
        }
        if (initialTextBuffer) {
          const { index, startChunk, endChunk } = ensureBlock('text')
          if (endChunk) yield endChunk
          if (startChunk) yield startChunk
          currentBlock!.content += initialTextBuffer
          yield { type: 'text-delta', index, text: initialTextBuffer }
          initialTextBuffer = ''
        }
      }

      const endCurrentBlock = (): StreamChunk | null => {
        if (!currentBlock) return null
        const closed = {
          type: 'block-end' as const,
          index: currentBlock.index,
          block: { type: currentBlock.type, text: currentBlock.content },
        }
        currentBlock = null
        return closed
      }

      const ensureBlock = (type: 'reasoning' | 'text'): { index: number; startChunk?: StreamChunk; endChunk?: StreamChunk } => {
        if (currentBlock && currentBlock.type === type) {
          return { index: currentBlock.index }
        }
        const endChunk = endCurrentBlock() || undefined
        const index = blockIndex++
        currentBlock = { type, index, content: '' }
        const startChunk: StreamChunk = { type: 'block-start', index, blockType: type }
        return { index, startChunk, endChunk }
      }

      while (true) {
        if (signal?.aborted) {
          if (acpSessionId) client.cancel(acpSessionId)
          throw new LlmError('Devin ACP request aborted', 'ABORTED')
        }

        if (Date.now() - lastActivity >= this.config.streamIdleTimeoutMs) {
          throw new LlmError('Devin ACP stream idle timeout', 'TIMEOUT')
        }

        const update = await queue.next(200)
        if (update === undefined) {
          // 仅当底层 ACP prompt 调用已彻底 resolve、且队列已无后续更新时，流才自然结束
          if (promptDone) break
          continue
        }

        lastActivity = Date.now()

        if ('done' in update) {
          if (update.cancelled) {
            yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } }
            return
          }
          if (promptError) {
            throw promptError
          }
          break
        }

        // 处理工具调用开始：以 DSH 原生独立事件发射，在前端渲染为独立的工具调用卡片消息体
        if (update.sessionUpdate === 'tool_call') {
          hasToolCalls = true
          // 既然触发了工具调用，丢弃工具前暂存的零碎过渡短语或心声，防止在工具前建立过早的时间锚点导致工具卡片沉底
          initialThoughtBuffer = ''
          initialTextBuffer = ''
          bypassToolBuffering = true

          // 如果之前有尚未关闭的块，关闭它
          const endChunk = endCurrentBlock()
          if (endChunk) yield endChunk

          const tc = update as {
            title?: string
            kind?: string
            toolCallId?: string
            rawInput?: Record<string, unknown>
            _meta?: Record<string, unknown>
          }
          if (dshSession && typeof dshSession.append === 'function') {
            try {
              const mapped = mapDevinToolNameToDsh(tc)
              const toolCallId = tc.toolCallId || `devin_call_${Date.now()}`
              const appendResult = dshSession.append('tool/call', {
                turn: currentTurn,
                step: currentStep,
                callId: toolCallId,
                name: mapped.name,
                arguments: JSON.stringify(mapped.args),
              })
              const callSeq = appendResult?.seq ?? Date.now()
              activeToolCalls.set(toolCallId, { callSeq, name: mapped.name })
            } catch (err) {
              console.warn('[dsh-devin-cli] Failed to append tool/call to session:', err)
            }
          }
        }
        // 处理工具调用完成/失败状态：更新对应的独立工具卡片为完成并回填输出结果
        else if (update.sessionUpdate === 'tool_call_update') {
          const tcu = update as {
            toolCallId?: string
            callId?: string
            id?: string
            status?: string
            isError?: boolean
            content?: Array<{ type?: string; content?: { type?: string; text?: string } }>
          }
          const resolvedToolCallId = tcu.toolCallId || tcu.callId || tcu.id
          if (dshSession && typeof dshSession.append === 'function' && resolvedToolCallId) {
            const active = activeToolCalls.get(resolvedToolCallId)
            const status = (tcu.status || '').toLowerCase()
            const isFinished = status === 'completed' || status === 'failed' || status === 'success' || status === 'done' || status === 'finished' || status === 'error' || tcu.isError !== undefined
            if (active && (isFinished || !status)) {
              activeToolCalls.delete(resolvedToolCallId)
              try {
                let outputText = ''
                if (Array.isArray(tcu.content)) {
                  for (const item of tcu.content) {
                    if (item.content?.text) outputText += item.content.text
                  }
                }
                const isError = status === 'failed' || status === 'error' || Boolean(tcu.isError)
                const message = createToolResultMessage({
                  callId: ToolCallId(resolvedToolCallId),
                  content: [{ type: 'text', text: outputText || (isError ? 'Tool execution failed' : 'Done') }],
                  isError,
                })
                dshSession.append('tool/result', {
                  turn: currentTurn,
                  step: currentStep,
                  message,
                }, {
                  surfaceOp: 'append',
                  sourceEventSeqs: active.callSeq ? [active.callSeq] : [],
                })
              } catch (err) {
                console.warn('[dsh-devin-cli] Failed to append tool/result to session:', err)
              }
            }
          }
        }
        // 处理深度思考流
        else if (update.sessionUpdate === 'agent_thought_chunk') {
          const thought = update as { content?: { type?: string; text?: string } }
          const text = thought.content?.text
          if (text) {
            if (!hasToolCalls && !bypassToolBuffering) {
              // 纯对话阶段探测：暂存心声
              initialThoughtBuffer += text
            } else if (hasToolCalls) {
              // 工具已经发生过：若模型此时输出思考，说明在途工具已执行完毕，自动收敛挂起的工具卡片
              if (activeToolCalls.size > 0) {
                settleActiveToolCalls()
              }
              const { index, startChunk, endChunk } = ensureBlock('reasoning')
              if (endChunk) yield endChunk
              if (startChunk) yield startChunk
              currentBlock!.content += text
              yield { type: 'reasoning-delta', index, text }
            } else {
              // 确认无工具调用的纯对话
              const { index, startChunk, endChunk } = ensureBlock('reasoning')
              if (endChunk) yield endChunk
              if (startChunk) yield startChunk
              currentBlock!.content += text
              yield { type: 'reasoning-delta', index, text }
            }
          }
        }
        // 处理正文回复流
        else if (update.sessionUpdate === 'agent_message_chunk') {
          const chunk = update as AcpAgentMessageChunk
          const contents = Array.isArray(chunk.content) ? chunk.content : [chunk.content]
          for (const content of contents) {
            if (content.type === 'text' && content.text) {
              if (!hasToolCalls && !bypassToolBuffering) {
                initialTextBuffer += content.text
                // 如果文字积累已长（超过 100 字），说明不是工具前简短过渡短语，而是直接回答
                if (initialTextBuffer.length > 100) {
                  yield* flushInitialBuffers()
                }
              } else if (hasToolCalls) {
                // 如果发生过工具调用：模型开始输出正文结论时，立即将所有在途工具卡片安全结算（避免后台工具计数异常阻塞正文）
                if (activeToolCalls.size > 0) {
                  settleActiveToolCalls()
                }
                const { index, startChunk, endChunk } = ensureBlock('text')
                if (endChunk) yield endChunk
                if (startChunk) yield startChunk
                currentBlock!.content += content.text
                yield { type: 'text-delta', index, text: content.text }
              } else {
                const { index, startChunk, endChunk } = ensureBlock('text')
                if (endChunk) yield endChunk
                if (startChunk) yield startChunk
                currentBlock!.content += content.text
                yield { type: 'text-delta', index, text: content.text }
              }
            }
          }
        }
        // 处理 token 用量更新
        else if (update.sessionUpdate === 'usage_update') {
          const usage = update as AcpUsageUpdate & { used?: number; totalTokens?: number }
          if (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number') {
            const inTok = usage.inputTokens ?? 0
            const outTok = usage.outputTokens ?? 0
            const totTok = typeof usage.totalTokens === 'number' ? usage.totalTokens : (typeof usage.used === 'number' ? usage.used : inTok + outTok)
            yield {
              type: 'usage',
              usage: {
                inputTokens: inTok,
                outputTokens: outTok,
                totalTokens: totTok,
              },
            }
          }
        }
      }

      // 纯对话场景下若缓冲区仍有残留内容，在流收尾前输出
      if (!hasToolCalls && !bypassToolBuffering) {
        yield* flushInitialBuffers()
      }

      // 确保收尾在途尚未接收到完成回执的工具卡片，避免前端卡片一直等待
      settleActiveToolCalls()

      // 收尾当前尚未关闭的内容块
      const finalEnd = endCurrentBlock()
      if (finalEnd) yield finalEnd

      if (promptUsage) {
        yield { type: 'usage', usage: promptUsage }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      if (error instanceof LlmError) throw error
      const msg = error instanceof Error ? (error.stack || error.message) : String(error)
      const tail = client.getStderrTail().trim() || 'none'
      console.error('[dsh-devin-cli] Stream exception:', error)
      throw new LlmError(`Devin ACP stream failed: ${msg} (stderr tail: ${tail})`, 'TRANSPORT', { cause: error as Error })
    } finally {
      client.close()
    }
  }

  private handlePermission(request: AcpPermissionRequestParams): { outcome: { outcome: string; optionId?: string } } | undefined {
    // 优先允许工具执行（支持代码查找、文档阅读与分析），防止子进程由于等待确认而无限期死锁挂起
    const allow = request.options?.find((o) => {
      const k = (o.kind || '').toLowerCase()
      const id = (o.optionId || o.id || '').toLowerCase()
      return k.includes('allow') || id.includes('allow') || id.includes('accept') || id.includes('approve') || id.includes('yes')
    })
    const chosen = allow ?? request.options?.[0]
    const optionId = chosen?.optionId || chosen?.id || 'allow_once'
    return {
      outcome: {
        outcome: 'selected',
        optionId,
      },
    }
  }

}
