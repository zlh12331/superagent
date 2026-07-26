# 目录结构文档

> 基于 `novel-writer-agent` v0.1.3 实际目录扫描整理。
> 整理时间：2026-07-23

## 1. 顶层结构

```
f:\TraeProjects\1\
├── .github/workflows/        # CI/CD（ci.yml + release.yml）
├── docs/                     # 文档
│   ├── design/               # 本设计文档集
│   ├── 参考项目/             # 第三方参考项目源码副本（不入索引）
│   ├── rust-dev-standards-ai.txt
│   ├── software-architecture-principles-ai.txt
│   └── typescript-dev-standards-ai.txt
├── e2e/                      # Playwright E2E 测试
├── packages/                 # pnpm workspace 内部包
│   ├── shared/               # @novel-writer/shared 跨进程共享包
│   └── tsconfig/             # @novel-writer/tsconfig 统一 TS 预设
├── resources/                # 应用资源（图标等）
├── scripts/                  # 工具脚本
├── src/
│   ├── main/                 # Electron 主进程
│   ├── preload/              # Preload 脚本
│   └── renderer/             # React 19 渲染层
├── .biome.json               # Biome lint + format 配置
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

### 2.1 src/main/infra/ — 业务服务（按业务域分 7 个子目录，47 个 .ts 文件）

| 域 | 文件数 | 关键文件 |
|---|---|---|
| ai/（顶层） | 10 | [agent-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/agent-service.ts) / [chat-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/chat-service.ts) / [ai-provider.ts](file:///f:/TraeProjects/1/src/main/infra/ai/ai-provider.ts) / [tool-registry.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tool-registry.ts) / [tool-executor.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tool-executor.ts) / [permission-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/permission-service.ts) / [tool.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tool.ts) / [error-classifier.ts](file:///f:/TraeProjects/1/src/main/infra/ai/error-classifier.ts) + 2 测试 |
| ai/mcp/ | 9 | [mcp-client.ts](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-client.ts) / [mcp-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-service.ts) / [mcp-tool-adapter.ts](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-tool-adapter.ts) / [mcp-types.ts](file:///f:/TraeProjects/1/src/main/infra/ai/mcp/mcp-types.ts) + 4 测试 + index.ts |
| ai/prompt/ | 6 | [prompt-service.ts](file:///f:/TraeProjects/1/src/main/infra/ai/prompt/prompt-service.ts) / [default-prompt.ts](file:///f:/TraeProjects/1/src/main/infra/ai/prompt/default-prompt.ts) / [dynamic-context.ts](file:///f:/TraeProjects/1/src/main/infra/ai/prompt/dynamic-context.ts) / [agents-md.ts](file:///f:/TraeProjects/1/src/main/infra/ai/prompt/agents-md.ts) / [git-adapter.ts](file:///f:/TraeProjects/1/src/main/infra/ai/prompt/git-adapter.ts) / index.ts |
| ai/tools/ | 9 | 7 个工具 + [path-guard.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/path-guard.ts) + [index.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/index.ts) |
| storage/ | 8 | [db.ts](file:///f:/TraeProjects/1/src/main/infra/storage/db.ts) / [schema.ts](file:///f:/TraeProjects/1/src/main/infra/storage/schema.ts) / [session-service.ts](file:///f:/TraeProjects/1/src/main/infra/storage/session-service.ts) / [keychain.ts](file:///f:/TraeProjects/1/src/main/infra/storage/keychain.ts) / [app-data.ts](file:///f:/TraeProjects/1/src/main/infra/storage/app-data.ts) / [telemetry-pref.ts](file:///f:/TraeProjects/1/src/main/infra/storage/telemetry-pref.ts) + 2 测试 |
| codebase/ | 1 | [codebase-service.ts](file:///f:/TraeProjects/1/src/main/infra/codebase/codebase-service.ts) |
| file/ | 1 | [file-service.ts](file:///f:/TraeProjects/1/src/main/infra/file/file-service.ts) |
| git/ | 1 | [git-service.ts](file:///f:/TraeProjects/1/src/main/infra/git/git-service.ts) |
| search/ | 1 | [search-service.ts](file:///f:/TraeProjects/1/src/main/infra/search/search-service.ts) |
| terminal/ | 1 | [terminal-service.ts](file:///f:/TraeProjects/1/src/main/infra/terminal/terminal-service.ts) |

### 2.2 src/main/ipc/ — IPC Handler（14 个 handler 文件）

按域对应关系见 [01-architecture.md §3.1](file:///f:/TraeProjects/1/docs/design/01-architecture.md) 的 IPC 表格。每个 handler 文件注册本域的 invoke + subscribe 通道。

### 2.3 其他 src/main 子目录

| 目录 | 文件 | 职责 |
|---|---|---|
| config/ | [index.ts](file:///f:/TraeProjects/1/src/main/config/index.ts) + [config.test.ts](file:///f:/TraeProjects/1/src/main/config/config.test.ts) | 应用配置（环境变量读取、缓存） |
| security/ | — | CSP 策略注入相关 |
| telemetry/ | [otel.ts](file:///f:/TraeProjects/1/src/main/telemetry/otel.ts) | OpenTelemetry 初始化 |
| utils/ | [logger.ts](file:///f:/TraeProjects/1/src/main/utils/logger.ts) / [wrap.ts](file:///f:/TraeProjects/1/src/main/utils/wrap.ts) / [retry.ts](file:///f:/TraeProjects/1/src/main/utils/retry.ts) + 测试 | 工具函数 |
| index.ts | [src/main/index.ts](file:///f:/TraeProjects/1/src/main/index.ts) | 主进程入口 |
| service-container.ts | [src/main/service-container.ts](file:///f:/TraeProjects/1/src/main/service-container.ts) | 13 服务统一生命周期管理 |

### 2.4 src/main/infra/ai/tools/ — 内置工具（7 个）

实际注册 7 个工具（[index.ts#L60-L72](file:///f:/TraeProjects/1/src/main/infra/ai/tools/index.ts#L60)）：

| 工具文件 | 工具名 | 权限 | 依赖 |
|---|---|---|---|
| [read-file.tool.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/read-file.tool.ts) | read_file | auto | IFileService |
| [write-file.tool.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/write-file.tool.ts) | write_file | ask | IFileService |
| [edit-file.tool.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/edit-file.tool.ts) | edit_file | ask | 无 |
| [list-directory.tool.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/list-directory.tool.ts) | list_directory | auto | IFileService |
| [grep.tool.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/grep.tool.ts) | grep | auto | ISearchService |
| [glob.tool.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/glob.tool.ts) | glob | auto | ISearchService |
| [run-command.tool.ts](file:///f:/TraeProjects/1/src/main/infra/ai/tools/run-command.tool.ts) | run_command | ask | 无 |

## 3. src/preload/ — Preload 脚本

```
src/preload/
├── index.ts              # contextBridge 暴露 window.api（14 个域）
├── utils/
│   └── ipc-bridge.ts     # invoke/subscribe 底层封装（traceId 自动注入）
└── tsconfig.json         # sandbox CJS 配置
```

## 4. src/renderer/ — React 19 渲染层

约 76 个 .ts/.tsx 文件。

```
src/renderer/
├── components/           # 32 个组件（不含测试）
│   ├── agent/            # 2 个（Agent 相关 UI）
│   ├── chat/             # 3 个（Chat 相关 UI）
│   ├── common/           # 6 个（通用组件）
│   ├── dev/              # 4 个（LogsPanel / MetricsPanel / InspectorPanel 等）
│   ├── git/              # 1 个（GitPanel）
│   ├── layout/           # 4 个（DevPanel / 主布局）
│   ├── settings/         # 1 个
│   ├── terminal/         # 1 个（TerminalPanel）
│   └── ui/               # 13 个（shadcn 基础组件）
├── hooks/                # 11 个 + 2 测试
│   ├── use-active-session.ts
│   ├── use-agent.ts
│   ├── use-api-key.ts
│   ├── use-approval-bridge.ts
│   ├── use-chat.ts
│   ├── use-git.ts
│   ├── use-sessions.ts
│   ├── use-system.ts
│   ├── use-telemetry.ts
│   ├── use-terminal-bridge.ts
│   └── use-tool-bridge.ts
├── stores/               # 7 个 + 1 测试（三层架构）
│   ├── persistent/       # sessions / settings / create-persistent-store
│   ├── server/           # create-ipc-stream-store（TanStack Query 模式）
│   └── transient/        # approvals / terminal / tool
├── lib/                  # 9 个
│   ├── agent/            # ipc-agent-transport
│   ├── chat/             # ipc-chat-transport
│   ├── motion/           # index + transitions + variants
│   ├── query/            # query-client
│   ├── constants.ts
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
├── test/                 # 3 个（setup / msw-handlers / smoke.test）
│   └── __tests__/mock-api.test.ts
├── App.tsx
├── main.tsx              # 渲染层入口
├── router.tsx
├── instrumentation.ts    # Sentry 浏览器侧初始化
├── index.html
├── index.css
├── vite-env.d.ts
└── components.json       # shadcn 配置
```

## 5. packages/shared/ — 跨进程共享包

[packages/shared/src/index.ts](file:///f:/TraeProjects/1/packages/shared/src/index.ts) 统一导出，22 个 .ts 文件（含 4 测试）：

```
packages/shared/src/
├── index.ts              # barrel 导出
├── constants/
│   └── errors.ts         # AppError + ErrorCode 错误码（6 组分类）
├── ipc/
│   ├── channels.ts       # 51 个 IPC_CHANNELS 常量 + IpcChannel 联合类型
│   ├── api.ts            # IpcApi 接口契约（14 域方法签名）
│   ├── payloads.ts       # payload 类型映射
│   └── response.ts       # IpcResponse 判别联合
├── schemas/              # 12 个 Zod schema 文件
│   ├── agent.ts          # AgentRunReqSchema / AgentStreamPartPayload 等
│   ├── chat.ts           # ChatMessageSchema（复用 AI SDK ModelMessage）
│   ├── codebase.ts
│   ├── devtools.ts
│   ├── file.ts
│   ├── git.ts
│   ├── search.ts
│   ├── session.ts
│   ├── settings.ts
│   ├── system.ts
│   ├── terminal.ts
│   └── tool.ts
└── __tests__/            # 4 测试文件
    ├── api.test.ts
    ├── channels.test.ts
    ├── errors.test.ts
    └── smoke.test.ts
```

**子路径导入设计**：preload 通过 `@novel-writer/shared/ipc/channels` 子路径导入（[preload/index.ts#L30](file:///f:/TraeProjects/1/src/preload/index.ts#L30)），避免触发主入口的 zod 求值，防止 zod（纯 ESM）被拉进 sandbox preload 的 CJS 构建产物。

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
| 根 tsconfig | [tsconfig.json](file:///f:/TraeProjects/1/tsconfig.json) |
| main tsconfig | [src/main/tsconfig.json](file:///f:/TraeProjects/1/src/main/tsconfig.json) |
| renderer tsconfig | [src/renderer/tsconfig.json](file:///f:/TraeProjects/1/src/renderer/tsconfig.json) |
| preload tsconfig | [src/preload/tsconfig.json](file:///f:/TraeProjects/1/src/preload/tsconfig.json) |
| shared tsconfig | [packages/shared/tsconfig.json](file:///f:/TraeProjects/1/packages/shared/tsconfig.json) |
| TS 预设包 | [packages/tsconfig/](file:///f:/TraeProjects/1/packages/tsconfig/tsconfig.json) |
| electron-vite 配置 | [electron.vite.config.ts](file:///f:/TraeProjects/1/electron.vite.config.ts) |
| biome 配置 | [biome.json](file:///f:/TraeProjects/1/biome.json) |
| electron-builder | [electron-builder.yml](file:///f:/TraeProjects/1/electron-builder.yml) |
| vitest（3 套） | [src/main/vitest.config.ts](file:///f:/TraeProjects/1/src/main/vitest.config.ts) / [src/renderer/vitest.config.ts](file:///f:/TraeProjects/1/src/renderer/vitest.config.ts) / [packages/shared/vitest.config.ts](file:///f:/TraeProjects/1/packages/shared/vitest.config.ts) |
| playwright（3 套） | [e2e/playwright.config.ts](file:///f:/TraeProjects/1/e2e/playwright.config.ts) / [e2e/playwright.electron.config.ts](file:///f:/TraeProjects/1/e2e/playwright.electron.config.ts) / [e2e/playwright.smoke.config.ts](file:///f:/TraeProjects/1/e2e/playwright.smoke.config.ts) |
| sentry | [sentry.properties](file:///f:/TraeProjects/1/sentry.properties) + [.env](file:///f:/TraeProjects/1/.env) |
| audit 白名单 | [.nsprc](file:///f:/TraeProjects/1/.nsprc) |

## 9. 测试目录布局

采用 **`__tests__` 内联**为主 + **`.test.ts` 同目录**为辅的混合策略：

| 位置 | 模式 | 文件数 |
|---|---|---|
| packages/shared/src/__tests__/ | 内联 __tests__ 目录 | 4 |
| src/main/ 同目录 .test.ts | colocation | 12 |
| src/renderer/components/{域}/__tests__/ | 内联 __tests__ | 3（DevPanel / GitPanel / TerminalPanel） |
| src/renderer/hooks/__tests__/ | 内联 __tests__ | 2（use-git / use-terminal-bridge） |
| src/renderer/stores/transient/__tests__/ | 内联 __tests__ | 1（terminal-store） |
| src/renderer/test/ | 独立测试目录 | 3（setup / msw-handlers / smoke.test）+ __tests__/mock-api.test |
| e2e/ | 独立 Playwright E2E | 6 spec 文件 |
