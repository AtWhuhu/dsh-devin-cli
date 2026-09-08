import z from "@deepseek-ai/schemastery";
import { GenerateOptions, LlmAdapter, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
//#region src/DevinAdapter.d.ts
declare const PROVIDER = "devin";
interface DevinModelConfig {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
}
interface DevinModelInfo extends LlmModelInfo {
  contextWindow?: number;
  maxTokens?: number;
}
interface DevinAdapterConfig {
  ctx?: any;
  bin: string;
  cwd: string;
  streamIdleTimeoutMs: number;
  models: DevinModelConfig[];
  defaultContextWindow: number;
  defaultMaxTokens: number;
  token?: string;
  retryPolicy?: ResolvedRetryPolicy;
  discoverModels?: () => Promise<Array<{
    id: string;
    name: string;
    contextWindow?: number;
    maxTokens?: number;
  }>>;
}
/**
 * 将 Devin 的工具调用归一化映射为 DSH 原生 UI 组件（@deepseek-ai/dsh-client-ui-tool）识别的标准工具名称与参数
 * 从而在 DSH 聊天界面中渲染为独立原生的工具卡片（Grep · ... / 读取 · ... / Pwsh · ... / 编辑 · ...）
 */
declare function mapDevinToolNameToDsh(tc: {
  kind?: string;
  title?: string;
  rawInput?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}): {
  name: string;
  args: Record<string, unknown>;
};
/**
 * Devin CLI 专有 DSH LlmAdapter。
 * 直接通过 stdio 交互调用本机的 `devin acp` 服务，零多余协议代理。
 */
declare class DevinAdapter extends LlmAdapter {
  private readonly config;
  private cachedModels;
  constructor(config: DevinAdapterConfig);
  providerInfo(_provider: string): LlmProviderInfo;
  clearCache(): void;
  listModels(_provider?: string): Promise<readonly DevinModelInfo[]>;
  resolveModel(_provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  /**
   * 满足 DSH Desktop 新版 dsh-llm 对 prepareCall 的契约要求。
   */
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo;
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
  }>;
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
  stream(options: GenerateOptions, signal?: AbortSignal): AsyncIterable<StreamChunk>;
  private handlePermission;
}
//#endregion
//#region src/models.d.ts
/**
 * 通过本机 devin CLI 执行 `devin models list --format json`
 * 动态获取当前账户可用的所有模型列表，并构建家族与变体映射索引。
 */
declare function discoverDevinModels(devinBin?: string, signal?: AbortSignal): Promise<{
  id: string;
  name: string;
  contextWindow: number | undefined;
  maxTokens: number | undefined;
  efforts: string[];
}[]>;
//#endregion
//#region src/credentials.d.ts
/**
 * Devin CLI credentials.toml 的平台相关路径。
 * 支持环境变量 DEVIN_CREDENTIALS_PATH 覆盖。
 */
declare function devinCredentialsPath(): string;
interface DevinSession {
  /** windsurf_api_key，格式 devin-session-token$... */
  apiKey: string;
  /** api_server_url，默认 https://server.codeium.com */
  apiServerUrl: string;
  /** devin_api_url，可选 */
  devinApiUrl?: string;
}
/**
 * 尝试从 Devin CLI 的 credentials.toml 读取 session。
 * 文件不存在或格式无效时返回 undefined，不抛异常。
 */
declare function readDevinSession(options?: {
  credentialsPath?: string;
}): DevinSession | undefined;
//#endregion
//#region src/storage.d.ts
interface DevinPluginSettings {
  devinBin: string;
  workspace: string;
  streamIdleTimeoutMs: number;
  activeModelIds: string[];
}
//#endregion
//#region src/rpc.d.ts
interface DevinRpcOptions {
  devinBin?: string;
  onSettingsChanged?: (settings: DevinPluginSettings) => void;
}
/**
 * 把设置面板的管理端点注册到 DSH 原生 `/api` RPC 通道：
 * 复用宿主的浏览器认证与 Host/Origin 信任栅栏，不再监听任何本地端口。
 */
declare function installDevinRpc(ctx: Context, options?: DevinRpcOptions): void;
//#endregion
//#region src/acp/protocol.d.ts
declare const ACP_PROTOCOL_VERSION = 1;
interface AcpClientInfo {
  name: string;
  version: string;
}
interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities: Record<string, unknown>;
  clientInfo: AcpClientInfo;
}
interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  args?: string[];
  env?: Record<string, string>;
}
interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: Record<string, unknown>;
  agentInfo: AcpClientInfo;
  authMethods?: AcpAuthMethod[];
}
interface AcpSessionNewParams {
  cwd: string;
  mcpServers?: unknown[];
  [key: string]: unknown;
}
interface AcpSessionNewResult {
  sessionId: string;
}
interface AcpPromptContent {
  type: 'text' | 'image';
  text?: string;
  mimeType?: string;
  data?: string;
}
interface AcpPromptParams {
  sessionId: string;
  prompt: AcpPromptContent[];
}
interface AcpPromptResponse {
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}
interface AcpSessionUpdateEnvelope {
  sessionId: string;
  update: AcpSessionUpdate;
}
type AcpSessionUpdate = AcpAgentMessageChunk | AcpAgentStopped | AcpUsageUpdate | AcpToolCall | AcpToolCallUpdate | AcpPlanUpdate | AcpStateUpdate | AcpUnknownUpdate;
interface AcpAgentMessageChunk {
  sessionUpdate: 'agent_message_chunk';
  content: AcpPromptContent | AcpPromptContent[];
}
interface AcpAgentStopped {
  sessionUpdate: 'agent_stopped';
  cancelled?: boolean;
}
interface AcpUsageUpdate {
  sessionUpdate: 'usage_update';
  inputTokens?: number;
  outputTokens?: number;
}
interface AcpToolCall {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
}
interface AcpToolCallUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status?: string;
  content?: unknown;
}
interface AcpPlanUpdate {
  sessionUpdate: 'plan';
  plan?: unknown;
}
interface AcpStateUpdate {
  sessionUpdate: 'state_update';
  state?: string;
  stopReason?: string;
}
interface AcpUnknownUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}
interface AcpPermissionOption {
  optionId?: string;
  id?: string;
  name?: string;
  kind?: string;
}
interface AcpPermissionRequestParams {
  sessionId?: string;
  permission?: {
    id: string;
  };
  toolCall?: {
    toolCallId?: string;
    [key: string]: unknown;
  };
  options: AcpPermissionOption[];
}
interface AcpJsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    message: string;
  };
}
//#endregion
//#region src/acp/AcpStdioClient.d.ts
interface AcpStdioClientOptions {
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onUpdate: (update: AcpSessionUpdate) => void;
  onPermissionRequest?: (request: AcpPermissionRequestParams) => {
    outcome: {
      outcome: string;
      optionId?: string;
    };
  } | undefined;
  onGarbage?: (line: string) => void;
  onStderr?: (chunk: string) => void;
}
declare class AcpStdioClient {
  private readonly options;
  private readonly process;
  private readonly pending;
  private nextId;
  private closed;
  private readonly stderrBuffer;
  constructor(options: AcpStdioClientOptions);
  private onStdoutData;
  private onMessage;
  private send;
  private request;
  initialize(clientInfo: AcpClientInfo, timeoutMs?: number): Promise<AcpInitializeResult>;
  authenticate(methodId: string, meta?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  sessionNew(params: AcpSessionNewParams, timeoutMs?: number): Promise<AcpSessionNewResult>;
  prompt(sessionId: string, prompt: AcpPromptContent[]): Promise<AcpPromptResponse>;
  cancel(sessionId: string): void;
  getStderrTail(): string;
  close(error?: Error): void;
}
//#endregion
//#region src/index.d.ts
declare const name = "dsh-devin-cli";
declare const inject: string[];
interface Config {
  /** Devin CLI 可执行文件名称或路径，默认 'devin'。 */
  devinBin: string;
  /** ACP session 工作目录。 */
  workspace: string;
  /** ACP 流空闲超时（毫秒）。 */
  streamIdleTimeoutMs: number;
  /**
   * Devin session token（可选）。
   * 留空时自动复用本机 Devin CLI 的登录会话。
   */
  token: string;
  /** 默认上下文窗口，默认 200,000。 */
  defaultContextWindow: number;
  /** 默认最大输出 token，默认 65,536。 */
  defaultMaxTokens: number;
  /** 可用模型列表。 */
  models: DevinModelConfig[];
  /** 重试策略。 */
  retryPolicy: RetryPolicyConfig;
}
declare const Config: z<Config>;
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { ACP_PROTOCOL_VERSION, AcpAgentMessageChunk, AcpAgentStopped, AcpAuthMethod, AcpClientInfo, AcpInitializeParams, AcpInitializeResult, AcpJsonRpcMessage, AcpPermissionOption, AcpPermissionRequestParams, AcpPlanUpdate, AcpPromptContent, AcpPromptParams, AcpPromptResponse, AcpSessionNewParams, AcpSessionNewResult, AcpSessionUpdate, AcpSessionUpdateEnvelope, AcpStateUpdate, AcpStdioClient, AcpToolCall, AcpToolCallUpdate, AcpUnknownUpdate, AcpUsageUpdate, Config, DevinAdapter, type DevinModelConfig, type DevinModelInfo, type DevinRpcOptions, type DevinSession, PROVIDER, apply, devinCredentialsPath, discoverDevinModels, inject, installDevinRpc, mapDevinToolNameToDsh, name, readDevinSession };