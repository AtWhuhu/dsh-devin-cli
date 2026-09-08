Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region src/client/index.ts
const { createElement: h, useState, useEffect } = typeof window !== "undefined" && window.React || (typeof require !== "undefined" ? require("react") : null);
const name = "dsh-devin-cli-client";
const inject = ["slots", "connection"];
async function rpcCall(conn, endpoint, payload = {}) {
	let result;
	try {
		result = await conn.call("/devin-cli", endpoint, payload ?? {});
	} catch (err) {
		throw new Error(`无法连接 Devin CLI 服务: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (result && result.ok === true) return result.value;
	const error = result && result.ok === false ? result.error : void 0;
	throw new Error(error ? `Devin CLI 服务错误 [${error.code}]: ${error.message}` : "Devin CLI 服务返回了无法识别的响应");
}
async function fetchStatus(conn) {
	return rpcCall(conn, "status");
}
async function fetchModels(conn) {
	return rpcCall(conn, "models");
}
function apply(ctx) {
	const DevinSettingsSection = () => {
		const conn = ctx.connection.rpc;
		const [status, setStatus] = useState(null);
		const [models, setModels] = useState([]);
		const [activeIds, setActiveIds] = useState(/* @__PURE__ */ new Set());
		const [searchQuery, setSearchQuery] = useState("");
		const [filterTab, setFilterTab] = useState("all");
		const [saving, setSaving] = useState(false);
		const [refreshing, setRefreshing] = useState(false);
		const [toast, setToast] = useState(null);
		const showToast = (msg) => {
			setToast(msg);
			setTimeout(() => setToast((prev) => prev === msg ? null : prev), 3e3);
		};
		const loadData = async () => {
			try {
				const st = await fetchStatus(conn);
				setStatus(st);
				if (st.settings?.activeModelIds) setActiveIds(new Set(st.settings.activeModelIds));
				const md = await fetchModels(conn);
				if (md?.models) {
					const map = /* @__PURE__ */ new Map();
					for (const m of md.models) if (m?.id && !map.has(m.id)) map.set(m.id, m);
					setModels(Array.from(map.values()));
					if (md.activeModelIds) setActiveIds(new Set(md.activeModelIds));
				}
			} catch (e) {
				showToast(`Devin CLI 服务连接失败: ${e instanceof Error ? e.message : String(e)}`);
			}
		};
		useEffect(() => {
			loadData();
			const timer = setInterval(() => {
				fetchStatus(conn).then((s) => setStatus(s)).catch(() => {});
			}, 5e3);
			return () => clearInterval(timer);
		}, []);
		const handleRefresh = async () => {
			setRefreshing(true);
			try {
				const json = await rpcCall(conn, "refresh");
				const map = /* @__PURE__ */ new Map();
				for (const m of json.models || []) if (m?.id && !map.has(m.id)) map.set(m.id, m);
				const unique = Array.from(map.values());
				setModels(unique);
				showToast(`已重新探测，发现 ${unique.length} 个可用模型`);
			} catch (e) {
				showToast(`探测失败: ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				setRefreshing(false);
			}
		};
		const handleSave = async () => {
			setSaving(true);
			try {
				await rpcCall(conn, "settings", { activeModelIds: [...activeIds] });
				showToast(`已成功保存 ${activeIds.size} 个激活模型！`);
			} catch (e) {
				showToast(`保存失败: ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				setSaving(false);
			}
		};
		const toggleModel = (id) => {
			const next = new Set(activeIds);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			setActiveIds(next);
		};
		const selectAll = () => {
			setActiveIds(new Set(filteredModels.map((m) => m.id)));
		};
		const selectNone = () => {
			setActiveIds(/* @__PURE__ */ new Set());
		};
		const activeModelList = Array.from(new Map(models.filter((m) => activeIds.has(m.id)).map((m) => [m.id, m])).values());
		const baseList = filterTab === "active" ? activeModelList : models;
		const uniqueBaseList = Array.from(new Map(baseList.map((m) => [m.id, m])).values());
		const query = searchQuery.trim().toLowerCase();
		const filteredModels = query ? uniqueBaseList.filter((m) => {
			const idMatch = (m.id || "").toLowerCase().includes(query);
			const nameMatch = (m.name || "").toLowerCase().includes(query);
			const effortMatch = (m.efforts || []).some((e) => (e || "").toLowerCase().includes(query));
			return idMatch || nameMatch || effortMatch;
		}) : uniqueBaseList;
		return h("div", { style: {
			padding: "24px",
			maxWidth: "960px",
			margin: "0 auto",
			color: "var(--text-primary, #e2e8f0)",
			fontFamily: "system-ui, -apple-system, sans-serif"
		} }, toast ? h("div", { style: {
			position: "fixed",
			top: "20px",
			right: "24px",
			background: "#10b981",
			color: "#ffffff",
			padding: "8px 16px",
			borderRadius: "8px",
			fontWeight: 600,
			fontSize: "13px",
			boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
			zIndex: 9999
		} }, toast) : null, h("div", { style: {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "24px",
			marginBottom: "24px"
		} }, h("div", { style: {
			flex: "1 1 auto",
			minWidth: 0,
			paddingRight: "12px"
		} }, h("h2", { style: {
			margin: 0,
			fontSize: "20px",
			fontWeight: 700,
			lineHeight: "28px"
		} }, "Devin CLI 驱动中枢"), h("p", { style: {
			margin: "6px 0 0",
			fontSize: "13px",
			lineHeight: "20px",
			color: "var(--text-secondary, #94a3b8)"
		} }, "由本机已登录的 devin CLI 驱动，提供 210 个官方模型、ACP Stdio 流式对话与深度思考支持。")), h("button", {
			type: "button",
			onClick: handleSave,
			disabled: saving,
			style: {
				flexShrink: 0,
				whiteSpace: "nowrap",
				minWidth: "84px",
				height: "36px",
				background: "#2563eb",
				color: "#ffffff",
				border: "none",
				borderRadius: "8px",
				padding: "0 20px",
				fontSize: "14px",
				fontWeight: 600,
				cursor: saving ? "not-allowed" : "pointer",
				opacity: saving ? .7 : 1,
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				boxShadow: "0 1px 3px rgba(0, 0, 0, 0.2)",
				transition: "background 0.2s"
			}
		}, saving ? "保存中..." : "保存")), h("div", { style: {
			background: "rgba(59, 130, 246, 0.08)",
			border: "1px solid rgba(59, 130, 246, 0.22)",
			borderRadius: "8px",
			padding: "10px 16px",
			marginBottom: "18px",
			display: "flex",
			alignItems: "center",
			gap: "10px",
			fontSize: "13px",
			lineHeight: "20px",
			color: "#93c5fd"
		} }, h("span", { style: {
			fontSize: "15px",
			flexShrink: 0
		} }, "💡"), h("div", null, h("strong", { style: { color: "#bfdbfe" } }, "在会话中使用："), "勾选您需要的模型并点击右上角「保存」后，在聊天输入框底部点击模型下拉切换，或直接输入 ", h("code", { style: {
			background: "rgba(255,255,255,0.1)",
			padding: "2px 6px",
			borderRadius: "4px",
			color: "#ffffff"
		} }, "/model"), " 即可立即选用 Devin 模型进行对话。")), h("div", { style: {
			background: "var(--bg-card, rgba(255,255,255,0.03))",
			border: "1px solid var(--border-color, rgba(255,255,255,0.08))",
			borderRadius: "10px",
			padding: "16px 20px",
			marginBottom: "18px",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "16px"
		} }, h("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: "12px",
			flex: "1 1 auto",
			minWidth: 0
		} }, h("span", { style: {
			display: "inline-block",
			width: "10px",
			height: "10px",
			borderRadius: "50%",
			background: status?.online ? "#10b981" : "#f59e0b",
			boxShadow: status?.online ? "0 0 8px #10b981" : "none",
			flexShrink: 0
		} }), h("div", { style: { minWidth: 0 } }, h("div", { style: {
			fontSize: "14px",
			fontWeight: 600
		} }, status?.online ? "Devin CLI 服务已就绪" : "等待 Devin CLI 连接..."), h("div", { style: {
			fontSize: "12px",
			color: "var(--text-secondary, #94a3b8)",
			marginTop: "2px",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		} }, `命令: ${status?.bin || "devin"} | 版本: ${status?.version || "探测中"} | 已发现 ${models.length} 个模型 (已激活 ${activeIds.size} 个)`))), h("button", {
			type: "button",
			onClick: handleRefresh,
			disabled: refreshing,
			style: {
				flexShrink: 0,
				whiteSpace: "nowrap",
				background: "transparent",
				border: "1px solid var(--border-color, rgba(255,255,255,0.15))",
				color: "var(--text-primary, #e2e8f0)",
				borderRadius: "6px",
				padding: "6px 14px",
				fontSize: "12px",
				cursor: refreshing ? "not-allowed" : "pointer"
			}
		}, refreshing ? "探测中..." : "🔄 重新探测模型")), h("div", { style: {
			background: "var(--bg-card, rgba(255,255,255,0.03))",
			border: "1px solid var(--border-color, rgba(255,255,255,0.08))",
			borderRadius: "10px",
			padding: "16px 20px",
			marginBottom: "20px"
		} }, h("div", { style: {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			marginBottom: "12px"
		} }, h("div", { style: {
			fontSize: "14px",
			fontWeight: 600,
			display: "flex",
			alignItems: "center",
			gap: "8px"
		} }, h("span", null, "✨ 当前已选激活模型"), h("span", { style: {
			background: activeIds.size > 0 ? "#2563eb" : "rgba(255,255,255,0.1)",
			color: "#ffffff",
			borderRadius: "10px",
			padding: "1px 8px",
			fontSize: "12px",
			fontWeight: 700
		} }, String(activeIds.size))), activeIds.size > 0 ? h("button", {
			type: "button",
			onClick: selectNone,
			style: {
				background: "transparent",
				border: "none",
				color: "#f87171",
				fontSize: "12px",
				cursor: "pointer",
				padding: "2px 6px"
			}
		}, "清空已选") : null), activeIds.size === 0 ? h("div", { style: {
			color: "var(--text-secondary, #94a3b8)",
			fontSize: "13px",
			padding: "6px 0"
		} }, "暂无已选模型。请在下方模型列表中勾选您想在会话中使用的模型，勾选后点击右上角「保存」即可生效。") : h("div", { style: {
			display: "flex",
			flexWrap: "wrap",
			gap: "8px"
		} }, activeModelList.map((m) => h("div", {
			key: m.id,
			style: {
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
				background: "rgba(37, 99, 235, 0.12)",
				border: "1px solid rgba(59, 130, 246, 0.35)",
				borderRadius: "6px",
				padding: "4px 10px",
				fontSize: "12px"
			}
		}, h("span", { style: {
			width: "6px",
			height: "6px",
			borderRadius: "50%",
			background: "#10b981",
			flexShrink: 0
		} }), h("span", { style: {
			fontWeight: 600,
			color: "#e2e8f0"
		} }, m.name || m.id), h("span", { style: {
			color: "#94a3b8",
			fontSize: "11px"
		} }, `(${m.id})`), h("button", {
			type: "button",
			title: "移除此模型",
			onClick: (e) => {
				e.stopPropagation();
				toggleModel(m.id);
			},
			style: {
				background: "transparent",
				border: "none",
				color: "#94a3b8",
				cursor: "pointer",
				marginLeft: "4px",
				padding: "0 2px",
				fontSize: "14px",
				lineHeight: "1"
			}
		}, "×"))))), h("div", { style: {
			background: "var(--bg-card, rgba(255,255,255,0.03))",
			border: "1px solid var(--border-color, rgba(255,255,255,0.08))",
			borderRadius: "10px",
			padding: "18px 20px"
		} }, h("div", { style: {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			marginBottom: "14px"
		} }, h("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: "8px"
		} }, h("button", {
			type: "button",
			onClick: () => setFilterTab("all"),
			style: {
				background: filterTab === "all" ? "#2563eb" : "transparent",
				color: filterTab === "all" ? "#ffffff" : "var(--text-secondary, #94a3b8)",
				border: filterTab === "all" ? "none" : "1px solid var(--border-color, rgba(255,255,255,0.12))",
				borderRadius: "6px",
				padding: "5px 12px",
				fontSize: "13px",
				fontWeight: 600,
				cursor: "pointer",
				transition: "all 0.15s ease"
			}
		}, `全部模型 (${models.length})`), h("button", {
			type: "button",
			onClick: () => setFilterTab("active"),
			style: {
				background: filterTab === "active" ? "#2563eb" : "transparent",
				color: filterTab === "active" ? "#ffffff" : "var(--text-secondary, #94a3b8)",
				border: filterTab === "active" ? "none" : "1px solid var(--border-color, rgba(255,255,255,0.12))",
				borderRadius: "6px",
				padding: "5px 12px",
				fontSize: "13px",
				fontWeight: 600,
				cursor: "pointer",
				transition: "all 0.15s ease"
			}
		}, `仅看已选 (${activeIds.size})`)), h("div", { style: {
			display: "flex",
			gap: "8px"
		} }, h("button", {
			type: "button",
			onClick: selectAll,
			style: {
				background: "transparent",
				border: "1px solid var(--border-color, rgba(255,255,255,0.15))",
				color: "var(--text-secondary, #94a3b8)",
				borderRadius: "4px",
				padding: "4px 10px",
				fontSize: "12px",
				cursor: "pointer"
			}
		}, "全部勾选"), h("button", {
			type: "button",
			onClick: selectNone,
			style: {
				background: "transparent",
				border: "1px solid var(--border-color, rgba(255,255,255,0.15))",
				color: "var(--text-secondary, #94a3b8)",
				borderRadius: "4px",
				padding: "4px 10px",
				fontSize: "12px",
				cursor: "pointer"
			}
		}, "全不选"))), h("div", { style: {
			position: "relative",
			width: "100%",
			marginBottom: "10px"
		} }, h("input", {
			type: "text",
			value: searchQuery,
			onChange: (e) => setSearchQuery(e.target?.value ?? ""),
			onInput: (e) => setSearchQuery(e.target?.value ?? ""),
			placeholder: "搜索模型名称或 ID，例如 claude, glm, swe, gpt, deepseek, gemini...",
			style: {
				width: "100%",
				boxSizing: "border-box",
				background: "var(--bg-input, rgba(0,0,0,0.2))",
				border: "1px solid var(--border-color, rgba(255,255,255,0.12))",
				borderRadius: "6px",
				padding: "8px 36px 8px 12px",
				color: "inherit",
				fontSize: "13px",
				outline: "none"
			}
		}), searchQuery ? h("button", {
			type: "button",
			title: "清空搜索",
			onClick: () => setSearchQuery(""),
			style: {
				position: "absolute",
				right: "10px",
				top: "50%",
				transform: "translateY(-50%)",
				background: "transparent",
				border: "none",
				color: "#94a3b8",
				cursor: "pointer",
				fontSize: "14px",
				padding: "2px 6px",
				lineHeight: "1"
			}
		}, "✕") : null), query ? h("div", { style: {
			fontSize: "12px",
			color: "#93c5fd",
			marginBottom: "10px",
			paddingLeft: "2px",
			display: "flex",
			alignItems: "center",
			gap: "6px"
		} }, `🔍 搜索 "${searchQuery}"：找到 ${filteredModels.length} 个匹配模型`) : null, h("div", { style: {
			maxHeight: "460px",
			overflowY: "auto",
			border: "1px solid var(--border-color, rgba(255,255,255,0.06))",
			borderRadius: "6px"
		} }, filteredModels.length === 0 ? h("div", { style: {
			padding: "36px 16px",
			textAlign: "center",
			color: "var(--text-secondary, #94a3b8)",
			fontSize: "13px"
		} }, query ? `未找到与 "${searchQuery}" 相关的模型，请尝试更换搜索词` : "暂无可用模型") : filteredModels.map((m) => {
			const checked = activeIds.has(m.id);
			return h("div", {
				key: m.id,
				onClick: () => toggleModel(m.id),
				style: {
					display: "flex",
					alignItems: "flex-start",
					gap: "12px",
					padding: "12px 16px",
					borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.05))",
					cursor: "pointer",
					background: checked ? "rgba(59, 130, 246, 0.08)" : "transparent",
					transition: "background 0.15s ease"
				}
			}, h("input", {
				type: "checkbox",
				checked,
				onChange: () => {},
				style: {
					cursor: "pointer",
					marginTop: "3px",
					flexShrink: 0
				}
			}), h("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				flex: "1 1 auto",
				minWidth: 0
			} }, h("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				flexWrap: "wrap"
			} }, h("span", { style: {
				fontWeight: 600,
				fontSize: "14px",
				color: "var(--text-primary, #f8fafc)"
			} }, m.name || m.id), h("span", { style: {
				fontSize: "11px",
				color: "var(--text-secondary, #94a3b8)",
				background: "rgba(255,255,255,0.06)",
				border: "1px solid rgba(255,255,255,0.08)",
				padding: "1px 6px",
				borderRadius: "4px",
				fontFamily: "monospace"
			} }, m.id)), h("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				flexWrap: "wrap"
			} }, m.efforts && m.efforts.length > 1 ? h("span", { style: {
				fontSize: "11px",
				color: "#60a5fa",
				background: "rgba(59, 130, 246, 0.12)",
				border: "1px solid rgba(59, 130, 246, 0.25)",
				padding: "1px 8px",
				borderRadius: "4px",
				fontWeight: 500
			} }, `等级: ${m.efforts.join(" · ")}`) : null, m.contextWindow ? h("span", { style: {
				fontSize: "11px",
				color: "var(--text-secondary, #94a3b8)",
				background: "rgba(255,255,255,0.05)",
				border: "1px solid rgba(255,255,255,0.06)",
				padding: "1px 8px",
				borderRadius: "4px"
			} }, `Context: ${(m.contextWindow / 1e3).toFixed(0)}k`) : null)));
		}))));
	};
	const DevinHeaderBadge = () => {
		const [status, setStatus] = useState(null);
		useEffect(() => {
			fetchStatus(ctx.connection.rpc).then(setStatus).catch(() => {});
		}, []);
		return h("button", {
			type: "button",
			title: `Devin CLI: ${status?.online ? "服务就绪" : "等待就绪"} · 点击查看`,
			style: {
				background: "var(--bg-header, rgba(255,255,255,0.05))",
				border: "1px solid var(--border-color, rgba(255,255,255,0.12))",
				borderRadius: "999px",
				cursor: "pointer",
				padding: "2px 9px",
				fontSize: "11.5px",
				fontWeight: 600,
				color: "var(--text-primary, #e2e8f0)",
				display: "inline-flex",
				alignItems: "center",
				gap: "5px"
			}
		}, h("span", { style: {
			display: "inline-block",
			width: "6px",
			height: "6px",
			borderRadius: "50%",
			background: status?.online ? "#10b981" : "#f59e0b"
		} }), "Devin");
	};
	ctx.slots.inject("conversation.session.header.actions", () => {
		return ctx.slots.register({
			name: "conversation.session.header.actions",
			id: "devin-cli-badge",
			order: 12,
			label: (() => "Devin")
		}, DevinHeaderBadge);
	});
	ctx.slots.inject("settings.section", () => {
		return ctx.slots.register({
			name: "settings.section",
			id: "devin-cli",
			order: 25,
			label: (() => "Devin CLI")
		}, DevinSettingsSection);
	});
}
//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;
