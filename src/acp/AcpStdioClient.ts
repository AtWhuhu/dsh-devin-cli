import { spawn, type ChildProcess } from 'node:child_process'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  ACP_PROTOCOL_VERSION,
  type AcpClientInfo,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpJsonRpcMessage,
  type AcpPermissionRequestParams,
  type AcpPromptContent,
  type AcpPromptParams,
  type AcpPromptResponse,
  type AcpSessionNewParams,
  type AcpSessionNewResult,
  type AcpSessionUpdate,
  type AcpSessionUpdateEnvelope,
} from './protocol.ts'

export interface AcpStdioClientOptions {
  argv: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  onUpdate: (update: AcpSessionUpdate) => void
  onPermissionRequest?: (request: AcpPermissionRequestParams) => { outcome: { outcome: string; optionId?: string } } | undefined
  onGarbage?: (line: string) => void
  onStderr?: (chunk: string) => void
}

export class AcpStdioClient {
  private readonly process: ChildProcess
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
  private nextId = 1
  private closed = false
  private readonly stderrBuffer: string[] = []

  constructor(private readonly options: AcpStdioClientOptions) {
    this.process = spawn(options.argv[0]!, options.argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.process.stdin?.on('error', () => {})
    this.process.stdout!.setEncoding('utf8')
    this.process.stderr!.setEncoding('utf8')

    this.process.stdout!.on('data', (chunk: string) => this.onStdoutData(chunk))
    this.process.stderr!.on('data', (chunk: string) => {
      this.stderrBuffer.push(chunk)
      if (this.stderrBuffer.length > 30) this.stderrBuffer.shift()
      this.options.onStderr?.(chunk)
    })
    this.process.on('error', (err) => this.close(err))
    this.process.on('exit', () => this.close(new Error('acp child process exited')))
  }

  private onStdoutData(chunk: string): void {
    const lines = chunk.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const message = JSON.parse(trimmed) as AcpJsonRpcMessage
        this.onMessage(message)
      } catch {
        this.options.onGarbage?.(trimmed)
      }
    }
  }

  private onMessage(message: AcpJsonRpcMessage): void {
    // 1. 处理来自服务端的 RPC 请求（优先响应 session/request_permission，避免死锁挂起）
    if (message.method) {
      if (message.method === 'session/request_permission') {
        const response = this.options.onPermissionRequest?.(message.params as AcpPermissionRequestParams)
        const result = response !== undefined ? response : { outcome: { outcome: 'cancelled' } }
        if (message.id !== undefined) {
          this.send({ jsonrpc: '2.0', id: message.id, result })
        }
        return
      }

      if (message.method === 'session/update') {
        const envelope = message.params as AcpSessionUpdateEnvelope
        this.options.onUpdate(envelope.update)
        return
      }
      return
    }

    // 2. 处理客户端发起调用的对应回包
    if (message.id !== undefined) {
      const key = typeof message.id === 'number' ? message.id : Number(message.id)
      const entry = this.pending.get(key)
      if (entry) {
        this.pending.delete(key)
        if (message.error !== undefined) {
          entry.reject(new Error(`acp: ${message.error.message}`))
        } else {
          entry.resolve(message.result)
        }
      }
    }
  }


  private send(message: AcpJsonRpcMessage): void {
    if (this.closed) return
    if (!this.process.stdin?.writable) return
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      // 管道若破裂静默忽略，由 exit/error 回调统一结算
    }
  }

  private request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new LlmError('acp: client closed', 'TRANSPORT'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new LlmError(`acp: request "${method}" timed out after ${timeoutMs}ms`, 'TIMEOUT'))
        }, timeoutMs)
      }
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value as T)
        },
        reject: (err) => {
          if (timer) clearTimeout(timer)
          reject(err)
        },
      })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        if (timer) clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async initialize(clientInfo: AcpClientInfo, timeoutMs = 30_000): Promise<AcpInitializeResult> {
    const params: AcpInitializeParams = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo,
    }
    return this.request<AcpInitializeResult>('initialize', params, timeoutMs)
  }

  authenticate(methodId: string, meta?: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    return this.request<unknown>('authenticate', { methodId, ...(meta ? { meta } : {}) }, timeoutMs)
  }

  sessionNew(params: AcpSessionNewParams, timeoutMs = 30_000): Promise<AcpSessionNewResult> {
    return this.request<AcpSessionNewResult>('session/new', params, timeoutMs)
  }

  prompt(sessionId: string, prompt: AcpPromptContent[]): Promise<AcpPromptResponse> {
    const params: AcpPromptParams = { sessionId, prompt }
    return this.request<AcpPromptResponse>('session/prompt', params)
  }

  cancel(sessionId: string): void {
    this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  }

  getStderrTail(): string {
    return this.stderrBuffer.join('').slice(-4096)
  }

  close(error?: Error): void {
    if (this.closed) return
    this.closed = true
    for (const [, entry] of this.pending) {
      entry.reject(error ?? new LlmError('acp: connection closed', 'TRANSPORT'))
    }
    this.pending.clear()
    if (!this.process.killed) {
      this.process.kill('SIGTERM')
    }
  }
}
