// src/main/index.ts
// Electron 主进程入口
// 职责：创建 BrowserWindow、加载渲染层、配置安全基线
// 设计文档 §1.1 进程拓扑 / §4.5 安全配置 / §7.6 日志
//
// 说明：P7 新增 SQLite + Drizzle 持久化层（SessionService），
// 替代早期已删除的 PG/Prisma/AGE 数据库层。
// 当前主进程负责：Logger 初始化、SQLite 初始化、
// 窗口创建、退出清理（含 closeDb）。

import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme, session } from 'electron';
import { broadcastDeepLink, parseDeepLink, registerDeepLinkProtocol } from './deep-link';
import { agentAskService } from './infra/ai/agent/agent-ask-service';
import {
  compressByTokenBudget,
  estimateMessagesTokens,
  getCompactionBudget,
} from './infra/ai/agent/context-compression';
import { LearnSkillService } from './infra/ai/knowledge/learn-skill-agent';
import { llmClient } from './infra/ai/llm-client/ai-provider';
import { modelRegistry } from './infra/ai/models';
import { skillRegistry } from './infra/ai/skills/skill-registry';
import { createMemoryCaptureWire } from './infra/memory-hub/capture-wire';
import { isMemoryEnabled } from './infra/memory-hub/memory-pref';
import { scheduleMemoryPrewarm } from './infra/memory-hub/prewarm';
import { buildRemoteEndpoints, getLanIPv4Addresses } from './infra/remote/network-info';
import { initDb } from './infra/storage/db';
import { readAllSettings, readSetting } from './infra/storage/settings-pref';
import { readTelemetryLevelSync } from './infra/storage/telemetry-pref';
import { EventLoopLagMonitor } from './infra/telemetry/event-loop-lag';
import { reportEventLoopLag } from './infra/telemetry/lag-alert';
import { startMemoryMonitor } from './infra/telemetry/memory-monitor';
import { initTelemetry, shutdownTelemetry } from './infra/telemetry/otel';
import { clearUpdateCache, readUpdateCacheInfo } from './infra/update/update-cache';
import { createAgentHandlers } from './ipc/agent.handler';
import { createAgentApprovalHandlers } from './ipc/agent-approval.handler';
import { createAgentAskHandlers } from './ipc/agent-ask.handler';
import { appHandlers } from './ipc/app.handler';
import { createBrowserHandlers } from './ipc/browser.handler';
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
import { createRemoteHandlers } from './ipc/remote.handler';
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
import { mountTurnNotifications } from './notification';
import { isCloseConfirmed, isQuitting, setCloseConfirmed, setQuitting } from './quit-state';
import { buildCsp } from './security/csp';
import {
  disposeServices,
  hasRunningAgentTurns,
  initRuntimeModels,
  recoverFromCrash,
  serviceContainer,
} from './service-container';
import { createTray } from './tray';
import { reportMessage } from './utils/error-report';
import { initLogger, logger, registerGlobalErrorHandlers } from './utils/logger';
import { confirmInterruptRunningTurns, createWindow } from './window';
// 主题联动独立模块（无 service-container 依赖的纯 Electron 关注点）
import { syncTitleBarOverlayFromTheme } from './window-theme';

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

// 加载 .env 到 process.env（dev 模式）
// 项目从 Prisma 迁移到 SQLite 后，不再有自动 .env 加载机制。
// 使用 Node.js v20.12+ 内置 process.loadEnvFile()，无需安装 dotenv。
// - dev 模式：从项目根目录加载 .env
// - test 模式：跳过（避免测试读取到开发期变量）
// - production：.env 不存在（不打包），catch 静默跳过
// 注意：process.loadEnvFile() 不会覆盖已存在的 env 变量
if (process.env['NODE_ENV'] !== 'test') {
  try {
    process.loadEnvFile(join(__dirname, '../../.env'));
  } catch {
    // .env 不存在（production 或 CI），跳过
  }
}

// 单实例锁：防止多开（多实例会争抢 SQLite 数据库锁 / IM 长轮询 / 端口监听）
// - 主实例：正常启动，监听 second-instance 聚焦已有窗口
// - 第二实例：requestSingleInstanceLock 返回 false，立即退出（不初始化任何服务）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  // 用户再次启动应用（双击 exe / 命令行 / 协议唤起）时：聚焦已有主窗口而不是新开实例
  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win !== undefined) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
    // Windows/Linux 深度链接：协议唤起时 argv 携 code-agent:// URL，解析并广播
    broadcastDeepLink(parseDeepLink(argv.find((a) => a.startsWith('code-agent://')) ?? ''));
  });
}

// 注册自定义协议（code-agent://）：Windows/Linux 直接 here；macOS 走 open-url 事件
registerDeepLinkProtocol();
// macOS 深度链接：open-url 事件在 app ready 前可能触发（Cold Launch），
// 窗口尚未创建时广播无线索——由 handleOpenUrl 缓存，createWindow 后补发
let coldLaunchDeepLink: string | null = null;
app.on('open-url', (event, url) => {
  event.preventDefault();
  const win = BrowserWindow.getAllWindows()[0];
  if (win === undefined) {
    // 冷启动：缓存 URL，createWindow 完成后补发
    coldLaunchDeepLink = url;
  } else {
    broadcastDeepLink(parseDeepLink(url));
  }
});

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
    // 初始化 OpenTelemetry（需要在 app.getVersion 之后）：
    // - OTel 采集自定义业务 trace span（agent.streamText / tool.execute / IPC）
    // - 失败容忍：未配置 OTEL_EXPORTER_OTLP_ENDPOINT 时退化为 Console exporter
    // - 遥测开关：telemetry-pref 为 off 时跳过初始化，避免用户关闭遥测后 span 仍外发
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
    // 系统通知：Agent 回合完成后台提醒（窗口不可见时才弹，前台不打扰）
    // 订阅 onTurnEvent（TURN_END），unsubscribe 随进程退出自然回收
    mountTurnNotifications(serviceContainer.getAgentService());
    // 定时任务调度接线（C2 修复：cron-service 建成未接线——任务能建不会跑）；
    // 必须在 initDb 之后（start 从 sqlite 恢复启用任务），fire 触发的回合经
    // initCronScheduler 注册的 handler 无头执行
    serviceContainer.initCronScheduler();
    // 注册全部 IPC handler（定义表驱动，registerIpcHandlers 统一执行）
    // - handler 对象形状受 InferHandlers 约束：定义表新增方法而 handler 缺失 → 编译期报错
    // - channel / schema / traceId / sender 校验 / 错误上报由 wrap 统一处理
    registerIpcHandlers({
      app: appHandlers,
      agent: {
        ...createAgentHandlers({
          agentService: serviceContainer.getAgentService(),
          memoryWire: createMemoryCaptureWire({
            agentService: serviceContainer.getAgentService(),
            port: serviceContainer.getMemoryPort(),
          }),
          memoryPort: serviceContainer.getMemoryPort(),
          promptService: serviceContainer.getPromptService(),
        }),
        ...createAgentApprovalHandlers({
          permissionService: serviceContainer.getPermissionService(),
        }),
        ...createAgentAskHandlers({ askService: agentAskService }),
      },
      session: createSessionHandlers({
        sessionService: serviceContainer.getSessionService(),
        // /compact 上下文压缩：默认模型窗口感知的预算裁剪（与 agent 主流程同一纯函数）
        // removed 只计整条丢弃；就地裁剪（条数不变）体现在 reclaimedTokens，
        // handler 以回收的 token 数作为落库与展示口径
        compactMessages: (messages) => {
          const resolved = modelRegistry.resolve(undefined);
          const budget = getCompactionBudget(resolved.capabilities.contextWindowSize ?? 128_000);
          const trimmed = compressByTokenBudget([...messages], budget);
          return {
            trimmed,
            removed: messages.length - trimmed.length,
            reclaimedTokens: Math.max(
              0,
              estimateMessagesTokens([...messages]) - estimateMessagesTokens(trimmed),
            ),
          };
        },
      }),
      file: createFileHandlers({ fileService: serviceContainer.getFileService() }),
      search: createSearchHandlers({ searchService: serviceContainer.getSearchService() }),
      terminal: createTerminalHandlers({ terminalService: serviceContainer.getTerminalService() }),
      git: createGitHandlers({ gitService: serviceContainer.getGitService() }),
      tool: createToolHandlers({ toolRegistry: serviceContainer.getToolRegistry() }),
      settings: createSettingsHandlers({
        permissionService: serviceContainer.getPermissionService(),
      }),
      system: systemHandlers,
      goal: createGoalHandlers({ goalService: serviceContainer.getGoalService() }),
      memory: createMemoryHandlers({
        listL0BySession: (sessionKey, limit) =>
          serviceContainer.getMemoryHubService().listL0BySession(sessionKey, limit),
        listKnownSessionKeys: () => serviceContainer.getMemoryHubService().listKnownSessionKeys(),
        clearBySession: async (sessionKey) => {
          try {
            const service = serviceContainer.getMemoryHubService();
            const port = await service.ensureStarted();
            const res = await port.clear(sessionKey);
            // 引擎 SQLite 是权威存储；JSONL 为 UI 列表数据源（审计镜像），
            // 同步清理该会话的行，保证清除后列表中不再残留（杜绝"假清空"）
            const jsonlRemoved = service.removeL0JsonlBySession(sessionKey);
            if (res.ok && jsonlRemoved > 0) {
              logger.info(
                { sessionKey, jsonlRemoved },
                '记忆清除完成（含 JSONL 审计镜像同步清理）',
              );
            }
            return res;
          } catch (error) {
            // 引擎未配置/启动失败 → 降级 ok=false（不抛给 IPC，前端走失败 toast）
            return {
              ok: false,
              deletedCount: 0,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        },
        status: {
          isEnabled: () => isMemoryEnabled(),
          isAvailable: () => serviceContainer.getMemoryHubService().isConfigured(),
          isRunning: () => serviceContainer.getMemoryHubService().isRunning(),
          isHealthy: () => serviceContainer.getMemoryHubService().probeHealth(),
          countRecords: () => serviceContainer.getMemoryHubService().countRecords(),
        },
      }),
      models: modelsHandlers,
      mcp: createMcpHandlers(serviceContainer.getMcpService(), serviceContainer.getToolRegistry()),
      skill: skillHandlers,
      whitelist: createWhitelistHandlers({
        permissionService: serviceContainer.getPermissionService(),
      }),
      task: taskHandlers,
      im: createImHandlers({ imService: serviceContainer.getImService() }),
      remote: createRemoteHandlers({
        remoteControl: serviceContainer.getRemoteControlService(),
        network: {
          listAddresses: getLanIPv4Addresses,
          buildEndpoints: buildRemoteEndpoints,
        },
      }),
      logs: logsHandlers,
      devtools: devtoolsHandlers,
      dialog: dialogHandlers,
      browser: createBrowserHandlers({
        browserPreviewService: serviceContainer.getBrowserPreviewService(),
      }),
      update: createUpdateHandlers({
        updateService: serviceContainer.getUpdateService(),
        readCacheInfo: () => readUpdateCacheInfo(process.resourcesPath),
        clearCache: () => clearUpdateCache(process.resourcesPath),
      }),
    });

    // 启动自动更新服务（注册 autoUpdater 事件 → 推送渲染层）
    // 启动检查按用户设置调度（settings.update.autoCheck；缺失/损坏视为开）；
    // 非打包环境内部直接跳过调度，仅注册监听
    serviceContainer.getUpdateService().start({ autoCheckEnabled: isAutoCheckEnabled });

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
    // - unref 定时器不阻塞应用退出
    startMemoryMonitor({
      onAlert: (report) => {
        reportMessage(
          `主进程内存疑似持续增长：${report.growthMb.toFixed(0)}MB / ${report.durationSec.toFixed(0)}s`,
          'warning',
        );
        logger.warn(
          { growthMb: report.growthMb, durationSec: report.durationSec },
          '主进程内存疑似泄漏（连续增长）',
        );
      },
    });

    // 事件循环延迟监控（阻塞告警现场见 lag-alert.ts）
    lagMonitor = new EventLoopLagMonitor({
      onLag: (sample) =>
        reportEventLoopLag(sample, () => serviceContainer.getAgentService().hasActiveSessions()),
    });
    lagMonitor.start();

    // Windows/Linux 冷启动 deep-link：进程未运行时 second-instance 不触发，URL 在 argv
    coldLaunchDeepLink ??= process.argv.find((a) => a.startsWith('code-agent://')) ?? null;

    createWindow();

    // 系统托盘：后台驻留中心（状态驱动 tooltip/菜单，见 docs/design/28-tray-spec.md）
    createTray({
      getUpdateStatus: () => serviceContainer.getUpdateService().getStatus().snapshot,
      hasRunningTurns: () => serviceContainer.hasRunningAgentTurns(),
      listRecentSessions: async () => {
        const res = await serviceContainer.getSessionService().list(5, 0);
        return res.sessions.map((session) => ({ id: session.id, title: session.title }));
      },
      createSession: async () => {
        // 用最近使用的项目目录创建（无历史目录则回退用户主目录），创建后唤回导航
        const dirs = await serviceContainer
          .getSessionService()
          .listRecentDirs({ limit: 1 })
          .catch(() => null);
        const workingDir = dirs?.dirs[0]?.workingDir ?? homedir();
        return serviceContainer
          .getSessionService()
          .create({ workingDir, title: undefined, messages: undefined });
      },
      openSession: (sessionId) => {
        broadcastDeepLink({ sessionId, url: `code-agent://open/session/${sessionId}` });
      },
      checkForUpdate: () => {
        void serviceContainer.getUpdateService().check(false);
      },
      installUpdate: () => {
        serviceContainer.getUpdateService().quitAndInstall();
      },
      setAutostart: (enabled) => {
        app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
      },
      onUpdateStatus: (listener) => serviceContainer.getUpdateService().onStatus(listener),
      getLocale: () => (readSetting('language') === 'en' ? 'en' : 'zh-CN'),
    });

    // 记忆引擎启动预热：后台拉起 sidecar（生产走 tsx 直跑 TS，冷启动约 14s），
    // 消除应用刚启动后首次记忆操作的等待。延迟启动避免与渲染层争抢 CPU；
    // 失败静默降级，不阻塞启动（见 infra/memory-hub/prewarm.ts）。
    scheduleMemoryPrewarm({ service: serviceContainer.getMemoryHubService() });

    // 冷启动深度链接补发（macOS open-url 早于窗口创建；Windows/Linux 冷启动
    // 的黑参数已在 process.argv 中，由渲染层启动时主动拉取一次）
    if (coldLaunchDeepLink !== null) {
      broadcastDeepLink(parseDeepLink(coldLaunchDeepLink));
      coldLaunchDeepLink = null;
    }

    // 系统主题变化 → 窗口控件色联动（theme='system' 时与渲染层 matchMedia 行为对齐；
    // 手动主题路径由 settings:set / settings:getAll 收口，见 settings.handler.ts）
    nativeTheme.on('updated', () => {
      syncTitleBarOverlayFromTheme(readAllSettings()['theme']);
    });

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

// ── 信号优雅退出（进程与窗口维度：非 GUI 退出路径也要走善后）──
// SIGINT（dev 终端 Ctrl+C）/ SIGTERM（kill / CI 超时终止）默认直接杀进程，
// before-quit / before-quit 的 drain（agentService 3s + markInterruptedOnShutdown）
// 全部不执行 → 孤儿 PTY / 残留 running 会话。转为 app.quit() 后走完整退出链。
// 语义选择：信号 = 无 GUI 确认场景，直接置 closeConfirmed 跳过协商弹框，
// 但保留 drain 善后（强杀意图明确，善后是尽力而为的 3s 窗口）。
// Windows 注意：taskkill 默认不投递信号（需 /ESP），此注册主要服务 dev 与 POSIX CI。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    setCloseConfirmed();
    app.quit();
  });
}

// 应用退出前统一清理所有服务（设计文档 §1.1 应用生命周期 / §7.6 生命周期管理）
// P3-10 改造：disposeServices 内部调用 ChatService.dispose() 等待所有活跃 stream 真正完成
// （带 3s 超时兜底），避免进程退出时正在进行的 IPC send 丢失 / 渲染层 loading 状态卡死
// 防重入标志：app.exit(0) 可能再次触发 before-quit，避免重复清理。
// 用 ./quit-state 的进程级标志——window.ts close 协商依赖 isQuitting() 区分
// 「用户点 X」与「退出流程中的窗口销毁」（后者放行，不做最小化劫持）
// IM 渠道初始化 Promise（whenReady 内赋值；before-quit 等待其落定，见下）
let imChannelsInit: Promise<void> | null = null;
// 事件循环延迟监控器（whenReady 内赋值；before-quit 停止）
let lagMonitor: EventLoopLagMonitor | null = null;
app.on('before-quit', async (event) => {
  if (isQuitting()) {
    return;
  }
  // ── 进程级关窗协商（覆盖 macOS Cmd+Q / app.quit() 路径）──
  // Cmd+Q 不经过窗口 close 事件（before-quit 先行），Windows 点 X 的协商在
  // window.ts close handler——两条路径共享 isCloseConfirmed 标志，任一通过即放行。
  if (
    !isCloseConfirmed() &&
    process.env['CODE_AGENT_SKIP_CLOSE_GUARD'] !== '1' &&
    hasRunningAgentTurns()
  ) {
    event.preventDefault();
    const win = BrowserWindow.getAllWindows()[0];
    // 窗口已不存在（window-all-closed 后的 quit）→ 无协商对象，直接放行清理
    const confirmed = win !== undefined ? await confirmInterruptRunningTurns(win) : true;
    if (!confirmed) {
      logger.info({}, '用户取消退出，运行中回合继续（应用保持运行）');
      return;
    }
    setCloseConfirmed();
    logger.info({}, '用户确认退出（运行中回合将被中断标记）');
    // 重新触发 before-quit：此时协商已通过，走下方清理流程
    app.quit();
    return;
  }
  // preventDefault 必须在事件循环开始处同步调用，确保能阻止默认退出
  event.preventDefault();
  setQuitting();
  try {
    // 事件循环延迟监控先停（避免退出路径上仍产生告警样本）
    lagMonitor?.stop();
    lagMonitor = null;
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
  } catch (err) {
    logger.error({ error: err }, '应用退出清理失败');
  }
  // 更新安装（Windows）：应用已完全退出、即将 exit 时拉起新版安装器——
  // 消除「安装器启动时应用仍在退出链中」的竞态（NSIS 会弹「无法关闭」要求手动关闭）。
  // 静默安装（/S）+ --force-run 装完自动启动。
  serviceContainer.getUpdateService().runDeferredInstall();
  // 强制退出，不再触发 before-quit（与 app.quit() 不同）
  app.exit(0);
});

/**
 * 读取"自动检查更新"开关（app_settings 的 update 域，见设计文档 §4）
 *
 * 缺失、结构损坏或读取异常（如 db 未就绪）一律视为开启——与设置默认值一致，
 * 且不阻断启动流程。
 */
function isAutoCheckEnabled(): boolean {
  try {
    const value = readSetting('update');
    if (typeof value !== 'object' || value === null) {
      return true;
    }
    return (value as { autoCheck?: unknown }).autoCheck !== false;
  } catch {
    return true;
  }
}
