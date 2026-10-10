import { join } from 'node:path';
import type { UpdateStatusPayload } from '@code-agent/shared/main';
import {
  app,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  Tray,
} from 'electron';
import { broadcastDeepLink } from './deep-link';
import { createAutostartDeps, readAutostartState } from './infra/autostart/autostart';
import { readSetting, writeSetting } from './infra/storage/settings-pref';
import { logger } from './utils/logger';
import { showMainWindow } from './window-show';

interface TrayText {
  readonly running: string;
  readonly idle: string;
  readonly newSession: string;
  readonly recentSessions: string;
  readonly checkUpdate: string;
  readonly installUpdate: string;
  readonly downloading: string;
  readonly autostart: string;
  readonly closeToTray: string;
  readonly quit: string;
  readonly minimized: string;
}

type TrayLocale = 'zh-CN' | 'en';

const TRAY_TEXT: Readonly<Record<TrayLocale, TrayText>> = {
  'zh-CN': {
    running: '● 有回合正在运行',
    idle: '空闲',
    newSession: '新建会话',
    recentSessions: '最近会话',
    checkUpdate: '检查更新',
    installUpdate: '重启并安装',
    downloading: '下载中',
    autostart: '开机自启',
    closeToTray: '关闭时最小化到托盘',
    quit: '退出',
    minimized: '已最小化到托盘，退出请用托盘菜单',
  },
  en: {
    running: '● A turn is running',
    idle: 'Idle',
    newSession: 'New session',
    recentSessions: 'Recent sessions',
    checkUpdate: 'Check for updates',
    installUpdate: 'Restart & install',
    downloading: 'Downloading',
    autostart: 'Launch at login',
    closeToTray: 'Minimize to tray on close',
    quit: 'Quit',
    minimized: 'Minimized to tray. Quit from the tray menu',
  },
} as const;

export interface TraySessionItem {
  readonly id: string;
  readonly title: string;
}

const HIDE_HINT_KEY = 'window.hideHintShown';

export interface TrayDeps {
  getUpdateStatus: () => UpdateStatusPayload | null;
  hasRunningTurns: () => boolean;
  listRecentSessions: () => Promise<readonly TraySessionItem[]>;
  createSession: () => Promise<string>;
  openSession: (sessionId: string) => void;
  checkForUpdate: () => void;
  installUpdate: () => void;
  setAutostart: (enabled: boolean) => void;
  getCloseAction: () => 'minimize' | 'quit';
  setCloseAction: (action: 'minimize' | 'quit') => void;
  onUpdateStatus: (listener: (payload: UpdateStatusPayload) => void) => () => void;
  getLocale: () => TrayLocale;
}

let tray: Tray | null = null;
let deps: TrayDeps | null = null;

function createTrayImage(): Electron.NativeImage {
  const resourcesDir = join(app.getAppPath(), 'resources/icons');

  if (process.platform === 'darwin') {
    const template = nativeImage.createFromPath(join(resourcesDir, 'trayTemplate.png'));
    if (!template.isEmpty()) {
      template.setTemplateImage(true);
      return template;
    }
    logger.info({}, 'macOS template 图标不存在，回退常规图标');
  }

  const base = nativeImage.createFromPath(join(resourcesDir, 'tray16.png'));
  if (!base.isEmpty()) {
    for (const [scaleFactor, file] of [
      [1.5, 'tray24.png'],
      [2, 'tray32.png'],
    ] as const) {
      const rep = nativeImage.createFromPath(join(resourcesDir, file));
      if (!rep.isEmpty()) {
        base.addRepresentation({ scaleFactor, buffer: rep.toPNG() });
      }
    }
    return base;
  }

  const iconPath = join(resourcesDir, 'icon.png');
  const image = nativeImage.createFromPath(iconPath);
  const fallback = nativeImage.createEmpty();
  return image.isEmpty() ? fallback : image.resize({ width: 16, height: 16 });
}
export function createTray(trayDeps: TrayDeps): void {
  if (tray !== null) {
    return;
  }
  deps = trayDeps;

  const trayImage = createTrayImage();
  tray = new Tray(trayImage);
  updateTrayPresentation();

  tray.on('click', () => {
    showMainWindow();
  });

  tray.on('right-click', () => {
    void popUpMenu();
  });

  trayDeps.onUpdateStatus(() => {
    updateTrayPresentation();
  });

  logger.info({}, '系统托盘已创建（后台驻留中心）');
}

function currentText(): TrayText {
  const locale = deps?.getLocale() ?? 'zh-CN';
  return TRAY_TEXT[locale] ?? TRAY_TEXT['zh-CN'];
}

function updateTrayPresentation(): void {
  if (tray === null || deps === null) {
    return;
  }
  const status = deps.getUpdateStatus();
  const name = app.getName();
  if (status?.phase === 'downloading') {
    tray.setToolTip(`${name} — ${currentText().downloading} ${status.progress ?? 0}%`);
    return;
  }
  if (status?.phase === 'downloaded') {
    tray.setToolTip(`${name} — ${currentText().installUpdate}`);
    return;
  }
  tray.setToolTip(name);
}

async function popUpMenu(): Promise<void> {
  const d = deps;
  const t = tray;
  if (t === null || d === null) {
    return;
  }
  const text = currentText();
  const running = d.hasRunningTurns();
  const status = d.getUpdateStatus();
  const template: MenuItemConstructorOptions[] = [
    { label: running ? text.running : text.idle, enabled: false },
    { type: 'separator' },
    {
      label: text.newSession,
      click: () => {
        void d
          .createSession()
          .then((sessionId) => {
            openSession(sessionId);
          })
          .catch((err: unknown) => {
            logger.error({ error: String(err) }, '托盘新建会话失败');
          });
      },
    },
  ];

  const sessions = await d.listRecentSessions().catch(() => []);
  if (sessions.length > 0) {
    template.push({
      label: text.recentSessions,
      submenu: sessions.slice(0, 5).map((session) => ({
        label: session.title,
        click: () => {
          openSession(session.id);
        },
      })),
    });
  }

  template.push({ type: 'separator' });
  if (status?.phase === 'downloaded') {
    template.push({
      label: text.installUpdate,
      click: () => {
        d.installUpdate();
      },
    });
  } else if (status?.phase === 'downloading') {
    template.push({
      label: `${text.downloading} ${status.progress ?? 0}%`,
      enabled: false,
    });
  } else {
    template.push({
      label: text.checkUpdate,
      click: () => {
        d.checkForUpdate();
      },
    });
  }

  const autostart = await readAutostartState(createAutostartDeps());
  template.push({
    label: text.autostart,
    type: 'checkbox',
    checked: autostart.openAtLogin,
    ...(autostart.supported ? {} : { enabled: false }),
    click: () => {
      d.setAutostart(!autostart.openAtLogin);
    },
  });

  const closeAction = d.getCloseAction();
  template.push({
    label: text.closeToTray,
    type: 'checkbox',
    checked: closeAction === 'minimize',
    click: () => {
      d.setCloseAction(closeAction === 'minimize' ? 'quit' : 'minimize');
    },
  });

  template.push({ type: 'separator' });
  template.push({
    label: text.quit,
    click: () => {
      logger.info({}, '托盘退出菜单被点击，走完整退出善后链');
      app.quit();
    },
  });

  t.popUpContextMenu(Menu.buildFromTemplate(template));
}

function openSession(sessionId: string): void {
  showMainWindow();
  broadcastDeepLink({ sessionId, url: `code-agent://open/session/${sessionId}` });
}

export function notifyMinimizedToTray(): void {
  if (tray === null || deps === null || !Notification.isSupported()) {
    return;
  }
  try {
    if (readSetting(HIDE_HINT_KEY) === true) {
      return;
    }
    writeSetting(HIDE_HINT_KEY, true);
    const text = currentText();
    const notification = new Notification({
      title: app.getName(),
      body: text.minimized,
      silent: true,
    });
    notification.on('click', () => {
      showMainWindow();
    });
    notification.show();
  } catch (err) {
    logger.warn({ error: String(err) }, '最小化引导通知发送失败（忽略）');
  }
}
