# 05 · 工具系统与 MCP

> 覆盖：`src/main/infra/ai/tools/`（Tool 抽象、注册表、执行器、权限审批、内置工具）与 `mcp/`（MCP 客户端、服务、工具适配）。

## 1. 工具系统分层

```
Tool<TInput> 接口（tool.ts）
  ├─ ToolRegistry     注册/注销/查找/列表 + toAISDKTools 转换（tool-registry.ts）
  ├─ ToolExecutor     统一执行入口：权限决策 + 审批 + 事件推送（tool-executor.ts）
  │    └─ PermissionService  审批/拒绝/白名单/记忆决策（permission-service.ts）
  ├─ 上下文             ToolContext（tool.ts）：workingDir/sessionId/messageId/callId/abortSignal/webContents/metadata/mode/userPrompt
  └─ registerBuiltinTools  内置工具注册（index.ts）→ 32 个 + MCP 适配工具
```

## 2. 核心抽象 `tool.ts`

- `ToolContext`：工具执行上下文（含 `mode: 'plan'|'build'`、`webContents`、`abortSignal`、`metadata`）。
- `ToolResult`：统一返回结构（`{ ok, data?, error? }`）。
- `ToolCategory`：工具类别枚举。
- `Tool<TInput>` 接口：

```ts
interface Tool<TInput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  permission: 'auto' | 'ask' | 'deny';   // 工具默认权限
  category: ToolCategory;
  requiresReview?: boolean;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}
```

## 3. ToolRegistry（`tool-registry.ts`）

- `register(tool)` / `unregister(name)` / `get(name)` / `list()`。
- `toAISDKTools(ctx, executeHook)`：把项目内 `Tool` 转换为 AI SDK 原生 tool（`tools: { name: { description, parameters, execute } }`），注入 `executeHook` 统一做权限检查 + 事件推送。

## 4. ToolExecutor（`tool-executor.ts`）

`execute(name, input, ctx)` 统一入口：
1. 查工具（未找到 → 错误）。
2. 权限决策（经 PermissionService）：`auto` 直接执行；`ask` 发起审批；`deny` 拒绝。
3. 推送 `agent:tool:call` 事件（含 permission）。
4. 处理审批结果 / 拒绝 / 超时。
5. 检查中断信号（abort）。
6. 调用 `tool.execute(input, ctx)` → 标准化 `ToolResult` → 推送 `agent:tool:result`。

## 5. PermissionService（`permission-service.ts`）

- `IPermissionService`：权限决策、审批请求、审批响应、记忆决策、白名单、拒绝跟踪、审批生命周期监听。
- 审批模式（`ask | auto | denied`，由 `approval-pref.json` 持久化）；写操作（`permission='ask'`）需用户批准。
- **拒绝跟踪**（`denial-tracking.ts`）：记录拒绝历史，避免重复申请。
- **危险命令**（`dangerous-commands.ts`）：`run_command`/`terminal` 识别高风险命令。
- **命令分类器**（`command-classifier.ts`）：用 LLM 判断命令安全性（`deny`/`ask`）。
- **路径守卫**（`path-guard.ts`）：限制工具访问工作目录之外路径。

## 6. 内置工具清单（`tools/`，`registerBuiltinTools` 注册）

**核心文件/读写**：
- `read-file.tool.ts`（read_file，含 `read-tracker.ts` 追踪已读文件）
- `write-file.tool.ts`（write_file）
- `edit-file.tool.ts`（edit_file，字符串匹配编辑）
- `list-directory.tool.ts`（list_directory）
- `path-guard.ts`（路径限制，配套 `path-guard.test.ts`）

**搜索**：
- `grep.tool.ts`、`glob.tool.ts`（基于 SearchService/ripgrep）

**执行/Git**：
- `run-command.tool.ts`（run_command，含危险检测）
- `terminal.tool.ts`（terminal，node-pty）
- `git-commit.tool.ts` / `git-add.tool.ts` / `git-push.tool.ts`

**代码智能 / LSP**：
- `lsp-definition.tool.ts` / `lsp-references.tool.ts` / `lsp-hover.tool.ts`（LSP 定位/引用/悬停）
- 其余 codebase 查询经 `codebase` 域 handler

**网络 / 代码评审 / 模式**：
- `web-fetch.tool.ts`（web_fetch）
- `code-review.tool.ts`（code_review）
- `plan-mode.tools.ts`（enter_plan_mode / exit_plan_mode，plan 模式下写工具拒绝）

**任务 / 定时 / 工作流**：
- `task-create/list/update/stop.tool.ts`（tasks 表）
- `cron-create/delete/list.tool.ts`（croner + cron_tasks 表，配合 `cron-service.ts`）
- `run-workflow.tool.ts`（run_workflow，多步工作流编排，依赖 module 级 WorkflowService 单例）

**协作 / 子代理**：
- `run-subagent.tool.ts`（子代理）、`run-team.tool.ts`（团队，依赖 SubagentManager）
- `ask-user-question.tool.ts`（agentAskService）

**技能 / 记忆**：
- `load-skill.tool.ts`（加载技能，只读自动放行）
- `save-memory.tool.ts`（记忆主动写入，经 MemoryPort）
- `recall-memory.tool.ts`（记忆按需检索，只读；L0/L1 不进 prompt，模型主动查询）

**错误分类**：`error-classifier.ts`（工具错误 → ErrorCode）。

> 完整注册清单见 `tools/index.ts` 的 `registerBuiltinTools(registry, fileService, searchService, terminalService, gitService, memoryPort, lspManager, askService, permissionService)` —— 工具工厂依赖这些服务注入（memoryPort 为 memory-hub 的 `MemoryPort`，见 07 记忆章节）。

## 7. MCP 集成（`mcp/`）

| 文件 | 职责 |
|---|---|
| `mcp-client.ts` | `MCPClient.connect()` 启动 MCP server 子进程、协议握手、缓存 listTools；`callTool()` 转发调用、透传 abortSignal、转换结果为 `McpToolCallResult` |
| `mcp-service.ts` | 多 MCP server 管理器；`startServer()` → `listTools()` → `adaptMcpTool()` → 注册进 ToolRegistry；`stopAll()` 关闭所有子进程 |
| `mcp-tool-adapter.ts` | `adaptMcpTool()`：命名空间工具名、宽松 inputSchema、`decideMcpToolPermission()`（优先 config 覆盖 → `readOnlyHint=true` → `auto` → 默认 `ask`） |
| `mcp-types.ts` | MCP 类型定义 |

**流程**：入配置的 MCP server → MCPService 启动子进程 → 拉取工具列表 → 适配为项目内 `Tool` → 注册进统一 ToolRegistry → Agent 经 ToolExecutor 调用（同样走权限审批）。

## 8. 关键设计点

- **审批流**：写操作 `permission='ask'` → PermissionService 请求审批 → 主进程推送 `agent:tool:call` → 渲染层 `inline-approval-card` / `approval-preview` 展示 → 用户批准/拒绝 → `agent:approvalResponse` → 回合状态机 `waitingApproval` 恢复。
- **plan/build 差异**：plan 模式下写工具（`ask`）统一拒绝返回 `TOOL_PERMISSION_DENIED`，零副作用。
- **统一错误分类**：工具失败经 `error-classifier` 映射到 ErrorCode，供渲染层 i18n。
- **MCP 权限宽严**：优先 `permissionOverride`，其次只读 hint 自动放行，其余一律询问。

## 9. 关键文件

- `tools/index.ts`（注册）、`tools/tool.ts`、`tools/tool-registry.ts`、`tools/tool-executor.ts`、`tools/permission-service.ts`
- `mcp/mcp-client.ts`、`mcp/mcp-service.ts`、`mcp/mcp-tool-adapter.ts`
- 测试：`tool-registry.test.ts`、`tool-executor.test.ts`、`permission-service.test.ts`、`path-guard.test.ts`、`file-tools.test.ts`、`search-tools.test.ts`、`run-command.tool.test.ts`。