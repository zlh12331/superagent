# 接口设计文档

> 基于 `novel-writer-agent` v0.1.3 实际代码整理。
> 整理时间：2026-07-23

## 1. IPC Channels 完整清单

定义文件：[packages/shared/src/ipc/channels.ts](file:///f:/TraeProjects/1/packages/shared/src/ipc/channels.ts)

`IPC_CHANNELS` 常量使用 `as const` 派生字面量类型，导出 `IpcChannel` 联合类型。命名规范：

- `{domain}:{action}` — 请求-响应
- `{domain}:stream:{event}` — 流式事件
- `{domain}:event:{name}` — 状态变更事件

### 1.1 按域分组

| 域 | 数量 | Channels |
|---|---|---|
| app | 2 | `app:getStatus`, `app:openExternal` |
| chat | 5 (3 推送) | `chat:send`, `chat:stop`, `chat:stream:part`, `chat:stream:end`, `chat:stream:error` |
| agent | 9 (6 推送) | `agent:run`, `agent:stop`, `agent:stream:part`, `agent:stream:end`, `agent:stream:error`, `agent:tool:call`, `agent:tool:result`, `agent:approval:request`, `agent:approval:response` |
| tool | 1 | `tool:list` |
| session | 4 | `session:list`, `session:get`, `session:delete`, `session:rename` |
| file | 6 (1 推送) | `file:read`, `file:write`, `file:list`, `file:watch:start`, `file:watch:stop`, `file:watch:event` |
| search | 2 | `search:grep`, `search:glob` |
| terminal | 6 (2 推送) | `terminal:create`, `terminal:input`, `terminal:resize`, `terminal:kill`, `terminal:event:output`, `terminal:event:exit` |
| git | 2 | `git:status`, `git:diff` |
| codebase | 6 | `codebase:query`, `codebase:explore`, `codebase:node`, `codebase:callers`, `codebase:callees`, `codebase:impact` |
| settings | 5 | `settings:getApiKey`, `settings:setApiKey`, `settings:deleteApiKey`, `settings:getTelemetryLevel`, `settings:setTelemetryLevel` |
| system | 1 | `system:getStatus` |
| logs | 1 | `logs:read` |
| devtools | 1 | `devtools:open` |

合计 14 个域 / 51 个 channel（39 invoke + 12 push）。

## 2. Preload API 形状（window.api）

实现文件：[src/preload/index.ts#L115-L299](file:///f:/TraeProjects/1/src/preload/index.ts#L115)
契约定义：[packages/shared/src/ipc/api.ts#L56](file:///f:/TraeProjects/1/packages/shared/src/ipc/api.ts#L56)

通过 `contextBridge.exposeInMainWorld('api', api)` 暴露（[L302](file:///f:/TraeProjects/1/src/preload/index.ts#L302)），并用 `satisfies IpcApi` 编译时校验。

### 2.1 14 个域方法

| 域 | invoke 方法 | subscribe 方法 |
|---|---|---|
| app | `getStatus`, `openExternal` | — |
| chat | `send`, `stop` | `subscribePart`, `subscribeEnd`, `subscribeError` |
| agent | `run`, `stop`, `approvalResponse` | `subscribeStreamPart`, `subscribeStreamEnd`, `subscribeStreamError`, `subscribeToolCall`, `subscribeToolResult`, `subscribeApprovalRequest` |
| session | `list`, `get`, `delete`, `rename` | — |
| file | `read`, `write`, `list`, `watchStart`, `watchStop` | `subscribeWatchEvent` |
| search | `grep`, `glob` | — |
| terminal | `create`, `input`, `resize`, `kill` | `subscribeOutputEvent`, `subscribeExitEvent` |
| git | `status`, `diff` | — |
| codebase | `query`, `explore`, `node`, `callers`, `callees`, `impact` | — |
| tool | `list` | — |
| settings | `getApiKey`, `setApiKey`, `deleteApiKey`, `getTelemetryLevel`, `setTelemetryLevel` | — |
| system | `getStatus` | — |
| logs | `read` | — |
| devtools | `open` | — |

### 2.2 invoke vs subscribe 形状差异

底层封装在 [src/preload/utils/ipc-bridge.ts](file:///f:/TraeProjects/1/src/preload/utils/ipc-bridge.ts)：

**invoke** — [L33-L41](file:///f:/TraeProjects/1/src/preload/utils/ipc-bridge.ts#L33)：

```ts
function invoke<T>(channel: string, input?: unknown): Promise<IpcResponse<T>>
```

- 返回 `Promise<IpcResponse<T>>`（成功 `{data}` / 失败 `{error}` 判别联合）
- 每次调用自动生成 `crypto.randomUUID()` 作为 `traceId`，作为第三个参数传入主进程 `ipcMain.handle`

**subscribe** — [L69-L80](file:///f:/TraeProjects/1/src/preload/utils/ipc-bridge.ts#L69)：

```ts
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void
```

- 内部包装回调吞掉 `IpcRendererEvent`，只透传 payload 给业务层
- 返回 unsubscribe 函数，保留 handler 引用以精确 `removeListener`

### 2.3 类型契约

[packages/shared/src/ipc/api.ts#L29-L42](file:///f:/TraeProjects/1/packages/shared/src/ipc/api.ts#L29)：

- `IpcInvokeMethod<Channel>`：根据 `IpcRequestMap[Channel]['req']` 是否为 `void` 决定参数个数，返回 `Promise<IpcResponse<...>>`
- `IpcSubscribeMethod<Channel>`：接收 `(payload: IpcEventMap[Channel]) => void` 回调，返回 `() => void`

## 3. Service 接口（13 个）

接口定义在各自服务文件内（与具体类同文件，未单独抽到 `types.ts`）。每个接口遵循"接口 + 默认实现 + 单例 getter + reset 测试工具"四件套模式。

### 3.1 IChatService

[src/main/infra/ai/chat-service.ts#L65-L82](file:///f:/TraeProjects/1/src/main/infra/ai/chat-service.ts#L65)：

```ts
export interface IChatService {
  startChat(options: StartChatOptions): Promise<string>;
  abort(sessionId: string): boolean;
  abortAll(): void;
  dispose(timeoutMs?: number): Promise<void>;
}
```

### 3.2 IAgentService

[src/main/infra/ai/agent-service.ts#L83-L113](file:///f:/TraeProjects/1/src/main/infra/ai/agent-service.ts#L83)：

```ts
export interface IAgentService {
  startAgent(options: StartAgentOptions): Promise<string>;
  abort(sessionId: string): boolean;
  abortAll(): void;
  dispose(timeoutMs?: number): Promise<void>;
}
```

### 3.3 IFileService

[src/main/infra/file/file-service.ts#L91-L104](file:///f:/TraeProjects/1/src/main/infra/file/file-service.ts#L91)：

```ts
export interface IFileService {
  read(options: FileReadOptions): Promise<FileReadRes>;
  write(options: FileWriteOptions): Promise<FileWriteRes>;
  list(options: FileListOptions): Promise<FileListRes>;
  watch(options: FileWatchOptions): Promise<FileWatchHandle>;
  unwatch(watcherId: string): boolean;
  dispose(): Promise<void>;
}
```

### 3.4 ISearchService

[src/main/infra/search/search-service.ts#L66-L73](file:///f:/TraeProjects/1/src/main/infra/search/search-service.ts#L66)：

```ts
export interface ISearchService {
  grep(options: GrepOptions): Promise<GrepRes>;
  glob(options: GlobOptions): Promise<GlobRes>;
  dispose(): Promise<void>;
}
```

### 3.5 ITerminalService

[src/main/infra/terminal/terminal-service.ts#L62-L73](file:///f:/TraeProjects/1/src/main/infra/terminal/terminal-service.ts#L62)：

```ts
export interface ITerminalService {
  create(options: TerminalCreateOptions): Promise<TerminalCreateRes>;
  input(terminalId: string, data: string): Promise<TerminalInputRes>;
  resize(terminalId: string, cols: number, rows: number): Promise<TerminalResizeRes>;
  kill(terminalId: string): Promise<TerminalKillRes>;
  dispose(): Promise<void>;
}
```

### 3.6 IGitService

[src/main/infra/git/git-service.ts#L46-L53](file:///f:/TraeProjects/1/src/main/infra/git/git-service.ts#L46)：

```ts
export interface IGitService {
  status(path: string): Promise<GitStatusRes>;
  diff(options: GitDiffOptions): Promise<GitDiffRes>;
  dispose(): Promise<void>;
}
```

### 3.7 ISessionService

[src/main/infra/storage/session-service.ts#L86-L107](file:///f:/TraeProjects/1/src/main/infra/storage/session-service.ts#L86)：

```ts
export interface ISessionService {
  // IPC 暴露
  list(limit: number, offset: number): Promise<SessionListRes>;
  get(id: string): Promise<SessionGetRes>;
  delete(id: string): Promise<SessionDeleteRes>;
  rename(id: string, title: string): Promise<SessionRenameRes>;
  // 内部 API（AgentService / ChatService 直接调用，不走 IPC）
  create(options: SessionCreateOptions): Promise<string>;
  appendMessage(options: SessionAppendMessageOptions): Promise<number>;
  dispose(): Promise<void>;
}
```

### 3.8 IToolRegistry

[src/main/infra/ai/tool-registry.ts#L38-L99](file:///f:/TraeProjects/1/src/main/infra/ai/tool-registry.ts#L38)：

```ts
export interface IToolRegistry {
  register(tool: Tool): void;
  unregister(name: string): boolean;
  get(name: string): Tool | undefined;
  list(permissionFilter?: 'auto' | 'ask'): readonly ToolDescriptor[];
  toAISDKTools(
    ctx: ToolContext,
    executeHook?: (tool: Tool, input: unknown, ctx: ToolContext, toolCallId: string) => Promise<unknown>,
  ): Record<string, AITool>;
}
```

### 3.9 IToolExecutor

[src/main/infra/ai/tool-executor.ts#L42-L71](file:///f:/TraeProjects/1/src/main/infra/ai/tool-executor.ts#L42)：

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

[src/main/infra/ai/permission-service.ts#L68-L123](file:///f:/TraeProjects/1/src/main/infra/ai/permission-service.ts#L68)：

```ts
export interface IPermissionService {
  decide(tool: Tool, input: unknown): PermissionDecision;
  requestApproval(
    payload: AgentApprovalRequestPayload,
    tool: Tool,
    input: unknown,
    webContents: WebContents,
  ): Promise<boolean>;
  handleApprovalResponse(approvalId: string, approved: boolean, rememberDecision: boolean): void;
  dispose(): void;
}
```

### 3.11 IPromptService

[src/main/infra/ai/prompt/prompt-service.ts#L42-L53](file:///f:/TraeProjects/1/src/main/infra/ai/prompt/prompt-service.ts#L42)：

```ts
export interface IPromptService {
  initialize(): void;
  resolvePrompt(id: string | undefined, workingDir: string): Promise<ResolvedPrompt>;
}
```

### 3.12 ICodebaseService

[src/main/infra/codebase/codebase-service.ts#L110-L125](file:///f:/TraeProjects/1/src/main/infra/codebase/codebase-service.ts#L110)：

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

[src/main/infra/ai/mcp/mcp-service.ts#L48-L59](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-service.ts#L48)：

```ts
export interface IMCPService {
  startServer(config: McpServerConfig): Promise<void>;
  stopServer(name: string): Promise<void>;
  stopAll(): Promise<void>;
  listServers(): readonly McpServerInfo[];
  hasRunningServers(): boolean;
}
```

## 4. 数据类型定义

`packages/shared/src` 下无独立 `types/` 子目录，类型定义分布在 `schemas/`（zod schema + 派生类型）、`ipc/`（payload 接口）、`constants/`（错误码）三个目录。所有 schema 由 [packages/shared/src/index.ts](file:///f:/TraeProjects/1/packages/shared/src/index.ts) barrel 导出。

### 4.1 Zod schema 作为单一来源

示例 [packages/shared/src/schemas/chat.ts#L41](file:///f:/TraeProjects/1/packages/shared/src/schemas/chat.ts#L41)：

```ts
export const ChatMessageSchema: z.ZodType<ModelMessage> = z.custom<ModelMessage>(...);
export type ChatMessage = ModelMessage;
```

[packages/shared/src/schemas/agent.ts#L34](file:///f:/TraeProjects/1/packages/shared/src/schemas/agent.ts#L34)：

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
- response 类型直接定义为 TypeScript interface（如 `AgentRunRes` [agent.ts#L63](file:///f:/TraeProjects/1/packages/shared/src/schemas/agent.ts#L63)）

### 4.2 核心 Payload 类型

`AgentStreamPartPayload` [agent.ts#L156](file:///f:/TraeProjects/1/packages/shared/src/schemas/agent.ts#L156)：

```ts
export interface AgentStreamPartPayload {
  readonly sessionId: string;
  readonly part: unknown;  // UIMessageStreamPart 的 JSON 序列化对象
}
```

其他 payload：

- `AgentStreamEndPayload` (reason: 'completed' | 'aborted' | 'error') [L163](file:///f:/TraeProjects/1/packages/shared/src/schemas/agent.ts#L163)
- `AgentStreamErrorPayload` [L170](file:///f:/TraeProjects/1/packages/shared/src/schemas/agent.ts#L170)
- `AgentToolCallPayload` (含 permission: 'auto' | 'ask') [L83](file:///f:/TraeProjects/1/packages/shared/src/schemas/agent.ts#L83)
- `AgentToolResultPayload` [L101](file:///f:/TraeProjects/1/packages/shared/src/schemas/agent.ts#L101)
- `AgentApprovalRequestPayload` [L123](file:///f:/TraeProjects/1/packages/shared/src/schemas/agent.ts#L123)
- `AgentApprovalResponseReqSchema` (zod) [L144](file:///f:/TraeProjects/1/packages/shared/src/schemas/agent.ts#L144)

### 4.3 错误类型

定义在 [packages/shared/src/constants/errors.ts](file:///f:/TraeProjects/1/packages/shared/src/constants/errors.ts)：

- `ErrorCode` 常量对象 + `as const` 派生联合类型（[L25-L65](file:///f:/TraeProjects/1/packages/shared/src/constants/errors.ts#L25)），分 6 组：通用 / IPC 边界 / AI 调用 / 文件系统 / Code Agent 工具 / 会话 / 终端
- `ERROR_META` 表覆盖所有错误码，每项含 `userMessage` / `retryable` / `severity`（[L89-L141](file:///f:/TraeProjects/1/packages/shared/src/constants/errors.ts#L89)）
- `AppError` 类继承 Error，使用 ES2022 原生 `cause` 属性（[L165-L223](file:///f:/TraeProjects/1/packages/shared/src/constants/errors.ts#L165)），提供 `meta` / `retryable` / `severity` getter 与 `toIpcError()` 序列化方法
- `IpcError` 接口（[L148-L152](file:///f:/TraeProjects/1/packages/shared/src/constants/errors.ts#L148)）作为 IPC 错误传输结构

## 5. 数据库表结构

定义在 [src/main/infra/storage/schema.ts](file:///f:/TraeProjects/1/src/main/infra/storage/schema.ts)（Drizzle ORM + better-sqlite3）：

### sessions 表

[L29-L42](file:///f:/TraeProjects/1/src/main/infra/storage/schema.ts#L29)：

- `id` text primaryKey（UUID）
- `title` text notNull
- `created_at` integer notNull（Unix ms）
- `updated_at` integer notNull
- `last_message` text（nullable，最后一条 user 消息预览，前 100 字符）
- `message_count` integer notNull default 0（冗余字段避免 list 时 COUNT(*)）

### messages 表

[L53-L71](file:///f:/TraeProjects/1/src/main/infra/storage/schema.ts#L53)：

- `id` integer primaryKey autoIncrement
- `session_id` text notNull + `references(() => sessions.id, { onDelete: 'cascade' })`（外键级联删除）
- `seq` integer notNull（同 sessionId 内从 0 递增）
- `role` text notNull（user / assistant / tool / system）
- `content` text notNull（完整 ModelMessage 的 JSON 字符串）
- `created_at` integer notNull

### prompts 表

[L91-L108](file:///f:/TraeProjects/1/src/main/infra/storage/schema.ts#L91)：

- `id` / `name` / `description` / `role` / `content` / `is_default` / `created_at` / `updated_at`

### 消息存储格式

`serializeMessage` [session-service.ts#L524-L530](file:///f:/TraeProjects/1/src/main/infra/storage/session-service.ts#L524) 直接 `JSON.stringify(msg)` 存入 `content` 列；反序列化通过 `JSON.parse` 还原为 `unknown`（[L210-L220](file:///f:/TraeProjects/1/src/main/infra/storage/session-service.ts#L210)）。`create` / `appendMessage` 都用事务包裹（`db.transaction`）保证 sessions 行与 messages 行原子写入。

数据库操作使用 `IF NOT EXISTS` for tables 和 indexes 确保幂等。
