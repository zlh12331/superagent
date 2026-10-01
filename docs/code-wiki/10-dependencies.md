# 10 · 依赖关系总览

> 覆盖：包级依赖（workspace）、进程内模块依赖、服务依赖、以及"新增一个功能要动哪些文件"的依赖心智图。

## 1. 包（workspace）依赖

pnpm workspace（`pnpm-workspace.yaml`）：

- `code-agent-desktop`（根应用）

- `@code-agent/shared`（packages/shared）→ 被 main / preload / renderer 消费

- `@code-agent/tsconfig`（packages/tsconfig，base/node/web 三档）

- `@code-agent/memory-engine`（packages/memory-engine，记忆引擎上游源码进仓 + patches 补丁重放，构建失败即打包失败）

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
ToolRegistry ───────┤──► GitService ─────────────────┼──► 内置工具注册（34 个，2026-09-30 实测）
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

| 工具                                                      | 依赖服务                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| read\_file / write\_file / edit\_file / list\_directory | FileService（+ PathGuard + ReadTracker 先读后写——write/edit 消费）           |
| grep / glob                                             | SearchService（ripgrep）                                                    |
| terminal / run\_command                                 | TerminalService / spawn + PermissionService 决策链（CommandClassifier + dangerous-commands + DenialTracking 经 PermissionService 生效，工具本身不直依赖） |
| web\_fetch                                              | url-guard（SSRF 防护）                                                       |
| git\_commit/add/push                                    | GitService（权限统一走执行器权限闸）                                              |
| lsp\_definition / lsp\_references / lsp\_hover          | LspManager                                                                |
| codebase / code\_symbols                                | CodebaseService（codegraph CLI）                                           |
| task\_\*                                                | taskService（tasks 表）                                                     |
| cron\_\*                                                | cronService（croner + cron\_tasks 表）                                       |
| run\_workflow                                           | WorkflowService（module 级单例）                                               |
| run\_subagent / run\_team                               | SubagentManager + AgentService                                            |
| enter/exit\_plan\_mode                                  | PermissionService（模式切换 + approval-pref 写入）                               |
| ask\_user\_question                                     | AgentAskService                                                           |
| load\_skill                                             | SkillRegistry                                                             |
| save\_memory / recall\_memory                           | MemoryPort（memory-hub sidecar）                                            |
| MCP 工具（动态）                                              | MCPService + ToolRegistry 注册                                              |

## 6. IPC 域 → 服务映射（`src/main/index.ts` registerIpcHandlers）

| 域                                       | 后端服务                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| agent                                   | AgentService + PermissionService + agentAskService + MemoryPort/MemoryHubService（记忆捕获 wire）          |
| session                                 | SessionService +（compact 用 context-compression；clearAll 守卫同关窗协商真源）                            |
| file / search / terminal / git          | FileService / SearchService / TerminalService / GitService                                             |
| tool                                    | ToolRegistry                                                                                           |
| settings                                | PermissionService（审批/白名单） + storage 偏好层（app_settings/approval-pref 等，经 settings.handler）      |
| proxy / window / backup / system        | network（applyProxyChange）/ window-show / backup-store + 运行中回合守卫 / 系统级 handler                    |
| goal / memory                           | GoalService / MemoryHubService（memory-hub sidecar，memory 域 handler 直调 listL0/clear/JSONL 清理/健康探测）|
| models                                  | modelsHandlers（ModelRegistry + runtime-model-store）                                                    |
| mcp                                     | MCPService + ToolRegistry                                                                              |
| skill                                   | SkillRegistry + LearnSkillService                                                                       |
| whitelist                               | PermissionService                                                                                      |
| task                                    | taskService（tasks 表）                                                                                  |
| im / remote                             | ImService / RemoteControlService + LAN 地址发现                                                          |
| browser                                 | BrowserPreviewService（WebContentsView）                                                                 |
| update                                  | UpdateService + 更新缓存读写（resourcesPath）                                                             |
| logs / devtools / dialog                | 系统级 handler                                                                                            |

> 域名清单以 `packages/shared/src/ipc/meta.ts`（28 域 115 request）为唯一真源；`registerIpcHandlers` 注册项与之一一对应（`src/main/index.ts`）。

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

## 9. 第三方关键依赖（运行时 31 个 devDependencies 93 个——渲染层框架全在 devDeps，随 electron-vite 打包）

AI：`ai` 7 / `@ai-sdk/openai` / `@ai-sdk/openai-compatible` / `@ai-sdk/anthropic`（`@ai-sdk/react` 4 在 devDeps，渲染层 useChat 用）；LLM 结构化输出用 `gpt-tokenizer`
数据：`better-sqlite3` + `drizzle-orm`（`drizzle-kit` devDep，仅迁移生成）
终端：`node-pty` + `@xterm/xterm` + `@xterm/addon-fit`（渲染层）
搜索：`@vscode/ripgrep`；代码结构：`web-tree-sitter` + `@cursorless/tree-sitter-wasms`；代码智能：`@colbymchenry/codegraph`（按架构分发的 optionalDeps）
IM 渠道：`@larksuiteoapi/node-sdk`（飞书）+ `@wecom/aibot-node-sdk`（企微）；Telegram/钉钉/QQ/微信为直连 HTTP 实现（无 SDK）
MCP：`@modelcontextprotocol/sdk`
进程协作：`xstate` v5（回合状态机）；代理：`undici`（Node 栈 proxiedFetch，34 号——全局 fetch 不认 dispatcher）
UI（devDeps）：`@radix-ui/*` 12 个 + `tailwindcss` 4 + `lucide-react` + `class-variance-authority` + `tailwind-merge` + `react` 19 / `react-dom` / `react-router` 8 + `zustand` + `@tanstack/react-query` + `motion` + `tw-animate-css` + `react-markdown` + `remark-gfm` + `shiki` + `fuse.js`（模糊搜索）+ `diff-match-patch` + `chardet` / `iconv-lite`（编码检测）
框架：`electron` 44 + `electron-vite` 6 + `electron-updater` + `electron-builder`（devDeps）+ `electron-log`（运行时）
遥测：`@opentelemetry/*` 五包（API/resources/sdk-trace-base/sdk-trace-node/exporter-trace-otlp-http）；**无 Sentry**（2026-09-13 移除，错误走本地 `error-report` 单一出口）
定时：`croner`；文件监听：`chokidar`；Git：`simple-git`；zip：`adm-zip`（诊断包）

> 完整清单见根 `package.json` dependencies/devDependencies；安全覆盖（overrides）唯一真源在 `pnpm-workspace.yaml`（pnpm 11 不读 package.json#pnpm）。

