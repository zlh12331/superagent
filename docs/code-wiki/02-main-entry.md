# 02 · 主进程入口与生命周期

> 覆盖：`src/main/index.ts` 启动链、`ServiceContainer` 生命周期、进程安全基线、窗口创建。

## 1. 入口 `src/main/index.ts`

### 1.1 启动阶段顺序（`app.whenReady()` 链）

```
whenReady
 ├─ 单实例锁（requestSingleInstanceLock；失败则 quit）
 ├─ initSentry()           ← 必须在 whenReady 之前（已先执行）
 ├─ initLogger()           初始化 electron-log
 ├─ initTelemetry()        初始化 OpenTelemetry（无 endpoint 退化为 Console）
 ├─ initDb()               SQLite（建表幂等 + WAL + 外键）
 ├─ promptService.initialize()  幂等插入默认 Code Agent prompt（onConflictDoNothing）
 ├─ registerGlobalErrorHandlers()
 ├─ recoverFromCrash()     上次异常退出 → 残留 running 会话标 interrupted + 清崩溃标记
 ├─ initRuntimeModels()    自定义模型注册到 ModelRegistry（LLM 调用前）
 ├─ skillRegistry.loadFromRows(learnSkillService.listLearned())  已学技能合并
 ├─ serviceContainer.initImChannels()  已配置 IM 渠道自动连接
 ├─ serviceContainer.initSubagents()   run_subagent 工具依赖
 ├─ registerIpcHandlers({...18 域 handler})   定义表驱动，缺失编译期报错
 ├─ updateService.start()  注册 autoUpdater 事件
 ├─ 注入 CSP 响应头（buildCsp）+ 权限请求拒绝
 ├─ startMemoryMonitor()   主进程内存泄漏哨兵
 └─ createWindow()        创建主窗口
```

### 1.2 单实例锁

- `app.requestSingleInstanceLock()` 失败 → 立即 `app.quit()`（不初始化任何服务）。
- `second-instance` 事件：聚焦/还原已有主窗口。

### 1.3 环境与 userData

- **dev 模式**：`userData` 重定向到项目内 `.electron-user-data/`（可用 `CODE_AGENT_USER_DATA` 覆盖，多实例隔离避免 SQLite 锁冲突）；开启 `remote-debugging-port`（默认 9222，`CODE_AGENT_DEBUG_PORT` 可覆盖，供 CDP 直连调试）。
- **生产**：使用系统默认 `%APPDATA%/<AppName>`。
- `.env`：dev 通过 Node 内置 `process.loadEnvFile()` 加载（NODE_ENV=test 跳过）。

### 1.4 退出清理（`before-quit`）

`preventDefault()` → `disposeImChannels()` → `disposeServices()` → `shutdownTelemetry()`（flush span）→ `Sentry.close(2000)`（flush 错误）→ `app.exit(0)`。`isQuitting` 标志防重入。

### 1.5 错误兜底

`whenReady().catch` 捕获启动链任何同步抛错 → `console.error` + `dialog.showErrorBox` + `app.exit(1)`。

## 2. 服务生命周期 `src/main/service-container.ts`

### 2.1 单例模式

```ts
export const serviceContainer = new ServiceContainer();
let serviceContainer.getChatService(): IChatService;   // get 惰性初始化
serviceContainer.setChatService(mock | null);          // 仅测试用注入
```

每个服务都遵循 "get 惰性 + set 注入 + dispose 反向依赖" 三段式。工具系统三件套 `ToolRegistry / PermissionService / ToolExecutor` 由容器直接 `new`（非模块级单例）。

### 2.2 关键 getter 与依赖注入

| getter | 初始化依赖 | 备注 |
|---|---|---|
| `getChatService()` | SessionService + llmClient + concurrencyGate | 全局并发公平调度门（chat+agent 共用 FIFO 槽位，防 429） |
| `getAgentService()` | ToolRegistry + ToolExecutor + PromptService + SessionService + llmClient + gate + PermissionService | 通过 `ToolRegistry.toAISDKTools` 注入 `executeHook`（=ToolExecutor.execute） |
| `getToolRegistry()` | FileService + SearchService + TerminalService + GitService + MemoryService + LspManager + agentAskService + PermissionService | 首次访问注册 29 个内置工具 |
| `getPermissionService()` | CommandClassifier(llmClient) + 启动时 `readApprovalModeSync()` | 控制写操作审批 |
| `getMcpService()` | ToolRegistry | stopAll 关闭 MCP server 子进程 |
| `getCodebaseService()/getFileService()/...` | 各自模块单例 | 惰性包装 |
| `getGoalService()` | AgentService + GoalJudge(llmClient) | mount 回合监听 |
| `getImService()` | AgentService + PermissionService + SessionService（经 ImAgentBridge） | mount IM→Agent 桥 |
| `getLspManager()` | 首次工具调用才创建 | 懒加载 |

### 2.3 dispose() 顺序（反向依赖，每步 try/catch 隔离）

```
lspManager.disposeAll → chatService.dispose → agentService.dispose
→ mcpService.stopAll → goalService.unmount → imBridge.unmount → imService.stopAll
→ permissionService.dispose → agentAskService.dispose → fileService.dispose
→ searchService.dispose → terminalService.dispose → gitService / codebaseService / sessionService.dispose
→ prompt/memory/updateService 清引用 → resetAIProvider → closeDb（最后）
```

- `runStep` 独立 try/catch：单步失败不跳过后续，`failures[]` 汇总记录。
- `ChatService.dispose()` 等待活跃 stream 真正进入 finally（3s 超时兜底），避免 IPC send 丢失/渲染层 loading 卡死。

### 2.4 reset()（测试用）

与 dispose 不同：**不调用外部服务的 dispose**，仅清空引用并 fire-and-forget 停 MCP/IM，最后 `resetDb()` + `resetConfigCache()`。

### 2.5 崩溃恢复 `recoverFromCrash()`

`hasCrashMarker()` 检测上次异常退出 → `sessionService.markAllInterrupted()` → `clearCrashMarker()`。

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

- **CSP**：主进程注入响应头（`buildCsp`），生产严格 / 开发宽松（允许 HMR）。跳过 `chrome-extension://` 协议响应（避免与 React DevTools 扩展自身 CSP 冲突）。`X-Content-Type-Options: nosniff`；`X-Frame-Options`（生产 DENY / 开发 SAMEORIGIN，仅 http）。
- **权限请求**：`setPermissionRequestHandler` 默认拒绝所有（摄像头/麦克风/地理位置/通知等），显式拒绝 + 日志。
- **内存监控**：60s 采样，连续 3 次单调增长且累计 > 150MB 才告警（Sentry warning）。

### 3.4 开发辅助

dev 环境自动 `installExtension(REACT_DEVELOPER_TOOLS)`（失败容忍）+ `openDevTools({mode:'detach'})`（生产不触发）。

### 3.5 macOS 行为

- `activate` 时无窗口则 `createWindow`。
- `window-all-closed`：非 darwin 才 `app.quit()`。

## 4. 遥测初始化

| 组件 | 说明 |
|---|---|
| Sentry | `initSentry()` 在 whenReady 前；读 `telemetry-pref.json` 级别（off→跳过 / error-only→tracesSampleRate=0 / full）；`beforeSend` 脱敏移除 `Authorization` header；`startupTracingIntegration` 启动追踪 |
| OTel | `initTelemetry()` whenReady 后；采集 agent.streamText / tool.execute / IPC 业务 span；无 `OTEL_EXPORTER_OTLP_ENDPOINT` 退化为 Console |

## 5. 关键文件清单

| 文件 | 职责 |
|---|---|
| [index.ts](file:///f:/TraeProjects/1/src/main/index.ts) | 主进程入口、生命周期、窗口、安全 |
| [service-container.ts](file:///f:/TraeProjects/1/src/main/service-container.ts) | 服务单例 + 生命周期 |
| [config/index.ts](file:///f:/TraeProjects/1/src/main/config/index.ts) | AppConfig（含 Sentry 配置读取） |
| [security/csp.ts](file:///f:/TraeProjects/1/src/main/security/csp.ts) | 构建 CSP 响应头 |
| [utils/logger.ts](file:///f:/TraeProjects/1/src/main/utils/logger.ts) | electron-log + 全局错误处理 + 崩溃标记 |
| [utils/window-state.ts](file:///f:/TraeProjects/1/src/main/utils/window-state.ts) | 窗口尺寸状态记忆 |