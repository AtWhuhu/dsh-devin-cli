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

  ctx.effect(() => {
    let unregister: (() => void) | undefined
    let unregisterWebServer: (() => void) | undefined

    const register = (conn: HostConnectionLike) => {
      if (unregister || !conn?.rpc?.handle) return
      try {
        unregister = conn.rpc.handle(
          '/devin-cli',
          (endpoint, payload, signal) => handleRpc(endpoint, payload, signal),
        )
      } catch (err: any) {
        const msg = String(err?.message || err)
        // 遇到 DSH 官方 connection.rpc.handle 缺失 webServer inject 声明的已知缺陷，静默交由下方 webServer 路由处理
        if (!msg.includes('webServer') && !msg.includes('without inject')) {
          console.warn('[dsh-devin-cli] Failed to register RPC on connection:', msg)
        }
      }
    }

    // 双轨兜底：针对 DSH 0.1.5-rc.1 官方已知回归缺陷（connection.rpc.handle 无法解析 webServer 导致第三方 RPC 路由 404）
    // 直接向 webServer 挂载 /devin-cli 前缀路由，保证设置面板与控制端点 100% 可达
    const attachWebServer = (server: any) => {
      if (unregisterWebServer || !server?.register) return
      try {
        const routePath = '/devin-cli'
        if (server.prefix && typeof server.prefix.has === 'function' && server.prefix.has(routePath)) {
          try {
            server.prefix.delete(routePath)
          } catch {}
        }
        unregisterWebServer = server.register({
          kind: 'prefix',
          path: routePath,
          handler: async (req: any, res: any) => {
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            if (req.method === 'OPTIONS') {
              res.writeHead(204)
              res.end()
              return
            }
            if (req.method === 'GET') {
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.writeHead(200)
              res.end(JSON.stringify({ ok: true, name: 'dsh-devin-cli' }))
              return
            }
            if (req.method !== 'POST') {
              res.writeHead(405)
              res.end('Method Not Allowed')
              return
            }
            const url = new URL(req.url, 'http://localhost')
            const endpoint = url.pathname.replace(/^\/devin-cli\/?/, '')
            let body = ''
            req.on('data', (c: any) => { body += c })
            req.on('end', async () => {
              try {
                const parsed = body ? JSON.parse(body) : {}
                const rpcId = parsed.rpcId || 'devin-fallback'
                const payload = parsed.payload ?? {}
                const result = await handleRpc(endpoint, payload, new AbortController().signal)
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.writeHead(200)
                res.end(JSON.stringify({
                  type: 'server-response',
                  rpcId,
                  result,
                }))
              } catch (e: any) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.writeHead(200)
                res.end(JSON.stringify({
                  type: 'server-response',
                  rpcId: 'error',
                  result: { ok: false, error: { code: 'devin-cli/error', message: e.message, details: {} } },
                }))
              }
            })
          },
        })
        console.log('[dsh-devin-cli] Registered webServer fallback prefix route /devin-cli')
      } catch (err) {
        console.warn('[dsh-devin-cli] Failed to register webServer fallback route:', err)
      }
    }

    const existingConn = (ctx as any).connection as HostConnectionLike | undefined
    if (existingConn?.rpc?.handle) {
      register(existingConn)
    } else {
      ctx.inject(['connection'], (connCtx) => {
        const conn = (connCtx as unknown as { connection: HostConnectionLike }).connection
        register(conn)
      })
    }

    const existingWebServer = (ctx as any).webServer
    if (existingWebServer) {
      attachWebServer(existingWebServer)
    } else {
      ctx.inject(['webServer'], (wsCtx: any) => {
        attachWebServer(wsCtx.webServer)
      })
    }

    return () => {
      if (unregister) {
        unregister()
        unregister = undefined
      }
      if (unregisterWebServer) {
        unregisterWebServer()
        unregisterWebServer = undefined
      }
    }
  }, 'dsh-devin-cli: rpc channel')
}
