# 05 · 功能设计文档

> 本文档基于源码梳理 Code Agent 桌面应用的功能边界与各子系统的运行流程。
> 所有结论均来自项目实际代码，不做主观推断。

## 1. 功能总览

Code Agent 的核心能力链路：**用户消息 → 主进程 AgentService → AI SDK streamText 多轮工具调用循环 → IPC 流式推送 → 渲染层 UI 渲染**。

围绕这条主线，项目提供以下子系统：

| # | 子系统 | 实现位置 | 核心能力 |
|---|--------|---------|---------|
| 1 | AI Agent 核心 | [agent-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/agent/agent-service.ts) | 多轮工具调用循环、流式响应、中断控制 |
| 2 | 纯对话 Chat | [chat-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/agent/chat-service.ts) | 不带工具的流式响应 |
| 3 | 工具系统 | [tools/index.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/index.ts) + [tool-executor.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/tool-executor.ts) + [permission-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/permission-service.ts) | 12 个内置工具 + 权限审批 + IPC 推送 |
| 4 | MCP 集成 | [mcp/mcp-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-service.ts) | stdio transport 多 server 管理 |
| 5 | 会话管理 | [session-service.ts](file:///f:/TraeProjects/1/src/main/infra/storage/session-service.ts) | DB 持久化会话历史 |
| 6 | 代码理解 | [codebase-service.ts](file:///f:/TraeProjects/1/src/main/infra/codebase/codebase-service.ts) | 调用 codegraph CLI 做符号检索 |
| 7 | 终端集成 | [terminal-service.ts](file:///f:/TraeProjects/1/src/main/infra/terminal/terminal-service.ts) | node-pty 多终端会话 |
| 8 | 文件服务 | [file-service.ts](file:///f:/TraeProjects/1/src/main/infra/file/file-service.ts) | 文件读写 + chokidar 监听 |
| 9 | Prompt 系统 | [prompt/prompt-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/prompt/prompt-service.ts) | DB 模板 + 动态上下文注入 |
| 10 | 可观测性 | [utils/logger.ts](file:///f:/TraeProjects/1/src/main/utils/logger.ts) + [telemetry/otel.ts](file:///f:/TraeProjects/1/src/main/infra/telemetry/otel.ts) + [AppErrorBoundary.tsx](file:///f:/TraeProjects/1/src/renderer/components/common/AppErrorBoundary.tsx) | electron-log + OTel + Sentry 三层 |
| 11 | DevPanel | [DevPanel.tsx](file:///f:/TraeProjects/1/src/renderer/components/layout/DevPanel.tsx) | 应用内诊断面板 |
| 12 | i18n | [i18n/](file:///f:/TraeProjects/1/src/renderer/i18n) | 中英双语 |
| 13 | 目标系统 | [goal-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/knowledge/goal-service.ts) | 目标驱动会话（GoalJudge LLM 判定） |
| 14 | IM 接入 | [im-service.ts](file:///f:/TraeProjects/1/src/main/infra/im/im-service.ts) | 飞书/企微消息桥接（ImAgentBridge） |
| 15 | 记忆系统 | [memory-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/knowledge/memory-service.ts) | 知识记忆 recall/store/dream |

> 2026-08-11 同步：总览表由 12 行扩充至 15 行（新增目标/IM/记忆三系统）。前端交互侧另有对齐参考项目的功能集（侧边栏即时搜索 + 防抖高亮、⌘F 模糊搜索、目标编辑对话框、终端多标签、斜杠命令 /interrupt /goal、审批卡编辑重提/跳过、命令面板面板命令、快捷键体系 Ctrl+B/J、Ctrl+` 等，详见 09-ux-interaction-spec 与 10-component-design-spec）。

## 2. AI Agent 核心流程

### 2.1 流程概览

`AgentService.startAgent` 是整个应用的核心入口：

```
渲染层 agent:run invoke
  → ServiceContainer.getAgentService().startAgent(options)
    → 1. 生成 sessionId + 创建 AbortController 入 Map
    → 2. 解析 systemPrompt（调用方未传则 PromptService.resolvePrompt）
    → 3. 构造 ToolContext（workingDir / sessionId / abortSignal）
    → 4. toolRegistry.toAISDKTools(ctx, executeHook=ToolExecutor.execute)
    → 5. streamText({ model, messages, tools, stopWhen: isStepCount(maxSteps), abortSignal })
    → 6. result.toUIMessageStream().getReader() 循环 reader.read()
    → 7. 逐 part 通过 webContents.send(AGENT_STREAM_PART) 推送
    → 8. 流结束推送 AGENT_STREAM_END(reason='completed')
```

源码：[agent-service.ts#L164-L215](file:///f:/TraeProjects/1/src/main/infra/ai/agent/agent-service.ts#L164)（startAgent）、[agent-service.ts#L291-L530](file:///f:/TraeProjects/1/src/main/infra/ai/agent/agent-service.ts#L291)（streamToWebContents）。

### 2.2 关键设计

#### 多轮工具调用循环

使用 AI SDK v7 的 `streamText` + `tools` + `stopWhen` 组合实现自动多轮：

- `tools`：`Record<string, Tool>`，AI SDK 自动调用工具直到模型不再请求
- `stopWhen: isStepCount(maxSteps)`：v7 替代旧 `maxSteps`，限制工具调用轮数上限
- `maxSteps` 默认 20，上限 50，避免无限循环消耗 token

源码：[agent-service.ts#L423-L470](file:///f:/TraeProjects/1/src/main/infra/ai/agent/agent-service.ts#L423)（streamText + stopWhen 调用）。

#### executeHook 失败容忍

`executeHook` 注入 `ToolExecutor.execute` 作为权限检查 + 审批 + IPC 推送层。失败时不抛错，返回结构化错误对象 `{ error }` 给 LLM，让模型看到错误信息自行决策（重试 / 换工具 / 告知用户）。

源码：[agent-service.ts#L383-L414](file:///f:/TraeProjects/1/src/main/infra/ai/agent/agent-service.ts#L383)（executeHook 注入与失败容忍）。

#### 中断与生命周期

维护两个 Map：`activeSessions`（sessionId → AbortController）和 `activeStreams`（sessionId → Promise）。

- `abort(id)`：触发指定 session 的 abort 信号
- `abortAll()`：触发所有活跃 session 的 abort
- `dispose(timeoutMs=3000)`：abortAll + Promise.allSettled 等待所有 stream 完成，超时兜底

源码：[agent-service.ts#L218-L276](file:///f:/TraeProjects/1/src/main/infra/ai/agent/agent-service.ts#L218)（abort / abortAll / dispose）。

#### webContents 销毁守卫

流推送前检查 `webContents.isDestroyed()`，避免窗口关闭后继续推送导致异常。

源码：[agent-service.ts#L322-L347](file:///f:/TraeProjects/1/src/main/infra/ai/agent/agent-service.ts#L322)（回合事件推送前的 isDestroyed 守卫）、[agent-service.ts#L488](file:///f:/TraeProjects/1/src/main/infra/ai/agent/agent-service.ts#L488)（流推送循环内的守卫）。

### 2.3 与 ChatService 的差异

| 维度 | ChatService | AgentService |
|------|-------------|--------------|
| 工具调用 | 不带 tools | 带 tools + stopWhen 多轮循环 |
| 使用场景 | 纯对话 | Code Agent（文件/终端/Git 操作） |
| System Prompt | 不解析 | 默认 PromptService 解析（可被调用方覆盖） |
| 中断 | abort / abortAll / dispose | 一致 |
| 错误处理 | error-classifier 分类 | 一致 |

源码：[chat-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/agent/chat-service.ts)。

## 3. 工具系统

### 3.1 三层架构

```
ToolRegistry（注册）   ←─── MCPService（动态注册 MCP 工具）
       │
ToolExecutor（执行 + IPC 推送）
       │
PermissionService（权限决策 + 审批）
```

### 3.2 内置工具清单（12 个）

[tools/index.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/index.ts) 的 `registerBuiltinTools` 注册：

| 工具名 | 权限 | 依赖 | 说明 |
|--------|------|------|------|
| `read_file` | auto | IFileService | 读文件内容 |
| `write_file` | ask | IFileService | 写文件 |
| `list_directory` | auto | IFileService | 列目录 |
| `code_review` | auto | IFileService | 代码审查 |
| `grep` | auto | ISearchService | ripgrep 内容搜索 |
| `glob` | auto | ISearchService | glob 模式文件查找 |
| `terminal` | ask | ITerminalService | 终端会话操作 |
| `run_command` | ask | 无 | 子进程命令执行 |
| `edit_file` | ask | 无 | 基于 diff-match-patch 的文件编辑 |
| `git_add` | ask | IGitService | git 暂存改动 |
| `git_commit` | ask | IGitService | git 提交 |
| `git_push` | ask | IGitService | git 推送远程 |

源码：[tools/index.ts#L81-L100](file:///f:/TraeProjects/1/src/main/infra/ai/tools/index.ts#L81)（registerBuiltinTools 函数体）。

### 3.3 权限模型

**二态权限**：`'auto' | 'ask'`（不是三态 `'allow'|'ask'|'deny'`）。

源码：[tool.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/tool.ts)（Tool 接口 permission 字段）、[permission-service.ts#L38-L43](file:///f:/TraeProjects/1/src/main/infra/ai/tools/permission-service.ts#L38-L43)（PermissionDecision）。

#### 决策顺序（PermissionService.decide）

1. 检查记忆决策：若用户之前对同一 `tool + input` 组合选了"5 分钟内不再询问"且未过期，返回记忆结果
2. 否则返回 `tool.permission`

#### 记忆缓存

- key 格式：`${toolName}:${hash(input)}`，hash 用稳定 JSON 序列化后取 SHA-256 前 16 字节
- TTL：5 分钟（`REMEMBER_TTL_MS`）
- 过期后重新询问

源码：[permission-service.ts#L51-L59](file:///f:/TraeProjects/1/src/main/infra/ai/tools/permission-service.ts#L51-L59)。

### 3.4 工具执行流程（ToolExecutor.execute）

```
1. ToolRegistry.get(toolName) 查找工具 → 不存在返回 TOOL_NOT_FOUND
2. PermissionService.decide(tool, input) 决策权限
3. 推送 AGENT_TOOL_CALL 事件到渲染层
4. 若 permission='ask'：
   - 生成 approvalId
   - 推送 AGENT_APPROVAL_REQUEST
   - 等待 agent:approval:response 回传（5 分钟超时）
   - approved=false → 返回 TOOL_PERMISSION_DENIED
5. approved=true 或 permission='auto' → tool.execute(input, ctx)
6. 推送 AGENT_TOOL_RESULT 事件到渲染层
7. 返回 ToolResult（含 output 或 error）
```

源码：[tool-executor.ts#L95-L200](file:///f:/TraeProjects/1/src/main/infra/ai/tools/tool-executor.ts#L95)（execute 方法体）。

### 3.5 ToolContext

每次 agent 对话独立的上下文闭包，所有工具调用共享：

```typescript
interface ToolContext {
  workingDir: string;      // 工作目录约束（所有文件操作的根目录）
  sessionId: string;      // 关联 IPC 事件
  abortSignal: AbortSignal; // 中断信号
}
```

源码：[tool.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/tool.ts)。

### 3.6 路径守卫

所有文件操作工具都通过 `resolveWithinWorkspace(workingDir, targetPath)` 守卫，确保路径不会逃逸出 workingDir。

源码：[tools/path-guard.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/path-guard.ts)。

## 4. MCP 集成

### 4.1 实现范围

- **transport**：仅实现 stdio（不支持 sse / streamable-http）
- 多 server 管理：每个 server 一个独立子进程
- 工具命名空间：`mcp__{serverName}__{toolName}`

源码：[mcp/mcp-types.ts#L11-L12](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-types.ts#L11)（transport 类型定义）、[mcp/mcp-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-service.ts)。

### 4.2 与 ToolRegistry 的关系

MCPService 通过 `ToolRegistry.register` / `ToolRegistry.unregister` 动态管理 MCP 工具：

- server 启动后 → 列出工具 → 转换为 Tool 格式 → 注册到 Registry
- server 停止 → 注销对应工具

MCP 工具与内置工具共用同一套 ToolExecutor 执行路径（权限 + 审批 + IPC 推送）。

### 4.3 依赖

`@modelcontextprotocol/sdk@^1.30.0`（package.json dependencies）。

## 5. 会话管理

### 5.1 多方法组设计

SessionService 暴露多组方法：

- **IPC 暴露组**：`list` / `get` / `delete` / `rename` / `listRecentDirs` / `exportAll` / `getUsageSummary` / `getTurns` / `getRecentTurns`，由 IPC handler 调用
- **内部 API 组**：`create` / `appendMessage`，由 AgentService / ChatService 直接调用（不经过 IPC）
- **崩溃恢复组**：`markRunning` / `markIdle` / `markAllInterrupted`（回合状态机）
- **用量统计组**：`recordUsage`（agent/chat 回合结束时写入 token_usage 表）
- **Transcript 组**：`recordTurn`（回合结束后写入 turns 表）

源码：[session-service.ts](file:///f:/TraeProjects/1/src/main/infra/storage/session-service.ts)。

### 5.2 数据库表（6 张）

- `sessions`：id / title / createdAt / updatedAt / lastMessage / messageCount / workingDir / lastRunStatus
- `messages`：id / sessionId / seq / role / content / createdAt（外键 cascade 删除）
- `prompts`：id / name / description / role / content / isDefault / createdAt / updatedAt
- `token_usage`：id / sessionId / modelId / inputTokens / outputTokens / totalTokens / cacheReadTokens / reasoningTokens / createdAt
- `turns`：id / turnId / sessionId / seq / modelId / status / inputTokens / outputTokens / totalTokens / durationMs / createdAt
- `runtime_models`：modelId / providerKind / baseUrl / createdAt

源码：[storage/schema.ts](file:///f:/TraeProjects/1/src/main/infra/storage/schema.ts)。

### 5.3 消息存储格式

`messages.content` 存储为 `JSON.stringify(ChatMessage)`，读取时反序列化为 `unknown[]`，避免 AI SDK 类型泄露到 shared 包。

## 6. 代码理解

### 6.1 CodebaseService

通过调用 `codegraph` CLI 子进程实现符号检索：

- 每次调用 spawn 一个 codegraph 子进程，请求结束时退出
- 无外部资源需要 dispose

源码：[codebase-service.ts](file:///f:/TraeProjects/1/src/main/infra/codebase/codebase-service.ts)。

### 6.2 CodeGraph 依赖

外部依赖（用户级安装）：
- `@colbymchenry/codegraph` v0.9.8，全局 npm 安装
- 项目内通过 CLI 调用，不在 package.json dependencies 中

## 7. 终端集成

### 7.1 实现要点

- 基于 `node-pty@^1.1.0` 创建伪终端
- 多终端会话管理：每个终端会话独立 pty 进程
- dispose 时 kill 所有 pty 进程

源码：[terminal-service.ts](file:///f:/TraeProjects/1/src/main/infra/terminal/terminal-service.ts)。

### 7.2 渲染层

- 使用 `@xterm/xterm@^6.0.0` 渲染终端
- `@xterm/addon-fit` 自适应尺寸

源码：[TerminalPanel.tsx](file:///f:/TraeProjects/1/src/renderer/components/terminal/TerminalPanel.tsx)。

## 8. 文件服务

### 8.1 能力

- 文件读写
- 目录列举
- `chokidar@^5.0.0` 文件监听（dispose 时关闭所有 watcher）

源码：[file-service.ts](file:///f:/TraeProjects/1/src/main/infra/file/file-service.ts)。

## 9. Prompt 系统

### 9.1 三层架构

```
PromptService
  ├── 数据库层（prompts 表）
  ├── 默认 prompt（default-prompt.ts）
  └── 动态上下文注入（dynamic-context.ts）
```

### 9.2 解析流程（PromptService.resolvePrompt）

```
1. 从数据库读取 prompt 模板（id 默认 'code-agent'）
   - 失败 → 回退到硬编码 DEFAULT_CODE_AGENT_PROMPT
2. 收集动态上下文：
   - 当前 workingDir
   - git 状态（通过 GitSummaryProvider 注入）
   - AGENTS.md（如存在）
3. injectDynamicContext(template, context) → 完整 system prompt
4. 返回 ResolvedPrompt { content, source: 'database' | 'default-fallback' }
```

源码：[prompt-service.ts#L42-L79](file:///f:/TraeProjects/1/src/main/infra/ai/prompt/prompt-service.ts#L42-L79)。

### 9.3 GitSummaryProvider 注入

`GitSummaryProvider` 是定义在 [dynamic-context.ts](file:///f:/TraeProjects/1/src/main/infra/ai/prompt/dynamic-context.ts) 中的函数类型 `(workingDir: string) => Promise<GitSummary | null>`。PromptService 通过构造选项 `options.gitSummaryProvider` 接收，不直接依赖 `IGitService`，解耦具体 Git 实现。

> 注：项目中不存在独立的 `git-adapter.ts` 文件（`_template` 模板中有但未纳入实际项目）。`GitSummaryProvider` 由调用方（ServiceContainer）在构造 PromptService 时注入适配实现。

源码：[dynamic-context.ts#L42](file:///f:/TraeProjects/1/src/main/infra/ai/prompt/dynamic-context.ts#L42)（GitSummaryProvider 类型）、[prompt-service.ts#L68](file:///f:/TraeProjects/1/src/main/infra/ai/prompt/prompt-service.ts#L68)（PromptServiceOptions.gitSummaryProvider）。

## 10. 可观测性三层体系

### 10.1 三层职责分工

| 层 | 技术 | 职责 | 数据位置 |
|----|------|------|---------|
| 本地全量日志 | electron-log | 本地完整日志，供 DevPanel + 用户 bug report | `%APPDATA%/code-agent/logs/` |
| 业务 trace | OpenTelemetry | Code Agent 工具链路自定义 span | OTLP HTTP 上报 |
| 远程错误聚合 | Sentry | 远程错误聚合 + 性能追踪 + Session Replay | Sentry self-hosted v26.6.0 |

### 10.2 traceId 贯穿机制

```
渲染层 crypto.randomUUID() → IPC（ipc-bridge.ts 自动注入）→ 主进程日志 → Sentry → OTel span
```

### 10.3 关键文件

- 主进程 logger：[utils/logger.ts](file:///f:/TraeProjects/1/src/main/utils/logger.ts)
- OTel 入口：[telemetry/otel.ts](file:///f:/TraeProjects/1/src/main/infra/telemetry/otel.ts)
- Sentry 主进程初始化：[main/index.ts](file:///f:/TraeProjects/1/src/main/index.ts)（`initSentry()` 在 app.whenReady 前调用）
- Sentry 渲染层集成：[AppErrorBoundary.tsx](file:///f:/TraeProjects/1/src/renderer/components/common/AppErrorBoundary.tsx)（通过 `@sentry/electron/renderer` 的 `Sentry.captureException` 上报）

> 注：项目中不存在独立的 `src/renderer/instrumentation.ts` 文件（`_template` 模板中有但未纳入实际项目）。渲染层 Sentry 集成直接在 `AppErrorBoundary` 组件中完成。

### 10.4 三层不可替代关系

- electron-log：本地全量，DevPanel 与用户 bug report 依赖
- OTel：业务自定义 span，串联工具链路
- Sentry：远程聚合，跨设备/会话关联，性能追踪

通过 traceId 把三层串联。

## 11. DevPanel

### 11.1 定位

应用内嵌的诊断面板，提供 Logs / Metrics 等标签页查看运行态状态。

### 11.2 实现要点

- 渲染层组件：[DevPanel.tsx](file:///f:/TraeProjects/1/src/renderer/components/layout/DevPanel.tsx)
- 数据源：electron-log 通过 IPC 暴露给 DevPanel
- InspectorPanel 标签页：仅打开 Chromium DevTools，可能冗余

### 11.3 与 Chromium DevTools 的关系

- Chromium DevTools：浏览器原生调试工具，仅 dev mode 可用
- DevPanel：应用内嵌面板，prod 也可用
- 互补：DevTools 实时调试，DevPanel 生产诊断

## 12. i18n 国际化

### 12.1 实现

- `i18next@^26.3.6` + `react-i18next@^17.0.10` + `i18next-browser-languagedetector@^8.2.1`
- namespace 拆分：`common`（UI 文案）+ `errors`（错误码）
- 初始化顺序：`localStorage` → `navigator` language，结果持久化
- `react.useSuspense: false` 避免渲染阻塞

源码：[i18n/](file:///f:/TraeProjects/1/src/renderer/i18n)。

### 12.2 错误消息策略

`useErrorMessage` hook 实现 DRY：

1. 优先查 i18n resources
2. 回退到 `@code-agent/shared` 的 `ERROR_META.userMessage`

## 13. 渲染层架构补充

### 13.1 状态管理双栈

- **Zustand**：管理 IPC `on` 推送事件（chat:stream:part、file-tree:changed、tool:progress）
- **TanStack Query**：管理 IPC `invoke` 请求-响应（带缓存/失效/竞态处理）

### 13.2 关键交互模式

- Sidebar 导航用 `useNavigate` + 手动 `isActive` 样式（非 NavLink），因为点击 session item 需要同时 navigate + `setActiveSession`
- Radix DropdownMenuItem 用 `onSelect` + `setTimeout(0)` 可靠打开 Dialog（onClick 不可靠，会触发 pointerDownOutside 关闭）

## 14. 限制与已知缺口

### 14.1 未实现的能力

- **MCP transport**：仅 stdio，不支持 sse / streamable-http
- **MCP UI 管理**：无 server 启停/配置界面（仅服务端实现）
- **多 LLM provider 路由**：当前 `getModel()` 仅支持 OpenAI-compatible 单 provider
- **本地 LLM**：不支持

### 14.2 待优化项

- service-container.ts 注释漂移：注释说"5 个内置工具"，实际 12 个（见 [service-container.ts#L205](file:///f:/TraeProjects/1/src/main/service-container.ts#L205)、[service-container.ts#L239](file:///f:/TraeProjects/1/src/main/service-container.ts#L239)、[service-container.ts#L246](file:///f:/TraeProjects/1/src/main/service-container.ts#L246)）；`tools/index.ts` 文件头注释也说"7 个工具工厂函数"（[L5](file:///f:/TraeProjects/1/src/main/infra/ai/tools/index.ts#L5)），实际 12 个
- `InspectorPanel` 标签页仅打开 DevTools，可能冗余
- DevPanel 仅 Logs/Metrics，无 Network/Performance 子标签
- codebase-service 每次调用 spawn codegraph 子进程，可考虑常驻

### 14.3 安全风险

- ~~`.env` 硬编码 `SENTRY_AUTH_TOKEN`~~：已核实为误报——`.env` gitignore 未入仓，git 历史仅含脱敏占位符，release.yml 经 `secrets.SENTRY_AUTH_TOKEN` 注入
- `run_command` 工具的 `ask` 权限仅弹窗确认，无沙箱隔离
