# 目录结构文档

> 基于 `code-agent-desktop` v1.0.0 实际目录扫描整理。
> 整理时间：2026-07-23

## 1. 顶层结构

```
f:\TraeProjects\1\
├── .github/workflows/        # CI/CD（ci.yml + release.yml）
├── docs/                     # 文档
│   ├── design/               # 本设计文档集 + AI 编码/架构规范（.md）
│   │   ├── 01-architecture.md … 10-component-design-spec.md
│   │   ├── software-architecture-principles-ai.md
│   │   └── typescript-dev-standards-ai.md
│   └── 参考项目/             # 第三方参考项目源码副本（不入索引）
├── e2e/                      # Playwright E2E 测试
├── packages/                 # pnpm workspace 内部包
│   ├── shared/               # @code-agent/shared 跨进程共享包
│   └── tsconfig/             # @code-agent/tsconfig 统一 TS 预设
├── resources/                # 应用资源（图标等）
├── scripts/                  # 工具脚本
├── src/
│   ├── main/                 # Electron 主进程
│   ├── preload/              # Preload 脚本
│   └── renderer/             # React 19 渲染层
├── biome.json                # Biome lint + format 配置
├── .env                      # 环境变量（项目根）
├── .nsprc                    # audit-ci 白名单
├── electron-builder.yml      # electron-builder 打包配置
├── electron.vite.config.ts   # electron-vite 构建配置
├── package.json
├── pnpm-workspace.yaml       # pnpm workspace 配置
├── sentry.properties         # sentry-cli 配置
└── tsconfig.json             # solution-style TS 配置
```

## 2. src/main/ — Electron 主进程

`src/main/` 下分 6 个子目录：`config` / `infra` / `ipc` / `security` / `telemetry` / `utils`

### 2.1 src/main/infra/ — 业务服务（按业务域分 11 个子目录）

| 域 | 文件数 | 关键文件 |
|---|---|---|
| ai/（顶层） | 17 | [agent-service.ts](file:///src/main/infra/ai/agent/agent-service.ts) / [ai-provider.ts](file:///src/main/infra/ai/llm-client/ai-provider.ts) / [tool-registry.ts](file:///src/main/infra/ai/tools/tool-registry.ts) / [tool-executor.ts](file:///src/main/infra/ai/tools/tool-executor.ts) / [permission-service.ts](file:///src/main/infra/ai/tools/permission-service.ts) / [tool.ts](file:///src/main/infra/ai/tools/tool.ts) / [error-classifier.ts](file:///src/main/infra/ai/tools/error-classifier.ts) / [context-compression.ts](file:///src/main/infra/ai/agent/context-compression.ts) / [session-title.ts](file:///src/main/infra/ai/knowledge/session-title.ts) + 8 测试 |
| ai/agent-runtime/ | 8 | [index.ts](file:///src/main/infra/ai/agent-runtime/index.ts) / [stream-reader.ts](file:///src/main/infra/ai/agent-runtime/stream-reader.ts) / [turn-emitter.ts](file:///src/main/infra/ai/agent-runtime/turn-emitter.ts) / [turn-runner.ts](file:///src/main/infra/ai/agent-runtime/turn-runner.ts) / [turn-translator.ts](file:///src/main/infra/ai/agent-runtime/turn-translator.ts) + 3 测试 |
| ai/llm-client/ | 5 | [index.ts](file:///src/main/infra/ai/llm-client/index.ts) / [llm-client.ts](file:///src/main/infra/ai/llm-client/llm-client.ts) / [retry.ts](file:///src/main/infra/ai/llm-client/retry.ts) + 2 测试 |
| ai/mcp/ | 9 | [mcp-client.ts](file:///src/main/infra/ai/mcp/mcp-client.ts) / [mcp-service.ts](file:///src/main/infra/ai/mcp/mcp-service.ts) / [mcp-tool-adapter.ts](file:///src/main/infra/ai/mcp/mcp-tool-adapter.ts) / [mcp-types.ts](file:///src/main/infra/ai/mcp/mcp-types.ts) + 4 测试 + index.ts |
| ai/models/ | 13 | [builtin-models.ts](file:///src/main/infra/ai/models/builtin-models.ts) / [registry.ts](file:///src/main/infra/ai/models/registry.ts) / [runtime-model-store.ts](file:///src/main/infra/ai/models/runtime-model-store.ts) / [generation-options.ts](file:///src/main/infra/ai/models/generation-options.ts) / [reasoning-effort.ts](file:///src/main/infra/ai/models/reasoning-effort.ts) / [token-limits.ts](file:///src/main/infra/ai/models/token-limits.ts) / [types.ts](file:///src/main/infra/ai/models/types.ts) + index.ts + 6 测试 |
| ai/prompt/ | 5 | [prompt-service.ts](file:///src/main/infra/ai/prompt/prompt-service.ts) / [default-prompt.ts](file:///src/main/infra/ai/prompt/default-prompt.ts) / [dynamic-context.ts](file:///src/main/infra/ai/prompt/dynamic-context.ts) / [agents-md.ts](file:///src/main/infra/ai/prompt/agents-md.ts) + 1 测试 |
| ai/providers/ | 5 | [registry.ts](file:///src/main/infra/ai/providers/registry.ts) / [types.ts](file:///src/main/infra/ai/providers/types.ts) + index.ts + 2 测试 |
| ai/tools/ | 55 | 33 个内置工具（31 个 `*.tool.ts` + [plan-mode.tools.ts](file:///src/main/infra/ai/tools/plan-mode.tools.ts)）+ 注册/执行/权限基础设施（[index.ts](file:///src/main/infra/ai/tools/index.ts) / [tool-registry.ts](file:///src/main/infra/ai/tools/tool-registry.ts) / [tool-executor.ts](file:///src/main/infra/ai/tools/tool-executor.ts) / [permission-service.ts](file:///src/main/infra/ai/tools/permission-service.ts) / [path-guard.ts](file:///src/main/infra/ai/tools/path-guard.ts) / command-classifier / dangerous-commands / denial-tracking / error-classifier / read-tracker / tool.ts）+ 11 测试 |
| storage/ | 11 | [db.ts](file:///src/main/infra/storage/db.ts) / [schema.ts](file:///src/main/infra/storage/schema.ts) / [session-service.ts](file:///src/main/infra/storage/session-service.ts) / [keychain.ts](file:///src/main/infra/storage/keychain.ts) / [app-data.ts](file:///src/main/infra/storage/app-data.ts) / [telemetry-pref.ts](file:///src/main/infra/storage/telemetry-pref.ts) + 4 测试 |
| code/ | 2 | [code-analyzer.ts](file:///src/main/infra/code-analysis/code-analyzer.ts) + 1 测试 |
| codebase/ | 1 | [codebase-service.ts](file:///src/main/infra/codebase/codebase-service.ts) |
| file/ | 2 | [file-service.ts](file:///src/main/infra/file/file-service.ts) + 1 测试 |
| git/ | 2 | [git-service.ts](file:///src/main/infra/git/git-service.ts) + 1 测试 |
| search/ | 1 | [search-service.ts](file:///src/main/infra/search/search-service.ts) |
| terminal/ | 1 | [terminal-service.ts](file:///src/main/infra/terminal/terminal-service.ts) |
| update/ | 2 | [update-service.ts](file:///src/main/infra/update/update-service.ts) + 1 测试 |

### 2.2 src/main/ipc/ — IPC Handler（16 个 handler 文件）

按域对应关系见 [01-architecture.md §3.1](file:///docs/design/01-architecture.md) 的 IPC 表格。每个 handler 文件注册本域的 invoke + subscribe 通道。

### 2.3 其他 src/main 子目录

| 目录 | 文件 | 职责 |
|---|---|---|
| config/ | [index.ts](file:///src/main/config/index.ts) + [config.test.ts](file:///src/main/config/config.test.ts) | 应用配置（环境变量读取、缓存） |
| security/ | — | CSP 策略注入相关 |
| telemetry/ | [otel.ts](file:///src/main/infra/telemetry/otel.ts) | OpenTelemetry 初始化 |
| utils/ | [logger.ts](file:///src/main/utils/logger.ts) / [wrap.ts](file:///src/main/utils/wrap.ts) / [retry.ts](file:///src/main/infra/ai/llm-client/retry.ts) + 测试 | 工具函数 |
| index.ts | [src/main/index.ts](file:///src/main/index.ts) | 主进程入口 |
| service-container.ts | [src/main/service-container.ts](file:///src/main/service-container.ts) | 18 服务统一生命周期管理（2026-08-17 实测） |

### 2.4 src/main/infra/ai/tools/ — 内置工具（33 个）

实际注册 33 个工具（[tools/index.ts](file:///src/main/infra/ai/tools/index.ts) `registerBuiltinTools`，2026-08-30 实测）；下表列出核心 12 个，另含 ask_user_question / enter+exit_plan_mode / task_create+update+stop+list / cron_create+list+delete / run_subagent / run_team / **run_workflow** / web_fetch / save_memory / load_skill / lsp_definition / lsp_references / **lsp_hover**：

| 工具文件 | 工具名 | 权限 | 依赖 |
|---|---|---|---|
| [read-file.tool.ts](file:///src/main/infra/ai/tools/read-file.tool.ts) | read_file | auto | IFileService |
| [write-file.tool.ts](file:///src/main/infra/ai/tools/write-file.tool.ts) | write_file | ask | IFileService |
| [list-directory.tool.ts](file:///src/main/infra/ai/tools/list-directory.tool.ts) | list_directory | auto | IFileService |
| [code-review.tool.ts](file:///src/main/infra/ai/tools/code-review.tool.ts) | code_review | auto | IFileService |
| [grep.tool.ts](file:///src/main/infra/ai/tools/grep.tool.ts) | grep | auto | ISearchService |
| [glob.tool.ts](file:///src/main/infra/ai/tools/glob.tool.ts) | glob | auto | ISearchService |
| [terminal.tool.ts](file:///src/main/infra/ai/tools/terminal.tool.ts) | terminal | ask | ITerminalService |
| [run-command.tool.ts](file:///src/main/infra/ai/tools/run-command.tool.ts) | run_command | ask | 无 |
| [edit-file.tool.ts](file:///src/main/infra/ai/tools/edit-file.tool.ts) | edit_file | ask | 无 |
| [git-add.tool.ts](file:///src/main/infra/ai/tools/git-add.tool.ts) | git_add | ask | IGitService |
| [git-commit.tool.ts](file:///src/main/infra/ai/tools/git-commit.tool.ts) | git_commit | ask | IGitService |
| [git-push.tool.ts](file:///src/main/infra/ai/tools/git-push.tool.ts) | git_push | ask | IGitService |

## 3. src/preload/ — Preload 脚本

```
src/preload/
├── index.ts              # contextBridge 暴露 window.api（16 个域，createIpcApi 自动生成）
├── utils/
│   ├── create-api.ts     # createIpcApi 生成器（遍历 IPC_META）
│   └── ipc-bridge.ts     # invoke/subscribe 底层封装（traceId 自动注入）
└── tsconfig.json         # sandbox CJS 配置
```

## 4. src/renderer/ — React 19 渲染层

```
src/renderer/
├── components/           # UI 组件（不含测试）
│   ├── agent/            # ApprovalDialog
│   ├── chat/             # ChatInput / ChatMessageList / ChatPanel / Markdown
│   ├── common/           # AppErrorBoundary / AsyncBoundary / CommandPalette / EmptyState / ModelSelector / UpdateNotice
│   ├── dev/              # InspectorPanel / LogsPanel / MetricsPanel
│   ├── file-tree/        # FileTreeNavigator / FileTreeNode / FileTreePanel / FileViewerDialog
│   ├── git/              # GitPanel
│   ├── layout/           # AppShell / DevPanel / Sidebar / Topbar
│   ├── settings/         # SettingsDialog
│   ├── terminal/         # TerminalPanel
│   └── ui/               # shadcn 基础组件（button / dialog / dropdown-menu / input / label / scroll-area / separator / skeleton / sonner / tabs / textarea / tooltip）
├── hooks/                # 17 个 + 8 测试
│   ├── use-agent-bridge.ts
│   ├── use-agent.ts
│   ├── use-api-key.ts
│   ├── use-approval-bridge.ts
│   ├── use-async-view.ts
│   ├── use-file-content.ts
│   ├── use-file-tree-ops.ts
│   ├── use-file-tree.ts
│   ├── use-file-write.ts
│   ├── use-git.ts
│   ├── use-keyboard-shortcuts.ts
│   ├── use-layout-breakpoint.ts
│   ├── use-sessions.ts
│   ├── use-system.ts
│   ├── use-telemetry.ts
│   ├── use-terminal-bridge.ts
│   ├── use-tool-bridge.ts
│   └── use-update.ts
├── stores/               # 双层架构（persistent + transient）
│   ├── persistent/       # create-persistent-store / sessions-store / settings-store
│   └── transient/        # approvals / file-tree / file-viewer / terminal / tool / ui / usage / welcome store
├── lib/                  # 工具库
│   ├── agent/            # ipc-agent-transport
│   ├── diff/             # diff-stats
│   ├── motion/           # index + transitions + variants
│   ├── query/            # query-client
│   ├── constants.ts
│   ├── error-actions.ts
│   ├── format-time.ts
│   ├── ipc.ts
│   ├── theme-init.ts
│   └── utils.ts
├── routes/               # 3 个（chat.tsx / home.tsx / root.tsx）
├── providers/            # 3 个（QueryProvider / ThemeProvider / index）
├── i18n/                 # 4 个 + 4 locale JSON
│   ├── I18nProvider.tsx
│   ├── config.ts
│   ├── index.ts
│   ├── use-translation.ts
│   └── locales/
│       ├── en/common.json + errors.json
│       └── zh-CN/common.json + errors.json
├── test/                 # 3 个（setup / setup-lang / msw-handlers / smoke.test）
│   └── __tests__/mock-api.test.ts
├── styles/
│   └── globals.css
├── App.tsx
├── main.tsx              # 渲染层入口
├── router.tsx
├── index.html
├── index.css
├── vite-env.d.ts
└── components.json       # shadcn 配置
```

## 5. packages/shared/ — 跨进程共享包

[packages/shared/src/index.ts](file:///packages/shared/src/index.ts) 统一导出，49 个 .ts 文件（含 7 测试）：

```
packages/shared/src/
├── index.ts              # barrel 导出
├── main.ts               # 主进程入口（导出 IPC_DEFINITIONS / InferHandlers）
├── preload.ts            # preload 入口（导出 IpcApi / IpcResponse 类型）
├── renderer.ts           # renderer 入口
├── constants/
│   └── errors.ts         # AppError + ErrorCode 错误码（6 组分类）
├── ipc/
│   ├── meta.ts           # IPC_META 纯字符串元数据（零依赖，preload 沙箱安全）
│   ├── definitions.ts    # IPC_DEFINITIONS（meta + zod schema 合并，单一真源）
│   ├── channels.ts       # IPC_CHANNELS 由 deriveChannels(IPC_META) 自动生成
│   ├── derive.ts         # deriveChannels 工具函数
│   ├── api.ts            # IpcApi 接口契约（16 域方法签名）
│   ├── payloads.ts       # payload 类型映射
│   └── response.ts       # IpcResponse 判别联合
├── schemas/              # 15 个 Zod schema 文件
│   ├── agent.ts          # AgentRunReqSchema / AgentStreamPartPayload 等
│   ├── agent-events.ts   # TurnEvent 等
│   ├── chat.ts           # ChatMessageSchema（复用 AI SDK ModelMessage）
│   ├── codebase.ts
│   ├── devtools.ts
│   ├── dialog.ts
│   ├── file.ts
│   ├── git.ts
│   ├── search.ts
│   ├── session.ts
│   ├── settings.ts
│   ├── system.ts
│   ├── terminal.ts
│   ├── tool.ts
│   └── update.ts
└── __tests__/            # 4 测试文件
    ├── api.test.ts
    ├── channels.test.ts
    ├── errors.test.ts
    └── smoke.test.ts
```

**子路径导入设计**：preload 通过 `@code-agent/shared/ipc/meta` 子路径导入（[preload/index.ts#L27](file:///src/preload/index.ts#L27)），避免触发主入口的 zod 求值，防止 zod（纯 ESM）被拉进 sandbox preload 的 CJS 构建产物。

## 6. packages/tsconfig/ — TS 预设包

```
packages/tsconfig/
├── base.json             # 严格模式基线（见 02-tech-stack.md §5）
├── node.json             # extends base.json，添加 Node 环境
└── web.json              # extends base.json，添加 DOM 环境
```

## 7. e2e/ — Playwright E2E 测试

```
e2e/
├── playwright.config.ts              # 浏览器模式（dev server @ 5173）
├── playwright.electron.config.ts     # Electron dev 模式
├── playwright.smoke.config.ts        # 生产构建 smoke（win-unpacked）
├── electron.spec.ts                  # 8 用例，Electron 全链路
├── smoke.spec.ts                     # 3 用例，浏览器冒烟
├── smoke.prod.spec.ts                # 5 用例，生产构建冒烟
├── a11y.spec.ts                      # 6 用例，可访问性审计
├── visual.spec.ts                    # 3 用例，视觉回归
└── perf/
    └── navigation.bench.spec.ts      # 5 用例，性能基准
```

## 8. 关键配置文件位置

| 文件 | 路径 |
|---|---|
| 根 tsconfig | [tsconfig.json](file:///tsconfig.json) |
| main tsconfig | [src/main/tsconfig.json](file:///src/main/tsconfig.json) |
| renderer tsconfig | [src/renderer/tsconfig.json](file:///src/renderer/tsconfig.json) |
| preload tsconfig | [src/preload/tsconfig.json](file:///src/preload/tsconfig.json) |
| shared tsconfig | [packages/shared/tsconfig.json](file:///packages/shared/tsconfig.json) |
| TS 预设包 | [packages/tsconfig/](file:///packages/tsconfig/tsconfig.json) |
| electron-vite 配置 | [electron.vite.config.ts](file:///electron.vite.config.ts) |
| biome 配置 | [biome.json](file:///biome.json) |
| electron-builder | [electron-builder.yml](file:///electron-builder.yml) |
| vitest（3 套） | [src/main/vitest.config.ts](file:///src/main/vitest.config.ts) / [src/renderer/vitest.config.ts](file:///src/renderer/vitest.config.ts) / [packages/shared/vitest.config.ts](file:///packages/shared/vitest.config.ts) |
| playwright（3 套） | [e2e/playwright.config.ts](file:///e2e/playwright.config.ts) / [e2e/playwright.electron.config.ts](file:///e2e/playwright.electron.config.ts) / [e2e/playwright.smoke.config.ts](file:///e2e/playwright.smoke.config.ts) |
| sentry | [sentry.properties](file:///sentry.properties) + [.env](file:///.env) |
| audit 白名单 | [.nsprc](file:///.nsprc) |

## 9. 测试目录布局

采用 **`__tests__` 内联**为主 + **`.test.ts` 同目录**为辅的混合策略：

| 位置 | 模式 | 文件数（2026-08-17 实测） |
|---|---|---|
| packages/shared/src/__tests__/ | 内联 __tests__ 目录 | 5（api / channels / errors / smoke / shared-gaps） |
| src/main/ 同目录 .test.ts | colocation | 114 |
| src/renderer/components/{域}/__tests__/ | 内联 __tests__ | 24（分布 chat/agent/common/layout/terminal/git/file-tree/settings/ui/dev 各域） |
| src/renderer/hooks/__tests__/ | 内联 __tests__ | 10 |
| src/renderer/stores/transient/__tests__/ | 内联 __tests__ | 3（terminal / rate-limit / usage） |
| src/renderer/test/ | 独立测试目录 | 5（setup / setup-lang / msw-handlers / smoke.test + __tests__/mock-api.test） |
| e2e/ | 独立 Playwright E2E | 6 spec 文件 |
