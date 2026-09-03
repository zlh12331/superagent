// src/main/tray.ts
// 系统托盘关注点（后台驻留 + 窗口唤回）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-04 功能补齐）：桌面 Agent 常驻托盘——后台运行时用户可从
// 托盘唤回（最小化/失焦后）。

// 设计（保守，不改变既有"点 X 即协商退出"语义）：
// - 常驻托盘图标 + 右键菜单：显示窗口 / 退出
// - 左键单击托盘图标 → 显示/聚焦主窗口（桌面应用惯例）
// - 退出菜单位走完整善后链（app.quit() → before-quit drain）
// - 窗口关闭语义不变（仍由 window.ts 协商 + window-all-closed 退出）
//
// 平台差异：
// - Windows/Linux：Tray 长期可用；macOS 需 template 图标（menubar 自动深色适配）
// - 图标来源：resources/icons/trayTemplate.png（macOS template）+ tray.png（其他）
// ──────────────────────────────────────────────────────────────

import { join } from 'node:path';
import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';

import { logger } from './utils/logger';

let tray: Tray | null = null;

/**
 * 创建系统托盘（幂等：已存在则复用）
 *
 * 在 whenReady 后调用（Tray 构造需要 app ready）。应用退出时随进程回收。
 */
export function createTray(): void {
  if (tray !== null) {
    return; // 已创建（如 macOS activate 重建窗口路径），复用
  }
  // 图标：暂用应用图标（icon.png，随应用打包在 resources/icons/）。
  // macOS 托盘理想为 template 图标（trayTemplate.png，系统自动深色适配），
  // 当前 assets 未产出——待补资源时切换；缺图时 nativeImage 空图会静默
  // 崩溃窗口，故先创建失败则回退默认（Electron 默认图标）。
  const iconPath = join(app.getAppPath(), 'resources/icons/icon.png');
  const image = nativeImage.createFromPath(iconPath);
  const fallback = nativeImage.createEmpty();
  // 派生的 16x16（托盘标准尺寸，减内存与平台适配抖动）
  const trayImage = image.isEmpty() ? fallback : image.resize({ width: 16, height: 16 });

  tray = new Tray(trayImage);
  tray.setToolTip(app.getName());

  // 左键单击 → 显示/聚焦主窗口（Windows 默认行为；macOS Linux 需显式绑定）
  tray.on('click', () => {
    showMainWindow();
  });

  // 右键菜单：显示窗口 / 退出（对齐桌面应用托盘惯例）
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示 Code Agent',
        click: () => {
          showMainWindow();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          logger.info({}, '托盘退出菜单被点击，走完整退出善后链');
          app.quit();
        },
      },
    ]),
  );

  logger.info({}, '系统托盘已创建（后台驻留，托盘可唤回窗口）');
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
