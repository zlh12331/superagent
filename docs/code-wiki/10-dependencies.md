# 10 · 依赖关系总览

> 覆盖：包级依赖（workspace）、进程内模块依赖、服务依赖、以及"新增一个功能要动哪些文件"的依赖心智图。

## 1. 包（workspace）依赖

pnpm workspace（`pnpm-workspace.yaml`）：

- `code-agent-desktop`（根应用）
- `@code-agent/shared`（packages/shared）→ 被 main / preload / renderer 消费
- `@code-agent/tsconfig`（packages/tsconfig，base/node/web 三档）
- `@code-agent/depcruise`、`@code-agent/typedoc-docs`（工程辅助，被根 `check:docs`/`depcruise` 调用）

依赖方向：`code-agent-desktop → @code-agent/shared`（运行时）+ `@code-agent/tsconfig`（构建期）。

## 2. 进程内依赖方向（不可逆）

```
packages/shared  ──类型/常量/schema──►  main / preload / renderer
renderer  ──window.api──►  preload  ──ipcRenderer──►  main/ipc ──► main/infra 服务
main/infra 服务  ──不反向依赖 ipc──
```

`shared` 是唯一"两端共享"的包；`infra` 层不反向依赖 `ipc` 层；`handler` 层依赖 `infra` 服务。

## 3. 服务依赖图（ServiceContainer）

```
                    ┌──► FileService ────────────────┐
                    ├──► SearchService ──────────────┤
                    ├──► TerminalService ────────────┤
ToolRegistry ───────┤──► GitService ─────────────────┼──► 内置工具注册（33 个）
   │                ├──► MemoryPort（memory-hub）────┤
   │                ├──► LspManager ────────────────┤
   │                ├──► agentAskService ───────────┤
   │                └──► PermissionService ◄─────────┤
   │
ToolExecutor ──► ToolRegistry + PermissionService
AgentService ◄─ ToolRegistry + ToolExecutor + PromptService + SessionService + llmClient（标题 + repairToolCall 修复）+ ConcurrencyGate + PermissionService + MemoryPort（自动记忆捕获）
MCPService   ◄─ ToolRegistry
GoalService  ◄─ AgentService + GoalJudge(llmClient)
ImService / ImAgentBridge ◄─ AgentService + PermissionService + SessionService
MemoryHubService（懒启动 sidecar）◄─ 工具（MemoryPort）+ memory 域 handler + 记忆自动捕获
PromptService、MemoryService、LspManager、UpdateService、CodebaseService、SessionService、GitService 等 ◄─ 惰性加载
```

**并发闸**（`ConcurrencyGate`）：agent 回合共用同一 FIFO 槽位，防供应商 API 429。

**dispose/初始化顺序**（依赖反向）：AgentService/AI 先于 PermissionService；File/Search/Terminal/Git/Session 在其后；`resetAIProvider` 与 `closeDb` 最后。不可逆。

## 4. AI 层内部依赖

```
LlmClient（llm-client）
  ├─ ai-provider（llmClient 单例 + runtimeModelStore + resetAIProvider）
  ├─ retry（指数退避）
  └─ providers/registry（BUILTIN_DEFINITIONS / FACTORIES + types.PROVIDER_KINDS）
        └─ @ai-sdk/openai-compatible / @ai-sdk/openai / @ai-sdk/anthropic
models/（registry · runtime-model-store · generation-options · token-limits · reasoning-effort）
  ◄─ 被 LlmClient 与 agent/chat 主流程消费

Agent-Service ──► Agent-Runtime（turn-machine · turn-runner · create-stream · stream-reader · concurrency-gate · loop-detector）
Agent-Service ──► PromptService.dynamic-context.agents-md ——► context-compression
Agent-Service ──► ToolRegistry.toAISDKTools(executeHook=ToolExecutor.execute)
```

## 5. 工具 → 服务依赖

| 工具 | 依赖服务 |
|---|---|
| read_file / write_file / edit_file / list_directory | FileService（+ PathGuard） |
| grep / glob | SearchService（ripgrep） |
| terminal / run_command | TerminalService + CommandClassifier + dangerous-commands + DenialTracking |
| git_commit/add/push | GitService + PermissionService |
| lsp_definition / lsp_references / lsp_hover | LspManager |
| task_* / cron_* | SessionService(tasks/cron_tasks) + croner + cron-service |
| run_workflow | WorkflowService（module 级单例） |
| run_subagent / run_team | SubagentManager + AgentService |
| ask_user_question | AgentAskService |
| load_skill | SkillRegistry |
| save_memory / recall_memory | MemoryPort（memory-hub sidecar） |
| MCP 工具（动态） | MCPService + ToolRegistry 注册 |

## 6. IPC 域 → 服务映射（`src/main/index.ts` registerIpcHandlers）

| 域 | 后端服务 |
|---|---|
| agent | AgentService + PermissionService + agentAskService |
| session | SessionService +（compact 用 context-compression） |
| file / search / terminal / git | FileService / SearchService / TerminalService / GitService |
| codebase | CodebaseService |
| tool | ToolRegistry |
| settings | PermissionService（审批/API Key/运行时模型） + SessionService(app_settings) + keychain + telegram/sentry prefs |
| mcp | MCPService + ToolRegistry |
| goal / memory | GoalService / MemoryHubService（memory-hub sidecar，经 memory 域 handler） |
| im | ImService |
| update | UpdateService |
| system / logs / devtools / dialog / app | 系统级 handler |

## 7. 渲染层依赖

- **数据源**：`use-*` hooks → `lib/ipc.ts`（`window.api`）→ `@code-agent/shared` 类型。
- **状态**：TanStack Query（invoke 的 server state）+ Zustand stores（on 推送事件）。
- **AI 传输**：`lib/agent/ipc-agent-transport.ts`（@ai-sdk/react 接主进程 IPC）。
- **主题/样式**：`providers/ThemeProvider` + `styles/tokens.css`（由 `tokens/aurora.json` 生成）；i18n 最外层。

## 8. 新增功能依赖心智图

**新增一个工具**：`tools/{name}.tool.ts` 实现 `Tool` → `tools/index.ts` 注册 → （如需 IPC）`src/main/ipc/{domain}.handler.ts` + `packages/shared` schema → 渲染层 UI。

**新增一个 IPC 域**：见 03-§9 六步。

**新增一个模型供应商**：`settings.ts` 的 `ApiKeyProviderSchema` → `providers/types.ts` 的 `PROVIDER_KINDS` → `providers/registry.ts` 的 `BUILTIN_DEFINITIONS`/`BUILTIN_FACTORIES`。

**新增一张表**：在 `storage/schema.ts` 定义（列 + CHECK/UNIQUE/外键 + 查询索引）→ `pnpm exec drizzle-kit generate` 自动生成迁移 + journal/snapshot → `pnpm exec drizzle-kit check` 验证 → db.test 断言约束生效。若给**已有表**加 CHECK/UNIQUE：用重建式迁移（0001 先例，仅限无 FK 引用表）或触发器（0002 先例，被引用表），禁止手写第二份建表 SQL。

## 9. 第三方关键依赖（运行时）

AI：`ai` / `@ai-sdk/{react,openai,openai-compatible,anthropic}`
数据：`better-sqlite3` + `drizzle-orm` + `drizzle-kit`
终端：`@xterm/xterm` + `@xterm/addon-fit` + `node-pty`
搜索：`@vscode/ripgrep`；代码结构：`tree-sitter-wasms` + `web-tree-sitter`
UI：`@radix-ui/*` + `tailwindcss` + `lucide-react` + `class-variance-authority` + `tailwind-merge`
状态：`zustand` + `@tanstack/react-query`；动画：`motion` + `tw-animate-css`
框架：`react`/`react-dom`/`react-router`/`vite`；electron：`electron` + `electron-vite` + `electron-updater` + `electron-builder` + `electron-log`
遥测：`@sentry/electron` + `@opentelemetry/*`
序列化/校验：`zod`；富文本：`react-markdown` + `remark-gfm` + `shiki`
定时：`croner`；diff：`diff-match-patch` + `react-diff-viewer-continued`；模糊搜索：`fuse.js`

> 完整清单见根 `package.json` dependencies/devDependencies。