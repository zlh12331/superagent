# 22. AI 工具开发规范

> 基于项目实际工具体系（34 个内置工具 + tool-executor/registry/permission 支撑层 + scaffold:tool 脚手架）制定。
> 最后同步：2026-09-30（工具数/审批模式/IM 渠道数实测核对）

---

## 一、工具命名与文件位置（强制）

| 项 | 规则 | 示例 |
|---|---|---|
| 工具名 | snake_case | `fetch_url`、`run_command` |
| 文件名 | kebab-case + `.tool.ts` | `fetch-url.tool.ts` |
| 位置 | `src/main/infra/ai/tools/` | 注册在 `index.ts`（registerBuiltinTools） |
| 生成 | `pnpm scaffold:tool --name <snake_case> --permission auto\|ask` | 禁止手写骨架 |

## 二、工具定义契约

1. **入参 schema**：必须 zod schema（LLM 生成的入参先验证后执行——TypeScript 规范 §安全）；schema 即 AI SDK tools 的 `inputSchema`
2. **权限分级**（permission-service）：
   - `auto`：无副作用/只读（grep/glob/read-file/list-directory）
   - `ask`：有副作用（write-file/edit-file/run-command/git-push）——运行时审批（Plan/Ask/Auto/YOLO 模式）
   - 危险命令分类：dangerous-commands.ts（不可逆/影响他人——删除/推送/安装）
3. **错误返回**：execute 失败抛 AppError（code + statusCode），不得返回假成功；可预期失败返回结构化结果
4. **执行约束**：路径操作必须过 path-guard（防遍历/工作区边界）；read-tracker 防重复读取

## 三、注册流程

1. `index.ts` registerBuiltinTools 中注册（依赖经参数注入，DI 装配豁免参数上限）
2. 工具类接口：`ITool`（name/description/inputSchema/execute/needsApproval）
3. 审批：ask 工具由 permission-service 决策 → approval:request 推送渲染层

## 四、测试要求（不使用 mock 原则）

- 工具测试 colocation（`*.tool.test.ts`），用真实实现 + DI fake
- 必测：schema 校验失败、权限决策、错误路径、成功路径

## 五、检查清单

- [ ] snake_case 命名 + scaffold 生成
- [ ] zod 入参 schema
- [ ] 权限分级正确（副作用 → ask）
- [ ] 危险操作入 dangerous-commands
- [ ] 路径过 path-guard
- [ ] AppError 错误返回 + 测试覆盖

---

# 附录：工具系统与 MCP 现状详述（自 code-wiki 05 合并，2026-10-12）

> 内置工具全景与 MCP 集成的实然细节，与上文开发契约互补；工具清单以 `tools/index.ts` 为唯一真源。

## 1. 工具系统分层

```
Tool<TInput> 接口（tool.ts）
  ├─ ToolRegistry     注册/注销/查找/列表 + toAISDKTools 转换（tool-registry.ts）
  ├─ ToolExecutor     统一执行入口：权限决策 + 审批 + 事件推送（tool-executor.ts）
  │    └─ PermissionService  审批/拒绝/白名单/记忆决策（permission-service.ts）
  ├─ 上下文             ToolContext（tool.ts）：workingDir/sessionId/messageId/callId/abortSignal/webContents/metadata/mode/userPrompt
  └─ registerBuiltinTools  内置工具注册（index.ts）→ 34 个 + MCP 适配工具
```

## 2. 核心抽象 `tool.ts`

- `ToolContext`：工具执行上下文（含 `mode: 'plan'|'build'`、`webContents`、`abortSignal`、`metadata`、`contextWindowSize`（工具输出闸门按窗口比例收紧））。
- `ToolResult`：统一返回结构（`{ title, output, metadata? }`——title 给 UI、output 给 LLM、metadata 结构化可选）。
- `ToolCategory`：`'read' | 'control' | 'edit' | 'exec'`（ApprovalMode 分级决策依据）。
  - `read` 读数据 / `control` 零副作用控制面（提问、任务记账、计划模式切换）/ `edit` 工作区编辑 / `exec` 命令执行
  - 零副作用类别（read + control）由 `isZeroSideEffectTool` 统一判定：plan 模式放行 + auto 快速路径免审批
  - ⚠️ MCP 工具的 category 由适配器**硬编码为 exec**（`mcp-tool-adapter.ts`），第三方工具不参与快速路径
- `Tool<TInput>` 接口：

```ts
interface Tool<TInput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput> | Schema<TInput>;  // 内置 zod / MCP 等上游 JSON Schema 原样透传
  permission: 'auto' | 'ask';            // 工具默认权限（deny 只由权限决策产出，工具不可自声明）
  category: ToolCategory;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}
```

> `execute` 用方法声明而非函数属性：注册表存异构 `Tool<unknown>` 集合，方法声明获得双变（bivariance）才能赋值，函数属性在 strictFunctionTypes 下逆变不合法。

## 3. ToolRegistry（`tool-registry.ts`）

- `register(tool)` / `unregister(name)` / `get(name)` / `list()`。
- `toAISDKTools(ctx, executeHook)`：把项目内 `Tool` 转换为 AI SDK 原生 tool（`tools: { name: { description, parameters, execute } }`），注入 `executeHook` 统一做权限检查 + 事件推送。

## 4. ToolExecutor（`tool-executor.ts`）

`execute(name, input, ctx, webContents)` 统一入口：
1. 查工具（未找到 → 结构化错误）。
2. 权限决策（**fail-closed**：decide 本身抛异常 → 拒绝执行，保证 AGENT_TOOL_RESULT 必推送）。
3. 推送 `agent:tool:call` 事件（含 permission）。
4. **pre-tool-use 钩子**（可阻断执行；错误隔离）。
5. 权限闸：deny 直接拒绝 / ask 推审批（批准 / 拒绝 / 超时 / 窗口销毁 / 用户中断五种出口，中断经 abortSignal 立即 reject）。
6. 中断信号复查（审批等待期间被停止）。
7. 调用 `tool.execute(input, ctx)` → **post-tool-use 钩子** → 输出闸门 `clampToolOutput`（200KB 按字节截断，Buffer 切分防多字节字符劈半）→ 推送 `agent:tool:result`。

## 5. PermissionService（`permission-service.ts`）

- `IPermissionService`：权限决策、审批请求、审批响应、记忆决策（stableStringify 键序稳定哈希）、白名单、拒绝跟踪、审批生命周期监听。
- 审批模式（**`plan | ask | auto | yolo` 四档**，`ApprovalModeSchema` 见 shared settings schema，`approval-pref.json` 持久化）；`decide()` 分层决策：记忆决策 → 白名单（token 级前缀匹配，空/纯通配符模式永不命中）→ plan 模式（read→auto / 非 read→deny，带逃生舱名单）→ Layer-0 危险命令确定性拦截（不可被 auto 绕过）→ 模式分级（auto 模式下 exec 出 workingDir 边界降级 ask + LLM 分类器）。
- **拒绝跟踪**（`denial-tracking.ts`）：连续 3 次 / 累计 20 次拒绝 → 降级手动确认（放行重置连续计数），防模型死循环。
- **危险命令**（`dangerous-commands.ts`）：破坏性 git（reset --hard / clean -f / stash drop）与 IaC destroy 正则集强制 ask；用户 prompt 显式提及 discard/wipe 时意图豁免。
- **命令分类器**（`command-classifier.ts`）：auto 模式下 LLM 判定命令安全性（`{safe, reason}`），**fail-closed**——任何失败归 unknown → ask；带会话内缓存。
- **路径守卫**（`path-guard.ts`）：resolved（展示形态）/ realTarget（realpathSync 真实落点，IO 专用）双路径对抗 symlink TOCTOU。
- **出站 URL 守卫**（`url-guard.ts`）：web_fetch 的 SSRF 防护——本地名/云元数据黑名单、DNS 全地址解析任一命中即拒、重定向逐跳复查。
- **决策原语**（`command-guards.ts`）：白名单语义/复合命令识别/plan 逃生舱名单等纯函数层（与审批流解耦，独立单测）。
- **先读后写**（`read-tracker.ts`）：write/edit 已存在文件前必须先 read_file（会话级作用域）。

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
- `codebase.tool.ts`（codebase，auto/read——codegraph CLI 代码智能查询）
- `code-symbols.tool.ts`（code_symbols，auto/read）
- `lsp-definition.tool.ts` / `lsp-references.tool.ts` / `lsp-hover.tool.ts`（LSP 定位/引用/悬停）

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

> 完整注册清单见 `src/main/infra/ai/tools/index.ts` 的 `registerBuiltinTools(registry, fileService, searchService, terminalService, gitService, memoryPort, lspManager, askService, permissionService, codebaseService)` —— 工具工厂依赖这些服务注入（memoryPort 为 memory-hub 的 `MemoryPort`，记忆引擎详见 05 号功能设计附录）。

## 7. MCP 集成（`mcp/`）

| 文件 | 职责 |
|---|---|
| `mcp-client.ts` | `MCPClient.connect()` 启动 MCP server 子进程、协议握手、缓存 listTools；`callTool()` 转发调用、透传 abortSignal、转换结果为 `McpToolCallResult` |
| `mcp-service.ts` | 多 MCP server 管理器；`startServer()` → `listTools()` → `adaptMcpTool()` → 注册进 ToolRegistry；`stopAll()` 关闭所有子进程 |
| `mcp-tool-adapter.ts` | `adaptMcpTool()`：命名空间工具名（`mcp__${server}__${tool}`）、inputSchema 经 AI SDK `jsonSchema()` 原样透传（不降级，校验责任在上游 server）、`decideMcpToolPermission()`（优先 config.permissionOverride → `annotations.readOnlyHint=true` → 默认 `ask`） |
| `mcp-types.ts` | MCP 类型定义 |

**流程**：入配置的 MCP server → MCPService 启动子进程 → 拉取工具列表 → 适配为项目内 `Tool` → 注册进统一 ToolRegistry → Agent 经 ToolExecutor 调用（同样走权限审批）。

## 8. 关键设计点

- **审批流**：写操作 `permission='ask'` → PermissionService 请求审批 → 主进程推送 `agent:tool:call` → 渲染层 `inline-approval-card`（agent/ 组件）/ `approval-preview` 展示 → 用户批准/拒绝 → `agent:approval:response` IPC 回传 → 回合状态机 `waitingApproval` 恢复。
- **plan/build 差异**：plan 模式下 `ask` 与 `deny` 双保险——ToolExecutor 直接拒绝写操作返回 `TOOL_PERMISSION_DENIED`（不弹审批框），零副作用（plan/apply 分离的核心约束）。
- **统一错误分类**：工具失败经 `error-classifier` 映射到 ErrorCode（instanceof 类型守卫优先于 message 扫描），供渲染层 i18n。
- **MCP 权限宽严**：优先 `permissionOverride`，其次 `readOnlyHint` 自动放行，其余一律询问（安全默认）。
- **权限元数据不可信边界**：MCP 工具（`mcp__` 命名空间）入参不给 Layer-0 短路豁免；`permission='auto'` 的非只读工具同样先过 Layer-0（不可被标记绕过）。
- **输出闸门**：`clampToolOutput` 200KB 上限统一截断，SDK 流 part 侧同闸（盲区修复）。
