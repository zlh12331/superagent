# 架构设计文档

> 基于 `code-agent-desktop` v1.0.0 实际代码整理。所有结论均来自源码，未做主观推断。
> 整理时间：2026-07-23（服务清单 2026-08-11 同步）

## 1. 整体分层架构

项目为 **Electron + Vite + React 19 + Vercel AI SDK v7** 桌面 AI Agent 应用，采用四层进程隔离架构。

| 层级 | 入口文件 | 职责 |
|---|---|---|
| main | [src/main/index.ts](file:///src/main/index.ts) | Electron 主进程入口：窗口创建、Sentry/Logger/SQLite 初始化、CSP 注入、IPC handler 注册、退出清理 |
| renderer | [src/renderer/main.tsx](file:///src/renderer/main.tsx) | React 19 渲染层入口：Router + Providers |
| preload | [src/preload/index.ts](file:///src/preload/index.ts) | contextBridge 暴露 `window.api`（16 个域，由 `createIpcApi(IPC_META)` 自动生成），sandbox + contextIsolation |
| shared | [packages/shared/src/index.ts](file:///packages/shared/src/index.ts) | 跨进程共享包 `@code-agent/shared`：错误码、IPC 类型契约、Zod schemas |

### 主进程安全基线

[src/main/index.ts#L143-L150](file:///src/main/index.ts#L143) 配置：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`

preload 输出为 `.cjs`（[electron.vite.config.ts#L30-L44](file:///electron.vite.config.ts#L30)），强制 CJS 以兼容 sandbox 限制。

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

设计依据：[L12-L42](file:///src/main/service-container.ts#L12) 注释说明 dispose 严格按反向依赖顺序，db 必须最后关闭避免 SessionService 访问已关闭连接。每个服务的 dispose 都有 3 秒超时兜底避免 hang 死。

### 2.3 reset 函数（测试场景）

[L707-L735](file:///src/main/service-container.ts#L707)：仅清空缓存引用与模块级单例（`resetChatService` / `resetFileService` / `resetSearchService` / `resetTerminalService` / `resetGitService` / `resetCodebaseService` / `resetSessionService` / `resetAIProvider` / `resetDb` / `resetConfigCache`），**不调用 dispose**（不停止外部服务）。供测试用例隔离使用，与 `setXxxService(null)` 配套。

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

- `invoke<T>(channel, input?)`：返回 `Promise<IpcResponse<T>>`（成功 `{data}` / 失败 `{error}` 判别联合）。每次调用自动生成 `crypto.randomUUID()` 作为 traceId，作为第三个参数传入主进程 `ipcMain.handle`（[L33-L41](file:///src/preload/utils/ipc-bridge.ts#L33)）
- `subscribe<T>(channel, callback)`：包装 `ipcRenderer.on`，吞掉 `IpcRendererEvent`，返回 unsubscribe 函数（[L69-L81](file:///src/preload/utils/ipc-bridge.ts#L69)）

## 4. 进程通信模型

### 4.1 请求-响应 vs 推送分布

- **请求-响应（invoke）**：59 个 channel（80%）
- **推送（on）**：15 个 channel（20%）

### 4.2 流式推送机制

唯一流式通道（chat 域已随死链路清理删除，统一走 agent）：

**agent:stream:part** — [agent-service.ts#L310-L335](file:///src/main/infra/ai/agent/agent-service.ts#L310)
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
- dispose 模式（3s 超时兜底的 Promise.race + Promise.allSettled，[agent-service.ts#L182-L217](file:///src/main/infra/ai/agent/agent-service.ts#L182)）

### 5.2 工具系统三层分层

| 层 | 文件 | 职责 |
|---|---|---|
| ToolRegistry | [tool-registry.ts](file:///src/main/infra/ai/tools/tool-registry.ts) | 注册/查找/列出工具，`toAISDKTools(ctx, executeHook)` 转换为 AI SDK v7 原生 Tool |
| ToolExecutor | [tool-executor.ts](file:///src/main/infra/ai/tools/tool-executor.ts) | 统一执行入口：查找工具 → 权限决策 → 推送 AGENT_TOOL_CALL → 审批等待 → 执行 → 推送 AGENT_TOOL_RESULT |
| PermissionService | [permission-service.ts](file:///src/main/infra/ai/tools/permission-service.ts) | 权限决策（`'auto' \| 'ask'` 二态）+ 审批 Promise Map + 5 分钟记忆决策缓存 |

权限模型实际为二态 `'auto' \| 'ask'`（[tool.ts#L72](file:///src/main/infra/ai/tools/tool.ts#L72)），无 `'deny'` 态。

### 5.3 PromptService 角色

文件：[src/main/infra/ai/prompt/prompt-service.ts](file:///src/main/infra/ai/prompt/prompt-service.ts)

职责：

1. **默认 prompt 初始化**：`initialize()` 幂等插入 `DEFAULT_CODE_AGENT_PROMPT` 到 SQLite `prompts` 表，`onConflictDoNothing` 保护用户编辑
2. **数据库 CRUD**：`getPrompt(id)` 从 SQLite 读取
3. **动态上下文注入**：`resolvePrompt(id, workingDir)` 每次调用重新收集环境信息，返回 `{ content, source }`
4. **失败回退**：DB 读取失败时回退到 [default-prompt.ts](file:///src/main/infra/ai/prompt/default-prompt.ts) 硬编码默认值

依赖注入：`PromptServiceOptions` 支持 `gitSummaryProvider` 注入（[dynamic-context.ts](file:///src/main/infra/ai/prompt/dynamic-context.ts) 定义 `GitSummaryProvider` 类型）。ServiceContainer 创建 `PromptService` 时经 `gitSummaryProviderFrom(gitService.status)` 注入：`{{gitBranch}}` / `{{gitStatus}}` 为真实值；非 git 仓库或查询失败时由 `injectDynamicContext` 兜底为占位符。

## 6. traceId 贯穿机制

1. 渲染层 `invoke` 调用 [src/preload/utils/ipc-bridge.ts#L36-L40](file:///src/preload/utils/ipc-bridge.ts#L36)：`crypto.randomUUID()` 生成 traceId，作为第三个参数传入 `ipcRenderer.invoke`
2. 主进程 `wrap` [src/main/utils/wrap.ts#L48-L51](file:///src/main/utils/wrap.ts#L48)：`const traceId = incomingTraceId ?? randomUUID()`，构造 `IpcHandlerContext { traceId, sender }` 传给业务 handler
3. 日志贯穿：`LogContext` 接口 [logger.ts#L20-L27](file:///src/main/utils/logger.ts#L20) 含 `traceId?` 字段
4. Sentry 上报：wrap.ts catch 中带 traceId 上下文上报 Sentry
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
4. **沙箱友好的 preload 设计**：子路径导入 `@code-agent/shared/ipc/meta` 避免 zod 拉进 CJS 产物（[preload/index.ts#L27](file:///src/preload/index.ts#L27)），使用全局 `crypto.randomUUID()` 替代 node:crypto
5. **AI SDK v7 适配**：使用新 API `stopWhen: isStepCount(n)` 替代旧 `maxSteps`，`allowSystemInMessages: true` 显式兼容旧消息历史
6. **三层工具系统**：ToolRegistry（注册）/ PermissionService（决策+审批+5分钟记忆）/ ToolExecutor（执行+IPC推送）解耦清晰，权限决策有 TTL 防漂移
7. **unsubscribe 模式**：所有 subscribe 函数返回 unsubscribe，[ipc-bridge.ts#L78-L80](file:///src/preload/utils/ipc-bridge.ts#L78) 精确移除监听器避免内存泄漏

---

**统计摘要**：18 个服务实例（16 服务 + ToolRegistry/ToolExecutor 2 核心组件） / 16 个 IPC 域 / 74 个 channel（59 invoke + 15 push）/ 16 个 IPC handler 文件 / 4 层进程隔离。
