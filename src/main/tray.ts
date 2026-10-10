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

/** 托盘文案形状（双语文案表统一结构） */
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

/** 界面语言（settings.language 的合法值） */
type TrayLocale = 'zh-CN' | 'en';

/** 托盘文案（主进程无 i18n 体系，内置双语文案表按 settings.language 取用） */
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

/** 托盘会话条目（菜单「最近会话 ▸」） */
export interface TraySessionItem {
  readonly id: string;
  readonly title: string;
}

/** 首次最小化引导的已提示标记（app_settings；主进程直写，渲染层不感知） */
const HIDE_HINT_KEY = 'window.hideHintShown';

/** 托盘依赖（index.ts 装配；全部注入，本模块不触碰服务容器） */
export interface TrayDeps {
  /** 当前更新状态（null = 从未检查） */
  getUpdateStatus: () => UpdateStatusPayload | null;
  /** 是否有回合在跑（Agent 服务未初始化时安全返回 false） */
  hasRunningTurns: () => boolean;
  /** 最近会话（按更新时间倒序前 5） */
  listRecentSessions: () => Promise<readonly TraySessionItem[]>;
  /** 新建会话（返回新会话 id，用于唤回 + 导航） */
  createSession: () => Promise<string>;
  /** 打开指定会话（唤回 + 导航） */
  openSession: (sessionId: string) => void;
  /** 手动检查更新（自动检查静默） */
  checkForUpdate: () => void;
  /** 两段式安装（置标记 + 触发退出，退出链末端拉起安装器） */
  installUpdate: () => void;
  /** 写入开机自启（OS 登录项） */
  setAutostart: (enabled: boolean) => void;
  /**
   * 读取关窗行为
   *
   * 数据源是 `settings.window.closeAction`（SQLite），**不是** OS 登录项——
   * spec 28 §6:145-146 明确两个勾选项来源不同、勿混用存储。
   */
  getCloseAction: () => 'minimize' | 'quit';
  /** 写入关窗行为（实现须读改写，不覆盖同域其它字段） */
  setCloseAction: (action: 'minimize' | 'quit') => void;
  /** 订阅更新状态变化（图标/tooltip 更新） */
  onUpdateStatus: (listener: (payload: UpdateStatusPayload) => void) => () => void;
  /** 当前界面语言（settings.language；未知回退 zh-CN） */
  getLocale: () => TrayLocale;
}

let tray: Tray | null = null;
let deps: TrayDeps | null = null;

/**
 * 创建托盘图标
 *
 * macOS：template 图标（trayTemplate.png，createFromPath 自动挂同名 @2x 为
 *        2x 表示；黑色剪影 + alpha，系统按菜单栏深浅色自动反色）。
 * Windows/Linux：预生成多尺寸彩色图标（16/24/32 按 DPI 取档，见
 *        scripts/generate-tray-assets.py）；缺资源时回退运行时缩放 icon.png。
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
/**
 * 创建系统托盘（幂等：已创建则复用）。左键单击显示/聚焦主窗口，
 * 右键菜单含窗口/设置/退出入口
 */
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

/** 当前语言的托盘文案 */
function currentText(): TrayText {
  const locale = deps?.getLocale() ?? 'zh-CN';
  return TRAY_TEXT[locale] ?? TRAY_TEXT['zh-CN'];
}

/** tooltip 随更新状态变化（空闲 / 下载中带百分比 / 就绪） */
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

/** 右键菜单：即时构建（状态行 / 新建会话 / 最近会话 / 更新 / 自启 / 退出） */
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

/** 打开指定会话：唤回窗口并广播深度链接导航 */
function openSession(sessionId: string): void {
  showMainWindow();
  broadcastDeepLink({ sessionId, url: `code-agent://open/session/${sessionId}` });
}

/**
 * 首次最小化到托盘的一次性引导通知（点击唤回；已提示过不再发）
 *
 * 由 window.ts 的 minimize 关窗分支调用（closeAction = minimize 时）。
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
