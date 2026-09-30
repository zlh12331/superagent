# 02 · 主进程入口与生命周期

> 覆盖：`src/main/index.ts` 启动链、`ServiceContainer` 生命周期、进程安全基线、窗口创建。

## 1. 入口 `src/main/index.ts`

### 1.1 启动阶段顺序（`app.whenReady()` 链）

```
whenReady
 ├─ 单实例锁（requestSingleInstanceLock；失败则 quit；whenReady 内再查 gotTheLock 双保险）
 ├─ initLogger()           初始化 electron-log（需要 app.getPath，必须在 whenReady 后）
 ├─ initTelemetry()        初始化 OpenTelemetry（遥测级别 off→跳过；无 endpoint 退化为 Console）
 ├─ initDb()               SQLite（建表幂等 + WAL + 外键 + 备份轮转 + 损坏自愈）
 ├─ initMainI18n()         主进程 i18n（读 app_settings language 域，缺失回退 zh-CN）
 ├─ applyProxyChange()     34 号：代理配置启动应用（在 initDb 后、IM 渠道前；fire-and-forget 失败仅 warn）
 ├─ promptService.initialize()  幂等插入默认 Code Agent prompt（onConflictDoNothing）
 ├─ registerGlobalErrorHandlers()
 ├─ recoverFromCrash()     无条件执行：残留 running 会话标 interrupted + 残留 running 任务标
 │                         failed + 清崩溃标记（崩溃标记只影响日志口径，不门控恢复本身）
 ├─ pruneExpiredUsage()    清理 90 天窗口外的 token_usage（与用量页查询窗口对齐）
 ├─ initRuntimeModels()    自定义模型注册到 ModelRegistry（LLM 调用前）
 ├─ skillRegistry.loadFromRows(new LearnSkillService(llmClient).listLearned())  已学技能合并
 ├─ serviceContainer.initImChannels()  已配置 IM 渠道自动连接（含 IM→Agent 桥接挂载；
 │                         初始化 Promise 存入 imChannelsInit，退出时先等它落定再 stopAll）
 ├─ serviceContainer.initSubagents()   run_subagent 工具依赖
 ├─ mountTurnNotifications / mountApprovalNotifications  系统通知（后台回合 + 审批等待）
 ├─ initCronScheduler()    定时任务调度接线（须在 initDb 之后）
 ├─ registerIpcHandlers({...域 handler})   定义表驱动，缺失编译期报错
 ├─ updateService.start()  注册 autoUpdater 事件（devUpdateEnabled 需 CODE_AGENT_DEV_UPDATE=1）
 ├─ 注入 CSP 响应头（applyCspToSession）+ 权限请求默认拒绝
 ├─ startMemoryMonitor()   主进程内存泄漏哨兵（60s 采样）
 ├─ EventLoopLagMonitor    事件循环延迟监控（活跃回合上下文报告，见 lag-alert）
 └─ createWindow() + createTray()   主窗口 + 托盘（deep-link 冷启动 URL 从 argv 补捞）
```

关窗协商在 window.ts close handler 与 before-quit 双路径共享 `isCloseConfirmed` 标志（`CODE_AGENT_SKIP_CLOSE_GUARD=1` 豁免）；运行中回合弹确认。

### 1.2 单实例锁

- `app.requestSingleInstanceLock()` 失败 → 立即 `app.quit()`（不初始化任何服务）。
- `second-instance` 事件：聚焦/还原已有主窗口。

### 1.3 环境与 userData

- **dev 模式**：`userData` 重定向到项目内 `.electron-user-data/`（可用 `CODE_AGENT_USER_DATA` 覆盖，多实例隔离避免 SQLite 锁冲突）；开启 `remote-debugging-port`（默认 9222，`CODE_AGENT_DEBUG_PORT` 可覆盖，供 CDP 直连调试）。
- **生产**：使用系统默认 `%APPDATA%/<AppName>`。
- `.env`：dev 通过 Node 内置 `process.loadEnvFile()` 加载（NODE_ENV=test 跳过）。

### 1.4 退出清理（`before-quit`）

运行中回合先协商（确认弹窗，`isCloseConfirmed` 与窗口 close 路径共享标志）→ `preventDefault` + `setQuitting()` → 停 lagMonitor/内存监控 → 等 `imChannelsInit` 落定（3s 超时兜底）→ `disposeImChannels()` → `disposeServices()`（含 closeDb，`pendingBackup` 机制等待在途备份落地）→ `shutdownTelemetry()`（flush span）→ `runDeferredInstall()`（Windows 更新：应用完全退出后再拉起安装器，消除 NSIS「无法关闭」竞态）→ `app.exit(0)`。清理失败仅记日志不阻断退出。

### 1.5 错误兜底

`whenReady().catch` 捕获启动链任何同步抛错 → `console.error` + `dialog.showErrorBox` + `app.exit(1)`。

## 2. 服务生命周期 `src/main/service-container.ts`

### 2.1 单例模式

```ts
export const serviceContainer = new ServiceContainer();
serviceContainer.getAgentService();        // get 惰性初始化
serviceContainer.setAgentService(mock | null);  // 仅测试用注入
```

每个服务都遵循 "get 惰性 + set 注入 + dispose 反向依赖" 三段式。工具系统三件套 `ToolRegistry / PermissionService / ToolExecutor` 由容器直接 `new`（非模块级单例）。

### 2.2 关键 getter 与依赖注入

| getter | 初始化依赖 | 备注 |
|---|---|---|
| `getPromptService()` | gitSummaryProvider 闭包（动态上下文取真实 git 值） | DB 模板 + `{{gitBranch}}`/`{{gitStatus}}`/`{{agentsMd}}` 注入 |
| `getAgentService()` | ToolRegistry + ToolExecutor + PromptService + SessionService + llmClient（标题生成 + repairToolCall 工具入参修复）+ gate + PermissionService | 通过 `ToolRegistry.toAISDKTools` 注入 `executeHook`（=ToolExecutor.execute） |
| `getToolRegistry()` | FileService + SearchService + TerminalService + GitService + MemoryPort（memory-hub）+ LspManager + agentAskService + PermissionService + CodebaseService | 首次访问注册 34 个内置工具（tools/index.ts 为清单真源） |
| `getPermissionService()` | CommandClassifier(llmClient) + 启动时 `readApprovalModeSync()` | 控制写操作审批 |
| `getMcpService()` | ToolRegistry | stopAll 关闭 MCP server 子进程 |
| `getMemoryPort()` | MemoryHubService（懒启动 sidecar） | save_memory / recall_memory 工具注册期即可用，首次调用启动引擎 |
| `getMemoryHubService()` | memory-hub sidecar（上游 TencentDB-Agent-Memory） | 未配置 hubRoot 时内部降级为空实现（记忆静默不可用） |
| `getCodebaseService()/getFileService()/...` | 各自模块单例 | 惰性包装 |
| `getGoalService()` | AgentService + GoalJudge(llmClient) | mount 回合监听 |
| `getImService()` | AgentService + PermissionService + SessionService（经 ImAgentBridge） | mount IM→Agent 桥 |
| `getLspManager()` | 首次工具调用才创建（读 app_settings `lsp.serverCommands` 覆盖） | 懒加载 |

### 2.3 dispose() 顺序（反向依赖，每步 try/catch 隔离）

```
cronService.stop（最先：fire 会触发 agent 回合，防半拆解容器再起新回合）
→ goalService.unmount → imBridge.unmount → imService.stopAll（先停回合依赖方，
  drain 窗口内到达的 IM/远程命令不得再发起新回合）
→ remoteControl.release → agentService.dispose（drain：等活跃 stream 进入
  finally，3s 超时兜底）→ markInterruptedOnShutdown（退出善后：残留 running
  标 interrupted，消除「干净退出留 stale running」窗口）
→ mcpService.stopAll → lspManager.disposeAll（S14 修复：移到 agent drain 后，
  drain 窗口内 LSP 工具调用仍可用）
→ permissionService.dispose（含清空 ToolExecutor/ToolRegistry 引用）
→ agentAskService.dispose → fileService.dispose（chokidar watcher）
→ searchService.dispose（ripgrep 子进程）→ terminalService.dispose（pty）
→ gitService / codebaseService.dispose → sessionService.dispose（不关 db）
→ memoryHub.stop（sidecar 子进程）→ updateService.dispose → browserPreview.dispose
→ resetAIProvider → closeDb（最后）
```

实测以 service-container.ts `dispose()` 步骤注释为准（步骤号 1.8→11.5，2026-09-30 核对）：

- `runStep` 独立 try/catch：单步失败不跳过后续，`failures[]` 汇总记录。
- 退出路径整体顺序（index.ts before-quit）：lagMonitor/内存监控先停 → 等 imChannelsInit 落定（3s 超时兜底）→ disposeImChannels → disposeServices → shutdownTelemetry（flush span）→ runDeferredInstall（Windows 更新安装器拉起）→ app.exit(0)。

### 2.4 reset()（测试用）

与 dispose 不同：**不调用外部服务的 dispose**，仅清空引用并 fire-and-forget 停 MCP/IM，最后 `resetDb()` + `resetConfigCache()`。

### 2.5 崩溃恢复 `recoverFromCrash()`

启动期**无条件执行**（不依赖崩溃标记——标记只影响日志口径）：`markAllInterrupted()`（残留 running 会话 → interrupted）+ `taskService.markAllRunningFailed()`（残留 running 任务 → failed，2026-09-08 修复）→ `clearCrashMarker()`。与退出善后 `markInterruptedOnShutdown` 首尾呼应：外部工具/备份脚本读到的会话状态一律是终态。

### 2.6 导出别名

`disposeServices()` / `resetServices()` / `initRuntimeModels()` 兼容旧 API，委托给 `serviceContainer`。

## 3. 窗口创建与安全基线（`createWindow`）

### 3.1 BrowserWindow 配置

- 宽高恢复（`window-state.json`，校验不可见时回退 1280×800），`minWidth:960` / `minHeight:640`，`minWidth` 保证聊天输入区可见。
- 无边框标题栏：`titleBarStyle:'hidden'`；非 macOS 用 `titleBarOverlay`（透明底 + `symbolColor:#a8a29e` + 高度 52px）。
- **webPreferences**：`preload: ../preload/index.cjs`、`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`webSecurity:true`。

### 3.2 导航/弹窗限制

- `will-navigate`：仅允许 `http://localhost` 与 `app://`，其余 `preventDefault`。
- `setWindowOpenHandler`：`http` 链接走 `shell.openExternal`，统一 `deny` 新窗口。

### 3.3 运行时安全

- **CSP**：`applyCspToSession` 唯一注入入口（CSP / `X-Content-Type-Options: nosniff` / `X-Frame-Options` 三头一并），生产严格 / 开发宽松（允许 HMR）。跳过 `chrome-extension://` 协议响应（避免与 React DevTools 扩展自身 CSP 冲突）。
- **权限请求**：`setPermissionRequestHandler` 默认拒绝所有（摄像头/麦克风/地理位置/通知等），显式拒绝 + 日志（拒绝而非忽略，避免 Electron 默认放行）。
- **内存监控**：60s 采样，连续 3 次单调增长且累计 > 150MB 才告警（防 GC 抖动误报）；事件循环延迟监控（EventLoopLagMonitor）按活跃回合上下文报告。

### 3.4 静默启动与唤回

开机自启（Windows/Linux 登录项携带 `--hidden` 参数；macOS 走 `wasOpenedAtLogin` 判定——ServiceManagement 不透传 args）→ `startHidden` 不显示窗口。唤回唯一实现 `window-show.ts`（show + 首次唤回应用挂起的 maximize——直接 maximize 会隐式显示窗口导致 --hidden 失效，2026-09-21 真机实测教训；三份副本曾不一致致托盘驻留后唤不回，已收敛单点）。

### 3.5 开发辅助

dev 环境自动 `installExtension(REACT_DEVELOPER_TOOLS)`（失败容忍）+ `openDevTools({mode:'detach'})`（生产不触发）。

### 3.6 macOS 行为

- `activate` 时无窗口则 `createWindow`（经 window-show 单点）。
- `window-all-closed`：非 darwin 才 `app.quit()`。

## 4. 遥测初始化

| 组件 | 说明 |
|---|---|
| OpenTelemetry | `initTelemetry()` whenReady 后；采集 agent.streamText / tool.execute / IPC 业务 span；遥测级别 off→跳过初始化；无 `OTEL_EXPORTER_OTLP_ENDPOINT` 退化为 Console |

> 错误处理为本地优先（2026-09-13 移除 Sentry）：异常经 `utils/error-report.ts` 单一出口落本地日志（渲染层经 electron-log 转发主进程，随诊断包导出）。

## 5. 关键文件清单

| 文件 | 职责 |
|---|---|
| [index.ts](file:///src/main/index.ts) | 主进程入口、生命周期、窗口、安全 |
| [service-container.ts](file:///src/main/service-container.ts) | 服务单例 + 生命周期（21 accessor + dispose 链 + recoverFromCrash） |
| [config/index.ts](file:///src/main/config/index.ts) | AppConfig（环境配置读取） |
| [security/csp.ts](file:///src/main/security/csp.ts) | 安全响应头唯一注入入口（CSP/nosniff/XFO） |
| [utils/logger.ts](file:///src/main/utils/logger.ts) | electron-log + 全局错误处理 + 崩溃标记 |
| [utils/window-state.ts](file:///src/main/utils/window-state.ts) | 窗口尺寸状态记忆 |
| [window.ts](file:///src/main/window.ts) | 窗口创建/close 协商/静默启动（根级） |
| [quit-state.ts](file:///src/main/quit-state.ts) | 退出标志进程级单点（isQuitting/isCloseConfirmed 双路径共享） |
| [window-show.ts](file:///src/main/window-show.ts) | 窗口唤回唯一实现（托盘/通知/桌面图标共用） |
| [infra/autostart/autostart.ts](file:///src/main/infra/autostart/autostart.ts) | 开机自启（OS 登录项，托盘与设置页同源） |