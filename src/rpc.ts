import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { discoverDevinModels } from './models.ts'
import { loadSettings, saveSettings, type DevinPluginSettings } from './storage.ts'

const execFileAsync = promisify(execFile)

export const RPC_NAMESPACE = 'devin-cli'

export interface DevinRpcOptions {
  devinBin?: string
  onSettingsChanged?: (settings: DevinPluginSettings) => void
}

/** Wire result shape shared with @deepseek-ai/dsh-client-connection. */
export type ConnectionRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

interface HostConnectionLike {
  rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcResult<unknown>>,
    ): () => void
  }
}

interface DiscoveredModel {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  efforts?: string[]
}

function failure(code: string, message: string): ConnectionRpcResult<unknown> {
  return { ok: false, error: { code, message, details: {} } }
}

async function probeCliVersion(bin: string): Promise<{ online: boolean; version: string }> {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5000, windowsHide: true })
    return { online: true, version: stdout.trim() }
  } catch {
    return { online: false, version: 'unknown' }
  }
}

/**
 * 把设置面板的管理端点注册到 DSH 原生 `/api` RPC 通道：
 * 复用宿主的浏览器认证与 Host/Origin 信任栅栏，不再监听任何本地端口。
 */
export function installDevinRpc(ctx: Context, options: DevinRpcOptions = {}): void {
  const fallbackBin = options.devinBin ?? 'devin'
  let cachedModels: DiscoveredModel[] = []
  let inFlightDiscovery: Promise<DiscoveredModel[]> | null = null

  const ensureModels = async (bin: string, signal?: AbortSignal): Promise<DiscoveredModel[]> => {
    if (cachedModels.length > 0) {
      return cachedModels
    }
    if (inFlightDiscovery) {
      return inFlightDiscovery
    }
    inFlightDiscovery = (async () => {
      try {
        const raw = await discoverDevinModels(bin, signal)
        const map = new Map<string, DiscoveredModel>()
        for (const m of raw) {
          if (m?.id && !map.has(m.id)) {
            map.set(m.id, m)
          }
        }
        cachedModels = Array.from(map.values())
        return cachedModels
      } finally {
        inFlightDiscovery = null
      }
    })()
    return inFlightDiscovery
  }

  const handleRpc = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<ConnectionRpcResult<unknown>> => {
    try {
      const settings = loadSettings()
      const bin = settings.devinBin || fallbackBin
      switch (endpoint) {
        case 'status': {
          const { online, version } = await probeCliVersion(bin)
          const models = await ensureModels(bin, signal)
          return {
            ok: true,
            value: {
              ok: true,
              service: 'dsh-devin-cli',
              online,
              bin,
              version,
              totalModels: models.length,
              activeCount: settings.activeModelIds?.length || 0,
              settings,
            },
          }
        }
        case 'models': {
          const models = await ensureModels(bin, signal)
          return { ok: true, value: { ok: true, models, activeModelIds: settings.activeModelIds } }
        }
        case 'refresh': {
          cachedModels = []
          inFlightDiscovery = null
          const models = await ensureModels(bin, signal)
          return { ok: true, value: { ok: true, total: models.length, models } }
        }
        case 'settings': {
          const body = (payload ?? {}) as Partial<DevinPluginSettings>
          if (body.activeModelIds !== undefined && !Array.isArray(body.activeModelIds)) {
            return failure('devin-cli/invalid-settings', 'activeModelIds 必须是字符串数组')
          }
          const updated = saveSettings(body)
          options.onSettingsChanged?.(updated)
          return { ok: true, value: { ok: true, settings: updated } }
        }
        default:
          return failure('devin-cli/unknown-endpoint', `Unknown endpoint: ${endpoint}`)
      }
    } catch (err) {
      return failure('devin-cli/internal', err instanceof Error ? err.message : String(err))
    }
  }

  ctx.inject(['connection'], (connCtx) => {
    const connection = (connCtx as unknown as { connection: HostConnectionLike }).connection
    const dispose = connection.rpc.handle(
      '/devin-cli',
      (endpoint, payload, signal) => handleRpc(endpoint, payload, signal),
    )
    return () => {
      dispose?.()
    }
  })
}
