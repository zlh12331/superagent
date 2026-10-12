# 架构设计文档

> 基于 `code-agent-desktop` v1.0.0 实际代码整理。所有结论均来自源码，未做主观推断。
> 整理时间：2026-07-23（服务清单 2026-08-11 同步）

## 1. 整体分层架构

项目为 **Electron + Vite + React 19 + Vercel AI SDK v7** 桌面 AI Agent 应用，采用四层进程隔离架构。

| 层级 | 入口文件 | 职责 |
|---|---|---|
| main | [src/main/index.ts](file:///src/main/index.ts) | Electron 主进程入口：窗口创建、Logger/SQLite 初始化、CSP 注入、IPC handler 注册、退出清理 |
| renderer | [src/renderer/main.tsx](file:///src/renderer/main.tsx) | React 19 渲染层入口：Router + Providers |
| preload | [src/preload/index.ts](file:///src/preload/index.ts) | contextBridge 暴露 `window.api`（16 个域，由 `createIpcApi(IPC_META)` 自动生成），sandbox + contextIsolation |
| shared | [packages/shared/src/index.ts](file:///packages/shared/src/index.ts) | 跨进程共享包 `@code-agent/shared`：错误码、IPC 类型契约、Zod schemas |

### 主进程安全基线

[src/main/window.ts](file:///src/main/window.ts) 的 `webPreferences` 配置：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`

preload 输出为 `.cjs`（[electron.vite.config.ts](file:///electron.vite.config.ts) 的 preload 段），强制 CJS 以兼容 sandbox 限制。

## 2. ServiceContainer：统一生命周期管理

文件：[src/main/service-container.ts](file:///src/main/service-container.ts)（约 800 行）

### 2.1 持有的 16 个服务 + 2 个核心组件（共 18 个容器 getter）

| # | 服务 | 接口 | 初始化方式 |
|---|---|---|---|
| 1 | chatService | IChatService | 模块级单例 `getChatService()` |
| 2 | fileService | IFileService | 模块级单例 `getFileService()` |
| 3 | searchService | ISearchService | 模块级单例 `getSearchService()` |
| 4 | toolRegistry | IToolRegistry | class `new ToolRegistry()` + `registerBuiltinTools()` |
| 5 | permissionService | IPermissionService | class `new PermissionService()` |
| 6 | toolExecutor | IToolExecutor | class `new ToolExecutor(registry, permission)` |
| 7 | mcpService | IMCPService | class `new MCPService(toolRegistry)` |
| 8 | agentService | IAgentService | class `new AgentService(registry, executor, prompt, session, llmClient)` |
| 9 | promptService | IPromptService | class `new PromptService({ gitSummaryProvider })`（经 `gitSummaryProviderFrom` 适配 GitService.status） |
| 10 | terminalService | ITerminalService | 模块级单例 `getTerminalService()` |
| 11 | gitService | IGitService | 模块级单例 `getGitService()` |
| 12 | codebaseService | ICodebaseService | 模块级单例 `getCodebaseService()` |
| 13 | sessionService | ISessionService | 模块级单例 `getSessionService()` |
| 14 | updateService | IUpdateService | class `new UpdateService(autoUpdater, () => app.isPackaged)` |
| 15 | goalService | —（直接 export class GoalService） | class `new GoalService(agentService, GoalJudge(llmClient), …)` |
| 16 | imService | —（直接 export class ImService） | class `new ImService()`（+ ImAgentBridge 桥接，懒执行） |
| 17 | memoryService | —（直接 export class MemoryService） | class `new MemoryService(llmClient)` |
| 18 | lspManager | —（直接 export class LspServerManager） | class `new LspServerManager()`（懒加载，首次工具调用才有） |

- 模块级单例（getXXXService 模式）：7 个
- class 直接 new：11 个（含 toolRegistry/toolExecutor 2 个核心组件）

> 同步口径 2026-08-17 实测：服务表 18 行（14 基础 + goal/im/memory + lspManager）、getter 服务 18 个、dispose 18 步 runStep（见 §2.2）。行号随 service-container.ts 演进漂移，以函数名为准。

### 2.2 dispose 顺序（18 步 runStep，反向依赖）

定义在 [src/main/service-container.ts](file:///src/main/service-container.ts) `ServiceContainer.dispose()`（每步 `runStep` 独立 try/catch，单步失败不阻断后续）：

| 步 | 动作 | 释放资源 |
|---|---|---|
| 1 | lspManager.disposeAll() | 关闭 LSP server 子进程 |
| 2 | ChatService.dispose() + resetChatService() | 中断活跃对话 + 等待 stream 收尾 + 清空模块级单例 |
| 3 | AgentService.dispose() | 中断活跃 agent stream（等待 Promise.allSettled + 3s 超时兜底） |
| 4 | MCPService.stopAll() | 关闭所有 MCP server 子进程（必须先于 ToolRegistry 清空） |
| 5 | GoalService.unmount() | 解除回合监听（防泄漏） |
| 6 | ImAgentBridge.unmount() | 解除 IM 消息订阅 |
| 7 | ImService.stopAll() | 停止全部 IM 渠道长连接 |
| 8 | PermissionService.dispose() + toolExecutor/registry = null | reject 所有 pending 审批 Promise |
| 9 | agentAskService.dispose() | 清理 pending 提问 |
| 10 | FileService.dispose() + resetFileService() | 关闭 chokidar watcher |
| 11 | SearchService.dispose() + resetSearchService() | 终止 ripgrep 子进程 |
| 12 | TerminalService.dispose() + resetTerminalService() | kill 所有 pty 进程 |
| 13 | GitService.dispose() + resetGitService() | no-op（每次 spawn 即退，保持一致性） |
| 14 | CodebaseService.dispose() + resetCodebaseService() | no-op |
| 15 | SessionService.dispose() + resetSessionService() | no-op |
| 16 | promptService/memoryService = null | 清空引用 |
| 17 | UpdateService.dispose() | 更新事件收尾 |
| 18 | resetAIProvider() → closeDb() | SQLite 必须最后关闭 |

设计依据：[L12-L42](file:///src/main/service-container.ts) 注释说明 dispose 严格按反向依赖顺序，db 必须最后关闭避免 SessionService 访问已关闭连接。每个服务的 dispose 都有 3 秒超时兜底避免 hang 死。

### 2.3 reset 函数（测试场景）

[L707-L735](file:///src/main/service-container.ts)：仅清空缓存引用与模块级单例（`resetChatService` / `resetFileService` / `resetSearchService` / `resetTerminalService` / `resetGitService` / `resetCodebaseService` / `resetSessionService` / `resetAIProvider` / `resetDb` / `resetConfigCache`），**不调用 dispose**（不停止外部服务）。供测试用例隔离使用，与 `setXxxService(null)` 配套。

## 3. IPC 架构

### 3.1 Channel 定义

单一真源：[packages/shared/src/ipc/definitions.ts](file:///packages/shared/src/ipc/definitions.ts) 在 `IPC_META`（纯字符串元数据）基础上合并 zod schema，导出 `IPC_DEFINITIONS`。`IPC_CHANNELS` 由 `deriveChannels(IPC_META)` 自动生成（[channels.ts](file:///packages/shared/src/ipc/channels.ts)），导出 `IpcChannel` 联合类型。命名规范：

- `{domain}:{action}` 请求-响应
- `{domain}:stream:{event}` 流式事件
- `{domain}:event:{name}` 状态变更事件

**16 个域 / 74 个 channel**（59 invoke + 15 push）：

| 域 | channel 数 | handler 文件 |
|---|---|---|
| app | 3 | [app.handler.ts](file:///src/main/ipc/app.handler.ts) |
| agent | 10 (7 推送) | [agent.handler.ts](file:///src/main/ipc/agent.handler.ts) + [agent-approval.handler.ts](file:///src/main/ipc/agent-approval.handler.ts) |
| session | 10 | [session.handler.ts](file:///src/main/ipc/session.handler.ts) |
| file | 10 (1 推送) | [file.handler.ts](file:///src/main/ipc/file.handler.ts) |
| search | 2 | [search.handler.ts](file:///src/main/ipc/search.handler.ts) |
| terminal | 7 (3 推送) | [terminal.handler.ts](file:///src/main/ipc/terminal.handler.ts) |
| git | 5 | [git.handler.ts](file:///src/main/ipc/git.handler.ts) |
| tool | 1 | [tool.handler.ts](file:///src/main/ipc/tool.handler.ts) |
| settings | 8 | [settings.handler.ts](file:///src/main/ipc/settings.handler.ts) |
| system | 1 | [system.handler.ts](file:///src/main/ipc/system.handler.ts) |
| logs | 1 | [system.handler.ts](file:///src/main/ipc/system.handler.ts)（并入 system） |
| devtools | 1 | [devtools.handler.ts](file:///src/main/ipc/devtools.handler.ts) |
| dialog | 1 | [dialog.handler.ts](file:///src/main/ipc/dialog.handler.ts) |
| update | 3 (1 推送) | [update.handler.ts](file:///src/main/ipc/update.handler.ts) |

**注**：MCPService / PermissionService / AppConfig 不通过 IPC 暴露（[src/main/ipc/](file:///src/main/ipc/) 无 `mcp.handler.ts` / `permission.handler.ts`），它们是主进程内部服务。

### 3.2 Preload API 形状

[src/preload/index.ts](file:///src/preload/index.ts) 通过 `createIpcApi(IPC_META)` 自动生成 `window.api`（遍历 `IPC_META` 元数据表，零手写），通过 `contextBridge.exposeInMainWorld('api', api)` 暴露。生成器位于 [src/preload/utils/create-api.ts](file:///src/preload/utils/create-api.ts)。

底层封装在 [src/preload/utils/ipc-bridge.ts](file:///src/preload/utils/ipc-bridge.ts)：

- `invoke<T>(channel, input?)`：返回 `Promise<IpcResponse<T>>`（成功 `{data}` / 失败 `{error}` 判别联合）。每次调用自动生成 `crypto.randomUUID()` 作为 traceId，作为第三个参数传入主进程 `ipcMain.handle`（[L33-L41](file:///src/preload/utils/ipc-bridge.ts)）
- `subscribe<T>(channel, callback)`：包装 `ipcRenderer.on`，吞掉 `IpcRendererEvent`，返回 unsubscribe 函数（[L69-L81](file:///src/preload/utils/ipc-bridge.ts)）

## 4. 进程通信模型

### 4.1 请求-响应 vs 推送分布

- **请求-响应（invoke）**：59 个 channel（80%）
- **推送（on）**：15 个 channel（20%）

### 4.2 流式推送机制

唯一流式通道（chat 域已随死链路清理删除，统一走 agent）：

**agent:stream:part** — [agent-service.ts#L310-L335](file:///src/main/infra/ai/agent/agent-service.ts)
- 主进程 `streamText()` → `result.toUIMessageStream()` → reader.read() 循环 → `webContents.send(AGENT_STREAM_PART, {sessionId, part})`
- 额外推送 `AGENT_TOOL_CALL` / `AGENT_TOOL_RESULT` / `AGENT_APPROVAL_REQUEST`
- 配套 `AGENT_STREAM_END` / `AGENT_STREAM_ERROR`
- 通过 `webContents.isDestroyed()` 守卫避免窗口销毁后推送

## 5. AI 核心架构

### 5.1 AgentService（唯一会话执行服务）

ChatService（单轮无工具流式）已随死链路清理删除（2026-08 功能设计审计轮），会话执行统一由 AgentService 承担：

| 项 | AgentService |
|---|---|
| 文件 | [agent-service.ts](file:///src/main/infra/ai/agent/agent-service.ts) |
| tools 参数 | 有（`toolRegistry.toAISDKTools(ctx, executeHook)`） |
| stopWhen | `isStepCount(options.maxSteps)` |
| system prompt | 条件展开 `system` 字段 |
| 工作目录约束 | 有（写入 `ToolContext.workingDir`） |
| 依赖 | ai-provider + toolRegistry + toolExecutor + promptService |
| OTel span | `withSpan('agent.streamText', ...)` |

关键机制：

- 错误分类器 [error-classifier.ts](file:///src/main/infra/ai/tools/error-classifier.ts)
- dispose 模式（3s 超时兜底的 Promise.race + Promise.allSettled，[agent-service.ts#L182-L217](file:///src/main/infra/ai/agent/agent-service.ts)）

### 5.2 工具系统三层分层

| 层 | 文件 | 职责 |
|---|---|---|
| ToolRegistry | [tool-registry.ts](file:///src/main/infra/ai/tools/tool-registry.ts) | 注册/查找/列出工具，`toAISDKTools(ctx, executeHook)` 转换为 AI SDK v7 原生 Tool |
| ToolExecutor | [tool-executor.ts](file:///src/main/infra/ai/tools/tool-executor.ts) | 统一执行入口：查找工具 → 权限决策 → 推送 AGENT_TOOL_CALL → 审批等待 → 执行 → 推送 AGENT_TOOL_RESULT |
| PermissionService | [permission-service.ts](file:///src/main/infra/ai/tools/permission-service.ts) | 权限决策（`'auto' \| 'ask'` 二态）+ 审批 Promise Map + 5 分钟记忆决策缓存 |

权限模型实际为二态 `'auto' \| 'ask'`（[tool.ts#L72](file:///src/main/infra/ai/tools/tool.ts)），无 `'deny'` 态。

### 5.3 PromptService 角色

文件：[src/main/infra/ai/prompt/prompt-service.ts](file:///src/main/infra/ai/prompt/prompt-service.ts)

职责：

1. **默认 prompt 初始化**：`initialize()` 幂等插入 `DEFAULT_CODE_AGENT_PROMPT` 到 SQLite `prompts` 表，`onConflictDoNothing` 保护用户编辑
2. **数据库 CRUD**：`getPrompt(id)` 从 SQLite 读取
3. **动态上下文注入**：`resolvePrompt(id, workingDir)` 每次调用重新收集环境信息，返回 `{ content, source }`
4. **失败回退**：DB 读取失败时回退到 [default-prompt.ts](file:///src/main/infra/ai/prompt/default-prompt.ts) 硬编码默认值

依赖注入：`PromptServiceOptions` 支持 `gitSummaryProvider` 注入（[dynamic-context.ts](file:///src/main/infra/ai/prompt/dynamic-context.ts) 定义 `GitSummaryProvider` 类型）。ServiceContainer 创建 `PromptService` 时经 `gitSummaryProviderFrom(gitService.status)` 注入：`{{gitBranch}}` / `{{gitStatus}}` 为真实值；非 git 仓库或查询失败时由 `injectDynamicContext` 兜底为占位符。

## 6. traceId 贯穿机制

1. 渲染层 `invoke` 调用 [src/preload/utils/ipc-bridge.ts#L36-L40](file:///src/preload/utils/ipc-bridge.ts)：`crypto.randomUUID()` 生成 traceId，作为第三个参数传入 `ipcRenderer.invoke`
2. 主进程 `wrap` [src/main/utils/wrap.ts#L48-L51](file:///src/main/utils/wrap.ts)：`const traceId = incomingTraceId ?? randomUUID()`，构造 `IpcHandlerContext { traceId, sender }` 传给业务 handler
3. 日志贯穿：`LogContext` 接口 [logger.ts#L20-L27](file:///src/main/utils/logger.ts) 含 `traceId?` 字段
4. 本地错误上报：wrap.ts catch 中带 traceId 上下文经 error-report.ts 落本地日志（Sentry 已于 2026-09-13 移除）
5. OTel span：`withSpan('agent.streamText', { 'session.id': sessionId, ... })` 把 sessionId / maxSteps 等作为 span 属性

## 7. 关键风险点

1. **service-container.ts 单文件约 1000 行**：18 个服务的 getter/setter + dispose + reset 全部集中，随服务增加会进一步膨胀
2. **注释与代码漂移**：工具计数随迭代快速增长（12→29→31），需与 [tools/index.ts](file:///src/main/infra/ai/tools/index.ts) `registerBuiltinTools` 保持同步（2026-08-22 实测 **31 个**）
3. ~~**MCPService 无独立 IPC handler**~~：已解决——mcp.handler.ts 提供 list/start/stop，设置页有 MCP 管理分区（2026-08-22 起另支持 sse/streamable-http 远程传输）
4. **chat 域保留但被 agent 域替代**：channels.ts 注释明确"保留兼容旧 chat:send"，存在双轨制维护负担

## 8. 关键亮点

1. **ServiceContainer 模式**：18 个服务统一生命周期管理，dispose 顺序严格按反向依赖，3s 超时兜底避免 hang 死
2. **接口化设计**：所有服务都抽出 I*Service 接口，ServiceContainer 提供 `setXxxService()` 注入点便于测试 mock
3. **类型契约单一来源**：`IPC_DEFINITIONS` 定义在 shared，preload 通过 `createIpcApi(IPC_META)` 自动生成 IpcApi，channel 名通过 `IPC_CHANNELS` 常量表 + `as const` 派生字面量类型防拼写错误
4. **沙箱友好的 preload 设计**：子路径导入 `@code-agent/shared/ipc/meta` 避免 zod 拉进 CJS 产物（[preload/index.ts#L27](file:///src/preload/index.ts)），使用全局 `crypto.randomUUID()` 替代 node:crypto
5. **AI SDK v7 适配**：使用新 API `stopWhen: isStepCount(n)` 替代旧 `maxSteps`，`allowSystemInMessages: true` 显式兼容旧消息历史
6. **三层工具系统**：ToolRegistry（注册）/ PermissionService（决策+审批+5分钟记忆）/ ToolExecutor（执行+IPC推送）解耦清晰，权限决策有 TTL 防漂移
7. **unsubscribe 模式**：所有 subscribe 函数返回 unsubscribe，[ipc-bridge.ts#L78-L80](file:///src/preload/utils/ipc-bridge.ts) 精确移除监听器避免内存泄漏

---

**统计摘要**：18 个服务实例（16 服务 + ToolRegistry/ToolExecutor 2 核心组件） / 16 个 IPC 域 / 74 个 channel（59 invoke + 15 push）/ 16 个 IPC handler 文件 / 4 层进程隔离。

---

# 附录 A：现状详述——进程模型、分层与目录（自 code-wiki 01 合并，2026-10-12）

> 代码实然现状的细化快照，与上文"应然"设计互补；数字随代码演进会过时，以仓库现状为准。

## A.1 进程模型（Electron 三进程）

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer（React，沙箱 sandbox:true, nodeIntegration:false）  │
│   路由 / 组件 / stores / hooks ── window.api.* 白名单        │
└──────────────────────────────┬───────────────────────────────┘
                               │ IPC（类型安全契约，见 19 号）
┌──────────────────────────────┼───────────────────────────────┐
│ Preload（CJS，contextBridge）│  createIpcApi(IPC_META)        │
└──────────────────────────────┼───────────────────────────────┘
                               │ ipcRenderer.invoke / on
┌──────────────────────────────┴───────────────────────────────┐
│ Main（Node.js）                                               │
│   ServiceContainer ── 20 个 accessor 服务（懒加载 + 反向依赖  │
│   dispose；Agent/Session/File/Search/Terminal/Git/Codebase/  │
│   ToolRegistry+ToolExecutor/Permission/MCP/Prompt/MemoryPort+│
│   MemoryHub/LSP/Goal/IM/RemoteControl/BrowserPreview/Update）│
│   llmClient 与 cronService、agentAskService 同为模块级单例，  │
│   非 accessor（cronService.stop() 在 dispose 链首位）         │
│   遥测为 OTel 单通道基建（非 accessor）                        │
└───────────────────────────────────────────────────────────────┘
```

- **Renderer**：纯前端，无 Node 权限，只能调用 preload 暴露的 `window.api.*`。
- **Preload**：`contextBridge.exposeInMainWorld('api', api)`，由定义表 `IPC_META` 自动生成，零手写。
- **Main**：所有真实能力（文件、搜索、终端、数据库、LLM、工具执行）都在此。`ServiceContainer` 统一管理单例生命周期。

## A.2 分层架构

```
┌───────────────────────────────────────────────┐
│ packages/shared   IPC 类型契约 + zod schema   │ ← 单一真源
├───────────────────────────────────────────────┤
│ src/preload       window.api 桥接（CJS, sandbox）│
├───────────────────────────────────────────────┤
│ src/main/ipc      Handler 层（定义表驱动注册）  │
├───────────────────────────────────────────────┤
│ src/main/infra    领域服务（AI/文件/搜索/终端/…）│
│ src/main/security 安全基线（CSP/权限）          │
│ src/main/utils    基础设施（logger/wrap/…）     │
├───────────────────────────────────────────────┤
│ src/renderer      React 渲染层                 │
└───────────────────────────────────────────────┘
```

依赖方向：`renderer → shared(类型)`；`preload → shared(meta)`；`handler → infra 服务`；`infra → shared(schema)`。
**不变量**：`infra` 不得反向依赖 `ipc`；`shared` 不依赖任何运行时大包（zod 通过子路径隔离，避免拖进 preload）。

## A.3 目录结构（仓库根）

```
src/main/          主进程（service-container + infra 服务 + ipc handlers）
  infra/ai/        Agent / Agent-Runtime / LLM 客户端 / Providers / Prompt / cron / 工具 / MCP / Models / Skills / Knowledge
  infra/autostart/ 开机自启（OS 登录项）
  infra/browser/   WebContentsView 浏览器预览（独立 session 分区）
  infra/code-analysis/    代码分析器
  infra/codebase/  codegraph CLI 封装（代码智能查询）
  infra/file/      文件读写 + chokidar 监听
  infra/git/       Git 操作封装（simple-git）
  infra/i18n/      主进程轻量 i18n（工具文案）
  infra/im/        即时通讯渠道适配器（Telegram/钉钉/微信/企微/飞书/QQ/webhook）
  infra/invalidation/ 写路径声明式失效域（IPC 变更后自动失效渲染层 Query）
  infra/lsp/       LSP 客户端 + 语言服务器管理器
  infra/memory-hub/ 记忆引擎 sidecar（上游 TencentDB-Agent-Memory，MemoryPort/capture-wire）
  infra/network/   代理接缝（proxiedFetch，34 号）
  infra/remote/    远程控制（局域网配对）
  infra/search/    ripgrep 搜索（grep/glob）
  infra/storage/   SQLite + Drizzle + keychain + 偏好持久化
  infra/telemetry/ OTel 单通道 + 事件循环延迟监控
  infra/terminal/  node-pty 终端会话池
  infra/update/    自动更新（electron-updater）
  ipc/             各域 handler（定义表驱动注册）
  security/        CSP（security/csp.ts）
  utils/           logger / wrap / window-state / emit-event / error-report
  index.ts         主进程入口
  service-container.ts  统一服务生命周期（20 accessor + dispose 链）
  根级桌面集成：window.ts / tray.ts / deep-link.ts / notification.ts / theme-linkage
src/preload/       contextBridge 桥（index.ts + utils/create-api.ts / utils/ipc-bridge.ts）
src/renderer/      React 层（routes / components / hooks / stores / lib / providers / i18n / styles）
packages/shared/   IPC 契约 + zod schema（单一真源；constants / ipc / schemas 按进程拆出口）
packages/memory-engine/  vendored 记忆引擎上游源码（utilityProcess sidecar，integrity 门禁）
packages/tsconfig/ base / node / web 三档 tsconfig
e2e/               Playwright 三套配置（E2E / Electron / Smoke）+ 视觉/性能/可访问性
scripts/           工程脚本（scaffold / check-* / build-tokens）
docs/design/       设计文档（常态化维护，见其 README.md）；docs/implementation/ 实施记录
```

`infra/ai/` 是最大的一块，拆分 `agent / agent-runtime / llm-client / mcp / models / prompt / providers / skills / tools / knowledge / middleware` 多个关注点。

## A.4 关键架构决策（ADR 摘要）

| 决策 | 说明 |
|---|---|
| **类型契约单一真源** | `packages/shared` 定义 `IpcApi` 接口 + channel 常量 + zod schema。preload 用 `satisfies IpcApi` 编译期校验形状；主进程 handler 用 zod 校验入参。改一处全仓同步。 |
| **定义表驱动的 IPC + 编译期双向 parity** | `IPC_META`（纯字符串，preload 安全导入）→ `IPC_DEFINITIONS`（+schema）→ 推导 `IpcApi`。两处用 TS 类型相等检查保证 `meta ⊆ definitions ⊆ meta`，任何一侧多写方法都会编译失败。 |
| **ServiceContainer 单例 + 延迟初始化** | 所有服务懒加载 + 可注入（测试用 `setXxxService`）。dispose 严格按反向依赖顺序（见附录 B §2.3）逐步骤 try/catch 隔离。 |
| **StreamText 请求级重试** | 重试边界 = 首个真实内容事件（非空 delta / tool-call 等）——边界前结构事件缓冲为 prelude 重试时回注；边界后断流由 agent 层从对话锚点续写恢复，避免重复工具副作用。 |
| **plan / build 双模式** | plan 模式按工具类别判定：零副作用类别（`read` 读数据 / `control` 与用户或内部状态交互，经 `isZeroSideEffectTool` 判定）→ auto，其余（edit/exec）→ deny（零副作用只读探索；另有显式逃生舱名单 `PLAN_MODE_CONTROL_TOOLS`，现仅 save_memory——它有持久化副作用，不属零副作用，防计划期不可用）；build 模式写操作走审批流。子代理继承同一 PermissionService（plan 模式下子代理写工具同样被拒）。 |
| **前端 mock 层保留** | 渲染层 `dev/mock-api.ts` 在浏览器 dev 模式（`pnpm dev:web`）提供 `window.api` 全链路模拟，前端可独立于主进程开发；E2E 浏览器模式同走此层。不用 MSW——它拦截 HTTP，本项目 mock 的是 IPC 桥（裁决见 20 号）。 |
| **状态管理分工** | IPC `invoke` 的 server state 用 TanStack Query（缓存 + 去重 + 失效）；IPC `on` 推送事件用 Zustand（流式 part / tool progress / file-tree）。**铁律：不要把流式事件塞进 Query。** |
| **安全基线严格** | `sandbox:true` + `contextIsolation:true` + 自定义 CSP 注入 + 拒绝所有 Web 权限请求 + 导航/新窗口白名单（见附录 B §3）。 |
| **非必要不自研** | 能在 Vercel AI SDK / 成熟第三方包基础上实现的不自己造轮子（复用 AI SDK streamText、simple-git、codegraph CLI 等）。 |

## A.5 数据与事件流（一条消息的旅程）

```
用户输入 → renderer ChatInput
  → useAgentBridge(AI) invokes `agent:run` (window.api)
  → Main: agent.handler → ServiceContainer.getAgentService().startAgent()
  → AgentService 构造回合 → llmClient(Provider) → AI SDK streamText
  → stream part 经 streamReader/turnRunner 翻译成 TurnEvent
  → 遇到工具调用 → ToolRegistry.toAISDKTools 的 executeHook → ToolExecutor.execute
       → PermissionService 审批决策 → 推送 agent:tool:call 事件 → 渲染层审批卡
       → 用户批准 → 执行 `tool.execute` → 结果回填 → 进入下一轮 (stopWhen)
  → 全部结束后推送 agent:stream:end，渲染层收尾并失效 Query 刷新会话列表
```

核心"多轮循环"由 AI SDK `streamText` 的 `tools` + `stopWhen` 驱动，服务端在 `turn-runner` 里持续读流直到无更多工具调用或达到终止条件。

## A.6 质量基线快照（2026-09-30 实测）

`pnpm typecheck` 0 错误 / `pnpm lint` 0 问题 / 单元测试全绿——shared 110 + main 2135（另 8 平台相关 skip）+ renderer 1845 + integration 152 + scripts 364；测试文件 406 个（含 e2e）。数字随代码演进会过时，以 `pnpm test` 现跑结果为准。

## A.7 参考

- `02-tech-stack.md`、`03-directory-structure.md`、`19-ipc-spec.md`、`22-ai-tool-spec.md`（本目录）。

---

# 附录 B：主进程入口与生命周期（自 code-wiki 02 合并，2026-10-12）

> 覆盖：`src/main/index.ts` 启动链、`ServiceContainer` 生命周期、进程安全基线、窗口创建。

## B.1 入口 `src/main/index.ts`

### B.1.1 启动阶段顺序（`app.whenReady()` 链）

```
whenReady
 ├─ 单实例锁（requestSingleInstanceLock；失败则 quit；whenReady 内再查 gotTheLock 双保险）
 ├─ initLogger()           初始化 electron-log（需要 app.getPath，必须在 whenReady 后）
 ├─ initTelemetry()        初始化 OpenTelemetry（遥测级别 off→跳过；无 endpoint 退化为 Console）
 ├─ initDb()               SQLite（建表幂等 + WAL + 外键 + 备份轮转 + 损坏自愈）
 ├─ initMainI18n()         主进程 i18n（读 app_settings language 域，缺失回退 zh-CN）
 ├─ applyProxyChange()     34 号：代理配置启动应用（在 initDb 后、IM 渠道前；fire-and-forget 失败仅 warn）
 ├─ promptService.initialize()  幂等插入默认 Code Agent prompt（onConflictDoNothing）
 ├─ registerGlobalErrorHandlers()
 ├─ recoverFromCrash()     无条件执行：残留 running 会话标 interrupted + 残留 running 任务标
 │                         failed + 清崩溃标记（崩溃标记只影响日志口径，不门控恢复本身）
 ├─ pruneExpiredUsage()    清理 90 天窗口外的 token_usage（与用量页查询窗口对齐）
 ├─ initRuntimeModels()    自定义模型注册到 ModelRegistry（LLM 调用前）
 ├─ skillRegistry.loadFromRows(new LearnSkillService(llmClient).listLearned())  已学技能合并
 ├─ serviceContainer.initImChannels()  已配置 IM 渠道自动连接（含 IM→Agent 桥接挂载；
 │                         初始化 Promise 存入 imChannelsInit，退出时先等它落定再 stopAll）
 ├─ serviceContainer.initSubagents()   run_subagent 工具依赖
 ├─ mountTurnNotifications / mountApprovalNotifications  系统通知（后台回合 + 审批等待）
 ├─ initCronScheduler()    定时任务调度接线（须在 initDb 之后）
 ├─ registerIpcHandlers({...域 handler})   定义表驱动，缺失编译期报错
 ├─ updateService.start()  注册 autoUpdater 事件（devUpdateEnabled 需 CODE_AGENT_DEV_UPDATE=1）
 ├─ 注入 CSP 响应头（applyCspToSession）+ 权限请求默认拒绝
 ├─ startMemoryMonitor()   主进程内存泄漏哨兵（60s 采样）
 ├─ EventLoopLagMonitor    事件循环延迟监控（活跃回合上下文报告，见 lag-alert）
 └─ createWindow() + createTray()   主窗口 + 托盘（deep-link 冷启动 URL 从 argv 补捞）
```

关窗协商在 window.ts close handler 与 before-quit 双路径共享 `isCloseConfirmed` 标志（`CODE_AGENT_SKIP_CLOSE_GUARD=1` 豁免）；运行中回合弹确认。

### B.1.2 单实例锁

- `app.requestSingleInstanceLock()` 失败 → 立即 `app.quit()`（不初始化任何服务）。
- `second-instance` 事件：聚焦/还原已有主窗口。

### B.1.3 环境与 userData

- **dev 模式**：`userData` 重定向到项目内 `.electron-user-data/`（可用 `CODE_AGENT_USER_DATA` 覆盖，多实例隔离避免 SQLite 锁冲突）；开启 `remote-debugging-port`（默认 9222，`CODE_AGENT_DEBUG_PORT` 可覆盖，供 CDP 直连调试）。
- **生产**：使用系统默认 `%APPDATA%/<AppName>`。
- `.env`：dev 通过 Node 内置 `process.loadEnvFile()` 加载（NODE_ENV=test 跳过）。

### B.1.4 退出清理（`before-quit`）

运行中回合先协商（确认弹窗，`isCloseConfirmed` 与窗口 close 路径共享标志）→ `preventDefault` + `setQuitting()` → 停 lagMonitor/内存监控 → 等 `imChannelsInit` 落定（3s 超时兜底）→ `disposeImChannels()` → `disposeServices()`（含 closeDb，`pendingBackup` 机制等待在途备份落地）→ `shutdownTelemetry()`（flush span）→ `runDeferredInstall()`（Windows 更新：应用完全退出后再拉起安装器，消除 NSIS「无法关闭」竞态）→ `app.exit(0)`。清理失败仅记日志不阻断退出。

### B.1.5 错误兜底

`whenReady().catch` 捕获启动链任何同步抛错 → `console.error` + `dialog.showErrorBox` + `app.exit(1)`。

## B.2 服务生命周期 `src/main/service-container.ts`

### B.2.1 单例模式

```ts
export const serviceContainer = new ServiceContainer();
serviceContainer.getAgentService();        // get 惰性初始化
serviceContainer.setAgentService(mock | null);  // 仅测试用注入
```

每个服务都遵循 "get 惰性 + set 注入 + dispose 反向依赖" 三段式。工具系统三件套 `ToolRegistry / PermissionService / ToolExecutor` 由容器直接 `new`（非模块级单例）。

### B.2.2 关键 getter 与依赖注入

| getter | 初始化依赖 | 备注 |
|---|---|---|
| `getPromptService()` | gitSummaryProvider 闭包（动态上下文取真实 git 值） | DB 模板 + `{{gitBranch}}`/`{{gitStatus}}`/`{{agentsMd}}` 注入 |
| `getAgentService()` | ToolRegistry + ToolExecutor + PromptService + SessionService + llmClient（标题生成 + repairToolCall 工具入参修复）+ gate + PermissionService | 通过 `ToolRegistry.toAISDKTools` 注入 `executeHook`（=ToolExecutor.execute） |
| `getToolRegistry()` | FileService + SearchService + TerminalService + GitService + MemoryPort（memory-hub）+ LspManager + agentAskService + PermissionService + CodebaseService | 首次访问注册 34 个内置工具（tools/index.ts 为清单真源） |
| `getPermissionService()` | CommandClassifier(llmClient) + 启动时 `readApprovalModeSync()` | 控制写操作审批 |
| `getMcpService()` | ToolRegistry | stopAll 关闭 MCP server 子进程 |
| `getMemoryPort()` | MemoryHubService（懒启动 sidecar） | save_memory / recall_memory 工具注册期即可用，首次调用启动引擎 |
| `getMemoryHubService()` | memory-hub sidecar（上游 TencentDB-Agent-Memory） | 未配置 hubRoot 时内部降级为空实现（记忆静默不可用） |
| `getCodebaseService()/getFileService()/...` | 各自模块单例 | 惰性包装 |
| `getGoalService()` | AgentService + GoalJudge(llmClient) | mount 回合监听 |
| `getImService()` | AgentService + PermissionService + SessionService（经 ImAgentBridge） | mount IM→Agent 桥 |
| `getLspManager()` | 首次工具调用才创建（读 app_settings `lsp.serverCommands` 覆盖） | 懒加载 |

### B.2.3 dispose() 顺序（反向依赖，每步 try/catch 隔离）

```
cronService.stop（最先：fire 会触发 agent 回合，防半拆解容器再起新回合）
→ goalService.unmount → imBridge.unmount → imService.stopAll（先停回合依赖方，
  drain 窗口内到达的 IM/远程命令不得再发起新回合）
→ remoteControl.release → agentService.dispose（drain：等活跃 stream 进入
  finally，3s 超时兜底）→ markInterruptedOnShutdown（退出善后：残留 running
  标 interrupted，消除「干净退出留 stale running」窗口）
→ mcpService.stopAll → lspManager.disposeAll（S14 修复：移到 agent drain 后，
  drain 窗口内 LSP 工具调用仍可用）
→ permissionService.dispose（含清空 ToolExecutor/ToolRegistry 引用）
→ agentAskService.dispose → fileService.dispose（chokidar watcher）
→ searchService.dispose（ripgrep 子进程）→ terminalService.dispose（pty）
→ gitService / codebaseService.dispose → sessionService.dispose（不关 db）
→ memoryHub.stop（sidecar 子进程）→ updateService.dispose → browserPreview.dispose
→ resetAIProvider → closeDb（最后）
```

实测以 `src/main/service-container.ts` 的 `dispose()` 步骤注释为准（步骤号 1.8→11.5，2026-09-30 核对）：

- `runStep` 独立 try/catch：单步失败不跳过后续，`failures[]` 汇总记录。
- 退出路径整体顺序（index.ts before-quit）：lagMonitor/内存监控先停 → 等 imChannelsInit 落定（3s 超时兜底）→ disposeImChannels → disposeServices → shutdownTelemetry（flush span）→ runDeferredInstall（Windows 更新安装器拉起）→ app.exit(0)。

### B.2.4 reset()（测试用）

与 dispose 不同：**不调用外部服务的 dispose**，仅清空引用并 fire-and-forget 停 MCP/IM，最后 `resetDb()` + `resetConfigCache()`。

### B.2.5 崩溃恢复 `recoverFromCrash()`

启动期**无条件执行**（不依赖崩溃标记——标记只影响日志口径）：`markAllInterrupted()`（残留 running 会话 → interrupted）+ `taskService.markAllRunningFailed()`（残留 running 任务 → failed，2026-09-08 修复）→ `clearCrashMarker()`。与退出善后 `markInterruptedOnShutdown` 首尾呼应：外部工具/备份脚本读到的会话状态一律是终态。

### B.2.6 导出别名

`disposeServices()` / `resetServices()` / `initRuntimeModels()` 兼容旧 API，委托给 `serviceContainer`。

## B.3 窗口创建与安全基线（`createWindow`）

### B.3.1 BrowserWindow 配置

- 宽高恢复（`window-state.json`，校验不可见时回退 1280×800），`minWidth:960` / `minHeight:640`，`minWidth` 保证聊天输入区可见。
- 无边框标题栏：`titleBarStyle:'hidden'`；非 macOS 用 `titleBarOverlay`（透明底 + `symbolColor:#a8a29e` + 高度 52px）。
- **webPreferences**：`preload: ../preload/index.cjs`、`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`webSecurity:true`。

### B.3.2 导航/弹窗限制

- `will-navigate`：仅允许 `http://localhost` 与 `app://`，其余 `preventDefault`。
- `setWindowOpenHandler`：`http` 链接走 `shell.openExternal`，统一 `deny` 新窗口。

### B.3.3 运行时安全

- **CSP**：`applyCspToSession` 唯一注入入口（CSP / `X-Content-Type-Options: nosniff` / `X-Frame-Options` 三头一并），生产严格 / 开发宽松（允许 HMR）。跳过 `chrome-extension://` 协议响应（避免与 React DevTools 扩展自身 CSP 冲突）。
- **权限请求**：`setPermissionRequestHandler` 默认拒绝所有（摄像头/麦克风/地理位置/通知等），显式拒绝 + 日志（拒绝而非忽略，避免 Electron 默认放行）。
- **内存监控**：60s 采样，连续 3 次单调增长且累计 > 150MB 才告警（防 GC 抖动误报）；事件循环延迟监控（EventLoopLagMonitor）按活跃回合上下文报告。

### B.3.4 静默启动与唤回

开机自启（Windows/Linux 登录项携带 `--hidden` 参数；macOS 走 `wasOpenedAtLogin` 判定——ServiceManagement 不透传 args）→ `startHidden` 不显示窗口。唤回唯一实现 `window-show.ts`（show + 首次唤回应用挂起的 maximize——直接 maximize 会隐式显示窗口导致 --hidden 失效，2026-09-21 真机实测教训；三份副本曾不一致致托盘驻留后唤不回，已收敛单点）。

### B.3.5 开发辅助

dev 环境自动 `installExtension(REACT_DEVELOPER_TOOLS)`（失败容忍）+ `openDevTools({mode:'detach'})`（生产不触发）。

### B.3.6 macOS 行为

- `activate` 时无窗口则 `createWindow`（经 window-show 单点）。
- `window-all-closed`：非 darwin 才 `app.quit()`。

## B.4 遥测初始化

| 组件 | 说明 |
|---|---|
| OpenTelemetry | `initTelemetry()` whenReady 后；采集 agent.streamText / tool.execute / IPC 业务 span；遥测级别 off→跳过初始化；无 `OTEL_EXPORTER_OTLP_ENDPOINT` 退化为 Console |

> 错误处理为本地优先（2026-09-13 移除 Sentry）：异常经 `src/main/utils/error-report.ts` 单一出口落本地日志（渲染层经 electron-log 转发主进程，随诊断包导出）。

## B.5 关键文件清单

| 文件 | 职责 |
|---|---|
| `src/main/index.ts` | 主进程入口、生命周期、窗口、安全 |
| `src/main/service-container.ts` | 服务单例 + 生命周期（20 accessor + dispose 链 + recoverFromCrash） |
| `src/main/config/index.ts` | AppConfig（环境配置读取） |
| `src/main/security/csp.ts` | 安全响应头唯一注入入口（CSP/nosniff/XFO） |
| `src/main/utils/logger.ts` | electron-log + 全局错误处理 + 崩溃标记 |
| `src/main/utils/window-state.ts` | 窗口尺寸状态记忆 |
| `src/main/window.ts` | 窗口创建/close 协商/静默启动（根级） |
| `src/main/quit-state.ts` | 退出标志进程级单点（isQuitting/isCloseConfirmed 双路径共享） |
| `src/main/window-show.ts` | 窗口唤回唯一实现（托盘/通知/桌面图标共用） |
| `src/main/infra/autostart/autostart.ts` | 开机自启（OS 登录项，托盘与设置页同源） |
