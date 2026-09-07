import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DevinPluginSettings {
  devinBin: string
  workspace: string
  streamIdleTimeoutMs: number
  activeModelIds: string[]
}

const DEFAULT_SETTINGS: DevinPluginSettings = {
  devinBin: 'devin',
  workspace: '.',
  streamIdleTimeoutMs: 300_000,
  activeModelIds: [
    'glm-5-2',
    'swe-1-7',
    'claude-3-7-sonnet',
    'deepseek-v4-pro-max',
    'gemini-3-1-pro-high',
  ],
}

function getSettingsPath(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(dshHome, 'profiles', 'web')
  if (existsSync(dir)) return join(dir, 'devin-settings.json')
  return join(dshHome, 'devin-settings.json')
}

export function loadSettings(): DevinPluginSettings {
  const file = getSettingsPath()
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<DevinPluginSettings>
      return {
        ...DEFAULT_SETTINGS,
        ...data,
      }
    }
  } catch {
    // 忽略异常，使用默认设置
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(settings: Partial<DevinPluginSettings>): DevinPluginSettings {
  const current = loadSettings()
  const updated = {
    ...current,
    ...settings,
  }
  const file = getSettingsPath()
  try {
    const dir = file.replace(/[/\\][^/\\]+$/, '')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(updated, null, 2), 'utf8')
  } catch (err) {
    console.warn('[dsh-devin-cli] Failed to save devin-settings.json:', err)
  }
  return updated
}
