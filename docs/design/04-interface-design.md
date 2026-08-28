# 接口设计文档

> 基于 `code-agent-desktop` v1.0.0 实际代码整理。
> 整理时间：2026-07-23（IPC 域/Service 清单 2026-08-11 同步）

## 1. IPC Channels 完整清单

定义文件：[packages/shared/src/ipc/channels.ts](file:///packages/shared/src/ipc/channels.ts)

`IPC_CHANNELS` 常量使用 `as const` 派生字面量类型，导出 `IpcChannel` 联合类型。命名规范：

- `{domain}:{action}` — 请求-响应
- `{domain}:stream:{event}` — 流式事件
- `{domain}:event:{name}` — 状态变更事件

### 1.1 按域分组

| 域 | 数量 | Channels |
|---|---|---|
| audio | 3 | `audio:start`, `audio:append`, `audio:stop` |
| app | 4 | `app:getStatus`, `app:getInfo`, `app:openExternal`, `app:openDataDir` |
| chat | 5 (3 推送) | `chat:send`, `chat:stop`, `chat:stream:part`, `chat:stream:end`, `chat:stream:error` |
| agent | 12 (8 推送) | `agent:run`, `agent:ask:respond`, `agent:stop`, `agent:approval:response`, `agent:event:ask`, `agent:stream:part`, `agent:stream:end`, `agent:stream:error`, `agent:tool:call`, `agent:tool:result`, `agent:approval:request`, `agent:turn:event` |
| session | 12 | `session:list`, `session:get`, `session:delete`, `session:rename`, `session:pin`, `session:create`, `session:listRecentDirs`, `session:exportAll`, `session:getUsageSummary`, `session:getTurns`, `session:getRecentTurns`, `session:getTurnMessages` |
| file | 10 (1 推送) | `file:read`, `file:write`, `file:list`, `file:watch:start`, `file:watch:stop`, `file:watch:event`, `file:create`, `file:createDir`, `file:delete`, `file:rename` |
| search | 2 | `search:grep`, `search:glob` |
| terminal | 7 (3 推送) | `terminal:create`, `terminal:input`, `terminal:resize`, `terminal:kill`, `terminal:event:created`, `terminal:event:output`, `terminal:event:exit` |
| git | 5 | `git:status`, `git:diff`, `git:add`, `git:commit`, `git:push` |
| codebase | 6 | `codebase:query`, `codebase:explore`, `codebase:node`, `codebase:callers`, `codebase:callees`, `codebase:impact` |
| tool | 1 | `tool:list` |
| settings | 10 | `settings:getApiKey`, `settings:setApiKey`, `settings:deleteApiKey`, `settings:getTelemetryLevel`, `settings:setTelemetryLevel`, `settings:getApprovalMode`, `settings:setApprovalMode`, `settings:addRuntimeModel`, `settings:removeRuntimeModel`, `settings:listRuntimeModels` |
| system | 1 | `system:getStatus` |
| models | 1 | `models:list` |
| memory | 2 | `memory:list`, `memory:clear` |
| task | 1 | `task:list` |
| skill | 4 | `skill:list`, `skill:learn`, `skill:listLearned`, `skill:removeLearned` |
| whitelist | 3 | `whitelist:list`, `whitelist:add`, `whitelist:remove` |
| goal | 3 | `goal:create`, `goal:list`, `goal:clear` |
| im | 3 | `im:list`, `im:start`, `im:stop` |
| logs | 1 | `logs:read` |
| devtools | 1 | `devtools:open` |
| dialog | 2 | `dialog:pickDirectory`, `dialog:pickFiles` |
| mcp | 3 | `mcp:list`, `mcp:start`, `mcp:stop` |
| update | 3 (1 推送) | `update:check`, `update:install`, `update:event:status` |

合计 25 个域 / 105 个 channel（89 invoke + 16 push）。

## 2. Preload API 形状（window.api）

实现文件：[src/preload/index.ts](file:///src/preload/index.ts)（通过 `createIpcApi(IPC_META)` 自动生成）
契约定义：[packages/shared/src/ipc/api.ts](file:///packages/shared/src/ipc/api.ts)

通过 `contextBridge.exposeInMainWorld('api', api)` 暴露，形状由 `IPC_META` 元数据表驱动，类型系统保证与定义表同步。

### 2.1 16 个域方法

| 域 | invoke 方法 | subscribe 方法 |
|---|---|---|
| audio | `start`, `append`, `stop` | — |
| app | `getStatus`, `getInfo`, `openExternal`, `openDataDir` | — |
| chat | `send`, `stop` | `subscribePart`, `subscribeEnd`, `subscribeError` |
| agent | `run`, `askRespond`, `stop`, `approvalResponse` | `subscribeStreamPart`, `subscribeStreamEnd`, `subscribeStreamError`, `subscribeToolCall`, `subscribeToolResult`, `subscribeApprovalRequest`, `subscribeTurnEvent`, `subscribeAskEvent` |
| session | `list`, `get`, `delete`, `rename`, `pin`, `create`, `listRecentDirs`, `exportAll`, `getUsageSummary`, `getTurns`, `getRecentTurns`, `getTurnMessages` | — |
| file | `read`, `write`, `list`, `watchStart`, `watchStop`, `create`, `createDir`, `delete`, `rename` | `subscribeWatchEvent` |
| search | `grep`, `glob` | — |
| terminal | `create`, `input`, `resize`, `kill` | `subscribeCreatedEvent`, `subscribeOutputEvent`, `subscribeExitEvent` |
| git | `status`, `diff`, `add`, `commit`, `push` | — |
| codebase | `query`, `explore`, `node`, `callers`, `callees`, `impact` | — |
| tool | `list` | — |
| settings | `getApiKey`, `setApiKey`, `deleteApiKey`, `getTelemetryLevel`, `setTelemetryLevel`, `getApprovalMode`, `setApprovalMode`, `addRuntimeModel`, `removeRuntimeModel`, `listRuntimeModels` | — |
| system | `getStatus` | — |
| models | `list` | — |
| memory | `list`, `clear` | — |
| task | `list` | — |
| skill | `list`, `learn`, `listLearned`, `removeLearned` | — |
| whitelist | `list`, `add`, `remove` | — |
| goal | `create`, `list`, `clear` | — |
| im | `list`, `start`, `stop` | — |
| logs | `read` | — |
| devtools | `open` | — |
| dialog | `pickDirectory`, `pickFiles` | — |
| mcp | `list`, `start`, `stop` | — |
| update | `check`, `install` | `subscribeStatus` |

> 2026-08-11 同步：域表由 16 域/74 channel 更新为 25 域/105 channel（新增 audio/models/memory/task/skill/whitelist/goal/im/mcp + agent:ask/agent:event:ask/session:pin/session:getTurnMessages/settings 审批模式/dialog:pickFiles 等新方法），与 packages/shared/src/ipc/meta.ts 一致。

### 2.2 invoke vs subscribe 形状差异

底层封装在 [src/preload/utils/ipc-bridge.ts](file:///src/preload/utils/ipc-bridge.ts)：

**invoke** — [L33-L41](file:///src/preload/utils/ipc-bridge.ts#L33)：

```ts
function invoke<T>(channel: string, input?: unknown): Promise<IpcResponse<T>>
```

- 返回 `Promise<IpcResponse<T>>`（成功 `{data}` / 失败 `{error}` 判别联合）
- 每次调用自动生成 `crypto.randomUUID()` 作为 `traceId`，作为第三个参数传入主进程 `ipcMain.handle`

**subscribe** — [L69-L80](file:///src/preload/utils/ipc-bridge.ts#L69)：

```ts
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void
```

- 内部包装回调吞掉 `IpcRendererEvent`，只透传 payload 给业务层
- 返回 unsubscribe 函数，保留 handler 引用以精确 `removeListener`

### 2.3 类型契约

[packages/shared/src/ipc/api.ts#L29-L42](file:///packages/shared/src/ipc/api.ts#L29)：

- `IpcInvokeMethod<Channel>`：根据 `IpcRequestMap[Channel]['req']` 是否为 `void` 决定参数个数，返回 `Promise<IpcResponse<...>>`
- `IpcSubscribeMethod<Channel>`：接收 `(payload: IpcEventMap[Channel]) => void` 回调，返回 `() => void`

## 3. Service 接口（15 个）

接口定义在各自服务文件内（与具体类同文件，未单独抽到 `types.ts`）。每个接口遵循"接口 + 默认实现 + 单例 getter + reset 测试工具"四件套模式（UpdateService 例外，由 ServiceContainer 直接 `new`）。

### 3.1 IAgentService

[src/main/infra/ai/agent/agent-service.ts#L100-L130](file:///src/main/infra/ai/agent/agent-service.ts#L100)：

```ts
export interface IAgentService {
  startAgent(options: StartAgentOptions): Promise<string>;
  abort(sessionId: string): boolean;
  abortAll(): void;
  dispose(timeoutMs?: number): Promise<void>;
}
```

### 3.3 IFileService

[src/main/infra/file/file-service.ts#L145-L166](file:///src/main/infra/file/file-service.ts#L145)：

```ts
export interface IFileService {
  read(options: FileReadOptions): Promise<FileReadRes>;
  write(options: FileWriteOptions): Promise<FileWriteRes>;
  list(options: FileListOptions): Promise<FileListRes>;
  watch(options: FileWatchOptions): Promise<FileWatchHandle>;
  unwatch(watcherId: string): boolean;
  dispose(): Promise<void>;
  createFile(options: FileCreateOptions): Promise<FileCreateRes>;
  createDir(options: FileCreateDirOptions): Promise<FileCreateDirRes>;
  delete(options: FileDeleteOptions): Promise<FileDeleteRes>;
  rename(options: FileRenameOptions): Promise<FileRenameRes>;
}
```

### 3.4 ISearchService

[src/main/infra/search/search-service.ts#L66-L73](file:///src/main/infra/search/search-service.ts#L66)：

```ts
export interface ISearchService {
  grep(options: GrepOptions): Promise<GrepRes>;
  glob(options: GlobOptions): Promise<GlobRes>;
  dispose(): Promise<void>;
}
```

### 3.5 ITerminalService

[src/main/infra/terminal/terminal-service.ts#L63-L78](file:///src/main/infra/terminal/terminal-service.ts#L63)：

```ts
export interface ITerminalService {
  create(options: TerminalCreateOptions): Promise<TerminalCreateRes>;
  input(terminalId: string, data: string): Promise<TerminalInputRes>;
  resize(terminalId: string, cols: number, rows: number): Promise<TerminalResizeRes>;
  kill(terminalId: string): Promise<TerminalKillRes>;
  getOutput(terminalId: string): string;
  clearOutput(terminalId: string): void;
  dispose(): Promise<void>;
}
```

### 3.6 IGitService

[src/main/infra/git/git-service.ts#L104-L117](file:///src/main/infra/git/git-service.ts#L104)：

```ts
export interface IGitService {
  status(path: string): Promise<GitStatusRes>;
  diff(options: GitDiffOptions): Promise<GitDiffRes>;
  add(options: GitAddOptions): Promise<GitAddRes>;
  commit(options: GitCommitOptions): Promise<GitCommitRes>;
  push(options: GitPushOptions): Promise<GitPushRes>;
  dispose(): Promise<void>;
}
```

### 3.7 ISessionService

[src/main/infra/storage/session-service.ts#L121-L190](file:///src/main/infra/storage/session-service.ts#L121)：

```ts
export interface ISessionService {
  // ── IPC 暴露方法 ──
  list(limit: number, offset: number): Promise<SessionListRes>;
  get(id: string): Promise<SessionGetRes>;
  delete(id: string): Promise<SessionDeleteRes>;
  rename(id: string, title: string): Promise<SessionRenameRes>;
  // ── 内部 API（AgentService / ChatService 调用，不走 IPC）──
  create(options: SessionCreateOptions): Promise<string>;
  appendMessage(options: SessionAppendMessageOptions): Promise<number>;
  listRecentDirs(req: { readonly limit: number }): Promise<SessionListRecentDirsRes>;
  // ── 崩溃恢复（回合状态机）──
  markRunning(id: string): Promise<void>;
  markIdle(id: string): Promise<void>;
  markAllInterrupted(): Promise<number>;
  exportAll(): Promise<SessionExportPayload>;
  // ── token 用量统计（设置页展示）──
  recordUsage(usage: { ... }): Promise<void>;
  getUsageSummary(): Promise<UsageSummaryRes>;
  // ── Transcript（回合记录）──
  recordTurn(turn: { ... }): Promise<void>;
  getTurns(sessionId: string): Promise<SessionGetTurnsRes>;
  getRecentTurns(req: { readonly limit: number }): Promise<SessionRecentTurnsRes>;
  dispose(): Promise<void>;
}
```

> 完整方法签名见源文件；为简洁起见 `recordUsage` / `recordTurn` 的内联对象类型此处省略。

### 3.8 IToolRegistry

[src/main/infra/ai/tools/tool-registry.ts#L38-L95](file:///src/main/infra/ai/tools/tool-registry.ts#L38)：

```ts
export interface IToolRegistry {
  register(tool: Tool): void;
  unregister(name: string): boolean;
  get(name: string): Tool | undefined;
  list(permissionFilter?: 'auto' | 'ask'): readonly ToolDescriptor[];
  toAISDKTools(
    baseCtx: Omit<ToolContext, 'messageId' | 'callId' | 'metadata'>,
    executeHook?: (tool: Tool, input: unknown, ctx: ToolContext) => Promise<unknown>,
  ): Record<string, AITool>;
}
```

### 3.9 IToolExecutor

[src/main/infra/ai/tools/tool-executor.ts#L44-L73](file:///src/main/infra/ai/tools/tool-executor.ts#L44)：

```ts
export interface IToolExecutor {
  execute(
    toolName: string,
    toolCallId: string,
    input: unknown,
    ctx: ToolContext,
    webContents: WebContents,
  ): Promise<AgentToolResultPayload>;
}
```

### 3.10 IPermissionService

[src/main/infra/ai/tools/permission-service.ts#L68-L130](file:///src/main/infra/ai/tools/permission-service.ts#L68)：

```ts
export interface IPermissionService {
  decide(tool: Tool, input: unknown): PermissionDecision;
  requestApproval(
    payload: AgentApprovalRequestPayload,
    tool: Tool,
    input: unknown,
    webContents: WebContents,
    abortSignal?: AbortSignal,
  ): Promise<boolean>;
  handleApprovalResponse(approvalId: string, approved: boolean, rememberDecision: boolean): void;
  dispose(): void;
}
```

### 3.11 IPromptService

[src/main/infra/ai/prompt/prompt-service.ts#L42-L53](file:///src/main/infra/ai/prompt/prompt-service.ts#L42)：

```ts
export interface IPromptService {
  initialize(): void;
  resolvePrompt(id: string | undefined, workingDir: string): Promise<ResolvedPrompt>;
}
```

### 3.12 ICodebaseService

[src/main/infra/codebase/codebase-service.ts#L120-L140](file:///src/main/infra/codebase/codebase-service.ts#L120)：

```ts
export interface ICodebaseService {
  query(options: CodebaseQueryOptions): Promise<CodebaseQueryRes>;
  explore(options: CodebaseExploreOptions): Promise<CodebaseExploreRes>;
  node(options: CodebaseNodeOptions): Promise<CodebaseNodeRes>;
  callers(options: CodebaseCallOptions): Promise<CodebaseCallersRes>;
  callees(options: CodebaseCallOptions): Promise<CodebaseCalleesRes>;
  impact(options: CodebaseImpactOptions): Promise<CodebaseImpactRes>;
  dispose(): Promise<void>;
}
```

### 3.13 IMCPService

[src/main/infra/ai/mcp/mcp-service.ts#L48-L59](file:///src/main/infra/ai/mcp/mcp-service.ts#L48)：

```ts
export interface IMCPService {
  startServer(config: McpServerConfig): Promise<void>;
  stopServer(name: string): Promise<void>;
  stopAll(): Promise<void>;
  listServers(): readonly McpServerInfo[];
  hasRunningServers(): boolean;
}
```

### 3.14 IUpdateService

[src/main/infra/update/update-service.ts#L40-L49](file:///src/main/infra/update/update-service.ts#L40)：

```ts
export interface IUpdateService {
  start(): void;
  check(manual: boolean): Promise<UpdateCheckRes>;
  quitAndInstall(): void;
  dispose(): void;
}
```

> 实现为 `new UpdateService(autoUpdater, () => app.isPackaged)`，由 ServiceContainer 直接构造（非模块级单例）。

### 3.15 GoalService

[src/main/infra/ai/knowledge/goal-service.ts](file:///src/main/infra/ai/knowledge/goal-service.ts)：无独立接口，直接 export class。

```ts
export class GoalService {
  mount(goal: string): void;          // 挂载当前目标
  create(goal: string): Promise<void>; // 创建/更新目标
  list(): GoalItem[];                  // 列出目标
  clear(): void;                       // 清空目标
}
```

> 依赖 AgentService + GoalJudge（LLM 判定），用于目标驱动会话。

### 3.16 ImService

[src/main/infra/im/im-service.ts](file:///src/main/infra/im/im-service.ts)：无独立接口，直接 export class；由 ImAgentBridge 桥接到 Agent。

```ts
export class ImService {
  start(): Promise<void>;
  stop(): Promise<void>;
  list(): ImChannel[];
  send(channelId: string, message: string): Promise<void>;
  restore(): Promise<void>;
  stopAll(): void;
}
```

### 3.17 MemoryPort

[src/main/infra/memory-hub/types.ts](file:///src/main/infra/memory-hub/types.ts)：记忆引擎唯一边界接口（capture / recall / searchMemories / clear），实现由 memory-hub sidecar（TencentDB-Agent-Memory）提供。

```ts
export interface MemoryPort {
  capture(input: MemoryCaptureInput): Promise<MemoryCaptureResult>;
  recall(input: MemoryRecallInput): Promise<MemoryRecallResult>;
  searchMemories(query: string, limit?: number): Promise<MemorySearchResult>;
  clear(sessionKey: string): Promise<MemoryClearResult>;
}
```

> 2026-08-11 同步：Service 小节由 14 扩充至 17（新增 GoalService / ImService / MemoryService，均为直接 export class 无独立接口）。2026-08-25 更新：记忆模块迁至 memory-hub sidecar（TencentDB-Agent-Memory），接口收敛为 MemoryPort。

## 4. 数据类型定义

`packages/shared/src` 下无独立 `types/` 子目录，类型定义分布在 `schemas/`（zod schema + 派生类型）、`ipc/`（payload 接口）、`constants/`（错误码）三个目录。所有 schema 由 [packages/shared/src/index.ts](file:///packages/shared/src/index.ts) barrel 导出。

### 4.1 Zod schema 作为单一来源

示例 [packages/shared/src/schemas/chat.ts#L41](file:///packages/shared/src/schemas/chat.ts#L41)：

```ts
export const ChatMessageSchema: z.ZodType<ModelMessage> = z.custom<ModelMessage>(...);
export type ChatMessage = ModelMessage;
```

[packages/shared/src/schemas/agent.ts#L34](file:///packages/shared/src/schemas/agent.ts#L34)：

```ts
export const AgentRunReqSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  sessionId: z.string().optional().transform((v) => v ?? undefined),
  workingDir: z.string().min(1),
  systemPrompt: z.string().optional().transform((v) => v ?? undefined),
  maxSteps: z.number().int().positive().max(50).default(20),
});
```

Schema 与 inferred type 关系：

- request 类型从 schema 用 `z.infer` 派生
- response 类型直接定义为 TypeScript interface（如 `AgentRunRes` [agent.ts#L63](file:///packages/shared/src/schemas/agent.ts#L63)）

### 4.2 核心 Payload 类型

`AgentStreamPartPayload` [agent.ts#L156](file:///packages/shared/src/schemas/agent.ts#L156)：

```ts
export interface AgentStreamPartPayload {
  readonly sessionId: string;
  readonly part: unknown;  // UIMessageStreamPart 的 JSON 序列化对象
}
```

其他 payload：

- `AgentStreamEndPayload` (reason: 'completed' | 'aborted' | 'error') [L163](file:///packages/shared/src/schemas/agent.ts#L163)
- `AgentStreamErrorPayload` [L170](file:///packages/shared/src/schemas/agent.ts#L170)
- `AgentToolCallPayload` (含 permission: 'auto' | 'ask') [L83](file:///packages/shared/src/schemas/agent.ts#L83)
- `AgentToolResultPayload` [L101](file:///packages/shared/src/schemas/agent.ts#L101)
- `AgentApprovalRequestPayload` [L123](file:///packages/shared/src/schemas/agent.ts#L123)
- `AgentApprovalResponseReqSchema` (zod) [L144](file:///packages/shared/src/schemas/agent.ts#L144)

### 4.3 错误类型

定义在 [packages/shared/src/constants/errors.ts](file:///packages/shared/src/constants/errors.ts)：

- `ErrorCode` 常量对象 + `as const` 派生联合类型（[L25-L65](file:///packages/shared/src/constants/errors.ts#L25)），分 6 组：通用 / IPC 边界 / AI 调用 / 文件系统 / Code Agent 工具 / 会话 / 终端
- `ERROR_META` 表覆盖所有错误码，每项含 `userMessage` / `retryable` / `severity`（[L89-L141](file:///packages/shared/src/constants/errors.ts#L89)）
- `AppError` 类继承 Error，使用 ES2022 原生 `cause` 属性（[L165-L223](file:///packages/shared/src/constants/errors.ts#L165)），提供 `meta` / `retryable` / `severity` getter 与 `toIpcError()` 序列化方法
- `IpcError` 接口（[L148-L152](file:///packages/shared/src/constants/errors.ts#L148)）作为 IPC 错误传输结构

## 5. 数据库表结构

定义在 [src/main/infra/storage/schema.ts](file:///src/main/infra/storage/schema.ts)（Drizzle ORM + better-sqlite3），共 6 张表。

### sessions 表（会话元数据）

[L29-L46](file:///src/main/infra/storage/schema.ts#L29)：

- `id` text primaryKey（UUID，由 SessionService.create 生成）
- `title` text notNull（用户可编辑，默认取首条用户消息前 50 字符）
- `created_at` integer notNull（Unix ms）
- `updated_at` integer notNull
- `last_message` text（nullable，最后一条 user 消息预览，前 100 字符）
- `message_count` integer notNull default 0（冗余字段避免 list 时 COUNT(*)）
- `working_dir` text notNull（会话级项目工作目录，agent 工具操作边界）
- `last_run_status` text notNull default 'idle'（最近运行状态：idle / running / interrupted，崩溃恢复识别）

### messages 表（消息历史）

[L57-L75](file:///src/main/infra/storage/schema.ts#L57)：

- `id` integer primaryKey autoIncrement
- `session_id` text notNull + `references(() => sessions.id, { onDelete: 'cascade' })`（外键级联删除）
- `seq` integer notNull（同 sessionId 内从 0 递增）
- `role` text notNull（user / assistant / tool / system）
- `content` text notNull（完整 ModelMessage 的 JSON 字符串）
- `created_at` integer notNull

### prompts 表（System Prompt 模板存储）

[L95-L112](file:///src/main/infra/storage/schema.ts#L95)：

- `id` text primaryKey（如 'code-agent'）
- `name` text notNull（显示名称）
- `description` text notNull
- `role` text notNull（Agent 角色标识，当前仅 'code-agent'，预留扩展）
- `content` text notNull（支持模板变量：`{{workingDir}}` / `{{os}}` / `{{gitBranch}}` 等）
- `is_default` integer(boolean) notNull default true（内置 prompt 不可删除但可编辑）
- `created_at` integer notNull
- `updated_at` integer notNull

### token_usage 表（LLM 调用 token 用量记录）

[L132-L153](file:///src/main/infra/storage/schema.ts#L132)：

- `id` integer primaryKey autoIncrement
- `session_id` text notNull + `references(() => sessions.id, { onDelete: 'cascade' })`
- `model_id` text notNull（如 deepseek-v4-flash）
- `input_tokens` integer notNull
- `output_tokens` integer notNull
- `total_tokens` integer notNull
- `cache_read_tokens` integer（nullable，KV cache 命中，DeepSeek prompt_cache_hit_tokens）
- `reasoning_tokens` integer（nullable，思维链 token，reasoning 模型）
- `created_at` integer notNull

### turns 表（Agent 回合记录 / Transcript 结构化）

[L168-L193](file:///src/main/infra/storage/schema.ts#L168)：

- `id` integer primaryKey autoIncrement
- `turn_id` text notNull（UUID，关联 TurnEvent.turnId）
- `session_id` text notNull + `references(() => sessions.id, { onDelete: 'cascade' })`
- `seq` integer notNull（回合序号，会话内从 0 递增）
- `model_id` text notNull
- `status` text notNull（终止原因：completed / aborted / max-steps / error）
- `input_tokens` integer（nullable）
- `output_tokens` integer（nullable）
- `total_tokens` integer（nullable）
- `duration_ms` integer（nullable，回合总耗时）
- `created_at` integer notNull

### runtime_models 表（用户手动配置的模型运行时快照）

[L208-L217](file:///src/main/infra/storage/schema.ts#L208)：

- `model_id` text primaryKey（全局唯一）
- `provider_kind` text notNull（所属供应商 kind，决定 SDK 协议）
- `base_url` text（nullable，显式 baseUrl 覆盖供应商默认端点；null = 用默认）
- `created_at` integer notNull

> 注：apiKey 不落库，存 keychain（key = `runtime:${modelId}`，与 AI 域约定一致）。

### 消息存储格式

`serializeMessage` [session-service.ts#L524-L530](file:///src/main/infra/storage/session-service.ts#L524) 直接 `JSON.stringify(msg)` 存入 `content` 列；反序列化通过 `JSON.parse` 还原为 `unknown`（[L210-L220](file:///src/main/infra/storage/session-service.ts#L210)）。`create` / `appendMessage` 都用事务包裹（`db.transaction`）保证 sessions 行与 messages 行原子写入。

数据库操作使用 `IF NOT EXISTS` for tables 和 indexes 确保幂等。
