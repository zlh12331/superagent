// tray.ts：系统托盘（后台驻留中心）——右键菜单（状态/最近会话/更新/自启/关窗行为/退出）、
// tooltip 随更新状态变化、首关到托盘引导。依赖经 TrayDeps 注入（不直连服务容器，index.ts 装配）
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

// 托盘文案内置双语：托盘在主进程，不走渲染层 i18n 管线；语言跟随 settings.language
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

/** 最近会话菜单项（id 用于深链打开，title 直接展示） */
export interface TraySessionItem {
  readonly id: string;
  readonly title: string;
}

// 首次「最小化到托盘」引导通知的已读标记（一次性）
const HIDE_HINT_KEY = 'window.hideHintShown';

/** 托盘依赖注入接口：全部能力由 index.ts 从服务容器装配传入，托盘自身无业务依赖 */
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

/**
 * 构建托盘图标，三级降级：macOS template 图标（自适应明暗）→ 多分辨率 rep（1.5x/2x 保高清屏清晰）
 * → 应用图标缩到 16px → 空图（托盘仍可创建）
 */
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
/** 创建托盘单例（重复调用幂等）；左键唤起主窗，右键弹菜单（Windows/Linux 惯例） */
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

/** tooltip 承载更新状态：下载中显示进度、下载完提示可安装，平时只显示应用名 */
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

// 每次右键实时重建菜单：回合状态/更新进度/最近会话都是易变状态，缓存模板会展示过期数据
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

/** 从托盘打开会话：先唤起主窗，再经深链通道让渲染层切换激活会话 */
function openSession(sessionId: string): void {
  showMainWindow();
  broadcastDeepLink({ sessionId, url: `code-agent://open/session/${sessionId}` });
}

/**
 * 首次「最小化到托盘」引导通知：读 HIDE_HINT_KEY 即置位，只提示这一次
 * （关窗即消失的应用容易让用户以为已退出，找不到入口）
 */
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
