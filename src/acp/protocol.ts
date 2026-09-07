export const ACP_PROTOCOL_VERSION = 1

export interface AcpClientInfo {
  name: string
  version: string
}

export interface AcpInitializeParams {
  protocolVersion: number
  clientCapabilities: Record<string, unknown>
  clientInfo: AcpClientInfo
}

export interface AcpAuthMethod {
  id: string
  name?: string
  description?: string
  type?: string
  args?: string[]
  env?: Record<string, string>
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities: Record<string, unknown>
  agentInfo: AcpClientInfo
  authMethods?: AcpAuthMethod[]
}

export interface AcpSessionNewParams {
  cwd: string
  mcpServers?: unknown[]
  [key: string]: unknown
}

export interface AcpSessionNewResult {
  sessionId: string
}

export interface AcpPromptContent {
  type: 'text' | 'image'
  text?: string
  mimeType?: string
  data?: string
}

export interface AcpPromptParams {
  sessionId: string
  prompt: AcpPromptContent[]
}

export interface AcpPromptResponse {
  stopReason?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}

export interface AcpSessionUpdateEnvelope {
  sessionId: string
  update: AcpSessionUpdate
}

export type AcpSessionUpdate =
  | AcpAgentMessageChunk
  | AcpAgentStopped
  | AcpUsageUpdate
  | AcpToolCall
  | AcpToolCallUpdate
  | AcpPlanUpdate
  | AcpStateUpdate
  | AcpUnknownUpdate

export interface AcpAgentMessageChunk {
  sessionUpdate: 'agent_message_chunk'
  content: AcpPromptContent | AcpPromptContent[]
}

export interface AcpAgentStopped {
  sessionUpdate: 'agent_stopped'
  cancelled?: boolean
}

export interface AcpUsageUpdate {
  sessionUpdate: 'usage_update'
  inputTokens?: number
  outputTokens?: number
}

export interface AcpToolCall {
  sessionUpdate: 'tool_call'
  toolCallId: string
  title?: string
  kind?: string
  status?: string
  rawInput?: Record<string, unknown>
}

export interface AcpToolCallUpdate {
  sessionUpdate: 'tool_call_update'
  toolCallId: string
  status?: string
  content?: unknown
}

export interface AcpPlanUpdate {
  sessionUpdate: 'plan'
  plan?: unknown
}

export interface AcpStateUpdate {
  sessionUpdate: 'state_update'
  state?: string
  stopReason?: string
}

export interface AcpUnknownUpdate {
  sessionUpdate: string
  [key: string]: unknown
}

export interface AcpPermissionOption {
  optionId?: string
  id?: string
  name?: string
  kind?: string
}

export interface AcpPermissionRequestParams {
  sessionId?: string
  permission?: {
    id: string
  }
  toolCall?: {
    toolCallId?: string
    [key: string]: unknown
  }
  options: AcpPermissionOption[]
}


export interface AcpJsonRpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message: string }
}
