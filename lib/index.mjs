import z from "@deepseek-ai/schemastery";
import { LlmAdapter, LlmError, ReasoningEffortId, RetryPolicySchema, ToolCallId, createToolResultMessage, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import http from "node:http";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region src/acp/protocol.ts
const ACP_PROTOCOL_VERSION = 1;
//#endregion
//#region src/acp/AcpStdioClient.ts
var AcpStdioClient = class {
	options;
	process;
	pending = /* @__PURE__ */ new Map();
	nextId = 1;
	closed = false;
	stderrBuffer = [];
	constructor(options) {
		this.options = options;
		this.process = spawn(options.argv[0], options.argv.slice(1), {
			cwd: options.cwd,
			env: {
				...process.env,
				...options.env
			},
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.process.stdin?.on("error", () => {});
		this.process.stdout.setEncoding("utf8");
		this.process.stderr.setEncoding("utf8");
		this.process.stdout.on("data", (chunk) => this.onStdoutData(chunk));
		this.process.stderr.on("data", (chunk) => {
			this.stderrBuffer.push(chunk);
			if (this.stderrBuffer.length > 30) this.stderrBuffer.shift();
			this.options.onStderr?.(chunk);
		});
		this.process.on("error", (err) => this.close(err));
		this.process.on("exit", () => this.close(/* @__PURE__ */ new Error("acp child process exited")));
	}
	onStdoutData(chunk) {
		const lines = chunk.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const message = JSON.parse(trimmed);
				this.onMessage(message);
			} catch {
				this.options.onGarbage?.(trimmed);
			}
		}
	}
	onMessage(message) {
		if (message.method) {
			if (message.method === "session/request_permission") {
				const response = this.options.onPermissionRequest?.(message.params);
				const result = response !== void 0 ? response : { outcome: { outcome: "cancelled" } };
				if (message.id !== void 0) this.send({
					jsonrpc: "2.0",
					id: message.id,
					result
				});
				return;
			}
			if (message.method === "session/update") {
				const envelope = message.params;
				this.options.onUpdate(envelope.update);
				return;
			}
			return;
		}
		if (message.id !== void 0) {
			const key = typeof message.id === "number" ? message.id : Number(message.id);
			const entry = this.pending.get(key);
			if (entry) {
				this.pending.delete(key);
				if (message.error !== void 0) entry.reject(/* @__PURE__ */ new Error(`acp: ${message.error.message}`));
				else entry.resolve(message.result);
			}
		}
	}
	send(message) {
		if (this.closed) return;
		if (!this.process.stdin?.writable) return;
		try {
			this.process.stdin.write(`${JSON.stringify(message)}\n`);
		} catch {}
	}
	request(method, params, timeoutMs) {
		if (this.closed) return Promise.reject(new LlmError("acp: client closed", "TRANSPORT"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			let timer;
			if (timeoutMs !== void 0 && timeoutMs > 0) timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new LlmError(`acp: request "${method}" timed out after ${timeoutMs}ms`, "TIMEOUT"));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					if (timer) clearTimeout(timer);
					resolve(value);
				},
				reject: (err) => {
					if (timer) clearTimeout(timer);
					reject(err);
				}
			});
			try {
				this.send({
					jsonrpc: "2.0",
					id,
					method,
					params
				});
			} catch (err) {
				if (timer) clearTimeout(timer);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}
	async initialize(clientInfo, timeoutMs = 3e4) {
		const params = {
			protocolVersion: 1,
			clientCapabilities: {},
			clientInfo
		};
		return this.request("initialize", params, timeoutMs);
	}
	authenticate(methodId, meta, timeoutMs = 15e3) {
		return this.request("authenticate", {
			methodId,
			...meta ? { meta } : {}
		}, timeoutMs);
	}
	sessionNew(params, timeoutMs = 15e3) {
		return this.request("session/new", params, timeoutMs);
	}
	prompt(sessionId, prompt) {
		const params = {
			sessionId,
			prompt
		};
		return this.request("session/prompt", params);
	}
	cancel(sessionId) {
		this.send({
			jsonrpc: "2.0",
			method: "session/cancel",
			params: { sessionId }
		});
	}
	getStderrTail() {
		return this.stderrBuffer.join("").slice(-4096);
	}
	close(error) {
		if (this.closed) return;
		this.closed = true;
		for (const [, entry] of this.pending) entry.reject(error ?? new LlmError("acp: connection closed", "TRANSPORT"));
		this.pending.clear();
		if (!this.process.killed) this.process.kill("SIGTERM");
	}
};
//#endregion
//#region src/models.ts
const execFileAsync$1 = promisify(execFile);
function capitalize(s) {
	if (!s) return "";
	return s.charAt(0).toUpperCase() + s.slice(1);
}
function extractEffort(label = "", uid = "") {
	const mUid = uid.match(/-(low|medium|high|max|xhigh|minimal|none|fast)$/i);
	if (mUid) return mUid[1].toLowerCase();
	const mLabel = label.match(/\b(low|medium|high|max|xhigh|minimal|none|fast)\b/i);
	if (mLabel) return mLabel[1].toLowerCase();
	if (uid === "swe-1-7") return "max";
	if (uid === "swe-1-7-medium") return "medium";
	if (uid === "swe-1-7-lightning") return "max";
	if (uid === "swe-1-7-lightning-medium") return "medium";
}
var DevinModelRegistry = class {
	families = [];
	variantMap = /* @__PURE__ */ new Map();
	familyMap = /* @__PURE__ */ new Map();
	initialized = false;
	async init(devinBin = "devin", signal) {
		try {
			const { stdout } = await execFileAsync$1(devinBin, [
				"models",
				"list",
				"--format",
				"json"
			], {
				signal,
				timeout: 25e3,
				maxBuffer: 15728640,
				windowsHide: true
			});
			const data = JSON.parse(stdout);
			this.loadFromJsonFamilies(data.families || []);
			this.initialized = true;
		} catch (err) {
			console.warn("[DevinModelRegistry] Failed to fetch live models, using fallback defaults:", err);
			this.loadFallback();
		}
	}
	loadFromJsonFamilies(rawFamilies) {
		this.families = [];
		this.variantMap.clear();
		this.familyMap.clear();
		for (const fam of rawFamilies) {
			const fUid = String(fam.family_uid || fam.slug || "");
			const fLabel = String(fam.family_label || fUid || "Devin");
			const variants = [];
			const effortMap = /* @__PURE__ */ new Map();
			for (const v of fam.variants || []) {
				const uid = String(v.model_uid || "");
				if (!uid) continue;
				const label = String(v.label || uid);
				const effort = extractEffort(label, uid);
				const contextWindow = typeof v.max_context_tokens === "number" ? v.max_context_tokens : void 0;
				const variant = {
					uid,
					label,
					effort,
					contextWindow,
					maxTokens: typeof v.max_output_tokens === "number" ? v.max_output_tokens : void 0,
					familyUid: fUid,
					familyLabel: fLabel,
					supportsImages: /swe|claude|gpt|gemini|vision|omni/i.test(uid) || /swe|claude|gpt|gemini|vision|omni/i.test(fUid)
				};
				variants.push(variant);
				this.variantMap.set(uid.toLowerCase(), variant);
				if (effort && !effortMap.has(effort)) effortMap.set(effort, {
					id: effort,
					name: capitalize(effort),
					variantUid: uid,
					contextWindow
				});
			}
			if (variants.length > 0) {
				const effortOrder = [
					"minimal",
					"low",
					"medium",
					"high",
					"xhigh",
					"max",
					"fast",
					"none"
				];
				const supportedEfforts = Array.from(effortMap.values()).sort((a, b) => {
					const idxA = effortOrder.indexOf(a.id);
					const idxB = effortOrder.indexOf(b.id);
					return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
				});
				const defaultVariant = variants.find((v) => v.effort === "high") ?? variants.find((v) => v.effort === "max") ?? variants[0];
				const family = {
					familyUid: fUid,
					familyLabel: fLabel,
					variants,
					supportedEfforts,
					defaultVariant,
					defaultEffort: defaultVariant.effort || (supportedEfforts.length > 0 ? supportedEfforts[0].id : void 0),
					supportsImages: variants.some((v) => v.supportsImages)
				};
				this.families.push(family);
				this.familyMap.set(fUid.toLowerCase(), family);
				this.familyMap.set(fLabel.toLowerCase(), family);
			}
		}
	}
	loadFallback() {
		this.loadFromJsonFamilies([
			{
				family_uid: "glm-5-3-flash",
				family_label: "GLM-5.3 Flash",
				variants: [
					{
						model_uid: "glm-5-3-flash-low",
						label: "GLM-5.3 Flash Low",
						max_context_tokens: 1e6,
						max_output_tokens: 128e3
					},
					{
						model_uid: "glm-5-3-flash-high",
						label: "GLM-5.3 Flash High",
						max_context_tokens: 1e6,
						max_output_tokens: 128e3
					},
					{
						model_uid: "glm-5-3-flash-max",
						label: "GLM-5.3 Flash Max",
						max_context_tokens: 1e6,
						max_output_tokens: 128e3
					}
				]
			},
			{
				family_uid: "swe-1.7",
				family_label: "SWE-1.7",
				variants: [{
					model_uid: "swe-1-7",
					label: "SWE-1.7 Max",
					max_context_tokens: 262e3,
					max_output_tokens: 128e3
				}, {
					model_uid: "swe-1-7-medium",
					label: "SWE-1.7 Medium",
					max_context_tokens: 262e3,
					max_output_tokens: 128e3
				}]
			},
			{
				family_uid: "glm-5.2",
				family_label: "GLM-5.2",
				variants: [{
					model_uid: "glm-5-2",
					label: "GLM-5.2",
					max_context_tokens: 2e5,
					max_output_tokens: 65536
				}, {
					model_uid: "glm-5-2-max",
					label: "GLM-5.2 Max",
					max_context_tokens: 2e5,
					max_output_tokens: 65536
				}]
			}
		]);
	}
	/**
	* 返回基础模型列表（过滤掉各变体 -low, -high, -max 等后缀），
	* 使得在模型列表（/model 下拉菜单）中只展示简洁明了的基础模型。
	* 每个基础模型自动包含其支持的全部推理等级。
	*/
	getBaseModels() {
		return this.families.map((fam) => ({
			id: fam.familyUid,
			name: fam.familyLabel,
			contextWindow: fam.defaultVariant.contextWindow,
			maxTokens: fam.defaultVariant.maxTokens,
			supportsImages: fam.supportsImages,
			efforts: fam.supportedEfforts.map((e) => e.name)
		}));
	}
	/**
	* 将输入的任何模型 ID（可能是变体 ID 如 glm-5-3-flash-high，或旧配置 ID）
	* 归一化为对应的基础模型 familyUid。
	*/
	normalizeToBaseId(modelId) {
		const norm = modelId.toLowerCase().trim();
		const variant = this.variantMap.get(norm);
		if (variant) return variant.familyUid;
		const family = this.familyMap.get(norm);
		if (family) return family.familyUid;
		return modelId;
	}
	/**
	* 核心路由函数：
	* 传入基础模型 ID（如 glm-5-3-flash）或变体 ID（如 glm-5-3-flash-high），
	* 并结合用户在会话中选择的 reasoningEffort（如 high, low, medium, max），
	* 自动在同家族中查找匹配的变体后缀与真实模型 UID，并精准装配上下文大小。
	*/
	resolveRoute(modelId, reasoningEffort, defaultContext = 2e5, defaultMax = 65536) {
		const normId = modelId.toLowerCase().trim();
		let matchedFamily = this.familyMap.get(normId);
		let matchedVariant = this.variantMap.get(normId);
		if (!matchedFamily && matchedVariant) matchedFamily = this.familyMap.get(matchedVariant.familyUid.toLowerCase());
		if (!matchedFamily) {
			for (const fam of this.families) if (normId.startsWith(fam.familyUid.toLowerCase()) || fam.familyUid.toLowerCase().startsWith(normId)) {
				matchedFamily = fam;
				break;
			}
		}
		if (matchedFamily) {
			const familyEfforts = matchedFamily.supportedEfforts || [];
			let finalVariant = matchedFamily.defaultVariant;
			if (reasoningEffort && familyEfforts.length > 0) {
				const targetEffort = reasoningEffort.toLowerCase();
				const variantWithEffort = matchedFamily.variants.find((v) => v.effort === targetEffort);
				if (variantWithEffort) finalVariant = variantWithEffort;
			} else if (matchedVariant) finalVariant = matchedVariant;
			return {
				resolvedModelUid: finalVariant.uid,
				displayName: matchedFamily.familyLabel,
				contextWindow: finalVariant.contextWindow ?? defaultContext,
				maxTokens: finalVariant.maxTokens ?? defaultMax,
				supportsImages: matchedFamily.supportsImages,
				supportedEfforts: familyEfforts.map((e) => ({
					id: e.id,
					name: e.name
				})),
				currentEffort: finalVariant.effort || matchedFamily.defaultEffort
			};
		}
		return {
			resolvedModelUid: modelId,
			displayName: modelId,
			contextWindow: defaultContext,
			maxTokens: defaultMax,
			supportsImages: /swe|claude|gpt|gemini|vision|omni/i.test(modelId),
			supportedEfforts: []
		};
	}
};
const globalDevinRegistry = new DevinModelRegistry();
//#endregion
//#region src/DevinAdapter.ts
const PROVIDER = "devin";
/**
* 将 Devin 的工具调用归一化映射为 DSH 原生 UI 组件（@deepseek-ai/dsh-client-ui-tool）识别的标准工具名称与参数
* 从而在 DSH 聊天界面中渲染为独立原生的工具卡片（Grep · ... / 读取 · ... / Pwsh · ... / 编辑 · ...）
*/
function mapDevinToolNameToDsh(tc) {
	const kind = (tc.kind || "").toLowerCase();
	const title = (tc.title || "").toLowerCase();
	const metaName = String(tc._meta?.["cognition.ai/inferenceToolName"] || "").toLowerCase();
	const raw = { ...tc.rawInput || {} };
	if (kind === "exec" || kind === "bash" || kind === "pwsh" || metaName === "exec" || raw.command) return {
		name: process.platform === "win32" ? "pwsh" : "bash",
		args: {
			command: raw.command || tc.title || "",
			description: tc.title || raw.description,
			...raw
		}
	};
	if (kind === "read" || metaName === "read" || title.includes("read")) return {
		name: "read",
		args: {
			file_path: raw.file_path || raw.path || "",
			...raw
		}
	};
	if (kind === "grep" || metaName === "grep" || title.includes("grep")) return {
		name: "grep",
		args: {
			query: raw.query || raw.pattern || "",
			...raw
		}
	};
	if (kind === "glob" || kind === "find" || metaName === "glob" || title.includes("find file") || title.includes("glob")) return {
		name: "glob",
		args: {
			pattern: raw.pattern || raw.query || "",
			...raw
		}
	};
	if (kind === "edit" || kind === "write" || metaName === "edit" || metaName === "write" || title.includes("edit") || title.includes("write")) return {
		name: "edit",
		args: {
			file_path: raw.file_path || raw.path || "",
			...raw
		}
	};
	if (kind === "web_search" || metaName === "web_search" || title.includes("web search")) return {
		name: "web_search",
		args: {
			query: raw.query || "",
			...raw
		}
	};
	return {
		name: metaName || kind || "generic",
		args: raw
	};
}
var AsyncQueue = class {
	items = [];
	waiters = [];
	push(item) {
		const waiter = this.waiters.shift();
		if (waiter) waiter(item);
		else this.items.push(item);
	}
	next(timeoutMs) {
		const item = this.items.shift();
		if (item !== void 0) return Promise.resolve(item);
		return new Promise((resolve) => {
			let timer;
			const onDone = (res) => {
				if (timer) clearTimeout(timer);
				resolve(res);
			};
			if (timeoutMs !== void 0 && timeoutMs > 0) timer = setTimeout(() => {
				const idx = this.waiters.indexOf(onDone);
				if (idx !== -1) this.waiters.splice(idx, 1);
				resolve(void 0);
			}, timeoutMs);
			this.waiters.push(onDone);
		});
	}
};
function formatMessages(options) {
	const parts = [];
	if (options.system) parts.push(`[system]\n${options.system}`);
	const messages = Array.isArray(options.messages) ? options.messages : [];
	for (const message of messages) {
		if (!message) continue;
		const role = message.role === "assistant" ? "assistant" : message.source?.kind === "tool" ? "tool" : "user";
		parts.push(`[${role}]`);
		const blocks = Array.isArray(message.content) ? message.content : [];
		for (const block of blocks) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "text") {
				if (typeof block.text === "string") parts.push(block.text);
			} else if (block.type === "reasoning") {
				if (typeof block.text === "string") parts.push(`[thinking]\n${block.text}`);
			} else if (block.type === "tool-call") parts.push(`[tool-call ${block.id || ""}: ${block.name || ""}]\n${block.arguments || ""}`);
			else if (block.type === "tool-result") {
				const texts = [];
				if (Array.isArray(block.content)) {
					for (const sub of block.content) if (sub && typeof sub === "object" && sub.type === "text" && typeof sub.text === "string") texts.push(sub.text);
					else if (sub) try {
						texts.push(JSON.stringify(sub));
					} catch {}
				}
				const errPrefix = block.isError ? "ERROR: " : "";
				parts.push(`[Tool Result for ${block.toolCallId || ""}]: ${errPrefix}${texts.join("\n")}`);
			} else try {
				parts.push(JSON.stringify(block));
			} catch {}
		}
	}
	return parts.join("\n\n");
}
function toAcpPrompt(options) {
	return [{
		type: "text",
		text: formatMessages(options)
	}];
}
/**
* Devin CLI 专有 DSH LlmAdapter。
* 直接通过 stdio 交互调用本机的 `devin acp` 服务，零多余协议代理。
*/
var DevinAdapter = class extends LlmAdapter {
	config;
	cachedModels = null;
	constructor(config) {
		super();
		this.config = config;
	}
	providerInfo(_provider) {
		return {
			id: PROVIDER,
			name: "Devin"
		};
	}
	clearCache() {
		this.cachedModels = null;
	}
	async listModels(_provider) {
		if (this.cachedModels && this.cachedModels.length > 0) return this.cachedModels;
		if (globalDevinRegistry.getBaseModels().length === 0) {
			if (this.config.discoverModels) await this.config.discoverModels();
			else await globalDevinRegistry.init(this.config.bin);
		}
		const { loadSettings } = await Promise.resolve().then(() => storage_exports);
		const rawActive = loadSettings().activeModelIds || [];
		const activeSet = /* @__PURE__ */ new Set();
		if (rawActive.length > 0) for (const id of rawActive) {
			const lower = id.toLowerCase().trim();
			activeSet.add(lower);
			activeSet.add(lower.replace(/[._-]/g, ""));
			const baseId = globalDevinRegistry.normalizeToBaseId(lower).toLowerCase();
			activeSet.add(baseId);
			activeSet.add(baseId.replace(/[._-]/g, ""));
		}
		const baseModels = globalDevinRegistry.getBaseModels();
		const list = [];
		for (const m of baseModels) {
			const mLower = m.id.toLowerCase();
			const mCompact = mLower.replace(/[._-]/g, "");
			if (activeSet.size > 0 && !activeSet.has(mLower) && !activeSet.has(mCompact)) continue;
			list.push({
				provider: PROVIDER,
				id: m.id,
				name: m.name,
				...m.contextWindow ? { contextWindow: m.contextWindow } : {},
				...m.maxTokens ? { maxTokens: m.maxTokens } : {},
				inputModalities: m.supportsImages ? ["text", "image"] : ["text"]
			});
		}
		this.cachedModels = list;
		return list;
	}
	async resolveModel(_provider, model, _signal) {
		if (globalDevinRegistry.getBaseModels().length === 0) {
			if (this.config.discoverModels) await this.config.discoverModels();
			else await globalDevinRegistry.init(this.config.bin);
		}
		const route = globalDevinRegistry.resolveRoute(model, void 0, this.config.defaultContextWindow, this.config.defaultMaxTokens);
		return {
			provider: PROVIDER,
			id: model,
			name: route.displayName,
			inputModalities: route.supportsImages ? ["text", "image"] : ["text"],
			context: { contextWindow: route.contextWindow },
			defaultMaxTokens: route.maxTokens,
			...route.supportedEfforts.length > 1 ? { reasoning: {
				efforts: route.supportedEfforts.map((e) => ({
					id: ReasoningEffortId(e.id),
					name: e.name
				})),
				defaultEffort: route.currentEffort ? ReasoningEffortId(route.currentEffort) : ReasoningEffortId("high")
			} } : {}
		};
	}
	/**
	* 满足 DSH Desktop 新版 dsh-llm 对 prepareCall 的契约要求。
	*/
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options, options.signal ?? signal)
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.retryPolicy;
	}
	async *stream(options, signal) {
		const queue = new AsyncQueue();
		let acpSessionId;
		if (globalDevinRegistry.getBaseModels().length === 0) {
			if (this.config.discoverModels) await this.config.discoverModels();
			else await globalDevinRegistry.init(this.config.bin);
		}
		const effortStr = options.reasoningEffort ? String(options.reasoningEffort) : void 0;
		const targetModel = globalDevinRegistry.resolveRoute(options.model, effortStr, this.config.defaultContextWindow, this.config.defaultMaxTokens).resolvedModelUid;
		const argv = [this.config.bin, "acp"];
		if (targetModel) argv.push("--model", targetModel);
		const token = this.config.token ?? "";
		console.log(`[dsh-devin-cli] Starting stream for model: ${options.model}, targetModel: ${targetModel}`);
		const client = new AcpStdioClient({
			argv,
			cwd: this.config.cwd,
			env: token ? { WINDSURF_API_KEY: token } : void 0,
			onUpdate: (update) => queue.push(update),
			onPermissionRequest: (request) => this.handlePermission(request)
		});
		let promptDone = false;
		let promptUsage;
		try {
			if (signal?.aborted) throw new LlmError("Devin ACP request aborted before start", "ABORTED");
			const init = await client.initialize({
				name: "dsh-devin-cli",
				version: "0.3.0"
			}, 3e4);
			if (token && init.authMethods?.length) {
				const apiKeyMethod = init.authMethods.find((m) => m.type === "api_key" && m.id);
				if (apiKeyMethod) try {
					await client.authenticate(apiKeyMethod.id, { api_key: token }, 1e4);
				} catch {}
			}
			const dshSessionId = options.sessionId;
			let dshSession = options.session;
			if (!dshSession && dshSessionId && this.config.ctx) try {
				const ctxAny = this.config.ctx;
				dshSession = (typeof ctxAny.get === "function" ? ctxAny.get("sessions") : typeof ctxAny.reflect?.get === "function" ? ctxAny.reflect.get("sessions") : void 0)?.get?.(dshSessionId);
			} catch (err) {
				console.warn("[dsh-devin-cli] Failed to safely resolve session from ctx:", err);
				dshSession = void 0;
			}
			let effectiveCwd = this.config.cwd;
			if (dshSession?.header?.cwd) effectiveCwd = dshSession.header.cwd;
			else if (options.cwd) effectiveCwd = options.cwd;
			const sessionParams = {
				cwd: effectiveCwd,
				mcpServers: []
			};
			acpSessionId = (await client.sessionNew(sessionParams, 15e3)).sessionId;
			const promptPayload = toAcpPrompt(options);
			console.log(`[dsh-devin-cli] Prompting Devin ACP (session: ${acpSessionId}, length: ${promptPayload[0]?.text?.length || 0}, cwd: ${effectiveCwd})`);
			let promptError;
			client.prompt(acpSessionId, promptPayload).then((response) => {
				promptUsage = response.usage ? {
					inputTokens: response.usage.inputTokens ?? 0,
					outputTokens: response.usage.outputTokens ?? 0
				} : void 0;
			}).catch((err) => {
				promptError = err instanceof Error ? err : new Error(String(err));
				queue.push({
					done: true,
					usage: void 0,
					cancelled: false
				});
			}).finally(() => {
				promptDone = true;
			});
			let lastActivity = Date.now();
			let blockIndex = 0;
			let currentBlock = null;
			let currentTurn = 0;
			let currentStep = 0;
			if (dshSession) try {
				const events = dshSession.snapshotEvents ? dshSession.snapshotEvents() : dshSession.log || [];
				for (let i = events.length - 1; i >= 0; i--) {
					const ev = events[i];
					if (ev.type === "step/start") {
						currentStep = ev.data.step;
						currentTurn = ev.data.turn;
						break;
					}
					if (ev.type === "turn/start") {
						currentTurn = ev.data.turn;
						break;
					}
				}
			} catch {}
			const activeToolCalls = /* @__PURE__ */ new Map();
			const endCurrentBlock = () => {
				if (!currentBlock) return null;
				const closed = {
					type: "block-end",
					index: currentBlock.index,
					block: {
						type: currentBlock.type,
						text: currentBlock.content
					}
				};
				currentBlock = null;
				return closed;
			};
			const ensureBlock = (type) => {
				if (currentBlock && currentBlock.type === type) return { index: currentBlock.index };
				const endChunk = endCurrentBlock() || void 0;
				const index = blockIndex++;
				currentBlock = {
					type,
					index,
					content: ""
				};
				return {
					index,
					startChunk: {
						type: "block-start",
						index,
						blockType: type
					},
					endChunk
				};
			};
			while (true) {
				if (signal?.aborted) {
					if (acpSessionId) client.cancel(acpSessionId);
					throw new LlmError("Devin ACP request aborted", "ABORTED");
				}
				if (Date.now() - lastActivity >= this.config.streamIdleTimeoutMs) throw new LlmError("Devin ACP stream idle timeout", "TIMEOUT");
				const update = await queue.next(200);
				if (update === void 0) {
					if (promptDone) break;
					continue;
				}
				lastActivity = Date.now();
				if ("done" in update) {
					if (update.cancelled) {
						yield {
							type: "finish",
							reason: {
								kind: "aborted",
								failure: {
									code: "ABORTED",
									message: "cancelled"
								}
							}
						};
						return;
					}
					if (promptError) throw promptError;
					break;
				}
				if (update.sessionUpdate === "agent_thought_chunk") {
					const text = update.content?.text;
					if (text) {
						const { index, startChunk, endChunk } = ensureBlock("reasoning");
						if (endChunk) yield endChunk;
						if (startChunk) yield startChunk;
						currentBlock.content += text;
						yield {
							type: "reasoning-delta",
							index,
							text
						};
					}
				} else if (update.sessionUpdate === "tool_call") {
					const tc = update;
					if (dshSession && typeof dshSession.append === "function") try {
						const mapped = mapDevinToolNameToDsh(tc);
						const toolCallId = tc.toolCallId || `devin_call_${Date.now()}`;
						const callSeq = dshSession.append("tool/call", {
							turn: currentTurn,
							step: currentStep,
							callId: toolCallId,
							name: mapped.name,
							arguments: JSON.stringify(mapped.args)
						})?.seq ?? Date.now();
						activeToolCalls.set(toolCallId, {
							callSeq,
							name: mapped.name
						});
					} catch (err) {
						console.warn("[dsh-devin-cli] Failed to append tool/call to session:", err);
					}
				} else if (update.sessionUpdate === "tool_call_update") {
					const tcu = update;
					if (dshSession && typeof dshSession.append === "function" && tcu.toolCallId) {
						const active = activeToolCalls.get(tcu.toolCallId);
						if (active && (tcu.status === "completed" || tcu.status === "failed")) {
							activeToolCalls.delete(tcu.toolCallId);
							try {
								let outputText = "";
								if (Array.isArray(tcu.content)) {
									for (const item of tcu.content) if (item.content?.text) outputText += item.content.text;
								}
								const isError = tcu.status === "failed";
								const message = createToolResultMessage({
									callId: ToolCallId(tcu.toolCallId),
									content: [{
										type: "text",
										text: outputText || (isError ? "Tool execution failed" : "Done")
									}],
									isError
								});
								dshSession.append("tool/result", {
									turn: currentTurn,
									step: currentStep,
									message
								}, {
									surfaceOp: "append",
									sourceEventSeqs: active.callSeq ? [active.callSeq] : []
								});
							} catch (err) {
								console.warn("[dsh-devin-cli] Failed to append tool/result to session:", err);
							}
						}
					}
				} else if (update.sessionUpdate === "agent_message_chunk") {
					const chunk = update;
					const contents = Array.isArray(chunk.content) ? chunk.content : [chunk.content];
					for (const content of contents) if (content.type === "text" && content.text) {
						const { index, startChunk, endChunk } = ensureBlock("text");
						if (endChunk) yield endChunk;
						if (startChunk) yield startChunk;
						currentBlock.content += content.text;
						yield {
							type: "text-delta",
							index,
							text: content.text
						};
					}
				} else if (update.sessionUpdate === "usage_update") {
					const usage = update;
					if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") yield {
						type: "usage",
						usage: {
							inputTokens: usage.inputTokens ?? 0,
							outputTokens: usage.outputTokens ?? 0
						}
					};
				}
			}
			if (dshSession && typeof dshSession.append === "function" && activeToolCalls.size > 0) {
				for (const [toolCallId, active] of activeToolCalls) try {
					const message = createToolResultMessage({
						callId: ToolCallId(toolCallId),
						content: [{
							type: "text",
							text: "Done"
						}],
						isError: false
					});
					dshSession.append("tool/result", {
						turn: currentTurn,
						step: currentStep,
						message
					}, {
						surfaceOp: "append",
						sourceEventSeqs: active.callSeq ? [active.callSeq] : []
					});
				} catch {}
				activeToolCalls.clear();
			}
			const finalEnd = endCurrentBlock();
			if (finalEnd) yield finalEnd;
			if (promptUsage) yield {
				type: "usage",
				usage: promptUsage
			};
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
		} catch (error) {
			if (error instanceof LlmError) throw error;
			const msg = error instanceof Error ? error.stack || error.message : String(error);
			const tail = client.getStderrTail().trim() || "none";
			console.error("[dsh-devin-cli] Stream exception:", error);
			throw new LlmError(`Devin ACP stream failed: ${msg} (stderr tail: ${tail})`, "TRANSPORT", { cause: error });
		} finally {
			client.close();
		}
	}
	handlePermission(request) {
		const chosen = request.options?.find((o) => {
			const k = (o.kind || "").toLowerCase();
			const id = (o.optionId || o.id || "").toLowerCase();
			return k.includes("allow") || id.includes("allow") || id.includes("accept") || id.includes("approve") || id.includes("yes");
		}) ?? request.options?.[0];
		return { outcome: {
			outcome: "selected",
			optionId: chosen?.optionId || chosen?.id || "allow_once"
		} };
	}
};
/**
* Devin CLI credentials.toml 的平台相关路径。
* 支持环境变量 DEVIN_CREDENTIALS_PATH 覆盖。
*/
function devinCredentialsPath() {
	if (process.env.DEVIN_CREDENTIALS_PATH) return process.env.DEVIN_CREDENTIALS_PATH;
	if (platform() === "win32") {
		const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
		return join(appData, "devin", "credentials.toml");
	}
	const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(dataHome, "devin", "credentials.toml");
}
/**
* 从 credentials.toml 解析 Devin session。
* 使用轻量 TOML 顶层扫描器，避免引入额外依赖。
*/
function devinSessionEntry(contents) {
	const table = scanTomlTopLevel(contents);
	const apiKey = table["windsurf_api_key"];
	if (typeof apiKey !== "string" || !apiKey) return void 0;
	return {
		apiKey,
		apiServerUrl: table["api_server_url"] || "https://server.codeium.com",
		...table["devin_api_url"] ? { devinApiUrl: table["devin_api_url"] } : {}
	};
}
/**
* 尝试从 Devin CLI 的 credentials.toml 读取 session。
* 文件不存在或格式无效时返回 undefined，不抛异常。
*/
function readDevinSession(options) {
	const path = options?.credentialsPath ?? devinCredentialsPath();
	if (!existsSync(path)) return void 0;
	try {
		return devinSessionEntry(readFileSync(path, "utf8"));
	} catch {
		return;
	}
}
/**
* 扫描 TOML 文件的顶层 string key=value 对。
*/
function scanTomlTopLevel(contents) {
	const result = {};
	const lines = contents.split("\n");
	let inTable = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "" || line.startsWith("#")) continue;
		if (line.startsWith("[")) {
			inTable = true;
			continue;
		}
		if (inTable) continue;
		const eqIdx = line.indexOf("=");
		if (eqIdx < 0) continue;
		const key = line.slice(0, eqIdx).trim();
		const valuePart = line.slice(eqIdx + 1).trim();
		if (!valuePart.startsWith("\"")) continue;
		const closing = valuePart.indexOf("\"", 1);
		if (closing < 0) continue;
		result[key] = valuePart.slice(1, closing);
	}
	return result;
}
//#endregion
//#region src/storage.ts
var storage_exports = /* @__PURE__ */ __exportAll({
	loadSettings: () => loadSettings,
	saveSettings: () => saveSettings
});
const DEFAULT_SETTINGS = {
	devinBin: "devin",
	workspace: ".",
	streamIdleTimeoutMs: 3e5,
	activeModelIds: [
		"glm-5-2",
		"swe-1-7",
		"claude-3-7-sonnet",
		"deepseek-v4-pro-max",
		"gemini-3-1-pro-high"
	]
};
function getSettingsPath() {
	const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
	const dir = join(dshHome, "profiles", "web");
	if (existsSync(dir)) return join(dir, "devin-settings.json");
	return join(dshHome, "devin-settings.json");
}
function loadSettings() {
	const file = getSettingsPath();
	try {
		if (existsSync(file)) {
			const data = JSON.parse(readFileSync(file, "utf8"));
			return {
				...DEFAULT_SETTINGS,
				...data
			};
		}
	} catch {}
	return { ...DEFAULT_SETTINGS };
}
function saveSettings(settings) {
	const updated = {
		...loadSettings(),
		...settings
	};
	const file = getSettingsPath();
	try {
		const dir = file.replace(/[/\\][^/\\]+$/, "");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(file, JSON.stringify(updated, null, 2), "utf8");
	} catch (err) {
		console.warn("[dsh-devin-cli] Failed to save devin-settings.json:", err);
	}
	return updated;
}
//#endregion
//#region src/bridge.ts
const execFileAsync = promisify(execFile);
var DevinBridgeServer = class {
	server = null;
	port;
	adapter;
	devinBin;
	cachedModels = [];
	options;
	constructor(options = {}) {
		this.options = options;
		this.port = options.port ?? 4140;
		this.devinBin = options.devinBin ?? "devin";
		this.adapter = new DevinAdapter({
			bin: this.devinBin,
			cwd: options.workspace ?? ".",
			streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? 3e5,
			models: [],
			defaultContextWindow: 2e5,
			defaultMaxTokens: 65536,
			token: options.token ?? ""
		});
	}
	getAdapter() {
		return this.adapter;
	}
	async start() {
		if (this.server) return this.port;
		return new Promise((resolve, reject) => {
			const server = http.createServer(async (req, res) => {
				res.setHeader("Access-Control-Allow-Origin", "*");
				res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
				res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
				if (req.method === "OPTIONS") {
					res.writeHead(204);
					res.end();
					return;
				}
				const url = req.url?.split("?")[0] || "";
				if (req.method === "GET" && url === "/api/status") {
					try {
						const settings = loadSettings();
						let version = "unknown";
						let online = false;
						try {
							const { stdout } = await execFileAsync(settings.devinBin || this.devinBin, ["--version"], {
								timeout: 5e3,
								windowsHide: true
							});
							version = stdout.trim();
							online = true;
						} catch {}
						if (this.cachedModels.length === 0) this.cachedModels = await discoverDevinModels(settings.devinBin || this.devinBin);
						res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({
							ok: true,
							service: "dsh-devin-cli-bridge",
							port: this.port,
							online,
							bin: settings.devinBin || this.devinBin,
							version,
							totalModels: this.cachedModels.length,
							activeCount: settings.activeModelIds?.length || 0,
							settings
						}));
					} catch (err) {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({
							ok: false,
							error: String(err)
						}));
					}
					return;
				}
				if (req.method === "GET" && url === "/api/models") {
					try {
						const settings = loadSettings();
						if (this.cachedModels.length === 0) this.cachedModels = await discoverDevinModels(settings.devinBin || this.devinBin);
						res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({
							ok: true,
							models: this.cachedModels,
							activeModelIds: settings.activeModelIds
						}));
					} catch (err) {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({
							ok: false,
							error: String(err)
						}));
					}
					return;
				}
				if (req.method === "POST" && url === "/api/refresh") {
					try {
						const settings = loadSettings();
						this.cachedModels = await discoverDevinModels(settings.devinBin || this.devinBin);
						res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({
							ok: true,
							total: this.cachedModels.length,
							models: this.cachedModels
						}));
					} catch (err) {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(JSON.stringify({
							ok: false,
							error: String(err)
						}));
					}
					return;
				}
				if (req.method === "POST" && url === "/api/settings") {
					let bodyText = "";
					req.setEncoding("utf8");
					req.on("data", (chunk) => {
						bodyText += chunk;
					});
					req.on("end", () => {
						try {
							const updated = saveSettings(JSON.parse(bodyText));
							this.options.onSettingsChanged?.(updated);
							res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
							res.end(JSON.stringify({
								ok: true,
								settings: updated
							}));
						} catch (err) {
							res.writeHead(500, { "Content-Type": "application/json" });
							res.end(JSON.stringify({
								ok: false,
								error: String(err)
							}));
						}
					});
					return;
				}
				if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
					try {
						if (this.cachedModels.length === 0) this.cachedModels = await discoverDevinModels(this.devinBin);
						const models = this.cachedModels.map((d) => ({
							id: d.id,
							object: "model",
							name: d.name,
							context_window: d.contextWindow ?? 2e5,
							max_tokens: d.maxTokens ?? 65536,
							owned_by: "devin"
						}));
						res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({
							object: "list",
							data: models
						}));
					} catch (err) {
						res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({ error: { message: String(err) } }));
					}
					return;
				}
				if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
					let bodyText = "";
					req.setEncoding("utf8");
					req.on("data", (chunk) => {
						bodyText += chunk;
					});
					req.on("end", async () => {
						try {
							const body = JSON.parse(bodyText);
							const model = body.model || "glm-5-2";
							const abortController = new AbortController();
							req.on("close", () => abortController.abort());
							res.writeHead(200, {
								"Content-Type": "text/event-stream; charset=utf-8",
								"Cache-Control": "no-cache, no-transform",
								"Connection": "keep-alive"
							});
							const generateOptions = {
								provider: "devin",
								model,
								messages: (body.messages || []).map((m) => {
									let text = "";
									if (typeof m.content === "string") text = m.content;
									else if (Array.isArray(m.content)) text = m.content.map((item) => {
										if (typeof item === "string") return item;
										if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
										return "";
									}).join("\n");
									else if (m.content) text = JSON.stringify(m.content);
									return {
										role: m.role,
										content: [{
											type: "text",
											text
										}]
									};
								}),
								signal: abortController.signal
							};
							const stream = this.adapter.stream(generateOptions, abortController.signal);
							for await (const chunk of stream) if (chunk.type === "text-delta") {
								const sseChunk = {
									id: `chatcmpl-${Date.now()}`,
									object: "chat.completion.chunk",
									created: Math.floor(Date.now() / 1e3),
									model,
									choices: [{
										index: 0,
										delta: { content: chunk.text },
										finish_reason: null
									}]
								};
								res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
							}
							const endChunk = {
								id: `chatcmpl-${Date.now()}`,
								object: "chat.completion.chunk",
								created: Math.floor(Date.now() / 1e3),
								model,
								choices: [{
									index: 0,
									delta: {},
									finish_reason: "stop"
								}]
							};
							res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
							res.write("data: [DONE]\n\n");
							res.end();
						} catch (err) {
							if (!res.headersSent) {
								res.writeHead(500, { "Content-Type": "application/json" });
								res.end(JSON.stringify({ error: { message: String(err) } }));
							} else res.end();
						}
					});
					return;
				}
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not Found");
			});
			server.on("error", (err) => {
				if (err.code === "EADDRINUSE") server.listen(0, "127.0.0.1");
				else reject(err);
			});
			server.listen(this.port, "127.0.0.1", () => {
				const address = server.address();
				const boundPort = typeof address === "object" && address ? address.port : this.port;
				this.server = server;
				console.log(`[dsh-devin-cli] Devin bridge listening on http://127.0.0.1:${boundPort}`);
				resolve(boundPort);
			});
		});
	}
	async stop() {
		if (!this.server) return;
		return new Promise((resolve) => {
			this.server?.close(() => {
				this.server = null;
				resolve();
			});
		});
	}
};
//#endregion
//#region src/index.ts
/**
* 通过本机 devin CLI 执行 `devin models list --format json`
* 动态获取当前账户可用的所有模型列表，并构建家族与变体映射索引。
*/
async function discoverDevinModels(devinBin = "devin", signal) {
	try {
		await globalDevinRegistry.init(devinBin, signal);
		const list = globalDevinRegistry.getBaseModels().map((b) => ({
			id: b.id,
			name: b.name,
			contextWindow: b.contextWindow,
			maxTokens: b.maxTokens,
			efforts: b.efforts
		}));
		if (list.length > 0) return list;
	} catch (err) {
		console.warn("[discoverDevinModels error]:", err);
	}
	return [];
}
const name = "dsh-devin-cli";
const inject = ["llm"];
const SETTINGS_NS = "dsh-devin-cli";
const DEFAULT_MODELS = [{
	id: "glm-5-2",
	name: "GLM-5.2",
	description: "Devin GLM-5.2 reasoning model.",
	contextWindow: 2e5,
	maxTokens: 65536,
	supportsImages: false
}, {
	id: "swe-1-7",
	name: "SWE-1.7",
	description: "Devin SWE-1.7 coding model with vision support.",
	contextWindow: 262e3,
	maxTokens: 65536,
	supportsImages: true
}];
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	supportsImages: z.boolean()
});
const Config = z.object({
	bridgePort: z.number().step(1).min(1024).max(65535).default(4140),
	devinBin: z.string().default("devin"),
	workspace: z.string().default("."),
	streamIdleTimeoutMs: z.number().step(1).min(1e3).default(3e5),
	token: z.string().role("secret").default(""),
	defaultContextWindow: z.number().step(1).min(1).default(2e5),
	defaultMaxTokens: z.number().step(1).min(1).default(65536),
	models: z.array(catalogModel).default(DEFAULT_MODELS),
	retryPolicy: RetryPolicySchema
});
function apply(ctx, config) {
	let adapterHandle = null;
	let bridgeServer = null;
	const userSettings = loadSettings();
	const devinBin = userSettings.devinBin || config.devinBin || "devin";
	const workspace = userSettings.workspace || config.workspace || ".";
	const streamIdleTimeoutMs = userSettings.streamIdleTimeoutMs || config.streamIdleTimeoutMs || 3e5;
	const retryPolicy = resolveRetryPolicy(config.retryPolicy, `llm: provider "${PROVIDER}" retryPolicy`);
	const token = config.token || readDevinSession()?.apiKey || "";
	const adapter = new DevinAdapter({
		ctx,
		bin: devinBin,
		cwd: workspace,
		streamIdleTimeoutMs,
		models: config.models,
		defaultContextWindow: config.defaultContextWindow,
		defaultMaxTokens: config.defaultMaxTokens,
		token,
		retryPolicy,
		discoverModels: () => discoverDevinModels(devinBin)
	});
	try {
		adapterHandle = ctx.llm.registerAdapter([PROVIDER], adapter);
		console.log("[dsh-devin-cli] Successfully registered Devin LLM adapter");
	} catch (err) {
		ctx.logger?.warn?.(`[dsh-devin-cli] Failed to register adapter: ${err}`);
	}
	bridgeServer = new DevinBridgeServer({
		port: config.bridgePort,
		devinBin,
		workspace,
		streamIdleTimeoutMs,
		token,
		onSettingsChanged: () => {
			adapter.clearCache();
		}
	});
	bridgeServer.start().catch((err) => {
		ctx.logger?.warn?.(`[dsh-devin-cli] Failed to start Devin bridge server: ${err}`);
	});
	const hooks = {
		setSource(thunk) {
			thunk();
		},
		onChange() {
			adapter.clearCache();
		}
	};
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, SETTINGS_NS, Config, config, hooks);
	});
	ctx.effect(() => () => {
		if (adapterHandle) {
			try {
				adapterHandle();
			} catch {}
			adapterHandle = null;
		}
		if (bridgeServer) {
			bridgeServer.stop();
			bridgeServer = null;
		}
	});
}
//#endregion
export { ACP_PROTOCOL_VERSION, AcpStdioClient, Config, DevinAdapter, DevinBridgeServer, PROVIDER, apply, devinCredentialsPath, discoverDevinModels, inject, mapDevinToolNameToDsh, name, readDevinSession };
