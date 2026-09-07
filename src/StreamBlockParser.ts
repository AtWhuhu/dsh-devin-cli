import {
  ToolCallId,
  type StreamChunk,
  type ContentBlockType,
} from '@deepseek-ai/dsh-llm'

export class StreamBlockParser {
  private buffer = ''
  private blockIndex = 0
  private activeBlock:
    | { type: 'text'; index: number; text: string }
    | { type: 'reasoning'; index: number; text: string }
    | { type: 'tool-call'; index: number; id: string; name: string; args: string }
    | null = null

  public hasToolCalls = false

  constructor(private readonly emit: (chunk: StreamChunk) => void) {}

  public feed(chunkText: string): void {
    if (!chunkText) return
    this.buffer += chunkText
    this.process()
  }

  public close(): void {
    if (this.buffer.length > 0) {
      if (this.activeBlock?.type === 'reasoning') {
        this.emit({ type: 'reasoning-delta', index: this.activeBlock.index, text: this.buffer })
        this.activeBlock.text += this.buffer
      } else if (this.activeBlock?.type === 'tool-call') {
        this.emit({
          type: 'tool-call-delta',
          index: this.activeBlock.index,
          id: ToolCallId(this.activeBlock.id),
          name: this.activeBlock.name,
          argumentsDelta: this.buffer,
        })
        this.activeBlock.args += this.buffer
      } else {
        this.ensureBlock('text')
        this.emit({ type: 'text-delta', index: this.activeBlock!.index, text: this.buffer })
        if (this.activeBlock && this.activeBlock.type === 'text') {
          this.activeBlock.text += this.buffer
        }
      }
      this.buffer = ''
    }
    this.endCurrentBlock()
  }

  private endCurrentBlock(): void {
    if (!this.activeBlock) return
    const b = this.activeBlock
    this.activeBlock = null

    if (b.type === 'text') {
      this.emit({ type: 'block-end', index: b.index, block: { type: 'text', text: b.text } })
    } else if (b.type === 'reasoning') {
      this.emit({ type: 'block-end', index: b.index, block: { type: 'reasoning', text: b.text } })
    } else if (b.type === 'tool-call') {
      this.emit({
        type: 'block-end',
        index: b.index,
        block: {
          type: 'tool-call',
          id: ToolCallId(b.id),
          name: b.name,
          arguments: b.args,
        },
      })
    }
  }

  private ensureBlock(type: ContentBlockType, meta: { id?: string; name?: string } = {}): void {
    if (this.activeBlock && this.activeBlock.type === type) return
    this.endCurrentBlock()
    const index = this.blockIndex++
    if (type === 'text') {
      this.activeBlock = { type: 'text', index, text: '' }
    } else if (type === 'reasoning') {
      this.activeBlock = { type: 'reasoning', index, text: '' }
    } else if (type === 'tool-call') {
      this.activeBlock = {
        type: 'tool-call',
        index,
        id: meta.id || `call_${Date.now()}`,
        name: meta.name || 'unknown',
        args: '',
      }
    }
    this.emit({ type: 'block-start', index, blockType: type })
  }

  private process(): void {
    while (this.buffer.length > 0) {
      if (this.activeBlock?.type === 'reasoning') {
        const closeTag = '</thinking>'
        const idx = this.buffer.indexOf(closeTag)
        if (idx !== -1) {
          const content = this.buffer.slice(0, idx)
          if (content) {
            this.emit({ type: 'reasoning-delta', index: this.activeBlock.index, text: content })
            this.activeBlock.text += content
          }
          this.endCurrentBlock()
          this.buffer = this.buffer.slice(idx + closeTag.length)
          continue
        } else {
          const safeLen = this.getSafeLength(this.buffer, closeTag)
          if (safeLen > 0) {
            const content = this.buffer.slice(0, safeLen)
            this.emit({ type: 'reasoning-delta', index: this.activeBlock.index, text: content })
            this.activeBlock.text += content
            this.buffer = this.buffer.slice(safeLen)
          }
          break
        }
      }

      if (this.activeBlock?.type === 'tool-call') {
        const closeTag1 = '</tool-call>'
        const closeTag2 = '</tool_call>'
        let closeIdx = this.buffer.indexOf(closeTag1)
        let matchedTag = closeTag1
        const idx2 = this.buffer.indexOf(closeTag2)
        if (closeIdx === -1 || (idx2 !== -1 && idx2 < closeIdx)) {
          closeIdx = idx2
          matchedTag = closeTag2
        }

        if (closeIdx !== -1) {
          const content = this.buffer.slice(0, closeIdx)
          if (content) {
            this.emit({
              type: 'tool-call-delta',
              index: this.activeBlock.index,
              id: ToolCallId(this.activeBlock.id),
              name: this.activeBlock.name,
              argumentsDelta: content,
            })
            this.activeBlock.args += content
          }
          this.endCurrentBlock()
          this.buffer = this.buffer.slice(closeIdx + matchedTag.length)
          continue
        } else {
          const safeLen = Math.min(
            this.getSafeLength(this.buffer, closeTag1),
            this.getSafeLength(this.buffer, closeTag2),
          )
          if (safeLen > 0) {
            const content = this.buffer.slice(0, safeLen)
            this.emit({
              type: 'tool-call-delta',
              index: this.activeBlock.index,
              id: ToolCallId(this.activeBlock.id),
              name: this.activeBlock.name,
              argumentsDelta: content,
            })
            this.activeBlock.args += content
            this.buffer = this.buffer.slice(safeLen)
          }
          break
        }
      }

      // 当前在文本状态，检测 <thinking> 或 <tool-call... / <tool_call...
      const thinkingIdx = this.buffer.indexOf('<thinking>')
      const toolCallRegex = /<tool[-_]call\s*([^>]*)>/i
      const toolCallMatch = this.buffer.match(toolCallRegex)
      const toolCallIdx = toolCallMatch ? this.buffer.indexOf(toolCallMatch[0]) : -1

      if (thinkingIdx === -1 && toolCallIdx === -1) {
        // 检查缓冲区末尾是否可能是未闭合的标签前缀
        const lastLt = this.buffer.lastIndexOf('<')
        if (lastLt !== -1 && this.isPotentialTagPrefix(this.buffer.slice(lastLt))) {
          const plain = this.buffer.slice(0, lastLt)
          if (plain) {
            this.ensureBlock('text')
            this.emit({ type: 'text-delta', index: this.activeBlock!.index, text: plain })
            if (this.activeBlock && this.activeBlock.type === 'text') {
              this.activeBlock.text += plain
            }
            this.buffer = this.buffer.slice(lastLt)
          }
          break
        } else {
          this.ensureBlock('text')
          this.emit({ type: 'text-delta', index: this.activeBlock!.index, text: this.buffer })
          if (this.activeBlock && this.activeBlock.type === 'text') {
            this.activeBlock.text += this.buffer
          }
          this.buffer = ''
          break
        }
      }

      // 确定哪个标签在前
      let targetTag: 'thinking' | 'tool-call' = 'thinking'
      let earliestIdx = thinkingIdx
      if (earliestIdx === -1 || (toolCallIdx !== -1 && toolCallIdx < earliestIdx)) {
        targetTag = 'tool-call'
        earliestIdx = toolCallIdx
      }

      // 吐出标签前面的纯文本
      if (earliestIdx > 0) {
        const plain = this.buffer.slice(0, earliestIdx)
        this.ensureBlock('text')
        this.emit({ type: 'text-delta', index: this.activeBlock!.index, text: plain })
        if (this.activeBlock && this.activeBlock.type === 'text') {
          this.activeBlock.text += plain
        }
        this.buffer = this.buffer.slice(earliestIdx)
      }

      if (targetTag === 'thinking') {
        this.buffer = this.buffer.slice('<thinking>'.length)
        this.ensureBlock('reasoning')
      } else {
        const matchedStr = toolCallMatch![0]
        const attrs = toolCallMatch![1] || ''
        const idMatch = attrs.match(/id=["']?([^"'\s>]+)["']?/i)
        const nameMatch = attrs.match(/name=["']?([^"'\s>]+)["']?/i)
        const id = idMatch ? idMatch[1] : `call_${Date.now()}`
        const name = nameMatch ? nameMatch[1] : 'unknown'

        this.buffer = this.buffer.slice(matchedStr.length)
        this.hasToolCalls = true
        this.ensureBlock('tool-call', { id, name })
      }
    }
  }

  private isPotentialTagPrefix(sub: string): boolean {
    const s = sub.toLowerCase()
    return (
      '<thinking>'.startsWith(s) ||
      '<tool-call'.startsWith(s) ||
      '<tool_call'.startsWith(s) ||
      (s.startsWith('<tool') && !s.includes('>'))
    )
  }

  private getSafeLength(buf: string, tag: string): number {
    for (let i = 1; i < tag.length; i++) {
      if (buf.endsWith(tag.slice(0, i))) {
        return buf.length - i
      }
    }
    return buf.length
  }
}
