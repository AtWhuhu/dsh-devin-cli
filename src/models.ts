import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const execFileAsync = promisify(execFile)

export interface DevinVariant {
  uid: string
  label: string
  effort?: string
  contextWindow?: number
  maxTokens?: number
  familyUid: string
  familyLabel: string
  supportsImages: boolean
}

export interface DevinFamily {
  familyUid: string
  familyLabel: string
  variants: DevinVariant[]
  supportedEfforts: Array<{ id: string; name: string; variantUid: string; contextWindow?: number }>
  defaultVariant: DevinVariant
  defaultEffort?: string
  supportsImages: boolean
}

export interface ResolvedModelRoute {
  resolvedModelUid: string
  displayName: string
  contextWindow: number
  maxTokens: number
  supportsImages: boolean
  supportedEfforts: Array<{ id: string; name: string }>
  currentEffort?: string
}

function capitalize(s: string): string {
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function extractEffort(label = '', uid = ''): string | undefined {
  // 1. 从 uid 后缀匹配
  const mUid = uid.match(/-(low|medium|high|max|xhigh|minimal|none|fast)$/i)
  if (mUid) return mUid[1].toLowerCase()

  // 2. 从 label 单词匹配
  const mLabel = label.match(/\b(low|medium|high|max|xhigh|minimal|none|fast)\b/i)
  if (mLabel) return mLabel[1].toLowerCase()

  // 3. 特殊模型 uid 规则
  if (uid === 'swe-1-7') return 'max'
  if (uid === 'swe-1-7-medium') return 'medium'
  if (uid === 'swe-1-7-lightning') return 'max'
  if (uid === 'swe-1-7-lightning-medium') return 'medium'

  return undefined
}

export class DevinModelRegistry {
  private families: DevinFamily[] = []
  private variantMap = new Map<string, DevinVariant>()
  private familyMap = new Map<string, DevinFamily>()
  private initialized = false

  async init(devinBin = 'devin', signal?: AbortSignal): Promise<void> {
    try {
      const { stdout } = await execFileAsync(devinBin, ['models', 'list', '--format', 'json'], {
        signal,
        timeout: 25_000,
        maxBuffer: 15 * 1024 * 1024,
        windowsHide: true,
      })
      const data = JSON.parse(stdout) as { families?: any[] }
      this.loadFromJsonFamilies(data.families || [])
      this.initialized = true
    } catch (err) {
      console.warn('[DevinModelRegistry] Failed to fetch live models, using fallback defaults:', err)
      this.loadFallback()
    }
  }

  loadFromJsonFamilies(rawFamilies: any[]): void {
    this.families = []
    this.variantMap.clear()
    this.familyMap.clear()

    for (const fam of rawFamilies) {
      const fUid = String(fam.family_uid || fam.slug || '')
      const fLabel = String(fam.family_label || fUid || 'Devin')
      const variants: DevinVariant[] = []
      const effortMap = new Map<string, { id: string; name: string; variantUid: string; contextWindow?: number }>()

      for (const v of fam.variants || []) {
        const uid = String(v.model_uid || '')
        if (!uid) continue

        const label = String(v.label || uid)
        const effort = extractEffort(label, uid)
        const contextWindow = typeof v.max_context_tokens === 'number' ? v.max_context_tokens : undefined
        const maxTokens = typeof v.max_output_tokens === 'number' ? v.max_output_tokens : undefined
        const supportsImages = /swe|claude|gpt|gemini|vision|omni/i.test(uid) || /swe|claude|gpt|gemini|vision|omni/i.test(fUid)

        const variant: DevinVariant = {
          uid,
          label,
          effort,
          contextWindow,
          maxTokens,
          familyUid: fUid,
          familyLabel: fLabel,
          supportsImages,
        }

        variants.push(variant)
        this.variantMap.set(uid.toLowerCase(), variant)

        if (effort && !effortMap.has(effort)) {
          effortMap.set(effort, {
            id: effort,
            name: capitalize(effort),
            variantUid: uid,
            contextWindow,
          })
        }
      }

      if (variants.length > 0) {
        const effortOrder = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'fast', 'none']
        const supportedEfforts = Array.from(effortMap.values()).sort((a, b) => {
          const idxA = effortOrder.indexOf(a.id)
          const idxB = effortOrder.indexOf(b.id)
          return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB)
        })

        // 挑选默认变体：优先 high，其次 max，其次第一个
        const defaultVariant = variants.find((v) => v.effort === 'high')
          ?? variants.find((v) => v.effort === 'max')
          ?? variants[0]

        const defaultEffort = defaultVariant.effort || (supportedEfforts.length > 0 ? supportedEfforts[0].id : undefined)
        const supportsImages = variants.some((v) => v.supportsImages)

        const family: DevinFamily = {
          familyUid: fUid,
          familyLabel: fLabel,
          variants,
          supportedEfforts,
          defaultVariant,
          defaultEffort,
          supportsImages,
        }

        this.families.push(family)
        this.familyMap.set(fUid.toLowerCase(), family)
        // 允许以 familyLabel 索引
        this.familyMap.set(fLabel.toLowerCase(), family)
      }
    }
  }

  private loadFallback(): void {
    const fallbackFamilies = [
      {
        family_uid: 'glm-5-3-flash',
        family_label: 'GLM-5.3 Flash',
        variants: [
          { model_uid: 'glm-5-3-flash-low', label: 'GLM-5.3 Flash Low', max_context_tokens: 1000000, max_output_tokens: 128000 },
          { model_uid: 'glm-5-3-flash-high', label: 'GLM-5.3 Flash High', max_context_tokens: 1000000, max_output_tokens: 128000 },
          { model_uid: 'glm-5-3-flash-max', label: 'GLM-5.3 Flash Max', max_context_tokens: 1000000, max_output_tokens: 128000 },
        ],
      },
      {
        family_uid: 'swe-1.7',
        family_label: 'SWE-1.7',
        variants: [
          { model_uid: 'swe-1-7', label: 'SWE-1.7 Max', max_context_tokens: 262000, max_output_tokens: 128000 },
          { model_uid: 'swe-1-7-medium', label: 'SWE-1.7 Medium', max_context_tokens: 262000, max_output_tokens: 128000 },
        ],
      },
      {
        family_uid: 'glm-5.2',
        family_label: 'GLM-5.2',
        variants: [
          { model_uid: 'glm-5-2', label: 'GLM-5.2', max_context_tokens: 200000, max_output_tokens: 65536 },
          { model_uid: 'glm-5-2-max', label: 'GLM-5.2 Max', max_context_tokens: 200000, max_output_tokens: 65536 },
        ],
      },
    ]
    this.loadFromJsonFamilies(fallbackFamilies)
  }

  /**
   * 返回基础模型列表（过滤掉各变体 -low, -high, -max 等后缀），
   * 使得在模型列表（/model 下拉菜单）中只展示简洁明了的基础模型。
   * 每个基础模型自动包含其支持的全部推理等级。
   */
  getBaseModels(): Array<{
    id: string
    name: string
    contextWindow?: number
    maxTokens?: number
    supportsImages: boolean
    efforts: string[]
  }> {
    return this.families.map((fam) => ({
      id: fam.familyUid,
      name: fam.familyLabel,
      contextWindow: fam.defaultVariant.contextWindow,
      maxTokens: fam.defaultVariant.maxTokens,
      supportsImages: fam.supportsImages,
      efforts: fam.supportedEfforts.map((e) => e.name),
    }))
  }

  /**
   * 将输入的任何模型 ID（可能是变体 ID 如 glm-5-3-flash-high，或旧配置 ID）
   * 归一化为对应的基础模型 familyUid。
   */
  normalizeToBaseId(modelId: string): string {
    const norm = modelId.toLowerCase().trim()
    const variant = this.variantMap.get(norm)
    if (variant) return variant.familyUid
    const family = this.familyMap.get(norm)
    if (family) return family.familyUid
    return modelId
  }

  /**
   * 核心路由函数：
   * 传入基础模型 ID（如 glm-5-3-flash）或变体 ID（如 glm-5-3-flash-high），
   * 并结合用户在会话中选择的 reasoningEffort（如 high, low, medium, max），
   * 自动在同家族中查找匹配的变体后缀与真实模型 UID，并精准装配上下文大小。
   */
  resolveRoute(
    modelId: string,
    reasoningEffort?: string,
    defaultContext = 200000,
    defaultMax = 65536,
  ): ResolvedModelRoute {
    const normId = modelId.toLowerCase().trim()
    let matchedFamily = this.familyMap.get(normId)
    let matchedVariant = this.variantMap.get(normId)

    if (!matchedFamily && matchedVariant) {
      matchedFamily = this.familyMap.get(matchedVariant.familyUid.toLowerCase())
    }

    // 模糊匹配兜底
    if (!matchedFamily) {
      for (const fam of this.families) {
        if (normId.startsWith(fam.familyUid.toLowerCase()) || fam.familyUid.toLowerCase().startsWith(normId)) {
          matchedFamily = fam
          break
        }
      }
    }

    if (matchedFamily) {
      const familyEfforts = matchedFamily.supportedEfforts || []
      let finalVariant = matchedFamily.defaultVariant

      // 1. 如果有指定的 reasoningEffort，精准匹配同家族对应等级的变体
      if (reasoningEffort && familyEfforts.length > 0) {
        const targetEffort = reasoningEffort.toLowerCase()
        const variantWithEffort = matchedFamily.variants.find((v) => v.effort === targetEffort)
        if (variantWithEffort) {
          finalVariant = variantWithEffort
        }
      } else if (matchedVariant) {
        // 2. 如果 modelId 本身就是某个具体变体且未指定 effort
        finalVariant = matchedVariant
      }

      return {
        resolvedModelUid: finalVariant.uid,
        displayName: matchedFamily.familyLabel, // 基础展示名纯净，不带冗余括号或等级
        contextWindow: finalVariant.contextWindow ?? defaultContext,
        maxTokens: finalVariant.maxTokens ?? defaultMax,
        supportsImages: matchedFamily.supportsImages,
        supportedEfforts: familyEfforts.map((e) => ({ id: e.id, name: e.name })),
        currentEffort: finalVariant.effort || matchedFamily.defaultEffort,
      }
    }

    // 未知模型兜底
    return {
      resolvedModelUid: modelId,
      displayName: modelId,
      contextWindow: defaultContext,
      maxTokens: defaultMax,
      supportsImages: /swe|claude|gpt|gemini|vision|omni/i.test(modelId),
      supportedEfforts: [],
    }
  }
}

export const globalDevinRegistry = new DevinModelRegistry()

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
