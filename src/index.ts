import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  resolveRetryPolicy,
  RetryPolicySchema,
  type RetryPolicyConfig,
  type ResolvedRetryPolicy,
  type LlmModelDiscoveryRequest,
  type LlmDiscoveredModel,
} from '@deepseek-ai/dsh-llm'
import type { SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import { DevinAdapter, PROVIDER, type DevinModelConfig } from './DevinAdapter.ts'
import { readDevinSession } from './credentials.ts'
import { DevinBridgeServer } from './bridge.ts'
import { loadSettings, saveSettings } from './storage.ts'
import { globalDevinRegistry } from './models.ts'

/**
 * 通过本机 devin CLI 执行 `devin models list --format json`
 * 动态获取当前账户可用的所有模型列表，并构建家族与变体映射索引。
 */
export async function discoverDevinModels(devinBin = 'devin', signal?: AbortSignal) {
  try {
    await globalDevinRegistry.init(devinBin, signal)
    const list = globalDevinRegistry.getBaseModels().map((b) => ({
      id: b.id,
      name: b.name,
      contextWindow: b.contextWindow,
      maxTokens: b.maxTokens,
      efforts: b.efforts,
    }))
    if (list.length > 0) return list
  } catch (err) {
    console.warn('[discoverDevinModels error]:', err)
  }
  return []
}

export const name = 'dsh-devin-cli'
export const inject = ['llm']

const SETTINGS_NS = 'dsh-devin-cli' as const

// ─── 默认模型 ───────────────────────────────────────────────────────────────

const DEFAULT_MODELS: DevinModelConfig[] = [
  {
    id: 'glm-5-2',
    name: 'GLM-5.2',
    description: 'Devin GLM-5.2 reasoning model.',
    contextWindow: 200_000,
    maxTokens: 65_536,
    supportsImages: false,
  },
  {
    id: 'swe-1-7',
    name: 'SWE-1.7',
    description: 'Devin SWE-1.7 coding model with vision support.',
    contextWindow: 262_000,
    maxTokens: 65_536,
    supportsImages: true,
  },
]

// ─── 配置 schema ────────────────────────────────────────────────────────────

export interface Config {
  /** 本地 Bridge 服务监听端口，默认 4140。 */
  bridgePort: number
  /** Devin CLI 可执行文件名称或路径，默认 'devin'。 */
  devinBin: string
  /** ACP session 工作目录。 */
  workspace: string
  /** ACP 流空闲超时（毫秒）。 */
  streamIdleTimeoutMs: number
  /**
   * Devin session token（可选）。
   * 留空时自动复用本机 Devin CLI 的登录会话。
   */
  token: string
  /** 默认上下文窗口，默认 200,000。 */
  defaultContextWindow: number
  /** 默认最大输出 token，默认 65,536。 */
  defaultMaxTokens: number
  /** 可用模型列表。 */
  models: DevinModelConfig[]
  /** 重试策略。 */
  retryPolicy: RetryPolicyConfig
}

const catalogModel: z<DevinModelConfig> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  supportsImages: z.boolean(),
})

export const Config: z<Config> = z.object({
  bridgePort: z.number().step(1).min(1024).max(65535).default(4140),
  devinBin: z.string().default('devin'),
  workspace: z.string().default('.'),
  streamIdleTimeoutMs: z.number().step(1).min(1000).default(300_000),
  token: z.string().role('secret').default(''),
  defaultContextWindow: z.number().step(1).min(1).default(200_000),
  defaultMaxTokens: z.number().step(1).min(1).default(65_536),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  retryPolicy: RetryPolicySchema,
})

// ─── 插件入口 ───────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  let current: Config = config
  const source: () => Config = () => current

  let adapterHandle: (() => void) | null = null
  let bridgeServer: DevinBridgeServer | null = null

  const userSettings = loadSettings()
  const devinBin = userSettings.devinBin || config.devinBin || 'devin'
  const workspace = userSettings.workspace || config.workspace || '.'
  const streamIdleTimeoutMs = userSettings.streamIdleTimeoutMs || config.streamIdleTimeoutMs || 300_000

  const retryPolicy: ResolvedRetryPolicy = resolveRetryPolicy(
    config.retryPolicy,
    `llm: provider "${PROVIDER}" retryPolicy`,
  )

  const token = config.token || readDevinSession()?.apiKey || ''

  const adapter = new DevinAdapter({
    ctx,
    bin: devinBin,
    cwd: workspace,
    streamIdleTimeoutMs,
    models: config.models,
    defaultContextWindow: config.defaultContextWindow,
    defaultMaxTokens: config.defaultMaxTokens,
    token,
    retryPolicy,
    discoverModels: () => discoverDevinModels(devinBin),
  })

  // 1. 原生注册到 DSH llm 适配器，用户在对话选择器（/model）中即可直接选用 Devin 的全部模型
  try {
    adapterHandle = ctx.llm.registerAdapter([PROVIDER], adapter)
    console.log('[dsh-devin-cli] Successfully registered Devin LLM adapter')
  } catch (err) {
    ctx.logger?.warn?.(`[dsh-devin-cli] Failed to register adapter: ${err}`)
  }

  // 2. 启动本地 Bridge 服务，供 Client 端 UI 获取状态、刷新与切换模型
  bridgeServer = new DevinBridgeServer({
    port: config.bridgePort,
    devinBin,
    workspace,
    streamIdleTimeoutMs,
    token,
    onSettingsChanged: () => {
      adapter.clearCache()
    },
  })

  void bridgeServer.start().catch((err) => {
    ctx.logger?.warn?.(`[dsh-devin-cli] Failed to start Devin bridge server: ${err}`)
  })

  // 3. 安装配置节（支持 Cordis 高级配置）
  const hooks: SettingsSectionHooks<Config> = {
    setSource(thunk: () => Config): void {
      current = thunk()
    },
    onChange(): void {
      adapter.clearCache()
    },
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NS, Config, config, hooks)
  })

  ctx.effect(() => () => {
    if (adapterHandle) {
      try { adapterHandle() } catch { /* ignore */ }
      adapterHandle = null
    }
    if (bridgeServer) {
      void bridgeServer.stop()
      bridgeServer = null
    }
  })
}

export {
  DevinAdapter,
  PROVIDER,
  mapDevinToolNameToDsh,
  type DevinModelConfig,
  type DevinModelInfo,
} from './DevinAdapter.ts'
export { DevinBridgeServer, type DevinBridgeOptions } from './bridge.ts'
export { readDevinSession, devinCredentialsPath, type DevinSession } from './credentials.ts'
export { AcpStdioClient } from './acp/AcpStdioClient.ts'
export * from './acp/protocol.ts'
