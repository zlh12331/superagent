# 技术栈文档

> 基于 `code-agent-desktop` 实际 [package.json](file:///package.json) 整理。
> 整理时间：2026-07-23（依赖清单 2026-08-11 同步；**2026-09-30 全量对账**——版本号/pnpm 11/allowBuilds/tsconfig 引用/workspace 三包按现值核对；**2026-10-09 pnpm 12.10.1 升级**——packageManager/engines/锁文件同步，version 行随包现值修正；**2026-10-12 全量对账**——Node 26/pnpm 12 引擎锚点 + 依赖表现值 + allowBuilds 清单按 package.json / pnpm-workspace.yaml 实测修正）

## 1. 项目基本信息

| 项              | 值                                                              | 来源                                         |
| -------------- | -------------------------------------------------------------- | ------------------------------------------ |
| name           | `code-agent-desktop`                                           | [package.json](file:///package.json) |
| version        | `1.8.0`                                                        | [package.json](file:///package.json) |
| description    | Code Agent Desktop - 生产级 Electron Code Agent 桌面应用（Windows 桌面端） | [package.json](file:///package.json) |
| type           | `module`                                                       | [package.json](file:///package.json) |
| main           | `./out/main/index.js`                                          | [package.json](file:///package.json) |
| packageManager | `pnpm@12.10.1`                                                  | [package.json](file:///package.json) |

## 2. engines 与运行时要求

| 依赖      | 版本要求        | 来源                                               |
| ------- | ----------- | ------------------------------------------------ |
| Node.js | `>=26.0.0` | [package.json](file:///package.json) |
| pnpm    | `>=12.0.0`  | [package.json](file:///package.json) |

构建脚本决策（pnpm 12 沿用 `allowBuilds`，取代旧 `onlyBuiltDependencies`）在 [pnpm-workspace.yaml](file:///pnpm-workspace.yaml)：放行 `better-sqlite3` / `electron` / `esbuild` / `node-pty`，显式 false 拒绝 `@sentry/cli` / `@swc/core` / `electron-winstaller` / `msw` / `protobufjs`（pnpm 对未决策包报 ERR_PNPM_IGNORED_BUILDS 阻断 install，必须逐一表态）。

## 3. 依赖分类清单

### 3.1 Electron / 构建工具

| 依赖                            | 版本             | 类型                            |
| ----------------------------- | -------------- | ----------------------------- |
| `electron`                    | `^44.7.0`      | devDep                        |
| `electron-vite`               | `6.0.0-beta.1` | dep                           |
| `electron-updater`            | `^6.8.9`       | dep                           |
| `electron-log`                | `^5`           | dep                           |
| `electron-builder`            | `^26`          | devDep                        |
| `@electron/rebuild`           | `^4.2.1`       | devDep                        |
| `electron-devtools-installer` | `^4.0.0`       | devDep                        |
| `vite`                        | `^8`           | dep                           |
| `@vitejs/plugin-react`        | `^6.1.2`       | devDep                        |
| `oxc-transform-react`         | `^0.152.0`     | devDep（React Compiler oxc 通道） |

### 3.2 React 全家桶

| 依赖                                                               | 版本                                |
| ---------------------------------------------------------------- | --------------------------------- |
| `react`（devDep）                                                | `^19.3.0`                         |
| `react-dom`                                                      | `^19.3.0`                         |
| `react-router`                                                   | `^8.4.0`                          |
| `react-i18next` / `i18next` / `i18next-browser-languagedetector` | `^17.0.16` / `^26.4.2` / `^8.2.1` |
| `@tanstack/react-query`                                          | `^5.104.1`                        |
| `react-error-boundary`                                           | `^6.1.6`                          |
| `react-hotkeys-hook`                                             | `^5.3.3`                          |
| `react-markdown` / `remark-gfm`                                  | `^10.1.0` / `^4.0.1`              |
| `react-activity-calendar`                                        | `^3.2.1`                          |

### 3.3 AI 相关

| 依赖                          | 版本        | 用途                                                        |
| --------------------------- | --------- | --------------------------------------------------------- |
| `ai` (Vercel AI SDK)        | `^7.0.133` | streamText / tools / stopWhen 多轮工具调用                      |
| `@ai-sdk/openai`            | `^4.0.89` | OpenAI provider                                           |
| `@ai-sdk/anthropic`         | `^4.0.76` | Anthropic provider                                        |
| `@ai-sdk/openai-compatible` | `^3.0.66` | DeepSeek 等 OpenAI 兼容 provider                             |
| `@ai-sdk/react`             | `^4.0.136` | useChat 等 React hooks                                     |
| `@modelcontextprotocol/sdk` | `^1.32.1` | MCP server 集成（stdio / sse / streamable-http 三态 transport） |
| `gpt-tokenizer`             | `^4.0.0`  | token 计数                                                  |

### 3.4 数据库

| 依赖                      | 版本         | 用途                                                                  |
| ----------------------- | ---------- | ------------------------------------------------------------------- |
| `better-sqlite3`        | `^13.0.3`  | SQLite 原生绑定                                                         |
| `drizzle-orm`           | `^0.45.3`  | TypeScript ORM                                                      |
| `drizzle-kit`           | `^0.31.11` | devDep，迁移工具（[drizzle.config.ts](file:///drizzle.config.ts) 已在根目录提供） |
| `@types/better-sqlite3` | `^9.6.0`   | devDep                                                              |

### 3.5 UI / 样式

| 依赖                                                                                        | 版本                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| `@tailwindcss/vite` / `tailwindcss`                                                       | `^4` / `^4`                                 |
| `@radix-ui/react-{dialog,dropdown-menu,label,scroll-area,slot,tabs,tooltip,alert-dialog}` | 多个                                          |
| `class-variance-authority` / `clsx` / `tailwind-merge` / `tw-animate-css`                 | `^0.7.1` / `^2.1.1` / `^3.7.0` / `^1.4.0`   |
| `lucide-react` / `cmdk` / `sonner` / `motion`                                             | `^1.53.0` / `^1.1.1` / `^2.0.8` / `^14.0.0` |
| `shiki`                                                                                   | `^4.5.0`                                    |

### 3.6 终端 / 文件系统 / 搜索

| 依赖                                  | 版本                   | 用途                                                                                              |
| ----------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `@xterm/xterm` / `@xterm/addon-fit` | `^6.0.0` / `^0.11.0` | 终端 UI                                                                                           |
| `node-pty`                          | `^1.1.0`             | PTY 进程                                                                                          |
| `chokidar`                          | `^5.0.0`             | 文件监听                                                                                            |
| `@vscode/ripgrep`                   | `^1.18.0`            | grep 搜索                                                                                         |
| `web-tree-sitter`                   | `^0.27.0`            | tree-sitter 解析                                                                                  |
| `@cursorless/tree-sitter-wasms`     | `^0.10.0`            | tree-sitter WASM 语法包（2026-09-04：原 tree-sitter-wasms 0.1.13 停更且旧 dylink ABI 与 0.25+ 运行时不兼容，整体升级） |
| `diff-match-patch`                  | `^1.0.5`             | 文件 diff                                                                                         |
| `fuse.js`                           | `^7.5.0`             | 模糊搜索                                                                                            |

> 2026-08-11 同步：依赖清单对齐 package.json（radix 补 alert-dialog 去 separator；AI 栈补 openai/anthropic provider；react-virtuoso → react-activity-calendar；motion ^13；补 tree-sitter-wasms）。
>
> 2026-10-12 同步：依赖表对齐 package.json 现值（electron ^44.7.0 / oxc ^0.152.0 / motion ^14 / ai ^7.0.133 / @ai-sdk 系 / react 19.3 / playwright 1.64 / vitest 5.0.3 / zod 4.6.5 / otel 0.223 + 2.12 / @types/node 26.6.4 等）。

### 3.7 状态 / 校验

| 依赖              | 版本        |
| --------------- | --------- |
| `zustand`       | `^5.0.15` |
| `zod`           | `^4.6.5`  |
| `@dnd-kit/core` | `^6.3.1`  |

### 3.8 监控 / 可观测性

| 依赖                                        | 版本         | 用途                          |
| ----------------------------------------- | ---------- | --------------------------- |
| `@opentelemetry/api`                      | `^1.9.1`   | OTel API                    |
| `@opentelemetry/exporter-trace-otlp-http` | `^0.223.0` | OTLP HTTP exporter          |
| `@opentelemetry/resources`                | `^2.12.0`  | Resource 定义                 |
| `@opentelemetry/sdk-trace-base`           | `^2.12.0`  | Tracer 基础                   |
| `@opentelemetry/sdk-trace-node`           | `^2.12.0`  | Node Tracer                 |

### 3.9 测试

| 依赖                                                   | 版本                               | 用途                 |
| ---------------------------------------------------- | -------------------------------- | ------------------ |
| `vitest` / `@vitest/coverage-v8`                     | `^5.0.3` / `^5.0.3`              | 单测框架 + v8 coverage |
| `@playwright/test` / `playwright`                    | `^1.64.0` / `^1.64.0`            | E2E 测试             |
| `@testing-library/react` / `jest-dom` / `user-event` | `^16.3.3` / `^7.0.1` / `^14.6.7` | 组件测试               |
| `@axe-core/playwright`                               | `^4.13.0`                        | a11y 审计            |
| `jsdom`                                              | `^30.1.2`                        | DOM 环境             |

### 3.10 工程化 / 工具

| 依赖                                        | 版本                    | 用途                |
| ----------------------------------------- | --------------------- | ----------------- |
| `@biomejs/biome`                          | `^2`                  | lint + format 二合一 |
| `typescript`                              | `^7.0.2`              | TS 编译器            |
| `tsx`                                     | `^4`                  | TS 脚本执行           |
| `husky` / `lint-staged`                   | `^9` / `^17.6.0`      | Git hooks         |
| `@commitlint/cli` / `config-conventional` | `^21.2.3` / `^21.2.3` | 提交规范              |
| `audit-ci`                                | `^7.1.0`              | 依赖审计              |
| `cross-env`                               | `^10.1.0`             | 跨平台环境变量           |
| `@types/node`                             | `^26.6.4`             | Node.js 类型        |

### 3.11 workspace 内部包

- `@code-agent/shared`: `workspace:*`（devDep）

- `@code-agent/tsconfig`: `workspace:*`（devDep）

## 4. Monorepo 结构

[pnpm-workspace.yaml](file:///pnpm-workspace.yaml) 配置 `packages/*` 与 `tools/*`，包含三个子包：

- [packages/shared](file:///packages/shared)：跨进程共享包（含独立 vitest.config.ts、tsconfig）

- [packages/tsconfig](file:///packages/tsconfig)：暴露 `base.json` / `node.json` / `web.json` 三个预设

- [packages/memory-engine](file:///packages/memory-engine)：记忆引擎（上游 TencentDB-Agent-Memory 源码 MIT 进仓 + patches 补丁重放；独立 TS 隔离，构建失败即打包失败）

## 5. TypeScript 配置

根 [tsconfig.json](file:///tsconfig.json) 是 solution-style 配置，无 `compilerOptions`，通过 `references` 编排 6 个子项目：

```
references: packages/tsconfig, packages/shared, src/main, src/preload, src/renderer, tsconfig.configs.json
```

严格模式集中在 [packages/tsconfig/base.json](file:///packages/tsconfig/base.json)：

- `target`: `ES2024`

- `module`: `ESNext`

- `moduleResolution`: `bundler`

- `lib`: `["ES2024", "ES2022.Error", "DOM"]`

- `strict`: `true`

特殊严格选项（全部开启）：

- `noUncheckedIndexedAccess`

- `noImplicitOverride`

- `noFallthroughCasesInSwitch`

- `noUnusedLocals` / `noUnusedParameters`

- `exactOptionalPropertyTypes`

- `verbatimModuleSyntax`

- `isolatedModules` / `isolatedDeclarations`

- `forceConsistentCasingInFileNames`

- `noImplicitReturns`

- `noPropertyAccessFromIndexSignature`

- `noUncheckedSideEffectImports`

- `allowUnreachableCode`: `false`

- `allowUnusedLabels`: `false`

## 6. Vite 构建配置

[electron.vite.config.ts](file:///electron.vite.config.ts) 三入口分别配置：

| 入口       | input                     | sourcemap | 特殊处理                                                                  |
| -------- | ------------------------- | --------- | --------------------------------------------------------------------- |
| main     | `src/main/index.ts`       | `hidden`  | —                                                                     |
| preload  | `src/preload/index.ts`    | `hidden`  | `output.format: 'cjs'`、`entryFileNames: '[name].cjs'`（sandbox 要求 CJS） |
| renderer | `src/renderer/index.html` | `hidden`  | `root: 'src/renderer'`、alias `@` → `src/renderer`                     |

关键配置：

- **Sourcemap 模式**：`'hidden'`（生成 `.map` 但不写 `sourceMappingURL`；map 不入安装包，构建机保留供本地排障）

- **renderer 插件**：`@vitejs/plugin-react`（启用 React Compiler：oxc 通道 `compiler: { compilationMode: 'infer' }`，依赖 `oxc-transform-react`）+ `@tailwindcss/vite`（Tailwind v4 官方插件）

- **符号上传**：无（Sentry 已于 2026-09-13 移除，错误经 error-report.ts 落本地日志）

## 7. Biome 配置

[biome.json](file:///biome.json)（schema 2.5.4）：

- **formatter**：space 缩进 2，lineWidth 100，LF 行尾

- **linter**：`recommended` preset + 自定义规则

  - correctness: `noUnusedVariables` error、`noUnusedImports` error、`useExhaustiveDependencies` warn

  - suspicious: `noExplicitAny` error、`noConsole` warn

  - style: `useImportType` error、`useNamingConvention` error、`useConst` error、`noDefaultExport` error

  - complexity: `useLiteralKeys` off

- **javascript formatter**：单引号、分号必加、尾逗号 all、箭头括号 always

- **css parser**：`tailwindDirectives: true`

- **ignore 列表**：`release`、`coverage`、`node_modules`、`out`、`dist`、`.codegraph`、`playwright-report`、`playwright-report-electron`、`playwright-report-smoke`、`test-results`、`playwright/.cache`、`docs/design`

- **overrides**（22 组）：`src/renderer/**/*.tsx` 关闭 `noDefaultExport`；常量/枚举文件关闭 `useNamingConvention`；AI 服务层 + storage + IPC handler 关闭 `strictCase`；`tests/**`、`e2e/**`、`scripts/**` 关闭 `noConsole`

## 8. 环境变量与配置文件

### .env / .env.example（项目根目录）

[.env.example](file:///.env.example) 提供环境变量模板，实际值写入本地 `.env`（gitignore，不入仓）：

- AI Provider base URL（`DEEPSEEK_API_BASE` / `OPENAI_API_BASE` / `ANTHROPIC_API_BASE` 等，全部可选）
- `LOG_LEVEL`（debug / info / warn / error）
- `OTEL_EXPORTER_OTLP_ENDPOINT`（OpenTelemetry OTLP 端点，未配置时不外发、退化为 Console exporter）
- `MEMORY_HUB_ROOT`（dev 专用：记忆引擎上游解压根目录；打包环境读 `process.resourcesPath/memory-hub`）

> 注：API Key 不通过 .env 管理（走应用内 safeStorage 加密存储），.env 仅提供便于 CI/自动化场景的默认值。

## 9. 关键风险点

1. **`electron-vite 6.0.0-beta.1`**：构建链核心依赖使用 beta 版本，存在稳定性风险（Electron 44 + pnpm 12 已实测稳定运行）
2. **自动更新依赖仓库可见性**：`electron-builder.yml` `publish` 为 `provider: github`，自动更新源为 GitHub Releases；私有仓库的资产下载需认证 token，面向用户分发需将仓库转为公开

## 10. 关键亮点

1. **顶配 TypeScript 严格度**：`base.json` 开启了几乎所有严格选项，远超默认 `strict: true`
2. **Biome v2 统一工具链**：用 Biome 2.5.15 同时替代 ESLint + Prettier，配合 22 组 overrides 精细化放宽命名约定
3. **React 19.3 + React Compiler**：渲染层经 `oxc-transform-react` 启用 React Compiler（`compilationMode: 'infer'` 自动 memoize；`check:compiler` 门禁防 oxc 依赖缺失导致的静默失效）
4. **Tailwind v4 官方 Vite 插件**：弃用 v3 postcss 流程，改用 `@tailwindcss/vite`，与 Vite 8 原生集成
5. **完整 monorepo**：pnpm workspace + 两个内部包，主应用三入口严格分离
6. **preload CJS 输出**：明确注释 sandbox: true 限制，preload 强制 `format: 'cjs'` + `.cjs` 扩展名
7. **原生模块编译管控**：pnpm 12 沿用的构建脚本决策（pnpm 11 引入）在 [pnpm-workspace.yaml](file:///pnpm-workspace.yaml) `allowBuilds`（取代旧 `pnpm.onlyBuiltDependencies`）：放行 `better-sqlite3` / `electron` / `esbuild` / `node-pty`，显式 false 拒绝 `@sentry/cli` / `@swc/core` / `electron-winstaller` / `msw` / `protobufjs`

---

# 附录：依赖关系总览（自 code-wiki 10 合并，2026-10-12）

> 包级依赖、进程内模块依赖、服务依赖图与"新增一个功能要动哪些文件"的心智图。

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
ToolRegistry ───────┤──► GitService ─────────────────┼──► 内置工具注册（34 个）
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

**并发闸**（`ConcurrencyGate`）：agent 回合按 provider 分桶（每桶基线容量 4，AIMD 自适应浮动），桶内 FIFO + 限流冷却，防供应商 API 429。

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
| read_file / write_file / edit_file / list_directory | FileService（+ PathGuard + ReadTracker 先读后写——write/edit 消费） |
| grep / glob | SearchService（ripgrep） |
| terminal / run_command | TerminalService / spawn + PermissionService 决策链（CommandClassifier + dangerous-commands + DenialTracking 经 PermissionService 生效，工具本身不直依赖） |
| web_fetch | url-guard（SSRF 防护） |
| git_commit/add/push | GitService（权限统一走执行器权限闸） |
| lsp_definition / lsp_references / lsp_hover | LspManager |
| codebase / code_symbols | CodebaseService（codegraph CLI） |
| task_* | taskService（tasks 表） |
| cron_* | cronService（croner + cron_tasks 表） |
| run_workflow | WorkflowService（module 级单例） |
| run_subagent / run_team | SubagentManager + AgentService |
| enter/exit_plan_mode | PermissionService（模式切换 + approval-pref 写入） |
| ask_user_question | AgentAskService |
| load_skill | SkillRegistry |
| save_memory / recall_memory | MemoryPort（memory-hub sidecar） |
| MCP 工具（动态） | MCPService + ToolRegistry 注册 |

## 6. IPC 域 → 服务映射（`src/main/index.ts` registerIpcHandlers）

| 域 | 后端服务 |
|---|---|
| agent | AgentService + PermissionService + agentAskService + MemoryPort/MemoryHubService（记忆捕获 wire） |
| session | SessionService +（compact 用 context-compression；clearAll 守卫同关窗协商真源） |
| file / search / terminal / git | FileService / SearchService / TerminalService / GitService |
| tool | ToolRegistry |
| settings | PermissionService（审批/白名单） + storage 偏好层（app_settings/approval-pref 等，经 settings.handler） |
| proxy / window / backup / system | network（applyProxyChange）/ window-show / backup-store + 运行中回合守卫 / 系统级 handler |
| goal / memory | GoalService / MemoryHubService（memory-hub sidecar，memory 域 handler 直调 listL0/clear/JSONL 清理/健康探测） |
| models | modelsHandlers（ModelRegistry + runtime-model-store） |
| mcp | MCPService + ToolRegistry |
| skill | SkillRegistry + LearnSkillService |
| whitelist | PermissionService |
| task | taskService（tasks 表） |
| im / remote | ImService / RemoteControlService + LAN 地址发现 |
| browser | BrowserPreviewService（WebContentsView） |
| update | UpdateService + 更新缓存读写（resourcesPath） |
| logs / devtools / dialog | 系统级 handler |

> 域名清单以 `packages/shared/src/ipc/meta.ts`（28 域 136 方法：115 request + 21 event）为唯一真源；`registerIpcHandlers` 注册项与之一一对应（`src/main/index.ts`）。

## 7. 渲染层依赖

- **数据源**：`use-*` hooks → `lib/ipc.ts`（`window.api`）→ `@code-agent/shared` 类型。
- **状态**：TanStack Query（invoke 的 server state）+ Zustand stores（on 推送事件）。
- **AI 传输**：`lib/agent/ipc-agent-transport.ts`（@ai-sdk/react 接主进程 IPC）。
- **主题/样式**：`providers/ThemeProvider` + `styles/tokens.css`（由 `tokens/aurora.json` 生成）；i18n 最外层。

## 8. 新增功能依赖心智图

**新增一个工具**：`tools/{name}.tool.ts` 实现 `Tool` → `tools/index.ts` 注册 → （如需 IPC）`src/main/ipc/{domain}.handler.ts` + `packages/shared` schema → 渲染层 UI。

**新增一个 IPC 域**：见 19 号开发流程六步。

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

