# dsh-devin-cli

<div align="center">

**DeepSeek Harness (DSH) 原生 Devin CLI LLM 适配器插件**

通过本地 Stdio ACP 协议，直接连接本机 Devin CLI 关联的 210+ 款模型，为 DSH 提供零多余网络抽象的流式对话支持。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=22.19](https://img.shields.io/badge/Node-%3E%3D22.19-brightgreen.svg)](package.json)
[![DSH: >=0.1.0-rc.6](https://img.shields.io/badge/DSH-%3E%3D0.1.0--rc.6-orange.svg)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/AtWhuhu/dsh-devin-cli/pulls)

</div>

---

## 🌟 核心特性

- **DSH 微前端原生体验**：通过 DSH Client Slots 注入专属独立「Devin CLI」设置面板与状态徽标，完全解耦，绝不污染官方原生配置。
- **210+ 模型可视化全选与管理**：自动探测本机 Devin CLI 关联账户下的海量可用模型，支持一键搜索过滤、批量激活，已激活模型直观置顶展示。
- **会话即选即用**：在 DSH 会话输入框中键入 `/model` 或点击底部模型下拉选择器，无缝调用已激活的任意 Devin 模型。
- **极简纯粹的本地 stdio ACP**：通过标准 Agent Client Protocol（JSON-RPC 2.0）直接与本地 `devin acp` 通信，无需额外外部代理。
- **全栈契约完备**：显式实现 `prepareCall(provider, model, signal)`，完美兼容最新版 DSH (`dsh-llm` 0.1.2-rc.1+)。
- **多模态就绪**：针对 `swe-1-7` 等模型精准声明 `inputModalities: ['text', 'image']`，支持视觉多模态能力。
- **原生独立工具调用卡片**：将 Devin 底层工具调用（代码搜索、终端执行、文件读写等）原生映射并派发为 DSH 独立的 `tool/call` 与 `tool/result` 卡片消息体，工具执行细节清晰直观，思考流（Reasoning）保持纯净无杂质。
- **上下文工作区动态对齐**：自动提取会话绑定的工作区目录（Session CWD），确保子进程环境精准对齐当前工程。
- **独立持久化保障**：用户模型勾选状态安全保存在 `~/.dsh/devin-settings.json`，插件更新升级不丢失配置。
- **自动化 Agent-Ready**：内置 `pnpm run mount` / `pnpm run unmount` 脚本，便于 AI Agent（如 Claude Code、Cursor、Antigravity、Windsurf）0 门槛自动完成安装与挂载。

---

## 🤖 面向 AI Agent 的自动化安装指南 (Agent-Ready)

> 本节专为 AI Agent（以及希望快速部署的开发者）设计。Agent 可直接按顺序执行下列步骤与检查命令。

### Step 0: 前置环境探测

请在执行安装前通过以下命令验证环境：

| 依赖项 | 检查命令 | 最低版本要求 | 常见修复方式 |
|---|---|---|---|
| **Node.js** | `node -v` | `>= 22.19.0` | 安装 Node 22+ (nvm / fnm) |
| **pnpm** | `pnpm -v` | `>= 9.0.0` | `npm install -g pnpm` |
| **Devin CLI** | `devin --version` | 需全局可用 | 安装 Devin CLI 并配置 PATH |
| **Devin 登录态** | `devin auth whoami` | 需返回有效用户 | 运行 `devin auth login` |
| **DSH 环境** | `dsh --version` | `>= 0.1.0-rc.6` | 确保已安装并初始化过 DSH (`~/.dsh`) |

```bash
# Agent 一键环境自检
node -e "console.log('Node:', process.version)" && pnpm -v && devin --version
```

---

### Step 1: 克隆与构建

```bash
# 1. 克隆代码仓库
git clone https://github.com/AtWhuhu/dsh-devin-cli.git
cd dsh-devin-cli

# 2. 安装依赖并构建产物 (包含 TypeScript 后端与 Client 微前端包装)
pnpm install
pnpm run check
```

构建成功后，`lib/` 目录下将生成：
- `lib/index.mjs` (Cordis 后端插件入口)
- `lib/client.js` (微前端微模块容器，调用 `window.__ModuleLoader__.load`)

---

### Step 2: 挂载插件到 DSH Profile

#### 方式 A：全自动挂载（推荐 AI Agent 执行）

仓库内置了跨平台的自动挂载脚本，可自动定位 `~/.dsh/profiles/` 下的配置并以符号链接注入：

```bash
pnpm run mount
```

*输出示例：*
```text
🔍 检测 DSH 环境目录: C:\Users\liuwan\.dsh
✅ [web] 成功挂载插件到: C:\Users\liuwan\.dsh\profiles\web\package.json
   └─ 链接路径: link:C:/Users/liuwan/dsh-devin-cli
🎉 挂载完成！共更新 1 个 DSH Profile。
```

> **提示**：若需要从 DSH 中卸载此插件，只需执行 `pnpm run unmount`。

#### 方式 B：手动挂载（配置对照）

如需手动配置，修改 `~/.dsh/profiles/web/package.json`（或桌面版对应 profile）：

```jsonc
{
  "name": "dsh-profile-web",
  "dsh": {
    "profile": {
      "bundles": [
        // ... 原有 bundles
        "dsh-devin-cli" // 👈 1. 添加此项
      ]
    }
  },
  "dependencies": {
    // ... 原有 dependencies
    "dsh-devin-cli": "link:/绝对路径/dsh-devin-cli" // 👈 2. 添加 link 依赖 (Windows 使用正斜杠 /)
  }
}
```

---

### Step 3: 启动并验证

启动 DSH Web 宿主：

```bash
dsh --profile web
```

#### 自动化健康检查端点（Agent 验证机制）

插件在后台随 DSH 启动后，会在本地启动一个轻量级的状态与配置管理 Bridge（端口 `4140`）：

```bash
# 1. 检查 Bridge 服务健康状态
curl http://127.0.0.1:4140/api/status
# 预期返回: {"ok":true,"service":"dsh-devin-cli-bridge","port":4140,"modelsCount":210,...}

# 2. 查询当前已持久化的模型列表
curl http://127.0.0.1:4140/api/settings
# 预期返回: {"models":["glm-5-2","swe-1-7",...],"updatedAt":...}
```

---

## 💡 在 DSH 会话中使用 Devin 模型

在浏览器访问 DSH Web（通常为 `http://localhost:3080`）：

### 1. 配置与激活模型
1. 点击左下角的 **「设置」** 齿轮图标；
2. 在左侧面板中选择 **「Devin CLI」** 独立专区；
3. 可以看到上方有 **【✨ 当前已选激活模型】** 状态栏与徽章；
4. 在下方的模型清单中搜索并勾选需要使用的模型（如 `glm-5-2`, `swe-1-7` 等）；
5. 点击右上角的 **「保存」** 按钮，系统会持久化至 `~/.dsh/devin-settings.json` 并动态注册到 DSH 模型注册表中。

### 2. 在对话中调用
1. 点击新建会话或进入已有会话；
2. **方式一**：在聊天输入框内输入 `/model`，在弹出的模型列表中选中你的 Devin 模型；
3. **方式二**：直接点击输入框底部的当前模型名称下拉框，从列表中切换至已激活的模型；
4. 输入你的 Prompt，即可体验原生打字机般的 Stdio ACP 极速流式输出！

---

## 🏗️ 架构与设计规范

```text
┌────────────────────────────────────────────────────────────┐
│                    DSH Web 前端 (浏览器)                   │
│   ┌──────────────────────────┐  ┌───────────────────────┐  │
│   │ Devin CLI Settings Slot  │  │   /model 切换模型     │  │
│   └────────────┬─────────────┘  └───────────┬───────────┘  │
└────────────────┼────────────────────────────┼──────────────┘
                 │ HTTP (4140 端口 Bridge)     │ DSH RPC
┌────────────────▼────────────────────────────▼──────────────┐
│                    DSH 插件后端 (Cordis)                   │
│   ┌──────────────────────────┐  ┌───────────────────────┐  │
│   │       BridgeServer       │  │     DevinAdapter      │  │
│   │ (4140 状态/配置存取)     │  │ (LlmAdapter 实现)     │  │
│   └────────────┬─────────────┘  └───────────┬───────────┘  │
└────────────────┼────────────────────────────┼──────────────┘
                 │ 独立持久化                  │ Stdio (JSON-RPC)
┌────────────────▼─────────────┐  ┌───────────▼──────────────┐
│ ~/.dsh/devin-settings.json   │  │ 本地 devin acp 进程      │
└──────────────────────────────┘  └──────────────────────────┘
```

1. **零污染隔离**：
   - 不修改 DSH 官方源码或官方模型枚举；
   - 微前端前端资源通过 `lib/client.js` 与 `window.__ModuleLoader__.load` 契约挂载；
   - 依赖注入由 Cordis 的 `inject = ['llm']` 精准管理。
2. **ACP 交互闭环 (Agent Client Protocol)**：
   - 启动参数：`devin acp --model <model>`；
   - 协议流程：`initialize` → `authenticate` → `session/new` → `session/prompt`；
   - 支持 `session/update` 实时转为 DSH 的 `StreamChunk`；
   - 支持多模态输入（文本 + 图片）与请求取消 (`signal.abort`)。

---

## 📂 代码目录

```text
dsh-devin-cli/
├── src/
│   ├── index.ts              # Cordis 插件入口，注册 DevinAdapter 与 BridgeServer
│   ├── DevinAdapter.ts       # LlmAdapter 标准实现 (prepareCall, stream, listModels)
│   ├── bridge.ts             # 4140 本地状态与配置 Bridge 端点
│   ├── storage.ts            # 用户设置独立持久化 (~/.dsh/devin-settings.json)
│   ├── credentials.ts        # 本地 ~/.devin/credentials.toml 凭据解析
│   ├── client/
│   │   └── index.ts          # 浏览器端 Slot 注入（Devin CLI 专属设置面板）
│   └── acp/
│       ├── protocol.ts       # ACP 协议定义 (JSON-RPC 2.0)
│       └── AcpStdioClient.ts # Stdio 进程通信与流解析器
├── scripts/
│   ├── build-client.js       # 微前端打包器（将 CJS 产物打包进 ModuleLoader）
│   ├── mount.mjs             # 自动化挂载脚本 (Agent-Ready)
│   └── unmount.mjs           # 自动化卸载脚本
├── cordis.patch.yml          # DSH Profile 补丁配置文件
├── package.json              # 插件元信息与依赖声明
└── tsconfig.json             # TypeScript 编译配置
```

---

## ⚙️ 核心配置参数

在 `cordis.patch.yml` 或 DSH 配置中支持以下可选属性：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `devinBin` | `devin` | 本机 Devin CLI 可执行文件路径 |
| `workspace` | `.` | ACP Session 启动的当前工作目录 |
| `streamIdleTimeoutMs` | `300000` | ACP 数据流空闲超时时间（毫秒） |
| `token` | `""` | 可选的指定 Token（留空时自动读取本机 credentials.toml） |
| `defaultContextWindow`| `200000` | 默认上下文窗口大小 |
| `defaultMaxTokens` | `65536` | 默认最大单次输出 Token |
| `retryPolicy` | normal ×3 | 请求遇到瞬时异常时的重试策略 |

---

## 🛠️ 常见问题排查 (Troubleshooting)

### Q1: 4140 端口提示冲突？
> **解答**：Bridge 采用宽松端口绑定。如果 4140 已被其他旧实例占用，请检查任务管理器中是否有旧的 Node 进程并结束它，或者重启 DSH。

### Q2: 提示 `registration.adapter.prepareCall is not a function`？
> **解答**：最新版 `dsh-llm` 要求必须显式实现 `prepareCall` 方法。本项目在 `DevinAdapter` 中已完备实现，若依然出现此提示，请运行 `pnpm run check` 重新打包。

### Q3: 为什么在设置页面选了模型，在会话中没有刷新？
> **解答**：在「Devin CLI」设置面板中勾选完模型后，请务必点击右上角的 **「保存」** 按钮。保存后后端会立即重新加载可用模型列表。如果聊天页面下拉菜单未即时变更，按 `F5` 刷新浏览器页面即可。

### Q4: 如何在多机器或容器环境跨平台部署？
> **解答**：`pnpm run mount` 脚本自动将 Windows 反斜杠 `\` 转换为正斜杠 `/`，保证在 Windows、macOS 和 Linux 上均可安全运行 `link:` 路径。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
