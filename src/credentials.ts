// Devin CLI credentials.toml 自动读取。
// 本模块只读不写，使用纯 Node.js 标准库解析，零外部依赖。

import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_API_SERVER_URL = 'https://server.codeium.com'

/**
 * Devin CLI credentials.toml 的平台相关路径。
 * 支持环境变量 DEVIN_CREDENTIALS_PATH 覆盖。
 */
export function devinCredentialsPath(): string {
  if (process.env.DEVIN_CREDENTIALS_PATH) return process.env.DEVIN_CREDENTIALS_PATH
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'devin', 'credentials.toml')
  }
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, 'devin', 'credentials.toml')
}

export interface DevinSession {
  /** windsurf_api_key，格式 devin-session-token$... */
  apiKey: string
  /** api_server_url，默认 https://server.codeium.com */
  apiServerUrl: string
  /** devin_api_url，可选 */
  devinApiUrl?: string
}

/**
 * 从 credentials.toml 解析 Devin session。
 * 使用轻量 TOML 顶层扫描器，避免引入额外依赖。
 */
export function devinSessionEntry(contents: string): DevinSession | undefined {
  const table = scanTomlTopLevel(contents)
  const apiKey = table['windsurf_api_key']
  if (typeof apiKey !== 'string' || !apiKey) return undefined
  return {
    apiKey,
    apiServerUrl: table['api_server_url'] || DEFAULT_API_SERVER_URL,
    ...table['devin_api_url'] ? { devinApiUrl: table['devin_api_url'] } : {},
  }
}

/**
 * 尝试从 Devin CLI 的 credentials.toml 读取 session。
 * 文件不存在或格式无效时返回 undefined，不抛异常。
 */
export function readDevinSession(options?: { credentialsPath?: string }): DevinSession | undefined {
  const path = options?.credentialsPath ?? devinCredentialsPath()
  if (!existsSync(path)) return undefined
  try {
    const contents = readFileSync(path, 'utf8')
    return devinSessionEntry(contents)
  } catch {
    return undefined
  }
}

/**
 * 扫描 TOML 文件的顶层 string key=value 对。
 */
function scanTomlTopLevel(contents: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = contents.split('\n')
  let inTable = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      inTable = true
      continue
    }
    if (inTable) continue
    const eqIdx = line.indexOf('=')
    if (eqIdx < 0) continue
    const key = line.slice(0, eqIdx).trim()
    const valuePart = line.slice(eqIdx + 1).trim()
    if (!valuePart.startsWith('"')) continue
    const closing = valuePart.indexOf('"', 1)
    if (closing < 0) continue
    result[key] = valuePart.slice(1, closing)
  }
  return result
}
