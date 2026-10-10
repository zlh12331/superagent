import { join } from 'node:path';
import { app, BrowserWindow, dialog, screen, shell } from 'electron';
import { installExtension, REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';
import { resolveStartHidden } from './infra/autostart/autostart';
import { readSetting } from './infra/storage/settings-pref';
import { isCloseConfirmed, isQuitting, setCloseConfirmed } from './quit-state';
import { hasRunningAgentTurns } from './service-container';
import { notifyMinimizedToTray } from './tray';
import { reportMessage } from './utils/error-report';
import { logger } from './utils/logger';
import { loadWindowState, trackWindowState, type WindowState } from './utils/window-state';
import { markMaximizeOnNextShow } from './window-show';
import { TITLE_BAR_SYMBOL } from './window-theme';

/**
 * 关窗行为（settings.window.closeAction；缺失/损坏/读取失败 → 默认 minimize）
 *
 * 导出供托盘装配复用（index.ts 注入给 tray 的「关闭时最小化到托盘」勾选项读取同一真源，
 * 不重复实现——spec 28 §6:145-146 明确该勾选项读的就是本设置）。
 */
export function readCloseAction(): 'minimize' | 'quit' {
  try {
    const value = readSetting('window');
    if (typeof value !== 'object' || value === null) {
      return 'minimize';
    }
    return (value as { closeAction?: unknown }).closeAction === 'quit' ? 'quit' : 'minimize';
  } catch {
    return 'minimize';
  }
}

/**
 * 运行中回合退出确认弹窗（close 协商与 before-quit 协商共用）
 *
 * @returns true = 用户确认退出（中断回合，交由退出善后标记 interrupted）
 *          false = 用户取消（回合继续，应用保持运行）
 */
export async function confirmInterruptRunningTurns(win: BrowserWindow): Promise<boolean> {
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: app.getName(),
      message: 'Agent 回合正在运行',
      detail: '现在退出将中断当前回合（已生成内容保留，下次启动可从中断处恢复）。确定退出吗？',
      buttons: ['取消', '退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  } catch (err) {
    logger.warn({ error: String(err) }, '关窗确认对话框失败，放行关闭（before-quit 兜底）');
    return true;
  }
}

/**
 * 创建主窗口
 *
 * 流程：恢复窗口状态 → BrowserWindow（frameless + 安全基线）→
 * 导航/新窗口限制 → 加载渲染层 → 状态跟踪 → dev DevTools 注入。
 */
export function createWindow(): BrowserWindow {
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
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin'
      ? {
          titleBarOverlay: {
            color: '#00000000',
            symbolColor: TITLE_BAR_SYMBOL.dark,
            height: 52,
          },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

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

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  const startHidden = resolveStartHidden(app);
  if (startHidden) {
    logger.info({}, '开机自启静默启动：窗口驻留托盘不显示');
  }
  win.once('ready-to-show', () => {
    if (startHidden) {
      return;
    }
    if (windowState.isMaximized) {
      win.maximize();
    }
    win.show();
  });

  win.on('close', (event) => {
    if (isQuitting() || isCloseConfirmed() || process.env['CODE_AGENT_SKIP_CLOSE_GUARD'] === '1') {
      return;
    }
    if (process.platform === 'darwin') {
      logger.info({}, 'macOS 关窗：关闭窗口（应用留存），不读 closeAction');
      return;
    }
    if (readCloseAction() === 'minimize') {
      event.preventDefault();
      logger.info({}, '关窗行为为最小化：隐藏窗口到托盘');
      notifyMinimizedToTray();
      win.hide();
      return;
    }
    if (!hasRunningAgentTurns()) {
      return;
    }
    event.preventDefault();
    logger.info({}, '检测到运行中的 Agent 回合，拦截窗口关闭并请求用户确认');
    void confirmInterruptRunningTurns(win).then((confirmed) => {
      if (confirmed) {
        setCloseConfirmed();
        win.close();
      }
    });
  });

  if (startHidden && windowState.isMaximized) {
    markMaximizeOnNextShow();
  }

  let crashRecoveryCount = 0;
  let crashWindowStart = 0;
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') {
      return;
    }
    logger.error(
      { reason: details.reason, exitCode: details.exitCode },
      '渲染进程异常退出，尝试自动恢复',
    );
    void reportMessage(`渲染进程崩溃：reason=${details.reason} exitCode=${details.exitCode}`);
    const now = Date.now();
    if (now - crashWindowStart > 60_000) {
      crashWindowStart = now;
      crashRecoveryCount = 0;
    }
    crashRecoveryCount += 1;
    if (crashRecoveryCount > 2) {
      logger.error(
        { reason: details.reason, crashRecoveryCount },
        '渲染进程短时间反复崩溃，停止自动恢复（请手动重启应用）',
      );
      void reportMessage('渲染进程反复崩溃，已停止自动恢复', 'warning');
      return;
    }
    win.webContents.reload();
  });

  trackWindowState(win, join(app.getPath('userData'), 'window-state.json'));

  if (!app.isPackaged) {
    void installExtension(REACT_DEVELOPER_TOOLS)
      .then((name) => {
        logger.info({ name }, 'React DevTools 扩展已安装');
      })
      .catch((err: unknown) => {
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
