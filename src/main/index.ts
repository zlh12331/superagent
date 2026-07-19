// src/main/index.ts
// Electron 主进程入口
// 职责：创建 BrowserWindow、加载渲染层、配置安全基线
// 设计文档 §1.1 进程拓扑 / §4.5 安全配置 / §7.6 日志 / §7.7 Sentry

import { join } from 'node:path';
import * as Sentry from '@sentry/electron/main';
import { app, BrowserWindow, shell } from 'electron';
import { initializeDatabase, shutdownDatabase } from './app/db-init';
import { getAppConfig } from './config';
import { initLogger, logger, registerGlobalErrorHandlers } from './utils/logger';

// __dirname / __filename 由 electron-vite 6.x 在构建时自动注入
// （基于 import.meta.dirname / import.meta.filename，Node 24 原生支持）
// 详见 https://electron-vite.org/guide/dev#limitations-of-sandboxing

// dev 环境把 userData 重定向到项目内目录，避免 TRAE 沙箱拦截系统 %APPDATA% 写入
// 生产环境（app.isPackaged === true）保持系统默认 %APPDATA%/<AppName>，符合用户数据规范
if (!app.isPackaged) {
  app.setPath('userData', join(__dirname, '../../.electron-user-data'));
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
 * 必须在 app.whenReady() 之前调用
 */
function initSentry(): void {
  const config = getAppConfig();
  if (config.sentry.dsn === '') {
    // DSN 未配置时跳过初始化（dev 环境常见）
    logger.warn({}, 'Sentry DSN 未配置，跳过初始化');
    return;
  }

  Sentry.init({
    dsn: config.sentry.dsn,
    release: `novel-writer@${app.getVersion()}`,
    environment: config.isPackaged ? 'production' : 'development',
    tracesSampleRate: config.sentry.tracesSampleRate,
    sendDefaultPii: false,
    beforeSend(event) {
      // 脱敏：移除可能的 API Key / Authorization header
      // 注意：@sentry/electron 5 的 beforeSend 入参为 ErrorEvent（type: undefined），
      // 返回类型必须为 ErrorEvent | null，因此采用不可变更新保持 type 兼容
      if (event.request?.headers?.authorization) {
        const { authorization: _auth, ...restHeaders } = event.request.headers;
        return { ...event, request: { ...event.request, headers: restHeaders } };
      }
      return event;
    },
  });
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
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  return win;
}

// Sentry 必须在 app.whenReady() 之前初始化（@sentry/electron 要求）
initSentry();

// 应用就绪后初始化 logger + 全局错误捕获 + 数据库 + 创建窗口
app.whenReady().then(async () => {
  // 初始化 logger（需要 app.getPath，必须在 whenReady 之后）
  initLogger();
  registerGlobalErrorHandlers();
  logger.info({}, '应用启动');

  // 初始化数据库（initdb + PG 启动 + migration + AGE + HNSW，设计文档 §1.1 + §6.5）
  // 失败则直接退出应用（无数据库无法运行）
  try {
    await initializeDatabase();
    logger.info({}, '数据库初始化完成');
  } catch (err) {
    logger.error({ error: err }, '数据库初始化失败，应用将退出');
    app.exit(1);
    return;
  }

  createWindow();

  // macOS: 点击 dock 图标时若无窗口则重建
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出前关闭数据库（设计文档 §1.1 应用生命周期）
// shutdownDatabase 包含 disconnectPrisma + pgController.stop（Phase 4b 集成）
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
    await shutdownDatabase();
  } catch (err) {
    logger.error({ error: err }, '应用退出清理失败');
  }
  // 强制退出，不再触发 before-quit（与 app.quit() 不同）
  app.exit(0);
});
