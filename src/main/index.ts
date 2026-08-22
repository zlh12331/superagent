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
import { app, BrowserWindow, screen, session, shell } from 'electron';
import { installExtension, REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';
import { getAppConfig } from './config';
import { agentAskService } from './infra/ai/agent/agent-ask-service';
import { compressByTokenBudget, getCompactionBudget } from './infra/ai/agent/context-compression';
import { LearnSkillService } from './infra/ai/knowledge/learn-skill-agent';
import { llmClient } from './infra/ai/llm-client/ai-provider';
import { modelRegistry } from './infra/ai/models';
import { skillRegistry } from './infra/ai/skills/skill-registry';
import { initDb } from './infra/storage/db';
import { readTelemetryLevelSync } from './infra/storage/telemetry-pref';
import { startMemoryMonitor } from './infra/telemetry/memory-monitor';
import { initTelemetry, shutdownTelemetry } from './infra/telemetry/otel';
import { createAgentHandlers } from './ipc/agent.handler';
import { createAgentApprovalHandlers } from './ipc/agent-approval.handler';
import { createAgentAskHandlers } from './ipc/agent-ask.handler';
import { appHandlers } from './ipc/app.handler';
import { createAudioHandlers } from './ipc/audio.handler';
import { createChatHandlers } from './ipc/chat.handler';
import { createCodebaseHandlers } from './ipc/codebase.handler';
import { devtoolsHandlers } from './ipc/devtools.handler';
import { dialogHandlers } from './ipc/dialog.handler';
import { createFileHandlers } from './ipc/file.handler';
import { createGitHandlers } from './ipc/git.handler';
import { createGoalHandlers } from './ipc/goal.handler';
import { createImHandlers } from './ipc/im.handler';
import { createMcpHandlers } from './ipc/mcp.handler';
import { createMemoryHandlers } from './ipc/memory.handler';
import { modelsHandlers } from './ipc/models.handler';
import { registerIpcHandlers } from './ipc/register';
import { createSearchHandlers } from './ipc/search.handler';
import { createSessionHandlers } from './ipc/session.handler';
import { createSettingsHandlers } from './ipc/settings.handler';
import { skillHandlers } from './ipc/skill.handler';
import { logsHandlers, systemHandlers } from './ipc/system.handler';
import { taskHandlers } from './ipc/task.handler';
import { createTerminalHandlers } from './ipc/terminal.handler';
import { createToolHandlers } from './ipc/tool.handler';
import { createUpdateHandlers } from './ipc/update.handler';
import { createWhitelistHandlers } from './ipc/whitelist.handler';
import { buildCsp } from './security/csp';
import {
  disposeServices,
  initRuntimeModels,
  recoverFromCrash,
  serviceContainer,
} from './service-container';
import { initLogger, logger, registerGlobalErrorHandlers } from './utils/logger';
import { loadWindowState, trackWindowState, type WindowState } from './utils/window-state';

// __dirname / __filename 由 electron-vite 6.x 在构建时自动注入
// （基于 import.meta.dirname / import.meta.filename，Node 24 原生支持）
// 详见 https://electron-vite.org/guide/dev#limitations-of-sandboxing

// dev 环境把 userData 重定向到项目内目录，避免 TRAE 沙箱拦截系统 %APPDATA% 写入
// 生产环境（app.isPackaged === true）保持系统默认 %APPDATA%/<AppName>，符合用户数据规范
if (!app.isPackaged) {
  // userData 重定向到项目目录（避免沙箱拦截系统 %APPDATA% 写入）
  // E2E 测试可通过 CODE_AGENT_USER_DATA 环境变量覆盖（多实例隔离，避免 SQLite 锁冲突）
  const userDataOverride = process.env['CODE_AGENT_USER_DATA'];
  app.setPath('userData', userDataOverride ?? join(__dirname, '../../.electron-user-data'));
  // 开启远程调试端口（CDP over WebSocket），允许 MCP / Chrome DevTools 直连 Electron 窗口
  // 用途：
  // - Chrome DevTools MCP 可通过 http://localhost:9222 连接 Electron 窗口（而非独立 Chromium）
  // - 这样能检查真实的 window.api（preload 注入）、React DevTools 面板、Electron 专属 API
  // 安全：仅在 dev 环境开启（!app.isPackaged），生产环境不暴露调试端口
  // 端口固定 9222（Chrome DevTools 协议惯例），冲突时 Electron 会自动递增
  // E2E 测试（playwright Electron 模式）用 CODE_AGENT_DEBUG_PORT 覆盖为独立端口，
  // 避免与并行 dev 实例（electron-vite dev 自带的窗口）争抢 9222 导致 CDP 连不上
  const debugPort = process.env['CODE_AGENT_DEBUG_PORT'] ?? '9222';
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
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
    release: `code-agent@${app.getVersion()}`,
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
  // 窗口状态记忆：恢复上次尺寸/位置/最大化（校验不可见时回退系统默认）
  const windowState: WindowState = loadWindowState(
    join(app.getPath('userData'), 'window-state.json'),
    { width: 1280, height: 800 },
    screen.getAllDisplays().map((d) => d.workArea),
  );
  const win = new BrowserWindow({
    ...(windowState.x !== undefined ? { x: windowState.x } : {}),
    ...(windowState.y !== undefined ? { y: windowState.y } : {}),
    width: windowState.width,
    height: windowState.height,
    // 最小窗口尺寸：低于 960 宽时主区被压缩至不可用（聊天输入区不可见）
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    // frameless 标题栏（对齐原型自绘标题栏设计，三端支持）：
    // - 隐藏系统标题栏，渲染层顶部栏延伸到窗口顶部（顶栏即标题栏）
    // - macOS：titleBarStyle hidden 保留红绿灯（系统绘制）
    // - Windows/Linux：titleBarOverlay 保留窗口控件（系统绘制，原生交互全保留）
    titleBarStyle: 'hidden',
    // 非 macOS 平台用 overlay 窗口控件（Electron 官方推荐平台分支写法）
    ...(process.platform !== 'darwin'
      ? {
          titleBarOverlay: {
            // 透明底：让顶栏玻璃背景统一延伸（深色实底会形成突兀黑块）
            color: '#00000000',
            // stone-400：暗色玻璃背景上清晰可见（纯黑会隐身）
            symbolColor: '#a8a29e',
            // 与 --aurora-topbar-h（52px）对齐
            height: 52,
          },
        }
      : {}),
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
  // P2 加固：dev 仅允许 electron-vite dev server 同源；prod（file:// 入口）
  // 不再放行任意 http://localhost:*——本机其他端口的服务同样能借此导航窗口
  const navRendererUrl = process.env['ELECTRON_RENDERER_URL'];
  win.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    try {
      const parsed = new URL(url);
      if (navRendererUrl !== undefined && parsed.origin === new URL(navRendererUrl).origin) {
        allowed = true;
      } else if (parsed.protocol === 'file:') {
        allowed = parsed.pathname.endsWith('/renderer/index.html');
      }
    } catch {
      allowed = false;
    }
    if (!allowed) {
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

  // 恢复最大化状态（必须在 show 前，避免先显示普通窗口再跳变）
  if (windowState.isMaximized) {
    win.maximize();
  }

  // 窗口状态跟踪：move/resize 防抖 + 最大化即时 + close 同步落盘
  trackWindowState(win, join(app.getPath('userData'), 'window-state.json'));

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

// 单实例锁：防止多开（多实例会争抢 SQLite 数据库锁 / IM 长轮询 / 端口监听）
// - 主实例：正常启动，监听 second-instance 聚焦已有窗口
// - 第二实例：requestSingleInstanceLock 返回 false，立即退出（不初始化任何服务）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  // 用户再次启动应用（双击 exe / 命令行）时：聚焦已有主窗口而不是新开实例
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win !== undefined) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });
}

// 应用就绪后初始化 logger + SQLite + 全局错误捕获 + IPC handler + 创建窗口
app
  .whenReady()
  .then(() => {
    // 双保险：第二实例即使 whenReady 触发也不初始化（正常流程 quit 已阻止）
    if (!gotTheLock) {
      return;
    }
    // 初始化 logger（需要 app.getPath，必须在 whenReady 之后）
    initLogger();
    // 初始化 OpenTelemetry（需要在 app.getVersion 之后，与 Sentry 互补：
    // - Sentry 采集错误 + 性能事务（自动 instrumentation）
    // - OTel 采集自定义业务 trace span（agent.streamText / tool.execute / IPC）
    // - 失败容忍：未配置 OTEL_EXPORTER_OTLP_ENDPOINT 时退化为 Console exporter
    // 安全修复：遥测开关对齐（Sentry 已接入，OTel 同样需检查用户偏好——
    // telemetry-pref 为 off 时跳过初始化，避免用户关闭遥测后 span 仍外发）
    const otelTelemetryLevel = readTelemetryLevelSync();
    if (otelTelemetryLevel !== 'off') {
      initTelemetry();
    } else {
      logger.warn({}, '遥测已关闭（telemetry-pref.json: off），跳过 OpenTelemetry 初始化');
    }
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
    // 崩溃恢复：上次异常退出时把残留 running 会话标记为 interrupted（渲染层提示恢复）
    void recoverFromCrash();
    // 统计保留策略：清理 90 天窗口外的 token_usage（与用量页查询窗口对齐，防无限膨胀）
    serviceContainer.pruneExpiredUsage();
    // 运行时模型加载：自定义模型注册到 ModelRegistry（LLM 首次调用前）
    void initRuntimeModels();
    // 已学习技能合并加载（skills 表 → 注册表，重启保留）
    skillRegistry.loadFromRows(new LearnSkillService(llmClient).listLearned());
    // IM 渠道恢复：已配置渠道自动连接（含 IM → Agent 桥接挂载）
    // 竞态修复：保存初始化 Promise——before-quit 需等待其完成再 stopAll，
    // 避免早退场景下 restore 与 stopAll 在同一实例上并发执行
    imChannelsInit = serviceContainer.initImChannels();
    // 子代理管理器初始化（run_subagent 工具依赖）
    serviceContainer.initSubagents();
    // 注册全部 IPC handler（定义表驱动，registerIpcHandlers 统一执行）
    // - handler 对象形状受 InferHandlers 约束：定义表新增方法而 handler 缺失 → 编译期报错
    // - channel / schema / traceId / sender 校验 / Sentry 由 wrap 统一处理
    registerIpcHandlers({
      audio: createAudioHandlers(),
      app: appHandlers,
      chat: createChatHandlers({ chatService: serviceContainer.getChatService() }),
      agent: {
        ...createAgentHandlers({ agentService: serviceContainer.getAgentService() }),
        ...createAgentApprovalHandlers({
          permissionService: serviceContainer.getPermissionService(),
        }),
        ...createAgentAskHandlers({ askService: agentAskService }),
      },
      session: createSessionHandlers({
        sessionService: serviceContainer.getSessionService(),
        // /compact 上下文压缩：默认模型窗口感知的预算裁剪（与 agent 主流程同一纯函数）
        compactMessages: (messages) => {
          const resolved = modelRegistry.resolve(undefined);
          const budget = getCompactionBudget(resolved.capabilities.contextWindowSize ?? 128_000);
          const trimmed = compressByTokenBudget([...messages], budget);
          return { trimmed, removed: messages.length - trimmed.length };
        },
      }),
      file: createFileHandlers({ fileService: serviceContainer.getFileService() }),
      search: createSearchHandlers({ searchService: serviceContainer.getSearchService() }),
      terminal: createTerminalHandlers({ terminalService: serviceContainer.getTerminalService() }),
      git: createGitHandlers({ gitService: serviceContainer.getGitService() }),
      codebase: createCodebaseHandlers({
        codebaseService: serviceContainer.getCodebaseService(),
      }),
      tool: createToolHandlers({ toolRegistry: serviceContainer.getToolRegistry() }),
      settings: createSettingsHandlers({
        permissionService: serviceContainer.getPermissionService(),
      }),
      system: systemHandlers,
      goal: createGoalHandlers({ goalService: serviceContainer.getGoalService() }),
      memory: createMemoryHandlers({ memoryService: serviceContainer.getMemoryService() }),
      models: modelsHandlers,
      mcp: createMcpHandlers(serviceContainer.getMcpService(), serviceContainer.getToolRegistry()),
      skill: skillHandlers,
      whitelist: createWhitelistHandlers({
        permissionService: serviceContainer.getPermissionService(),
      }),
      task: taskHandlers,
      im: createImHandlers({ imService: serviceContainer.getImService() }),
      logs: logsHandlers,
      devtools: devtoolsHandlers,
      dialog: dialogHandlers,
      update: createUpdateHandlers({ updateService: serviceContainer.getUpdateService() }),
    });

    // 启动自动更新服务（注册 autoUpdater 事件 → 推送渲染层；打包环境才实际检查）
    serviceContainer.getUpdateService().start();

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

    // 权限请求策略（安全基线）：默认拒绝所有 web 权限请求
    // 本应用不使用摄像头/麦克风/地理位置/系统通知等渲染层权限；
    // 剪贴板写入（navigator.clipboard.writeText）无需权限，读取会走拒绝。
    // 拒绝而非忽略：显式处理 + 日志，避免 Electron 默认放行一切权限请求的宽松行为。
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      logger.warn(
        { permission, url: webContents.getURL() },
        '拒绝渲染层权限请求（未授权权限类型）',
      );
      callback(false);
    });

    logger.info({}, '应用启动');

    // 主进程内存监控（生产长期趋势 + 泄漏哨兵）
    // - 60s 采样 + 连续 3 次单调增长且累计 > 150MB 才告警（防 GC 抖动误报）
    // - unref 定时器不阻塞应用退出；Sentry 未初始化时 captureMessage 为 no-op（安全）
    startMemoryMonitor({
      onAlert: (report) => {
        Sentry.captureMessage(
          `主进程内存疑似持续增长：${report.growthMb.toFixed(0)}MB / ${report.durationSec.toFixed(0)}s`,
          'warning',
        );
        logger.warn(
          { growthMb: report.growthMb, durationSec: report.durationSec },
          '主进程内存疑似泄漏（连续增长）',
        );
      },
    });

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
// IM 渠道初始化 Promise（whenReady 内赋值；before-quit 等待其落定，见下）
let imChannelsInit: Promise<void> | null = null;
app.on('before-quit', async (event) => {
  if (isQuitting) {
    return;
  }
  // preventDefault 必须在事件循环开始处同步调用，确保能阻止默认退出
  event.preventDefault();
  isQuitting = true;
  try {
    // IM 渠道停止（长轮询等后台协程先停，避免退出时残留请求）
    // 先等启动期 restore() 落定（3s 超时兜底），防止与 stopAll 并发
    if (imChannelsInit !== null) {
      await Promise.race([
        imChannelsInit.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      imChannelsInit = null;
    }
    await serviceContainer.disposeImChannels();
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
