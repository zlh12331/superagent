# 07 · 支撑服务与守护

> 覆盖：文件、搜索、终端、Git、代码智能（codebase）、LSP、远程控制、音频、自动更新、遥测、安全。每个均为 `src/main/infra/` 下的一个模块单例（经 `getXxxService` + `setXxxService` 注入）。

## 1. FileService（`file/file-service.ts`，模块单例）

- 封装：文件读写、目录列表（`read`/`write`/`list`/`create`/`createDir`/`delete`/`rename`）、chokidar 监听（`watchStart`/`watchStop`/`FileWatchEventPayload` 推送 `file:event:watch`）、编码检测（chardet/iconv-lite）、错误分类。
- IPC 域：`file`。
- 依赖：chokidar，`dispose()` 关闭所有 watcher。

## 2. SearchService（`search/search-service.ts`，模块单例）

- 基于 `@vscode/ripgrep` 启动子进程，实现 `grep` / `glob`，解析 JSON Lines，限制最大结果数、处理错误。
- `dispose()` 终止活跃 ripgrep 子进程。

## 3. TerminalService（`terminal/terminal-service.ts`，模块单例）

- 基于 node-pty 的终端会话池：`create/input/resize/kill`，推送 `terminal:event:created/output/exit`，维护输出缓冲。
- IPC 域：`terminal`；`dispose()` kill 所有 pty 进程。
- 渲染层配套 xterm.js + `@xterm/addon-fit`（`TerminalView`）。

## 4. GitService（`git/git-service.ts`，模块单例）

- 用 simple-git 封装 `status / diff / add / commit / push`，统一错误分类、仓库路径隔离。
- IPC 域：`git`（只读查询为主，写操作经工具审批）。

## 5. CodebaseService（`codebase/codebase-service.ts`，模块单例）

- 封装 `codegraph` CLI，提供代码智能查询：`query / explore / node / callers / callees / impact`，含子进程超时与清理保护。
- IPC 域：`codebase`（`codebase:query/explore/node/callers/callees/impact`）。
- 是"代码理解"能力的核心，供 Agent（`grep`/`lsp` 之外）做语义级推理。

## 6. LSP（`lsp/`）

- `lsp-client.ts`：JSON-RPC over stdio 的 LSP 客户端——管理语言服务器进程、initialize 握手、`definition/references/hover` 请求、dispose。
- `lsp-server-manager.ts`：按根目录懒加载并复用 `LspClient`，并发安全，`disposeAll` 统一释放。
- 工具：`lsp-definition.tool` / `lsp-references.tool` 定位/引用。

## 7. 其他支撑

**音频** `audio/audio-capture-service.ts`：麦克风采集 → 录音文件；IPC 域 `audio`（start/append/stop）。
**远程控制** `remote/remote-control.ts`：远程控制能力。
**代码分析** `code-analysis/code-analyzer.ts`：静态代码分析辅助。
**IM 渠道** `im/`：适配 Telegram / 钉钉 / 微信 / 企业微信 / 飞书 / QQ（各 `*-adapter` + `*-stream` / `webhook-channel`），`im-service` 管理渠道、`im-agent-bridge` 把 IM 消息路由进 Agent（无头），`im.handler` 暴露 IPC。
**自动更新** `update/update-service.ts`：electron-updater（github provider，GitHub Releases）+ `app-update.yml`；IPC 域 `update`（check/install/subscribeStatus）。

## 8. MemoryHub 记忆引擎（`memory-hub/`，sidecar）

记忆能力整体基于 **上游 TencentDB-Agent-Memory 引擎**（memory-hub sidecar 子进程），不再自研记忆存储。

| 文件 | 职责 |
|---|---|
| `memory-hub-service.ts` | `MemoryHubService`：管理 sidecar 生命周期（懒启动/停止）、HTTP 端口通信、L0 JSONL 审计镜像（`listL0BySession` / `removeL0JsonlBySession`）；`createDeferredMemoryPort(getService)` 返回注册期可用的延迟端口 |
| `adapter.ts` | `HttpMemoryPort`：实现 `MemoryPort` 接口（capture / recall / search / clear），over HTTP 与引擎交互 |
| `capture-wire.ts` | `createMemoryCaptureWire`：回合结束后从 AgentService 提取用户意图文本 → 引擎记忆捕获（agent.handler 注入）；`extractLastUserText` 解析消息 |
| `llm-config.ts` | `resolveDistillLlmConfig`：蒸馏 LLM 复用应用默认供应商 + keychain（协议不兼容/未配 Key 时优雅降级） |
| `types.ts` | `MemoryPort` / `MemoryCaptureInput` / `MemoryRecallResult` 等契约类型 |

- **hubRoot 来源**：打包 → `process.resourcesPath/memory-hub`（`prepare-memory-hub.mjs` 生成运行目录，extraResources 部署）；dev → 环境变量 `MEMORY_HUB_ROOT`；未配置时 `MemoryHubService` 内部降级为空实现（记忆静默不可用，不阻断应用）。
- **消费方**：`save_memory` / `recall_memory` 工具（经 `ToolRegistry` 注入 `MemoryPort`）、`memory` 域 IPC handler、`agent:run` 的记忆自动捕获。

## 9. 遥测（`telemetry/`）

| 文件 | 职责 |
|---|---|
| `otel.ts` | OpenTelemetry 初始化/关闭（`initTelemetry`/`shutdownTelemetry`），无 endpoint 退化为 Console |
| `sdk-telemetry.ts` | OTel SDK 装配（resources / processor / exporter） |
| `memory-monitor.ts` | 主进程内存监控（60s 采样、连续增长阈值告警） |
| `event-loop-lag.ts` | 事件循环延迟检测 |

## 10. 安全（`security/csp.ts`）

- `buildCsp(isDev)`：返回 CSP 响应头。生产严格（禁外联）、开发宽松（允许 HMR）。
- CSP 允许 Google Fonts（Typography）；跳过 `chrome-extension://`（见 02-§3.3）。
- 配套：主进程索引里的权限请求拒绝、导航/新窗口白名单。

## 11. 跨服务工具（`utils/`）

| 文件 | 职责 |
|---|---|
| `logger.ts` | electron-log 封装 + 全局错误捕获 + 崩溃标记（`hasCrashMarker`/`clearCrashMarker`） |
| `wrap.ts` | IPC 中间件（traceId/sender/zod/Sentry，见 03） |
| `emit-event.ts` | 事件发送统一封装（推送渲染层，含 webContents 销毁保护） |
| `window-state.ts` | 窗口状态记忆（move/resize 防抖 + close 落盘） |

## 12. 依赖注入要点

这些服务大多以"模块级 `getXxxService()` 单例 + 容器 `setXxxService()` 注入"方式对外。容器定义的安全顺序（见 `service-container.ts`）：`file`/`search`/`terminal`/`git`/`session` 等被工具系统与 AI 层依赖，因此 `getToolRegistry()` 首访时必须先 `getFileService()`/`getSearchService()`。dispose 时这些服务在工具/权限/AI 之后清理。