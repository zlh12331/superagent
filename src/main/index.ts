// src/main/index.ts
// Electron 主进程入口
// 职责：创建 BrowserWindow、加载渲染层、配置安全基线
// 设计文档 §1.1 进程拓扑 / §4.5 安全配置 / §7.6 日志 / §7.7 Sentry
//
// 说明：P7 新增 SQLite + Drizzle 持久化层（SessionService），
// 替代早期已删除的 PG/Prisma/AGE 数据库层。
// 当前主进程负责：Sentry 初始化、Logger 初始化、SQLite 初始化、
// 窗口创建、退出清理（含 closeDb）。

import { join } from 'node:path';
import * as Sentry from '@sentry/electron/main';
import { startupTracingIntegration } from '@sentry/electron/main';
import { app, BrowserWindow, session, shell } from 'electron';
import { installExtension, REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';
import { getAppConfig } from './config';
import { initDb } from './infra/storage/db';
import { readTelemetryLevelSync } from './infra/storage/telemetry-pref';
import { registerAgentHandlers } from './ipc/agent.handler';
import { registerAgentApprovalHandlers } from './ipc/agent-approval.handler';
import { registerAppHandlers } from './ipc/app.handler';
import { registerChatHandlers } from './ipc/chat.handler';
import { registerCodebaseHandlers } from './ipc/codebase.handler';
import { registerDevToolsHandlers } from './ipc/devtools.handler';
import { registerDialogHandlers } from './ipc/dialog.handler';
import { registerFileHandlers } from './ipc/file.handler';
import { registerGitHandlers } from './ipc/git.handler';
import { registerSearchHandlers } from './ipc/search.handler';
import { registerSessionHandlers } from './ipc/session.handler';
import { registerSettingsHandlers } from './ipc/settings.handler';
import { registerSystemHandlers } from './ipc/system.handler';
import { registerTerminalHandlers } from './ipc/terminal.handler';
import { registerToolHandlers } from './ipc/tool.handler';
import { buildCsp } from './security/csp';
import { disposeServices, serviceContainer } from './service-container';
import { initTelemetry, shutdownTelemetry } from './telemetry/otel';
import { initLogger, logger, registerGlobalErrorHandlers } from './utils/logger';

// __dirname / __filename 由 electron-vite 6.x 在构建时自动注入
// （基于 import.meta.dirname / import.meta.filename，Node 24 原生支持）
// 详见 https://electron-vite.org/guide/dev#limitations-of-sandboxing

// dev 环境把 userData 重定向到项目内目录，避免 TRAE 沙箱拦截系统 %APPDATA% 写入
// 生产环境（app.isPackaged === true）保持系统默认 %APPDATA%/<AppName>，符合用户数据规范
if (!app.isPackaged) {
  app.setPath('userData', join(__dirname, '../../.electron-user-data'));
  // 开启远程调试端口（CDP over WebSocket），允许 MCP / Chrome DevTools 直连 Electron 窗口
  // 用途：
  // - Chrome DevTools MCP 可通过 http://localhost:9222 连接 Electron 窗口（而非独立 Chromium）
  // - 这样能检查真实的 window.api（preload 注入）、React DevTools 面板、Electron 专属 API
  // 安全：仅在 dev 环境开启（!app.isPackaged），生产环境不暴露调试端口
  // 端口固定 9222（Chrome DevTools 协议惯例），冲突时 Electron 会自动递增
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

/**
 * 初始化 Sentry
 *
 * 设计文档 §7.7：
 * - 自托管 Sentry v26.6.0
 * - DSN 从 config 读取（环境变量 SENTRY_DSN）
 * - 生产环境采样 10% 事务，dev 不采样
 * - beforeSend 脱敏：移除 Authorization header
 *
 * P2 遥测用户开关（对标 VS Code telemetryLevel / Cursor 双开关）：
 * - off：不初始化 Sentry
 * - error-only：初始化但 tracesSampleRate = 0（仅错误，无性能事务）
 * - full：正常初始化
 * - 级别从 telemetry-pref.json 同步读取（必须在 whenReady 之前）
 *
 * 必须在 app.whenReady() 之前调用
 */
function initSentry(): void {
  // P2:读取用户遥测偏好（同步，因为 Sentry.init 要求同步）
  const telemetryLevel = readTelemetryLevelSync();
  if (telemetryLevel === 'off') {
    logger.warn({}, '遥测已关闭（telemetry-pref.json: off），跳过 Sentry 初始化');
    return;
  }

  const config = getAppConfig();
  if (config.sentry.dsn === '') {
    // DSN 未配置时跳过初始化（dev 环境常见）
    logger.warn({}, 'Sentry DSN 未配置，跳过初始化');
    return;
  }

  // error-only 模式：强制 tracesSampleRate = 0（不上报性能事务）
  // dev 环境强制 1.0（开发期需要完整性能数据，便于调试）
  // production 环境用 .env 配置的值（当前 1.0，小规模可全量；高负载可降为 0.1~0.3）
  const baseSampleRate = config.isPackaged ? config.sentry.tracesSampleRate : 1.0;
  const effectiveSampleRate = telemetryLevel === 'error-only' ? 0 : baseSampleRate;

  Sentry.init({
    dsn: config.sentry.dsn,
    release: `novel-writer@${app.getVersion()}`,
    environment: config.isPackaged ? 'production' : 'development',
    tracesSampleRate: effectiveSampleRate,
    sendDefaultPii: false,
    // Electron 启动追踪集成：
    // - 在 main 进程创建 'Startup' root transaction（op: app.start）
    // - 自动 instrument app 生命周期事件（will-finish-launching / ready / web-contents-created / dom-ready）
    // - 等待 renderer 的 pageload transaction 并合并其 spans
    // - 10 秒超时兜底（若 renderer 未发送 pageload，Startup transaction 以 Timeout 状态结束）
    integrations: [startupTracingIntegration()],
    // Session Replay 采样配置在 renderer 端的 SentryRenderer.init 中设置
    // （ElectronMainOptions 继承 NodeOptions，不支持 browser replay 参数）
    // main 进程负责接收 renderer 通过 IPC 转发的 replay envelope 并上传
    beforeSend(event) {
      // 脱敏：移除可能的 API Key / Authorization header
      // 注意：@sentry/electron 7 的 beforeSend 入参为 Event（携带 type 字段），
      // 返回类型必须为 Event | null，因此采用不可变更新保持 type 兼容
      // noPropertyAccessFromIndexSignature: headers 是索引签名，必须用方括号访问
      if (event.request?.headers?.['authorization']) {
        const { ['authorization']: _auth, ...restHeaders } = event.request.headers;
        return { ...event, request: { ...event.request, headers: restHeaders } };
      }
      return event;
    },
  });

  logger.info(
    {
      telemetryLevel,
      sampleRate: effectiveSampleRate,
    },
    'Sentry 已初始化（main 进程，renderer 端的 Replay 配置见 instrumentation.ts）',
  );
}

/**
 * 创建主窗口
 * 安全配置遵循 Electron Security 官方推荐：
 * - contextIsolation: true（XSS → RCE 防护）
 * - nodeIntegration: false
 * - sandbox: true（渲染层沙箱）
 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // preload 输出为 .cjs（CJS 格式）：sandbox: true 要求 preload 必须是 CommonJS
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // 限制导航（Security #13）：只允许应用内导航
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('app://')) {
      event.preventDefault();
    }
  });

  // 限制新窗口（Security #14）：外链走系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 开发环境加载 dev server，生产环境加载构建产物
  // noPropertyAccessFromIndexSignature: process.env 必须用方括号访问
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  // 方案 A + C：dev 模式自动安装 React DevTools 扩展 + 自动打开 Chromium DevTools
  // - C：installExtension 从 Chrome Web Store 下载 React DevTools 并注入 session
  //   失败容忍（网络问题/已安装）—— 仅 warn 不影响应用启动
  // - A：openDevTools({ mode: 'detach' }) 打开独立 DevTools 窗口
  //   生产环境不自动打开（打包后 app.isPackaged === true）
  //
  // 注意：electron-devtools-installer v4.0.0 使用废弃的 session.getAllExtensions API
  // 导致 deprecated 警告，但不影响功能；React DevTools 需要联网下载
  //
  // M4 修复：
  // - 用 `void` 显式标注 fire-and-forget Promise，避免 floating-promise lint 警告
  // - catch 中保留完整 error 对象（含 stack），便于 logger 序列化排查网络/权限问题
  // - openDevTools 不依赖 installExtension 成功（即使扩展安装失败，DevTools 仍可用）
  if (!app.isPackaged) {
    void installExtension(REACT_DEVELOPER_TOOLS)
      .then((name) => {
        logger.info({ name }, 'React DevTools 扩展已安装');
      })
      .catch((err: unknown) => {
        // 错误容忍：网络问题 / 已安装版本冲突 / Chrome Web Store 不可达
        // 不影响应用启动，DevTools 仍可用（openDevTools 不依赖扩展）
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'React DevTools 扩展安装失败（不影响应用运行）',
        );
      });
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

// 加载 .env 到 process.env（dev 模式）
// 项目从 Prisma 迁移到 SQLite 后，不再有自动 .env 加载机制。
// 使用 Node.js v20.12+ 内置 process.loadEnvFile()，无需安装 dotenv。
// - dev 模式：从项目根目录加载 .env
// - test 模式：跳过（避免测试错误上报到 Sentry）
// - production：.env 不存在（不打包），catch 静默跳过
// 注意：process.loadEnvFile() 不会覆盖已存在的 env 变量
if (process.env['NODE_ENV'] !== 'test') {
  try {
    process.loadEnvFile(join(__dirname, '../../.env'));
  } catch {
    // .env 不存在（production 或 CI），跳过
  }
}

// Sentry 必须在 app.whenReady() 之前初始化（@sentry/electron 要求）
initSentry();

// 应用就绪后初始化 logger + SQLite + 全局错误捕获 + IPC handler + 创建窗口
app
  .whenReady()
  .then(() => {
    // 初始化 logger（需要 app.getPath，必须在 whenReady 之后）
    initLogger();
    // 初始化 OpenTelemetry（需要在 app.getVersion 之后，与 Sentry 互补：
    // - Sentry 采集错误 + 性能事务（自动 instrumentation）
    // - OTel 采集自定义业务 trace span（agent.streamText / tool.execute / IPC）
    // - 失败容忍：未配置 OTEL_EXPORTER_OTLP_ENDPOINT 时退化为 Console exporter
    initTelemetry();
    // 初始化 SQLite + Drizzle（必须在注册任何依赖 DB 的服务之前）
    // - 建表 + 索引（幂等，已存在则跳过）
    // - 启用 WAL 模式 + 外键约束
    // - SessionService 通过 getDb() 动态访问，但首次访问必须确保 db 已初始化
    initDb();
    // 初始化 PromptService：幂等插入默认 Code Agent prompt 到 prompts 表
    // - 必须在 initDb 之后（依赖 prompts 表已创建）
    // - 必须在 AgentService 初始化之前（resolvePrompt 时数据库已有默认 prompt）
    // - 用户编辑过的 prompt 不会被覆盖（onConflictDoNothing）
    serviceContainer.getPromptService().initialize();
    registerGlobalErrorHandlers();
    // 注册应用级 IPC handler（app:getStatus / app:openExternal）
    registerAppHandlers();
    // 注册聊天域 IPC handler（chat:send / chat:stop，基于 Vercel AI SDK v7）
    // 通过 ServiceContainer 注入 IChatService 实例，解耦 handler 与具体实现
    registerChatHandlers({ chatService: serviceContainer.getChatService() });
    // 注册文件域 IPC handler（file:read / file:write / file:list / file:watch:start / file:watch:stop）
    // 通过 ServiceContainer 注入 IFileService 实例，handler 不直接依赖 FileService 实现
    registerFileHandlers({ fileService: serviceContainer.getFileService() });
    // 注册搜索域 IPC handler（search:grep / search:glob）
    // 通过 ServiceContainer 注入 ISearchService 实例，handler 不直接依赖 SearchService 实现
    registerSearchHandlers({ searchService: serviceContainer.getSearchService() });

    // 注册终端域 IPC handler（terminal:create / input / resize / kill）
    // 通过 ServiceContainer 注入 ITerminalService 实例（基于 node-pty）
    // terminal:create 传入 ctx.sender（WebContents）作为后续事件推送目标
    // 后续输出和退出事件通过 terminal:event:output / terminal:event:exit 推送
    registerTerminalHandlers({ terminalService: serviceContainer.getTerminalService() });

    // 注册 Git 域 IPC handler（git:status / git:diff）
    // 通过 ServiceContainer 注入 IGitService 实例（基于 child_process.spawn('git')）
    // 仅暴露只读查询，写操作通过 TerminalService 由用户手动执行
    registerGitHandlers({ gitService: serviceContainer.getGitService() });

    // 注册代码库域 IPC handler（codebase:query / explore / node / callers / callees / impact）
    // 通过 ServiceContainer 注入 ICodebaseService 实例（基于 child_process.spawn('codegraph')）
    // 提供 6 个代码智能查询通道，支持符号搜索、调用追踪、影响分析
    // Code Agent 调用这些方法获取代码上下文，喂给 LLM 辅助决策
    registerCodebaseHandlers({ codebaseService: serviceContainer.getCodebaseService() });

    // 注册 Session 域 IPC handler（session:list / get / delete / rename）
    // 通过 ServiceContainer 注入 ISessionService 实例（基于 drizzle + better-sqlite3）
    // 持久化会话历史：用户关闭窗口后下次启动可恢复历史对话
    // create / appendMessage 是内部 API（供 AgentService 调用），不通过 IPC 暴露
    registerSessionHandlers({ sessionService: serviceContainer.getSessionService() });

    // 注册工具域 IPC handler（tool:list）
    // 通过 ServiceContainer 注入 IToolRegistry 实例（已注册 7 个内置工具）
    registerToolHandlers({ toolRegistry: serviceContainer.getToolRegistry() });

    // 注册 Settings 域 IPC handler（settings:getApiKey / setApiKey / deleteApiKey）
    // 管理 API Key 等敏感数据，通过 safeStorage 加密存储（Windows DPAPI / macOS Keychain / Linux libsecret）
    // 无需 ServiceContainer 注入：直接调用 keychain 模块函数（无状态）
    registerSettingsHandlers();

    // 注册系统级 IPC handler（system:getStatus / logs:read）
    // - system:getStatus：返回运行时状态（内存/CPU/uptime/版本），DevPanel Metrics tab 使用
    // - logs:read：读取最近 N 行日志（从 main.log 文件尾部倒读），DevPanel Logs tab 使用
    // 无需 ServiceContainer 注入：仅读取 process 全局状态 + 日志文件
    registerSystemHandlers();

    // 注册 DevTools 域 IPC handler（devtools:open）
    // - 渲染层 DevPanel Inspector tab 按钮触发，主进程调用 webContents.openDevTools({ mode })
    // - 无需 ServiceContainer 注入：通过 BrowserWindow.fromWebContents(ctx.sender) 获取窗口
    registerDevToolsHandlers();

    // 注册 Dialog 域 IPC handler（dialog:pickDirectory）
    // - 原生目录选择器，供 NewSessionDialog 调用
    // - 无需 ServiceContainer 注入：dialog 是 Electron 全局 API
    registerDialogHandlers();

    // 注册 Agent 域 IPC handler（agent:run / agent:stop）
    // 通过 ServiceContainer 注入 IAgentService 实例（依赖 ToolRegistry + ToolExecutor）
    // agent:run 启动 streamText 多轮工具调用循环，立即返回 sessionId
    // 后续流式事件通过 AGENT_STREAM_PART / AGENT_TOOL_CALL / AGENT_TOOL_RESULT / AGENT_APPROVAL_REQUEST 推送
    registerAgentHandlers({ agentService: serviceContainer.getAgentService() });

    // 注册 Agent 审批响应 IPC handler（agent:approval:response）
    // 通过 ServiceContainer 注入 IPermissionService 实例
    // 渲染层 ApprovalModal 用户操作后通过此 channel 回传审批结果
    registerAgentApprovalHandlers({
      permissionService: serviceContainer.getPermissionService(),
    });

    // 注入 CSP 响应头（P1-5 安全基线）
    // 生产环境严格策略 / 开发环境宽松策略（允许 Vite HMR）
    // 覆盖渲染层 HTML 的 CSP meta，确保所有响应统一使用主进程策略
    const csp = buildCsp(!app.isPackaged);
    const isProduction = app.isPackaged;
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // 跳过 chrome-extension:// 协议的响应
      // 原因：dev 环境 React DevTools 扩展（chrome-extension://<id>/main.html）的
      // 内部资源加载策略由扩展自身 manifest.content_security_policy 控制，
      // 主进程注入的 CSP 会与扩展策略冲突，触发 ERR_BLOCKED_BY_RESPONSE 导致
      // Components/Profiler 面板无法加载。
      // 安全性：chrome-extension:// 协议的响应头由 Chrome Web Store 签名验证，
      // 不需要主进程额外注入安全头。
      if (details.url.startsWith('chrome-extension://')) {
        callback({});
        return;
      }

      const headers: Record<string, string[]> = {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        // X-Content-Type-Options: nosniff — 防止 MIME 类型嗅探
        // 阻止浏览器将非脚本资源解释为可执行脚本（防 XSS via MIME 混淆）
        // 参考：https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Content-Type-Options
        'X-Content-Type-Options': ['nosniff'],
      };

      // X-Frame-Options: 仅对 http(s) 协议注入
      // - 生产环境 DENY：完全禁止嵌入（最严格）
      // - 开发环境 SAMEORIGIN：允许同源嵌入（DevTools 面板用 chrome-extension:// 协议已被上面跳过）
      // CSP frame-ancestors 是更现代的替代方案，此头作为旧浏览器兜底
      // 参考：https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options
      if (details.url.startsWith('http')) {
        headers['X-Frame-Options'] = [isProduction ? 'DENY' : 'SAMEORIGIN'];
      }

      callback({ responseHeaders: headers });
    });
    logger.info({ isPackaged: app.isPackaged }, 'CSP 策略已注入');

    logger.info({}, '应用启动');

    createWindow();

    // macOS: 点击 dock 图标时若无窗口则重建
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch((err: unknown) => {
    // 启动错误兜底：whenReady 链中任何同步抛错（ServiceContainer 初始化 / IPC handler 注册 / DB 初始化）
    // 都会被这里捕获，避免 Promise rejection 被静默吞掉导致应用进入未定义状态
    // biome-ignore lint/suspicious/noConsole: logger 在 whenReady 内才初始化，此处仅 console 兜底
    console.error('[FATAL] 应用启动失败：', err);
    try {
      // 尝试用 dialog 通知用户（app 已 ready，dialog 可用）
      const { dialog } = require('electron');
      dialog.showErrorBox('应用启动失败', String(err));
    } catch {
      // dialog 也失败时仅 console.error（已在上面输出）
    }
    app.exit(1);
  });

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出前统一清理所有服务（设计文档 §1.1 应用生命周期 / §7.6 生命周期管理）
// P3-10 改造：disposeServices 内部调用 ChatService.dispose() 等待所有活跃 stream 真正完成
// （带 3s 超时兜底），避免进程退出时正在进行的 IPC send 丢失 / 渲染层 loading 状态卡死
// 防重入标志：app.exit(0) 可能再次触发 before-quit，避免重复清理
let isQuitting = false;
app.on('before-quit', async (event) => {
  if (isQuitting) {
    return;
  }
  // preventDefault 必须在事件循环开始处同步调用，确保能阻止默认退出
  event.preventDefault();
  isQuitting = true;
  try {
    await disposeServices();
    // 关闭 OpenTelemetry：flush 所有 pending span 到 exporter，避免丢失 trace 数据
    // 必须在 disposeServices 之后（业务 span 已全部 end）
    await shutdownTelemetry();
    // L4 配套修复：关闭 Sentry，flush 所有 pending 错误事件到 DSN
    // - wrap.ts 的 IPC 错误仅 fire-and-forget flush（不阻塞响应）
    // - 应用退出前必须显式 close，否则 captureException 入队的事件可能丢失
    // - 2s 超时：与 Sentry SDK 默认 shutdownTimeout 对齐，足够发送队列中的事件
    await Sentry.close(2000);
  } catch (err) {
    logger.error({ error: err }, '应用退出清理失败');
  }
  // 强制退出，不再触发 before-quit（与 app.quit() 不同）
  app.exit(0);
});
