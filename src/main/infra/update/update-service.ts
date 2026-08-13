// src/main/infra/update/update-service.ts
// 自动更新服务（electron-updater 封装，定义表驱动事件推送）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 启动时注册 autoUpdater 事件监听，转换为 UpdateStatusPayload 推送渲染层
// - check(manual)：手动/自动触发更新检查（开发模式返回明确错误）
// - quitAndInstall()：下载完成后安装并重启
//
// 设计：
// - 注入式：AutoUpdaterLike 接口抽象 electron-updater，测试注入 fake 实现
// - 事件推送：广播到所有窗口（webContents.send UPDATE_EVENT_STATUS）
// - 更新源：electron-updater 打包后自动读取 electron-builder 生成的
//   app-update.yml（由 electron-builder.yml 的 publish 配置生成），
//   无需运行时 setFeedURL
// ──────────────────────────────────────────────────────────────

import type { UpdateCheckRes, UpdateStatusPayload } from '@code-agent/shared/main';
import { IPC_DEFINITIONS } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';
import { emitEvent } from '../../utils/emit-event';
import { logger } from '../../utils/logger';

/**
 * electron-updater autoUpdater 的可注入子集
 *
 * 只声明 UpdateService 用到的 API，测试可注入 fake 实现
 * （与工具/服务层 DI 注入模式一致，不 mock 模块）。
 */
export interface AutoUpdaterLike {
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: 'checking-for-update', listener: () => void): void;
  on(event: 'update-available', listener: (info: { version: string }) => void): void;
  on(event: 'update-not-available', listener: () => void): void;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): void;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

/** UpdateService 接口（服务容器注入用） */
// biome-ignore lint/style/useNamingConvention: I 前缀接口遵循项目惯例（IChatService 等）
export interface IUpdateService {
  /** 注册 autoUpdater 事件监听（app ready 后调用一次） */
  start(): void;
  /** 触发更新检查（自动下载在 available 后开始，electron-updater 默认行为） */
  check(manual: boolean): Promise<UpdateCheckRes>;
  /** 安装已下载的更新并重启 */
  quitAndInstall(): void;
  /** 释放资源（electron-updater 无 off API，空实现占位） */
  dispose(): void;
}

/**
 * 自动更新服务实现
 *
 * @example
 * ```ts
 * const updateService = new UpdateService(autoUpdater, () => app.isPackaged);
 * updateService.start();
 * await updateService.check(false);
 * ```
 */
export class UpdateService implements IUpdateService {
  constructor(
    private readonly updater: AutoUpdaterLike,
    private readonly isPackaged: () => boolean,
  ) {}

  /** @inheritDoc */
  start(): void {
    this.updater.on('checking-for-update', () => {
      this.emit({ phase: 'checking' });
    });
    this.updater.on('update-available', (info) => {
      logger.info({ version: info.version }, '发现新版本');
      this.emit({ phase: 'available', version: info.version });
    });
    this.updater.on('update-not-available', () => {
      this.emit({ phase: 'not-available' });
    });
    this.updater.on('download-progress', (progress) => {
      this.emit({ phase: 'downloading', progress: Math.round(progress.percent) });
    });
    this.updater.on('update-downloaded', (info) => {
      logger.info({ version: info.version }, '新版本下载完成');
      this.emit({ phase: 'downloaded', version: info.version });
    });
    this.updater.on('error', (error) => {
      logger.error({ error: error.message }, '自动更新失败');
      this.emit({ phase: 'error', message: error.message });
    });
  }

  /** @inheritDoc */
  async check(manual: boolean): Promise<UpdateCheckRes> {
    // 开发模式（未打包）：electron-updater 无 app-update.yml，检查必失败
    if (!this.isPackaged()) {
      const message = '开发模式不支持自动更新（请打包后测试）';
      if (manual) {
        this.emit({ phase: 'error', message });
      }
      return { status: 'error', message };
    }
    try {
      await this.updater.checkForUpdates();
      return { status: 'checking' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (manual) {
        this.emit({ phase: 'error', message });
      }
      return { status: 'error', message };
    }
  }

  /** @inheritDoc */
  quitAndInstall(): void {
    this.updater.quitAndInstall();
  }

  /** @inheritDoc */
  dispose(): void {
    // electron-updater 的事件监听随进程退出释放，无显式 off API
  }

  /** 推送更新状态到所有渲染窗口（R2：统一出口 emitEvent——dev 契约校验） */
  private emit(payload: UpdateStatusPayload): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        emitEvent(win.webContents, IPC_DEFINITIONS.update.subscribeStatus, payload);
      }
    }
  }
}
