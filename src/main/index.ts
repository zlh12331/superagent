// src/main/index.ts
// Electron 主进程入口
// 职责：创建 BrowserWindow、加载渲染层、配置安全基线
// 设计文档 §1.1 进程拓扑 / §4.5 安全配置

import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';

// __dirname / __filename 由 electron-vite 6.x 在构建时自动注入
// （基于 import.meta.dirname / import.meta.filename，Node 24 原生支持）
// 详见 https://electron-vite.org/guide/dev#limitations-of-sandboxing

// dev 环境把 userData 重定向到项目内目录，避免 TRAE 沙箱拦截系统 %APPDATA% 写入
// 生产环境（app.isPackaged === true）保持系统默认 %APPDATA%/<AppName>，符合用户数据规范
if (!app.isPackaged) {
  app.setPath('userData', join(__dirname, '../../.electron-user-data'));
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

// 应用就绪后创建窗口
app.whenReady().then(() => {
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
