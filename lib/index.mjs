import z from "@deepseek-ai/schemastery";
import { LlmAdapter, LlmError, ReasoningEffortId, RetryPolicySchema, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import path, { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
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
				this.options.onUpdate(envelope.update, envelope.sessionId);
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
	sessionNew(params, timeoutMs = 3e4) {
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
		const err = error ?? new LlmError("acp: connection closed", "TRANSPORT");
		for (const [, entry] of this.pending) entry.reject(err);
		this.pending.clear();
		if (!this.process.killed) try {
			this.process.kill("SIGTERM");
		} catch {}
		this.options.onClose?.(err);
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
	initPromise = null;
	async init(devinBin = "devin", signal) {
		if (this.initialized && this.families.length > 0) return;
		if (this.initPromise) return this.initPromise;
		this.initPromise = (async () => {
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
			} finally {
				this.initPromise = null;
			}
		})();
		return this.initPromise;
	}
	loadFromJsonFamilies(rawFamilies) {
		this.families = [];
		this.variantMap.clear();
		this.familyMap.clear();
		const seenFamilies = /* @__PURE__ */ new Set();
		for (const fam of rawFamilies) {
			const fUid = String(fam.family_uid || fam.slug || "").trim();
			if (!fUid || seenFamilies.has(fUid.toLowerCase())) continue;
			seenFamilies.add(fUid.toLowerCase());
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
	const combined = `${kind} ${title} ${metaName}`;
	if (kind === "exec" || kind === "bash" || kind === "pwsh" || metaName === "exec" || metaName === "bash" || metaName === "pwsh" || raw.command || raw.cmd) {
		const isWindows = process.platform === "win32";
		const cmdStr = String(raw.command || raw.cmd || tc.title || "");
		const description = !tc.title || title === "ran command" || title === "run command" || title.startsWith("exec") ? cmdStr : tc.title || cmdStr;
		return {
			name: isWindows ? "pwsh" : "bash",
			args: {
				command: cmdStr,
				description,
				...raw
			}
		};
	}
	if (kind === "read" || metaName === "read" || combined.includes("read") || combined.includes("functions.read") || metaName.startsWith("functions.read")) {
		const filePath = String(raw.file_path || raw.path || raw.filePath || raw.file || "");
		return {
			name: "read",
			args: {
				file_path: filePath,
				path: filePath,
				...raw
			}
		};
	}
	if (kind === "grep" || metaName === "grep" || combined.includes("grep") || combined.includes("functions.grep") || metaName.startsWith("functions.grep")) {
		const query = String(raw.query || raw.pattern || raw.search_term || raw.regex || tc.title || "");
		const path = raw.path || raw.dir || raw.directory || raw.file_path;
		return {
			name: "grep",
			args: {
				pattern: query,
				query,
				...path ? { path: String(path) } : {},
				...raw
			}
		};
	}
	if (kind === "glob" || kind === "find" || metaName === "glob" || metaName === "find" || combined.includes("glob") || combined.includes("find file") || combined.includes("find_by_name")) {
		const pattern = String(raw.pattern || raw.query || raw.glob || "");
		const path = raw.path || raw.dir || raw.directory;
		return {
			name: "glob",
			args: {
				pattern,
				query: pattern,
				...path ? { path: String(path) } : {},
				...raw
			}
		};
	}
	if (kind === "edit" || kind === "write" || metaName === "edit" || metaName === "write" || combined.includes("edit") || combined.includes("write") || metaName.startsWith("functions.write") || metaName.startsWith("functions.edit")) {
		const filePath = String(raw.file_path || raw.path || raw.filePath || raw.file || "");
		return {
			name: "edit",
			args: {
				file_path: filePath,
				path: filePath,
				...raw
			}
		};
	}
	if (kind === "web_search" || metaName === "web_search" || combined.includes("web search") || combined.includes("web_search")) {
		const query = String(raw.query || raw.pattern || "");
		return {
			name: "web_search",
			args: {
				query,
				pattern: query,
				...raw
			}
		};
	}
	if (kind === "web_fetch" || metaName === "web_fetch" || combined.includes("web fetch") || combined.includes("web_fetch")) return {
		name: "web_fetch",
		args: {
			url: String(raw.url || raw.link || ""),
			...raw
		}
	};
	if (combined.includes("subagent")) {
		const desc = String(raw.description || raw.prompt || raw.task || raw.instruction || tc.title || "");
		return {
			name: "subagent",
			args: {
				description: desc,
				prompt: desc,
				...raw
			}
		};
	}
	let cleanName = metaName || kind || "generic";
	cleanName = cleanName.replace(/^functions\./i, "").replace(/:\d+$/, "");
	return {
		name: cleanName || "generic",
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
	close() {
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			if (waiter) waiter(void 0);
		}
		this.items = [];
	}
};
const DSH_UI_SPEC_RULE = `
[dsh-ui 交互式组件规范与视觉设计原则]
当在回复中使用 \`\`\`dsh-ui 围栏输出界面时，必须严格遵守白名单属性与合法枚举，严禁输出未声明属性或 CSS 缩写，否则界面无法渲染：
1. text: {"type":"text","content":"正文","size":"h1|h2|h3|body|muted|caption","center":boolean}
   - ⚠️ size 仅支持以上 6 个枚举，严禁使用 "sm"、"small"、"lg" 等；灰色文字请使用 "muted"；禁止添加 "color" 属性。
2. callout（提示横幅）: {"type":"callout","tone":"info|success|warning|error","title":"标题","content":"正文"}
   - ⚠️ 警告类型必须是 "warning"（不能写 "warn"），错误类型为 "error"（不能写 "danger"）。
   - ⚠️ 视觉红线：严禁连续堆放 3 个以上大色块 callout！callout 仅用于 1~2 个关键总结或高危警示；多段文字必须在 content 中使用 \\n\\n 明确分行。
3. accordion（手风琴折叠面板）: {"type":"accordion","items":[{"title":"问题标题","items":[{"type":"text","content":"详细分析与建议"}]}]}
   - 💡 强烈推荐：多项缺陷清单、分级排查条目、QA 问答首选 accordion，结构紧凑高质感，展开即看详情。
4. list: {"type":"list","items":[{"title":"主标题","desc":"说明"}]}
5. steps: {"type":"steps","current":0,"steps":[{"title":"步骤1","desc":"说明"}]}
   - ⚠️ 步骤数组属性名为 "steps"（每项含 title 与 desc）。
6. card: {"type":"card","title":"卡片标题","items":[...]}
7. table: {"type":"table","columns":["列1","列2"],"rows":[["值1","值2"]]}
8. badge: {"type":"badge","label":"标签","tone":"success|warn|danger|accent"}
9. stat: {"type":"stat","label":"标题","value":"数值","delta":"环比?"}
10. button: {"type":"button","label":"按钮","tone":"primary|danger|success|ghost","action":"actionName"}
排版要求：所有多段落文字（包含危害、建议、原因等）必须在 content 中使用 \\n\\n 明确换行分段，禁止挤成一坨；所有围栏必须是合法合规的单个 JSON 对象，禁止尾随逗号。`;
/**
* 格式化多行文本，在常见中文分段标记前自动补充 \\n\\n，
* 避免模型输出长文本时挤成一坨难以阅读。
*/
function formatContentBreaks(text) {
	if (!text || typeof text !== "string") return text;
	return text.replace(/([^\r\n])\s*(危害[：:]|【危害】)/g, "$1\n\n危害：").replace(/([^\r\n])\s*(修复建议[：:]|【修复建议】|建议[：:]|【建议】)/g, "$1\n\n修复建议：").replace(/([^\r\n])\s*(影响(?:范围)?[：:]|【影响】)/g, "$1\n\n影响：").replace(/([^\r\n])\s*(原因[：:]|【原因】)/g, "$1\n\n原因：").replace(/([^\r\n])\s*([0-9]+[、.][\u4e00-\u9fa5a-zA-Z])/g, "$1\n$2");
}
/**
* 智能自愈与规范化文本中的 \`\`\`dsh-ui 围栏 JSON 数据：
* 1. text: 修正 size 常见别名（sm/small -> muted, xs/mini -> caption, md/normal -> body, lg/large -> h3, xl -> h2），删除非法 size 及未声明的 color 属性，自动补充换行；
* 2. callout: 将 kind 映射为 tone，修正 warn -> warning, danger/alert -> error，自动补充 content 换行；
* 3. accordion: 兼容简写 item.content，自愈为规范的子 text 节点；
* 4. steps: 将 items 映射为 steps；
* 5. badge: 修正 warning -> warn, error -> danger；
* 6. card: 将 label 映射为 title；
* 7. button: 修正 default/secondary -> ghost；
* 避免因常见大模型习惯性字段差异导致 GenUI 严格校验阻断而退化为普通代码框。
*/
function healDshUiFences(fullText) {
	if (!fullText || !fullText.includes("dsh-ui")) return fullText;
	return fullText.replace(/(```dsh-ui[^\r\n]*\r?\n)([\s\S]*?)(\r?\n```)/g, (match, prefix, body, suffix) => {
		try {
			const healed = healGenuiNode(JSON.parse(body.trim()));
			return `${prefix}${JSON.stringify(healed)}${suffix}`;
		} catch {
			return match;
		}
	});
}
function formatArgsSummary(args) {
	if (!args || typeof args !== "object") return "";
	if (typeof args.file_path === "string") return args.file_path;
	if (typeof args.path === "string") return args.path;
	if (typeof args.command === "string") return args.command.length > 80 ? `${args.command.slice(0, 80)}...` : args.command;
	if (typeof args.query === "string") return args.query;
	if (typeof args.pattern === "string") return args.pattern;
	try {
		const str = JSON.stringify(args);
		return str.length > 80 ? `${str.slice(0, 80)}...` : str;
	} catch {
		return "";
	}
}
function formatOutputSummary(text) {
	if (!text) return "";
	const trimmed = text.trim();
	if (!trimmed) return "";
	const firstLine = trimmed.split("\n")[0];
	if (firstLine.length > 80) return `${firstLine.slice(0, 80)}...`;
	return firstLine;
}
function healGenuiNode(node) {
	if (!node || typeof node !== "object") return node;
	const validTextSizes = /* @__PURE__ */ new Set([
		"h1",
		"h2",
		"h3",
		"body",
		"muted",
		"caption"
	]);
	if (node.type === "text") {
		if (typeof node.size === "string") {
			const s = node.size.toLowerCase().trim();
			if (s === "sm" || s === "small") node.size = "muted";
			else if (s === "xs" || s === "mini") node.size = "caption";
			else if (s === "md" || s === "medium" || s === "normal") node.size = "body";
			else if (s === "lg" || s === "large") node.size = "h3";
			else if (s === "xl") node.size = "h2";
			else if (!validTextSizes.has(s)) delete node.size;
		}
		if ("color" in node && typeof node.color === "string") delete node.color;
		if (typeof node.content === "string") node.content = formatContentBreaks(node.content);
	} else if (node.type === "callout") {
		if (node.kind && !node.tone) {
			node.tone = node.kind;
			delete node.kind;
		}
		if (typeof node.tone === "string") {
			const t = node.tone.toLowerCase().trim();
			if (t === "warn") node.tone = "warning";
			else if (t === "danger" || t === "alert") node.tone = "error";
		}
		if (typeof node.content === "string") node.content = formatContentBreaks(node.content);
	} else if (node.type === "accordion") {
		if (Array.isArray(node.items)) node.items = node.items.map((item) => {
			if (!item || typeof item !== "object") return item;
			if (item.content && !item.items) return {
				title: item.title,
				items: [{
					type: "text",
					content: formatContentBreaks(item.content)
				}]
			};
			if (Array.isArray(item.items)) return {
				...item,
				items: item.items.map(healGenuiNode)
			};
			return item;
		});
	} else if (node.type === "steps") {
		if (Array.isArray(node.items) && !node.steps) {
			node.steps = node.items;
			delete node.items;
		}
	} else if (node.type === "badge") {
		if (typeof node.tone === "string") {
			const t = node.tone.toLowerCase().trim();
			if (t === "warning") node.tone = "warn";
			else if (t === "error") node.tone = "danger";
		}
	} else if (node.type === "card") {
		if (node.label && !node.title) {
			node.title = node.label;
			delete node.label;
		}
	} else if (node.type === "button") {
		if (typeof node.tone === "string") {
			const t = node.tone.toLowerCase().trim();
			if (t === "default" || t === "secondary") node.tone = "ghost";
		}
	}
	if (Array.isArray(node.items) && node.type !== "accordion") node.items = node.items.map(healGenuiNode);
	if (Array.isArray(node.steps)) node.steps = node.steps.map(healGenuiNode);
	if (Array.isArray(node.tabs)) node.tabs = node.tabs.map((tab) => ({
		...tab,
		items: Array.isArray(tab.items) ? tab.items.map(healGenuiNode) : tab.items
	}));
	return node;
}
function formatMessages(options) {
	const parts = [];
	const systemTexts = [];
	if (options.system && typeof options.system === "string") systemTexts.push(options.system);
	const rawMessages = Array.isArray(options.messages) ? options.messages : [];
	for (const msg of rawMessages) {
		if (!msg) continue;
		if (msg.role === "system") {
			const blocks = Array.isArray(msg.content) ? msg.content : [];
			for (const block of blocks) if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") systemTexts.push(block.text);
		}
	}
	if (systemTexts.length > 0) {
		const rawSysPrompt = systemTexts.join("\n\n");
		const systemPrompt = rawSysPrompt.includes("dsh-ui") ? `${rawSysPrompt}\n${DSH_UI_SPEC_RULE}` : rawSysPrompt;
		parts.push(`[system]\n${systemPrompt}`);
	}
	for (const message of rawMessages) {
		if (!message || message.role === "system") continue;
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
			} else if (block.type === "image") {
				const mime = block.mimeType || block.mediaType || "image/png";
				parts.push(`[image: ${mime}]`);
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
	client = null;
	clientReady = null;
	clientModel = null;
	clientCwd = null;
	switchingPromise = null;
	dshToAcpSessions = /* @__PURE__ */ new Map();
	activeQueues = /* @__PURE__ */ new Map();
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
		this.disposeClient();
	}
	disposeClient() {
		if (this.client) {
			try {
				this.client.close();
			} catch {}
			this.client = null;
		}
		this.clientReady = null;
		this.clientModel = null;
		this.clientCwd = null;
		this.switchingPromise = null;
		this.dshToAcpSessions.clear();
		for (const queue of this.activeQueues.values()) {
			queue.push({
				done: true,
				cancelled: false
			});
			queue.close();
		}
		this.activeQueues.clear();
	}
	ensureClient(model, cwd, token) {
		if (this.client && this.clientModel === model && this.clientCwd === cwd && this.clientReady) return this.clientReady;
		if (this.client && (this.clientModel !== model || this.clientCwd !== cwd)) {
			if (this.switchingPromise) return this.switchingPromise;
			this.switchingPromise = (this.clientReady ?? Promise.resolve()).catch(() => {}).then(() => {
				this.disposeClient();
			}).then(() => {
				this.clientModel = model ?? null;
				this.clientCwd = cwd;
				this.clientReady = this.spawnAndInit(model, cwd, token);
				return this.clientReady;
			}).finally(() => {
				this.switchingPromise = null;
			});
			return this.switchingPromise;
		}
		this.clientModel = model ?? null;
		this.clientCwd = cwd;
		this.clientReady = this.spawnAndInit(model, cwd, token);
		return this.clientReady;
	}
	async spawnAndInit(model, cwd, token) {
		const argv = [this.config.bin, "acp"];
		if (model) argv.push("--model", model);
		console.log(`[dsh-devin-cli] Spawning long-lived Devin ACP daemon (model: ${model || "default"}, cwd: ${cwd})`);
		const client = new AcpStdioClient({
			argv,
			cwd,
			env: token ? { WINDSURF_API_KEY: token } : void 0,
			onUpdate: (update, sessionId) => {
				if (sessionId) {
					const queue = this.activeQueues.get(sessionId);
					if (queue) queue.push(update);
				} else for (const queue of this.activeQueues.values()) queue.push(update);
			},
			onPermissionRequest: (request) => this.handlePermission(request),
			onClose: (err) => {
				console.warn("[dsh-devin-cli] Devin ACP daemon closed:", err?.message);
				for (const queue of this.activeQueues.values()) {
					queue.push({
						done: true,
						cancelled: false
					});
					queue.close();
				}
				this.activeQueues.clear();
				this.dshToAcpSessions.clear();
				this.client = null;
				this.clientReady = null;
				this.clientModel = null;
				this.clientCwd = null;
				this.switchingPromise = null;
			}
		});
		this.client = client;
		const init = await client.initialize({
			name: "dsh-devin-cli",
			version: "0.4.0"
		}, 3e4);
		if (token && init.authMethods?.length) {
			const apiKeyMethod = init.authMethods.find((m) => m.type === "api_key" && m.id);
			if (apiKeyMethod) try {
				await client.authenticate(apiKeyMethod.id, { api_key: token }, 1e4);
			} catch {}
		}
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
		const token = this.config.token ?? "";
		const dshSessionId = options.sessionId || "default";
		let effectiveCwd = this.config.cwd;
		if (options.cwd) effectiveCwd = options.cwd;
		else if (dshSessionId && this.config.ctx) try {
			const ctxAny = this.config.ctx;
			const session = (typeof ctxAny.get === "function" ? ctxAny.get("sessions") : typeof ctxAny.reflect?.get === "function" ? ctxAny.reflect.get("sessions") : void 0)?.get?.(dshSessionId);
			if (session?.header?.cwd) effectiveCwd = session.header.cwd;
		} catch {}
		effectiveCwd = path.isAbsolute(effectiveCwd) ? effectiveCwd : path.resolve(process.cwd(), effectiveCwd);
		if (signal?.aborted) throw new LlmError("Devin ACP request aborted before start", "ABORTED");
		await this.ensureClient(targetModel, effectiveCwd, token);
		const client = this.client;
		if (!client) throw new LlmError("Devin ACP client daemon not available", "TRANSPORT");
		let isNewSession = false;
		acpSessionId = this.dshToAcpSessions.get(dshSessionId);
		if (!acpSessionId) {
			isNewSession = true;
			const sessionParams = {
				cwd: effectiveCwd,
				mcpServers: []
			};
			acpSessionId = (await client.sessionNew(sessionParams, 2e4)).sessionId;
			this.dshToAcpSessions.set(dshSessionId, acpSessionId);
			console.log(`[dsh-devin-cli] Created NEW Devin ACP session: ${acpSessionId} for DSH session: ${dshSessionId}`);
		} else console.log(`[dsh-devin-cli] REUSING Devin ACP session: ${acpSessionId} for DSH session: ${dshSessionId}`);
		this.activeQueues.set(acpSessionId, queue);
		let promptDone = false;
		let promptUsage;
		try {
			const promptPayload = toAcpPrompt(options);
			console.log(`[dsh-devin-cli] Prompting Devin ACP (session: ${acpSessionId}, isNew: ${isNewSession}, length: ${promptPayload[0]?.text?.length || 0}, cwd: ${effectiveCwd})`);
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
			const endCurrentBlock = () => {
				if (!currentBlock) return null;
				const content = currentBlock.type === "text" ? healDshUiFences(currentBlock.content) : currentBlock.content;
				const closed = {
					type: "block-end",
					index: currentBlock.index,
					block: {
						type: currentBlock.type,
						text: content
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
					if (promptError) {
						this.dshToAcpSessions.delete(dshSessionId);
						throw promptError;
					}
					break;
				}
				if (update.sessionUpdate === "tool_call") {
					const mapped = mapDevinToolNameToDsh(update);
					const argsSummary = formatArgsSummary(mapped.args);
					const { index, startChunk, endChunk } = ensureBlock("reasoning");
					if (endChunk) yield endChunk;
					if (startChunk) yield startChunk;
					const actionText = `\n\n> 🛠️ **执行工具: ${mapped.name}**${argsSummary ? ` \`${argsSummary}\`` : ""}\n`;
					currentBlock.content += actionText;
					yield {
						type: "reasoning-delta",
						index,
						text: actionText
					};
				} else if (update.sessionUpdate === "tool_call_update") {
					const tcu = update;
					const status = (tcu.status || "").toLowerCase();
					if (status === "completed" || status === "failed" || status === "success" || status === "done" || status === "finished" || status === "error" || tcu.isError !== void 0 || !status) {
						let outputText = "";
						if (Array.isArray(tcu.content)) {
							for (const item of tcu.content) if (item.content?.text) outputText += item.content.text;
						}
						const isError = status === "failed" || status === "error" || Boolean(tcu.isError);
						const summary = formatOutputSummary(outputText);
						const resultText = `> ↳ ${isError ? "❌ 失败" : "✅ 完成"}${summary ? `: ${summary}` : ""}\n\n`;
						const { index, startChunk, endChunk } = ensureBlock("reasoning");
						if (endChunk) yield endChunk;
						if (startChunk) yield startChunk;
						currentBlock.content += resultText;
						yield {
							type: "reasoning-delta",
							index,
							text: resultText
						};
					}
				} else if (update.sessionUpdate === "agent_thought_chunk") {
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
					if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
						const inTok = usage.inputTokens ?? 0;
						const outTok = usage.outputTokens ?? 0;
						yield {
							type: "usage",
							usage: {
								inputTokens: inTok,
								outputTokens: outTok,
								totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : typeof usage.used === "number" ? usage.used : inTok + outTok
							}
						};
					}
				}
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
			const tail = this.client?.getStderrTail().trim() || "none";
			console.error("[dsh-devin-cli] Stream exception:", error);
			if (acpSessionId) this.dshToAcpSessions.delete(dshSessionId);
			this.disposeClient();
			throw new LlmError(`Devin ACP stream failed: ${msg} (stderr tail: ${tail})`, "TRANSPORT", { cause: error });
		} finally {
			if (acpSessionId) this.activeQueues.delete(acpSessionId);
			queue.close();
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
//#region src/rpc.ts
const execFileAsync = promisify(execFile);
function failure(code, message) {
	return {
		ok: false,
		error: {
			code,
			message,
			details: {}
		}
	};
}
async function probeCliVersion(bin) {
	try {
		const { stdout } = await execFileAsync(bin, ["--version"], {
			timeout: 5e3,
			windowsHide: true
		});
		return {
			online: true,
			version: stdout.trim()
		};
	} catch {
		return {
			online: false,
			version: "unknown"
		};
	}
}
/**
* 把设置面板的管理端点注册到 DSH 原生 `/api` RPC 通道：
* 复用宿主的浏览器认证与 Host/Origin 信任栅栏，不再监听任何本地端口。
*/
function installDevinRpc(ctx, options = {}) {
	const fallbackBin = options.devinBin ?? "devin";
	let cachedModels = [];
	let inFlightDiscovery = null;
	const ensureModels = async (bin, signal) => {
		if (cachedModels.length > 0) return cachedModels;
		if (inFlightDiscovery) return inFlightDiscovery;
		inFlightDiscovery = (async () => {
			try {
				const raw = await discoverDevinModels(bin, signal);
				const map = /* @__PURE__ */ new Map();
				for (const m of raw) if (m?.id && !map.has(m.id)) map.set(m.id, m);
				cachedModels = Array.from(map.values());
				return cachedModels;
			} finally {
				inFlightDiscovery = null;
			}
		})();
		return inFlightDiscovery;
	};
	const handleRpc = async (endpoint, payload, signal) => {
		try {
			const settings = loadSettings();
			const bin = settings.devinBin || fallbackBin;
			switch (endpoint) {
				case "status": {
					const { online, version } = await probeCliVersion(bin);
					return {
						ok: true,
						value: {
							ok: true,
							service: "dsh-devin-cli",
							online,
							bin,
							version,
							totalModels: (await ensureModels(bin, signal)).length,
							activeCount: settings.activeModelIds?.length || 0,
							settings
						}
					};
				}
				case "models": return {
					ok: true,
					value: {
						ok: true,
						models: await ensureModels(bin, signal),
						activeModelIds: settings.activeModelIds
					}
				};
				case "refresh": {
					cachedModels = [];
					inFlightDiscovery = null;
					const models = await ensureModels(bin, signal);
					return {
						ok: true,
						value: {
							ok: true,
							total: models.length,
							models
						}
					};
				}
				case "settings": {
					const body = payload ?? {};
					if (body.activeModelIds !== void 0 && !Array.isArray(body.activeModelIds)) return failure("devin-cli/invalid-settings", "activeModelIds 必须是字符串数组");
					const updated = saveSettings(body);
					options.onSettingsChanged?.(updated);
					return {
						ok: true,
						value: {
							ok: true,
							settings: updated
						}
					};
				}
				default: return failure("devin-cli/unknown-endpoint", `Unknown endpoint: ${endpoint}`);
			}
		} catch (err) {
			return failure("devin-cli/internal", err instanceof Error ? err.message : String(err));
		}
	};
	ctx.effect(() => {
		let unregister;
		let unregisterWebServer;
		const register = (conn) => {
			if (unregister || !conn?.rpc?.handle) return;
			try {
				unregister = conn.rpc.handle("/devin-cli", (endpoint, payload, signal) => handleRpc(endpoint, payload, signal));
			} catch (err) {
				const msg = String(err?.message || err);
				if (!msg.includes("webServer") && !msg.includes("without inject")) console.warn("[dsh-devin-cli] Failed to register RPC on connection:", msg);
			}
		};
		const attachWebServer = (server) => {
			if (unregisterWebServer || !server?.register) return;
			try {
				const routePath = "/devin-cli";
				if (server.prefix && typeof server.prefix.has === "function" && server.prefix.has(routePath)) try {
					server.prefix.delete(routePath);
				} catch {}
				unregisterWebServer = server.register({
					kind: "prefix",
					path: routePath,
					handler: async (req, res) => {
						res.setHeader("Access-Control-Allow-Origin", "*");
						res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
						res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
						if (req.method === "OPTIONS") {
							res.writeHead(204);
							res.end();
							return;
						}
						if (req.method === "GET") {
							res.setHeader("Content-Type", "application/json; charset=utf-8");
							res.writeHead(200);
							res.end(JSON.stringify({
								ok: true,
								name: "dsh-devin-cli"
							}));
							return;
						}
						if (req.method !== "POST") {
							res.writeHead(405);
							res.end("Method Not Allowed");
							return;
						}
						const endpoint = new URL(req.url, "http://localhost").pathname.replace(/^\/devin-cli\/?/, "");
						let body = "";
						req.on("data", (c) => {
							body += c;
						});
						req.on("end", async () => {
							try {
								const parsed = body ? JSON.parse(body) : {};
								const rpcId = parsed.rpcId || "devin-fallback";
								const payload = parsed.payload ?? {};
								const result = await handleRpc(endpoint, payload, new AbortController().signal);
								res.setHeader("Content-Type", "application/json; charset=utf-8");
								res.writeHead(200);
								res.end(JSON.stringify({
									type: "server-response",
									rpcId,
									result
								}));
							} catch (e) {
								res.setHeader("Content-Type", "application/json; charset=utf-8");
								res.writeHead(200);
								res.end(JSON.stringify({
									type: "server-response",
									rpcId: "error",
									result: {
										ok: false,
										error: {
											code: "devin-cli/error",
											message: e.message,
											details: {}
										}
									}
								}));
							}
						});
					}
				});
				console.log("[dsh-devin-cli] Registered webServer fallback prefix route /devin-cli");
			} catch (err) {
				console.warn("[dsh-devin-cli] Failed to register webServer fallback route:", err);
			}
		};
		const existingConn = ctx.connection;
		if (existingConn?.rpc?.handle) register(existingConn);
		else ctx.inject(["connection"], (connCtx) => {
			const conn = connCtx.connection;
			register(conn);
		});
		const existingWebServer = ctx.webServer;
		if (existingWebServer) attachWebServer(existingWebServer);
		else ctx.inject(["webServer"], (wsCtx) => {
			attachWebServer(wsCtx.webServer);
		});
		return () => {
			if (unregister) {
				unregister();
				unregister = void 0;
			}
			if (unregisterWebServer) {
				unregisterWebServer();
				unregisterWebServer = void 0;
			}
		};
	}, "dsh-devin-cli: rpc channel");
}
//#endregion
//#region src/index.ts
const name = "dsh-devin-cli";
const inject = [
	"llm",
	"connection",
	"settings",
	"webServer"
];
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
	installDevinRpc(ctx, {
		devinBin,
		onSettingsChanged: () => {
			adapter.clearCache();
		}
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
	});
}
//#endregion
export { ACP_PROTOCOL_VERSION, AcpStdioClient, Config, DevinAdapter, PROVIDER, apply, devinCredentialsPath, discoverDevinModels, healDshUiFences, inject, installDevinRpc, mapDevinToolNameToDsh, name, readDevinSession };
