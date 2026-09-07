import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DevinAdapter } from './DevinAdapter.ts'
import { discoverDevinModels } from './index.ts'
import { loadSettings, saveSettings, type DevinPluginSettings } from './storage.ts'

const execFileAsync = promisify(execFile)

export interface DevinBridgeOptions {
  port?: number
  devinBin?: string
  workspace?: string
  streamIdleTimeoutMs?: number
  token?: string
  onSettingsChanged?: (settings: DevinPluginSettings) => void
}

export class DevinBridgeServer {
  private server: http.Server | null = null
  private readonly port: number
  private adapter: DevinAdapter
  private devinBin: string
  private cachedModels: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number; efforts?: string[] }> = []
  private options: DevinBridgeOptions

  constructor(options: DevinBridgeOptions = {}) {
    this.options = options
    this.port = options.port ?? 4140
    this.devinBin = options.devinBin ?? 'devin'
    this.adapter = new DevinAdapter({
      bin: this.devinBin,
      cwd: options.workspace ?? '.',
      streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? 300_000,
      models: [],
      defaultContextWindow: 200_000,
      defaultMaxTokens: 65_536,
      token: options.token ?? '',
    })
  }

  getAdapter(): DevinAdapter {
    return this.adapter
  }

  async start(): Promise<number> {
    if (this.server) return this.port

    return new Promise<number>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        // 全局 CORS 头
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        const url = req.url?.split('?')[0] || ''

        // ─── 管理 API ──────────────────────────────────────────────────────────

        // 1. 获取当前状态
        if (req.method === 'GET' && url === '/api/status') {
          try {
            const settings = loadSettings()
            let version = 'unknown'
            let online = false
            try {
              const { stdout } = await execFileAsync(settings.devinBin || this.devinBin, ['--version'], {
                timeout: 5000,
                windowsHide: true,
              })
              version = stdout.trim()
              online = true
            } catch {
              // CLI 执行失败
            }

            if (this.cachedModels.length === 0) {
              this.cachedModels = await discoverDevinModels(settings.devinBin || this.devinBin)
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(
              JSON.stringify({
                ok: true,
                service: 'dsh-devin-cli-bridge',
                port: this.port,
                online,
                bin: settings.devinBin || this.devinBin,
                version,
                totalModels: this.cachedModels.length,
                activeCount: settings.activeModelIds?.length || 0,
                settings,
              }),
            )
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String(err) }))
          }
          return
        }

        // 2. 获取模型列表
        if (req.method === 'GET' && url === '/api/models') {
          try {
            const settings = loadSettings()
            if (this.cachedModels.length === 0) {
              this.cachedModels = await discoverDevinModels(settings.devinBin || this.devinBin)
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(
              JSON.stringify({
                ok: true,
                models: this.cachedModels,
                activeModelIds: settings.activeModelIds,
              }),
            )
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String(err) }))
          }
          return
        }

        // 3. 刷新模型列表
        if (req.method === 'POST' && url === '/api/refresh') {
          try {
            const settings = loadSettings()
            this.cachedModels = await discoverDevinModels(settings.devinBin || this.devinBin)
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(
              JSON.stringify({
                ok: true,
                total: this.cachedModels.length,
                models: this.cachedModels,
              }),
            )
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String(err) }))
          }
          return
        }

        // 4. 更新配置与激活的模型
        if (req.method === 'POST' && url === '/api/settings') {
          let bodyText = ''
          req.setEncoding('utf8')
          req.on('data', (chunk) => { bodyText += chunk })
          req.on('end', () => {
            try {
              const body = JSON.parse(bodyText) as Partial<DevinPluginSettings>
              const updated = saveSettings(body)
              this.options.onSettingsChanged?.(updated)
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, settings: updated }))
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: String(err) }))
            }
          })
          return
        }

        // ─── OpenAI 兼容服务 ──────────────────────────────────────────────────

        if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
          try {
            if (this.cachedModels.length === 0) {
              this.cachedModels = await discoverDevinModels(this.devinBin)
            }
            const models = this.cachedModels.map((d) => ({
              id: d.id,
              object: 'model',
              name: d.name,
              context_window: d.contextWindow ?? 200_000,
              max_tokens: d.maxTokens ?? 65_536,
              owned_by: 'devin',
            }))
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ object: 'list', data: models }))
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: { message: String(err) } }))
          }
          return
        }

        if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
          let bodyText = ''
          req.setEncoding('utf8')
          req.on('data', (chunk) => { bodyText += chunk })
          req.on('end', async () => {
            try {
              const body = JSON.parse(bodyText) as {
                model?: string
                messages?: Array<{ role: string; content: unknown }>
                stream?: boolean
              }
              const model = body.model || 'glm-5-2'
              const abortController = new AbortController()
              req.on('close', () => abortController.abort())

              res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
              })

              const messages = (body.messages || []).map((m) => {
                let text = ''
                if (typeof m.content === 'string') {
                  text = m.content
                } else if (Array.isArray(m.content)) {
                  text = m.content
                    .map((item: unknown) => {
                      if (typeof item === 'string') return item
                      if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
                        return item.text
                      }
                      return ''
                    })
                    .join('\n')
                } else if (m.content) {
                  text = JSON.stringify(m.content)
                }
                return {
                  role: m.role,
                  content: [{ type: 'text' as const, text }],
                }
              })

              const generateOptions: GenerateOptions = {
                provider: 'devin',
                model,
                messages: messages as any,
                signal: abortController.signal,
              }

              const stream: AsyncIterable<StreamChunk> = this.adapter.stream(generateOptions, abortController.signal)

              for await (const chunk of stream) {
                if (chunk.type === 'text-delta') {
                  const sseChunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: chunk.text },
                        finish_reason: null,
                      },
                    ],
                  }
                  res.write(`data: ${JSON.stringify(sseChunk)}\n\n`)
                }
              }

              const endChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: 'stop',
                  },
                ],
              }
              res.write(`data: ${JSON.stringify(endChunk)}\n\n`)
              res.write('data: [DONE]\n\n')
              res.end()
            } catch (err) {
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: { message: String(err) } }))
              } else {
                res.end()
              }
            }
          })
          return
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          server.listen(0, '127.0.0.1')
        } else {
          reject(err)
        }
      })

      server.listen(this.port, '127.0.0.1', () => {
        const address = server.address()
        const boundPort = typeof address === 'object' && address ? address.port : this.port
        this.server = server
        console.log(`[dsh-devin-cli] Devin bridge listening on http://127.0.0.1:${boundPort}`)
        resolve(boundPort)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    return new Promise((resolve) => {
      this.server?.close(() => {
        this.server = null
        resolve()
      })
    })
  }
}
