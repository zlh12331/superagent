// src/main/infra/update/update-service.test.ts
// UpdateService 单测：事件桥接 / 状态推送 / 打包判断（fake autoUpdater 注入）
import { beforeEach, describe, expect, it, vi } from 'vitest';

// mock electron：BrowserWindow.getAllWindows（事件推送目标窗口）
const { mockGetAllWindows } = vi.hoisted(() => ({
  mockGetAllWindows: vi.fn(),
}));

vi.mock('electron', () => ({
  // 字符串键：避免 useNamingConvention 对 PascalCase 属性名的检查
  ['BrowserWindow']: { getAllWindows: mockGetAllWindows },
}));

import { type AutoUpdaterLike, UpdateService } from './update-service';

/** 创建 fake autoUpdater（记录事件监听，测试可手动触发） */
function createFakeUpdater() {
  const listeners = new Map<string, (arg?: unknown) => void>();
  return {
    listeners,
    checkForUpdates: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (arg?: unknown) => void) => {
      listeners.set(event, listener);
    }),
  } as unknown as AutoUpdaterLike & {
    listeners: Map<string, (arg?: unknown) => void>;
    checkForUpdates: ReturnType<typeof vi.fn>;
    quitAndInstall: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
}

/** 触发 autoUpdater 事件 */
function fire(updater: ReturnType<typeof createFakeUpdater>, event: string, arg?: unknown): void {
  const listener = updater.listeners.get(event);
  if (listener !== undefined) {
    listener(arg);
  }
}

/** 创建 fake 窗口（记录 webContents.send） */
function createFakeWindow() {
  const send = vi.fn();
  return { isDestroyed: () => false, webContents: { send } };
}

describe('UpdateService', () => {
  let updater: ReturnType<typeof createFakeUpdater>;
  let service: UpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    updater = createFakeUpdater();
    service = new UpdateService(updater, () => true);
    mockGetAllWindows.mockReturnValue([]);
  });

  describe('start', () => {
    it('注册 6 个 autoUpdater 事件监听', () => {
      service.start();
      expect(updater.on).toHaveBeenCalledTimes(6);
      for (const event of [
        'checking-for-update',
        'update-available',
        'update-not-available',
        'download-progress',
        'update-downloaded',
        'error',
      ]) {
        expect(updater.on).toHaveBeenCalledWith(event, expect.any(Function));
      }
    });

    it('update-available 事件 → 推送 available payload（含版本）', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-available', { version: '1.1.0' });
      expect(win.webContents.send).toHaveBeenCalledWith('update:event:status', {
        phase: 'available',
        version: '1.1.0',
      });
    });

    it('download-progress 事件 → 推送四舍五入进度', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'download-progress', { percent: 42.6 });
      expect(win.webContents.send).toHaveBeenCalledWith('update:event:status', {
        phase: 'downloading',
        progress: 43,
      });
    });

    it('update-downloaded 事件 → 推送 downloaded payload', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-downloaded', { version: '1.1.0' });
      expect(win.webContents.send).toHaveBeenCalledWith('update:event:status', {
        phase: 'downloaded',
        version: '1.1.0',
      });
    });

    it('error 事件 → 推送 error payload（含 message）', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'error', new Error('network down'));
      expect(win.webContents.send).toHaveBeenCalledWith('update:event:status', {
        phase: 'error',
        message: 'network down',
      });
    });

    it('已销毁窗口跳过推送', () => {
      const win = createFakeWindow();
      win.isDestroyed = () => true;
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-not-available');
      expect(win.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('check', () => {
    it('开发模式（未打包）：返回 error 且不调用 checkForUpdates', async () => {
      const devService = new UpdateService(updater, () => false);
      const result = await devService.check(true);
      expect(result.status).toBe('error');
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('开发模式手动检查：额外推送 error 事件', async () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      const devService = new UpdateService(updater, () => false);
      await devService.check(true);
      expect(win.webContents.send).toHaveBeenCalledWith('update:event:status', {
        phase: 'error',
        message: expect.stringContaining('开发模式'),
      });
    });

    it('打包模式：调用 checkForUpdates 并返回 checking', async () => {
      const result = await service.check(false);
      expect(updater.checkForUpdates).toHaveBeenCalledOnce();
      expect(result).toEqual({ status: 'checking' });
    });

    it('checkForUpdates 抛错：返回 error；手动检查时推送 error 事件', async () => {
      updater.checkForUpdates.mockRejectedValueOnce(new Error('feed unreachable'));
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      const result = await service.check(true);
      expect(result).toEqual({ status: 'error', message: 'feed unreachable' });
      expect(win.webContents.send).toHaveBeenCalledWith('update:event:status', {
        phase: 'error',
        message: 'feed unreachable',
      });
    });

    it('自动检查失败：返回 error 但不推送事件（静默）', async () => {
      updater.checkForUpdates.mockRejectedValueOnce(new Error('feed unreachable'));
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      const result = await service.check(false);
      expect(result.status).toBe('error');
      expect(win.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('quitAndInstall', () => {
    it('转发到 autoUpdater.quitAndInstall', () => {
      service.quitAndInstall();
      expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    });
  });
});
