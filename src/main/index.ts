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
import { createAutostartDeps, setAutostartEnabled } from './infra/autostart/autostart';
import { initMainI18n } from './infra/i18n';
import { createMemoryCaptureWire } from './infra/memory-hub/capture-wire';
import { isMemoryEnabled } from './infra/memory-hub/memory-pref';
import { scheduleMemoryPrewarm } from './infra/memory-hub/prewarm';
import { applyProxyChange } from './infra/network/proxy-applier';
import { buildRemoteEndpoints, getLanIPv4Addresses } from './infra/remote/network-info';
import { readSelectedModelId } from './infra/storage/ai-pref';
import { initDb } from './infra/storage/db';
import { readAllSettings, readSetting, writeSetting } from './infra/storage/settings-pref';
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
import { createBackupHandlers } from './ipc/backup.handler';
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
import { createProxyHandlers } from './ipc/proxy.handler';
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
import { createWindowHandlers } from './ipc/window.handler';
import { broadcastLoginItemChanged, broadcastSettingChanged } from './main-events';
import { mountApprovalNotifications, mountTurnNotifications } from './notification';
import { isCloseConfirmed, isQuitting, setCloseConfirmed, setQuitting } from './quit-state';
import { applyCspToSession } from './security/csp';
import {
  disposeServices,
  hasRunningAgentTurns,
  initRuntimeModels,
  recoverFromCrash,
  serviceContainer,
} from './service-container';
import { createTray } from './tray';
import { reportMessage } from './utils/error-report';
import { flushPendingLogs, initLogger, logger, registerGlobalErrorHandlers } from './utils/logger';
import { confirmInterruptRunningTurns, createWindow, readCloseAction } from './window';
import { bringMainWindowToFront } from './window-show';
import { syncTitleBarOverlayFromTheme } from './window-theme';

if (!app.isPackaged) {
  const userDataOverride = process.env['CODE_AGENT_USER_DATA'];
  app.setPath('userData', userDataOverride ?? join(__dirname, '../../.electron-user-data'));
  const debugPort = process.env['CODE_AGENT_DEBUG_PORT'] ?? '9222';
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

if (process.env['NODE_ENV'] !== 'test') {
  try {
    process.loadEnvFile(join(__dirname, '../../.env'));
  } catch {}
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    bringMainWindowToFront(createWindow);
    broadcastDeepLink(parseDeepLink(argv.find((a) => a.startsWith('code-agent://')) ?? ''));
  });
}

registerDeepLinkProtocol();
let coldLaunchDeepLink: string | null = null;
app.on('open-url', (event, url) => {
  event.preventDefault();
  const win = BrowserWindow.getAllWindows()[0];
  if (win === undefined) {
    coldLaunchDeepLink = url;
  } else {
    broadcastDeepLink(parseDeepLink(url));
  }
});

app
  .whenReady()
  .then(() => {
    if (!gotTheLock) {
      return;
    }
    initLogger();
    const otelTelemetryLevel = readTelemetryLevelSync();
    if (otelTelemetryLevel !== 'off') {
      initTelemetry();
    } else {
      logger.warn({}, '遥测已关闭（telemetry-pref.json: off），跳过 OpenTelemetry 初始化');
    }
    initDb();
    initMainI18n(readSetting('language'));
    void applyProxyChange(readSetting('proxy'));
    serviceContainer.getPromptService().initialize();
    registerGlobalErrorHandlers();
    void recoverFromCrash();
    serviceContainer.pruneExpiredUsage();
    void initRuntimeModels();
    skillRegistry.loadFromRows(new LearnSkillService(llmClient).listLearned());
    imChannelsInit = serviceContainer.initImChannels();
    serviceContainer.initSubagents();
    mountTurnNotifications(serviceContainer.getAgentService());
    mountApprovalNotifications(serviceContainer.getPermissionService());
    serviceContainer.initCronScheduler();
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
        compactMessages: (messages) => {
          const resolved = modelRegistry.resolve(readSelectedModelId());
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
        hasRunningAgentTurns: () => serviceContainer.hasRunningAgentTurns(),
      }),
      file: createFileHandlers({ fileService: serviceContainer.getFileService() }),
      search: createSearchHandlers({ searchService: serviceContainer.getSearchService() }),
      terminal: createTerminalHandlers({ terminalService: serviceContainer.getTerminalService() }),
      git: createGitHandlers({ gitService: serviceContainer.getGitService() }),
      tool: createToolHandlers({ toolRegistry: serviceContainer.getToolRegistry() }),
      settings: createSettingsHandlers({
        permissionService: serviceContainer.getPermissionService(),
      }),
      proxy: createProxyHandlers(),
      window: createWindowHandlers(),
      backup: createBackupHandlers({
        hasRunningAgentTurns: () => serviceContainer.hasRunningAgentTurns(),
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
            const jsonlRemoved = await service.removeL0JsonlBySession(sessionKey);
            if (res.ok && jsonlRemoved > 0) {
              logger.info(
                { sessionKey, jsonlRemoved },
                '记忆清除完成（含 JSONL 审计镜像同步清理）',
              );
            }
            return res;
          } catch (error) {
            return {
              ok: false,
              deletedCount: 0,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        },
        clearEngineBySession: async (sessionKey) => {
          const port = await serviceContainer.getMemoryHubService().ensureStarted();
          return port.clear(sessionKey);
        },
        removeL0Jsonl: (sessionKeys) =>
          serviceContainer.getMemoryHubService().removeL0JsonlBySessions(sessionKeys),
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

    serviceContainer.getUpdateService().start({
      autoCheckEnabled: isAutoCheckEnabled,
      allowPrereleaseEnabled: isAllowPrereleaseEnabled,
      devUpdateEnabled: process.env['CODE_AGENT_DEV_UPDATE'] === '1',
    });

    applyCspToSession(session.defaultSession, !app.isPackaged);
    logger.info({ isPackaged: app.isPackaged }, 'CSP 策略已注入');

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      logger.warn(
        { permission, url: webContents.getURL() },
        '拒绝渲染层权限请求（未授权权限类型）',
      );
      callback(false);
    });

    logger.info({}, '应用启动');

    stopMemoryMonitor = startMemoryMonitor({
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

    lagMonitor = new EventLoopLagMonitor({
      onLag: (sample) =>
        reportEventLoopLag(sample, () => serviceContainer.getAgentService().hasActiveSessions()),
    });
    lagMonitor.start();

    coldLaunchDeepLink ??= process.argv.find((a) => a.startsWith('code-agent://')) ?? null;

    createWindow();

    createTray({
      getUpdateStatus: () => serviceContainer.getUpdateService().getStatus().snapshot,
      hasRunningTurns: () => serviceContainer.hasRunningAgentTurns(),
      listRecentSessions: async () => {
        const res = await serviceContainer.getSessionService().list(5, 0);
        return res.sessions.map((session) => ({ id: session.id, title: session.title }));
      },
      createSession: async () => {
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
        void setAutostartEnabled(createAutostartDeps(), enabled)
          .then((state) => {
            broadcastLoginItemChanged(state);
          })
          .catch((err: unknown) => {
            logger.warn({ error: String(err) }, '托盘切换开机自启失败');
          });
      },
      getCloseAction: () => readCloseAction(),
      setCloseAction: (action) => {
        const next = { ...readWindowSettings(), closeAction: action };
        writeSetting('window', next);
        logger.info({ closeAction: action }, '托盘切换关窗行为');
        broadcastSettingChanged('window', next);
      },
      onUpdateStatus: (listener) => serviceContainer.getUpdateService().onStatus(listener),
      getLocale: () => (readSetting('language') === 'en' ? 'en' : 'zh-CN'),
    });

    scheduleMemoryPrewarm({ service: serviceContainer.getMemoryHubService() });

    if (coldLaunchDeepLink !== null) {
      broadcastDeepLink(parseDeepLink(coldLaunchDeepLink));
      coldLaunchDeepLink = null;
    }

    nativeTheme.on('updated', () => {
      syncTitleBarOverlayFromTheme(readAllSettings()['theme']);
    });

    app.on('activate', () => {
      bringMainWindowToFront(createWindow);
    });
  })
  .catch((err: unknown) => {
    // biome-ignore lint/suspicious/noConsole: logger 在 whenReady 内才初始化，此处仅 console 兜底
    console.error('[FATAL] 应用启动失败：', err);
    try {
      const { dialog } = require('electron');
      dialog.showErrorBox('应用启动失败', String(err));
    } catch {}
    app.exit(1);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    setCloseConfirmed();
    app.quit();
  });
}

let imChannelsInit: Promise<void> | null = null;
let lagMonitor: EventLoopLagMonitor | null = null;
let stopMemoryMonitor: (() => void) | null = null;
app.on('before-quit', async (event) => {
  if (isQuitting()) {
    return;
  }
  if (
    !isCloseConfirmed() &&
    process.env['CODE_AGENT_SKIP_CLOSE_GUARD'] !== '1' &&
    hasRunningAgentTurns()
  ) {
    event.preventDefault();
    const win = BrowserWindow.getAllWindows()[0];
    const confirmed = win !== undefined ? await confirmInterruptRunningTurns(win) : true;
    if (!confirmed) {
      logger.info({}, '用户取消退出，运行中回合继续（应用保持运行）');
      return;
    }
    setCloseConfirmed();
    logger.info({}, '用户确认退出（运行中回合将被中断标记）');
    app.quit();
    return;
  }
  event.preventDefault();
  setQuitting();
  try {
    serviceContainer.getUpdateService().refreshAutoInstallOnAppQuit();
    lagMonitor?.stop();
    lagMonitor = null;
    stopMemoryMonitor?.();
    stopMemoryMonitor = null;
    if (imChannelsInit !== null) {
      await Promise.race([
        imChannelsInit.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      imChannelsInit = null;
    }
    await serviceContainer.disposeImChannels();
    await disposeServices();
    await shutdownTelemetry();
  } catch (err) {
    logger.error({ error: err }, '应用退出清理失败');
  }
  serviceContainer.getUpdateService().runDeferredInstall();
  await flushPendingLogs();
  app.exit(0);
});

function readWindowSettings(): Record<string, unknown> {
  try {
    const value = readSetting('window');
    if (typeof value !== 'object' || value === null) {
      return {};
    }
    return { ...(value as Record<string, unknown>) };
  } catch {
    return {};
  }
}

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

function isAllowPrereleaseEnabled(): boolean {
  try {
    const value = readSetting('update');
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    return (value as { allowPrerelease?: unknown }).allowPrerelease === true;
  } catch {
    return false;
  }
}
