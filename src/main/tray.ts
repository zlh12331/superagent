// src/main/tray.ts
// 系统托盘（后台驻留中心）：状态驱动的 tooltip/动态菜单
// ──────────────────────────────────────────────────────────────
// 设计（docs/design/28-tray-spec.md）：
// - 菜单在右键时即时构建（读取实时回合/更新状态与当前语言），无重建时机簿记
// - tooltip 随更新状态变化（空闲/下载中/就绪），经 onUpdateStatus 订阅驱动；
//   托盘图标的视觉变体（角标）需要设计资源，列 P2（见 §5 角标实现口径）
// - 左键唤回主窗口；「退出」走完整善后链（app.quit() → before-quit 协商）
// - 依赖全部注入（index.ts 装配），本模块不触碰 service-container
// ──────────────────────────────────────────────────────────────

import { join } from 'node:path';
import type { UpdateStatusPayload } from '@code-agent/shared/main';
import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeImage,
  Tray,
} from 'electron';
import { broadcastDeepLink } from './deep-link';
import { readSetting, writeSetting } from './infra/storage/settings-pref';
import { logger } from './utils/logger';

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
 * macOS：优先加载 template 图标（trayTemplate[_@2x].png，系统自动深浅色适配）；
 *        无 template 资源时回退到常规彩色图标。
 * Windows/Linux：加载常规彩色图标。
 */
function createTrayImage(): Electron.NativeImage {
  const resourcesDir = join(app.getAppPath(), 'resources/icons');

  if (process.platform === 'darwin') {
    // macOS template 图标：黑色轮廓 + alpha 通道，系统自动深浅色适配
    const template2x = nativeImage.createFromPath(join(resourcesDir, 'trayTemplate@2x.png'));
    if (!template2x.isEmpty()) {
      template2x.setTemplateImage(true);
      return template2x;
    }
    const template1x = nativeImage.createFromPath(join(resourcesDir, 'trayTemplate.png'));
    if (!template1x.isEmpty()) {
      template1x.setTemplateImage(true);
      return template1x;
    }
    // 无 template 资源：回退常规图标
    logger.info({}, 'macOS template 图标不存在，回退常规图标');
  }

  const iconPath = join(resourcesDir, 'icon.png');
  const image = nativeImage.createFromPath(iconPath);
  const fallback = nativeImage.createEmpty();
  return image.isEmpty() ? fallback : image.resize({ width: 16, height: 16 });
}
export function createTray(trayDeps: TrayDeps): void {
  if (tray !== null) {
    return; // 已创建（如 macOS activate 重建窗口路径），复用
  }
  deps = trayDeps;

  // macOS 优先 template 图标（系统自动深浅色），无则回退常规彩色图标
  const trayImage = createTrayImage();
  tray = new Tray(trayImage);
  updateTrayPresentation();

  // 左键单击 → 显示/聚焦主窗口（Windows 默认行为；macOS Linux 需显式绑定）
  tray.on('click', () => {
    showMainWindow();
  });

  // 右键 → 即时构建菜单（实时状态 + 当前语言），无静态菜单的重建时机问题
  tray.on('right-click', () => {
    void popUpMenu();
  });

  // 更新状态变化 → 刷新 tooltip（菜单在右键时即时构建，无需跟随）
  trayDeps.onUpdateStatus(() => {
    updateTrayPresentation();
  });

  logger.info({}, '系统托盘已创建（后台驻留中心）');
}

/** 显示并聚焦主窗口（最小化时还原） */
function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win === undefined || win.isDestroyed()) {
    return;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  win.focus();
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
  // 局部捕获：闭包内引用模块级可变变量会让 TS 收窄失效（且运行时更稳）
  const d = deps;
  const t = tray;
  if (t === null || d === null) {
    return;
  }
  const text = currentText();
  const running = d.hasRunningTurns();
  const status = d.getUpdateStatus();
  const template: MenuItemConstructorOptions[] = [
    // 状态行（只读）：回合运行态即时读取
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
    // 更新就绪：菜单项升级为安装动作（复用两段式安装链路）
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

  // 开机自启（OS 登录项直读直写，与设置页开关同源）
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  template.push({
    label: text.autostart,
    type: 'checkbox',
    checked: openAtLogin,
    click: () => {
      d.setAutostart(!openAtLogin);
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
    // 通知失败（构造异常等）非致命：记录后继续运行
    logger.warn({ error: String(err) }, '最小化引导通知发送失败（忽略）');
  }
}
