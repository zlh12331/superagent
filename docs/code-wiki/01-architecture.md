# 01 · 整体架构

> 覆盖：进程模型、分层架构、目录结构、依赖流向、关键架构决策。

## 1. 进程模型（Electron 三进程）

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer（React，沙箱 sandbox:true, nodeIntegration:false）  │
│   路由 / 组件 / stores / hooks ── window.api.* 白名单        │
└──────────────────────────────┬───────────────────────────────┘
                               │ IPC（类型安全契约，见 03）
┌──────────────────────────────┼───────────────────────────────┐
│ Preload（CJS，contextBridge）│  createIpcApi(IPC_META)        │
└──────────────────────────────┼───────────────────────────────┘
                               │ ipcRenderer.invoke / on
┌──────────────────────────────┴───────────────────────────────┐
│ Main（Node.js）                                               │
│   ServiceContainer ── 21 个 accessor 服务（懒加载 + 反向依赖  │
│   dispose；Agent/Session/File/Search/Terminal/Git/Codebase/  │
│   ToolRegistry+ToolExecutor/Permission/MCP/Prompt/MemoryPort+│
│   MemoryHub/LSP/Goal/IM/RemoteControl/BrowserPreview/Update/ │
│   LlmClient）；cronService 与 agentAskService 是模块级单例，  │
│   非 accessor（cronService.stop() 在 dispose 链首位）         │
│   遥测为 OTel 单通道基建（非 accessor），见 07                 │
└───────────────────────────────────────────────────────────────┘
```

- **Renderer**：纯前端，无 Node 权限，只能调用 preload 暴露的 `window.api.*`。
- **Preload**：`contextBridge.exposeInMainWorld('api', api)`，由定义表 `IPC_META` 自动生成，零手写。
- **Main**：所有真实能力（文件、搜索、终端、数据库、LLM、工具执行）都在此。`ServiceContainer` 统一管理单例生命周期。

## 2. 分层架构

```
┌───────────────────────────────────────────────┐
│ packages/shared   IPC 类型契约 + zod schema   │ ← 单一真源
├───────────────────────────────────────────────┤
│ src/preload       window.api 桥接（CJS, sandbox）│
├───────────────────────────────────────────────┤
│ src/main/ipc      Handler 层（定义表驱动注册）  │
├───────────────────────────────────────────────┤
│ src/main/infra    领域服务（AI/文件/搜索/终端/…）│
│ src/main/security 安全基线（CSP/权限）          │
│ src/main/utils    基础设施（logger/wrap/…）     │
├───────────────────────────────────────────────┤
│ src/renderer      React 渲染层                 │
└───────────────────────────────────────────────┘
```

依赖方向：`renderer → shared(类型)`；`preload → shared(meta)`；`handler → infra 服务`；`infra → shared(schema)`。
**不变量**：`infra` 不得反向依赖 `ipc`；`shared` 不依赖任何运行时大包（zod 通过子路径隔离，避免拖进 preload）。

## 3. 目录结构（仓库根）

```
src/main/          主进程（service-container + infra 服务 + ipc handlers）
  infra/ai/        Agent / Agent-Runtime / LLM 客户端 / Providers / Prompt / cron / 工具 / MCP / Models / Skills / Knowledge
  infra/autostart/ 开机自启（OS 登录项）
  infra/browser/   WebContentsView 浏览器预览（独立 session 分区）
  infra/code-analysis/    代码分析器
  infra/codebase/  codegraph CLI 封装（代码智能查询）
  infra/file/      文件读写 + chokidar 监听
  infra/git/       Git 操作封装（simple-git）
  infra/i18n/      主进程轻量 i18n（工具文案）
  infra/im/        即时通讯渠道适配器（Telegram/钉钉/微信/企微/飞书/QQ/webhook）
  infra/invalidation/ 写路径声明式失效域（IPC 变更后自动失效渲染层 Query）
  infra/lsp/       LSP 客户端 + 语言服务器管理器
  infra/memory-hub/ 记忆引擎 sidecar（上游 TencentDB-Agent-Memory，MemoryPort/capture-wire）
  infra/network/   代理接缝（proxiedFetch，34 号 spec）
  infra/remote/    远程控制（局域网配对）
  infra/search/    ripgrep 搜索（grep/glob）
  infra/storage/   SQLite + Drizzle + keychain + 偏好持久化
  infra/telemetry/ OTel 单通道 + 事件循环延迟监控
  infra/terminal/  node-pty 终端会话池
  infra/update/    自动更新（electron-updater）
  ipc/             各域 handler（定义表驱动注册）
  security/        CSP（security/csp.ts）
  utils/           logger / wrap / window-state / emit-event / error-report
  index.ts         主进程入口
  service-container.ts  统一服务生命周期（21 accessor + dispose 链）
  根级桌面集成：window.ts / tray.ts / deep-link.ts / notification.ts / theme-linkage
src/preload/       contextBridge 桥（index.ts + utils/create-api.ts / utils/ipc-bridge.ts）
src/renderer/      React 层（routes / components / hooks / stores / lib / providers / i18n / styles）
packages/shared/   IPC 契约 + zod schema（单一真源；constants / ipc / schemas 按进程拆出口）
packages/memory-engine/  vendored 记忆引擎上游源码（utilityProcess sidecar，integrity 门禁）
packages/tsconfig/ base / node / web 三档 tsconfig
e2e/               Playwright 三套配置（E2E / Electron / Smoke）+ 视觉/性能/可访问性
scripts/           工程脚本（scaffold / check-* / build-tokens）
docs/design/       设计文档（三区索引制：规范 / 实施记录 / 治理，见其 README.md）
```

关键源文件规模参考：主进程 `infra` 是最大的一块，`ai/` 子目录拆分 `agent / agent-runtime / llm-client / mcp / models / prompt / providers / skills / tools / knowledge / middleware` 多个关注点。

## 4. 关键架构决策（ADR 摘要）

| 决策 | 说明 |
|---|---|
| **类型契约单一真源** | `packages/shared` 定义 `IpcApi` 接口 + channel 常量 + zod schema。preload 用 `satisfies IpcApi` 编译期校验形状；主进程 handler 用 zod 校验入参。改一处全仓同步。 |
| **定义表驱动的 IPC + 编译期双向 parity** | `IPC_META`（纯字符串，preload 安全导入）→ `IPC_DEFINITIONS`（+schema）→ 推导 `IpcApi`。两处用 TS 类型相等检查保证 `meta ⊆ definitions ⊆ meta`，任何一侧多写方法都会编译失败。 |
| **ServiceContainer 单例 + 延迟初始化** | 所有服务懒加载 + 可注入（测试用 `setXxxService`）。dispose 严格按反向依赖顺序（见 02 章）逐步骤 try/catch 隔离。 |
| **StreamText 请求级重试** | 只重试"流创建 + 首 part 读取"阶段，首 part 成功后不重试，避免重复工具副作用。 |
| **plan / build 双模式** | plan 模式按工具类别判定：零副作用类别（`read` 读数据 / `control` 与用户或内部状态交互，经 `isZeroSideEffectTool` 判定）→ auto，其余（edit/exec）→ deny（零副作用只读探索；另有显式逃生舱名单 `PLAN_MODE_CONTROL_TOOLS`，现仅 save_memory——它有持久化副作用，不属零副作用，防计划期不可用）；build 模式写操作走审批流。子代理继承同一 PermissionService（plan 模式下子代理写工具同样被拒）。 |
| **前端 mock 层保留** | 渲染层 `dev/mock-api.ts` 在浏览器 dev 模式（`pnpm dev:web`）提供 `window.api` 全链路模拟，前端可独立于主进程开发；E2E 浏览器模式同走此层。不用 MSW——它拦截 HTTP，本项目 mock 的是 IPC 桥（裁决见 design/20 号）。 |
| **状态管理分工** | IPC `invoke` 的 server state 用 TanStack Query（缓存 + 去重 + 失效）；IPC `on` 推送事件用 Zustand（流式 part / tool progress / file-tree）。**铁律：不要把流式事件塞进 Query。** |
| **安全基线严格** | `sandbox:true` + `contextIsolation:true` + 自定义 CSP 注入 + 拒绝所有 Web 权限请求 + 导航/新窗口白名单（见 02）。 |
| **非必要不自研** | 能在 Vercel AI SDK / 成熟第三方包基础上实现的不自己造轮子（复用 AI SDK streamText、simple-git、codegraph CLI 等）。 |

## 5. 数据与事件流（一条消息的旅程）

```
用户输入 → renderer ChatInput
  → useAgentBridge(AI) invokes `agent:run` (window.api)
  → Main: agent.handler → ServiceContainer.getAgentService().startAgent()
  → AgentService 构造回合 → llmClient(Provider) → AI SDK streamText
  → stream part 经 streamReader/turnRunner 翻译成 TurnEvent
  → 遇到工具调用 → ToolRegistry.toAISDKTools 的 executeHook → ToolExecutor.execute
       → PermissionService 审批决策 → 推送 agent:tool:call 事件 → 渲染层审批卡
       → 用户批准 → 执行 `tool.execute` → 结果回填 → 进入下一轮 (stopWhen)
  → 全部结束后推送 agent:stream:end，渲染层收尾并失效 Query 刷新会话列表
```

核心"多轮循环"由 AI SDK `streamText` 的 `tools` + `stopWhen` 驱动，服务端在 `turn-runner` 里持续读流直到无更多工具调用或达到终止条件。

## 6. 演示与验证

- 全局质量基线（2026-09-30 实测）：`pnpm typecheck` 0 错误 / `pnpm lint` 0 问题 / 单元测试全绿——shared 110 + main 2135（另 8 平台相关 skip）+ renderer 1845 + integration 152 + scripts 364；测试文件 406 个（含 e2e）。数字随代码演进会过时，以 `pnpm test` 现跑结果为准。
- 官方 `README.md` + `docs/design/01-architecture.md` 是产品视角的架构文档，与本文档互补。

## 参考

- 设计规格：`docs/design/01-architecture.md`、`docs/design/02-tech-stack.md`、`docs/design/03-directory-structure.md`、`docs/design/19-ipc-spec.md`、`docs/design/22-ai-tool-spec.md`。