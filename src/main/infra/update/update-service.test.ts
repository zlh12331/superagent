// src/main/infra/update/update-service.test.ts
// UpdateService 单测：事件桥接 / 启动调度与退避 / 开关 / 进度透传 / 快照 / 取消 / 静默安装
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mock electron：BrowserWindow.getAllWindows（事件推送目标窗口）
const { mockGetAllWindows } = vi.hoisted(() => ({
  mockGetAllWindows: vi.fn(),
}));

vi.mock('electron', () => ({
  // 字符串键：避免 useNamingConvention 对 PascalCase 属性名的检查
  ['BrowserWindow']: { getAllWindows: mockGetAllWindows },
}));

import {
  type AutoUpdaterLike,
  type CancellationTokenLike,
  classifyUpdateError,
  toReleaseNotes,
  UpdateService,
} from './update-service';

/** fake updater 形状（含测试控制字段） */
type FakeUpdater = AutoUpdaterLike & {
  listeners: Map<string, (arg?: unknown) => void>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
};

/** 创建 fake autoUpdater（记录事件监听，测试可手动触发） */
function createFakeUpdater(): FakeUpdater {
  const listeners = new Map<string, (arg?: unknown) => void>();
  const updater = {
    listeners,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    forceDevUpdateConfig: false,
    logger: null as unknown,
    checkForUpdates: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (arg?: unknown) => void) => {
      listeners.set(event, listener);
    }),
  };
  return updater as unknown as FakeUpdater;
}

/** 创建 fake 取消令牌（cancel 后 cancelled 置真） */
function createFakeToken(): CancellationTokenLike & { cancel: ReturnType<typeof vi.fn> } {
  let cancelled = false;
  return {
    cancel: vi.fn(() => {
      cancelled = true;
    }),
    get cancelled(): boolean {
      return cancelled;
    },
  };
}

/** 触发 autoUpdater 事件 */
function fire(updater: FakeUpdater, event: string, arg?: unknown): void {
  const listener = updater.listeners.get(event);
  if (listener !== undefined) {
    listener(arg);
  }
}

/** 创建 fake 窗口（记录 webContents.send / setProgressBar；R2：emitEvent 需要 webContents.isDestroyed） */
function createFakeWindow() {
  const send = vi.fn();
  const setProgressBar = vi.fn();
  return {
    isDestroyed: () => false,
    setProgressBar,
    webContents: { isDestroyed: () => false, send },
  };
}

/** 取窗口上收到的最后一个 payload */
function lastPayload(win: ReturnType<typeof createFakeWindow>): unknown {
  const calls = win.webContents.send.mock.calls;
  const last = calls[calls.length - 1];
  return last === undefined ? undefined : last[1];
}

describe('UpdateService', () => {
  let updater: FakeUpdater;
  let tokens: Array<CancellationTokenLike & { cancel: ReturnType<typeof vi.fn> }>;
  let service: UpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    updater = createFakeUpdater();
    tokens = [];
    service = new UpdateService(
      updater,
      () => true,
      () => {
        const token = createFakeToken();
        tokens.push(token);
        return token;
      },
    );
    mockGetAllWindows.mockReturnValue([]);
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  describe('start', () => {
    it('注册 7 个 autoUpdater 事件监听', () => {
      service.start();
      expect(updater.on).toHaveBeenCalledTimes(7);
      for (const event of [
        'checking-for-update',
        'update-available',
        'update-not-available',
        'download-progress',
        'update-downloaded',
        'update-cancelled',
        'error',
      ]) {
        expect(updater.on).toHaveBeenCalledWith(event, expect.any(Function));
      }
    });

    it('接管日志出口并改由服务显式发起下载（autoDownload=false）', () => {
      service.start();
      expect(updater.autoDownload).toBe(false);
      expect(updater.logger).not.toBeNull();
    });

    it('开关开启：autoInstallOnAppQuit 保持 true', () => {
      service.start({ autoCheckEnabled: () => true });
      expect(updater.autoInstallOnAppQuit).toBe(true);
    });

    it('开关关闭：停用退出自动安装且不调度启动检查', async () => {
      vi.useFakeTimers();
      service.start({ autoCheckEnabled: () => false });
      expect(updater.autoInstallOnAppQuit).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('开发模式（未打包）：不调度启动检查', async () => {
      vi.useFakeTimers();
      const devService = new UpdateService(
        updater,
        () => false,
        () => createFakeToken(),
      );
      devService.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
      expect(updater.forceDevUpdateConfig).toBe(false);
      devService.dispose();
    });

    it('dev 调试开关开启：置 forceDevUpdateConfig 并放行调度与手动检查', async () => {
      vi.useFakeTimers();
      const devService = new UpdateService(
        updater,
        () => false,
        () => createFakeToken(),
      );
      devService.start({ devUpdateEnabled: true });
      expect(updater.forceDevUpdateConfig).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(updater.checkForUpdates).toHaveBeenCalledOnce();
      // 手动检查同样放行（不再返回"开发模式不支持"）
      const result = await devService.check(true);
      expect(result).toEqual({ status: 'checking' });
      devService.dispose();
    });

    it('打包且开关开启：延迟 5s 后发起一次启动检查', async () => {
      vi.useFakeTimers();
      service.start({ autoCheckEnabled: () => true });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    });

    it('启动检查失败：按 1/5/15 分钟退避重试，用尽后本会话不再检查', async () => {
      vi.useFakeTimers();
      updater.checkForUpdates.mockRejectedValue(new Error('offline'));
      service.start();
      await vi.advanceTimersByTimeAsync(5_000); // 首次
      await vi.advanceTimersByTimeAsync(60_000); // 第 1 次重试
      await vi.advanceTimersByTimeAsync(5 * 60_000); // 第 2 次重试
      await vi.advanceTimersByTimeAsync(15 * 60_000); // 第 3 次重试
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(60 * 60_000); // 再等一小时也无新检查
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(4);
    });

    it('检查成功后 12h 补一次长会话兜底检查', async () => {
      vi.useFakeTimers();
      service.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    });

    it('dispose 后挂起的定时器不再触发检查', async () => {
      vi.useFakeTimers();
      service.start();
      service.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  describe('事件 → payload', () => {
    it('update-available → available payload，并以自持 token 发起下载', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-available', { version: '1.2.0' });
      expect(lastPayload(win)).toEqual({ phase: 'available', version: '1.2.0' });
      expect(updater.downloadUpdate).toHaveBeenCalledOnce();
      expect(tokens).toHaveLength(1);
      expect(updater.downloadUpdate).toHaveBeenCalledWith(tokens[0]);
    });

    it('download-progress → 透传字节与速率并补上版本号', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-available', { version: '1.2.0' });
      fire(updater, 'download-progress', {
        percent: 42.6,
        transferred: 12_000_000,
        total: 48_000_000,
        bytesPerSecond: 2_100_000,
      });
      expect(lastPayload(win)).toEqual({
        phase: 'downloading',
        progress: 43,
        transferred: 12_000_000,
        total: 48_000_000,
        bytesPerSecond: 2_100_000,
        version: '1.2.0',
      });
    });

    it('download-progress：未发现版本时不带 version 字段', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'download-progress', {
        percent: 10,
        transferred: 1,
        total: 10,
        bytesPerSecond: 1,
      });
      expect(lastPayload(win)).toEqual({
        phase: 'downloading',
        progress: 10,
        transferred: 1,
        total: 10,
        bytesPerSecond: 1,
      });
    });

    it('update-downloaded → downloaded payload（含版本）', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-downloaded', { version: '1.2.0' });
      expect(lastPayload(win)).toEqual({ phase: 'downloaded', version: '1.2.0' });
    });

    it('update-cancelled → cancelled payload（含版本）', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-available', { version: '1.2.0' });
      fire(updater, 'update-cancelled', { version: '1.2.0' });
      expect(lastPayload(win)).toEqual({ phase: 'cancelled', version: '1.2.0' });
    });

    it('error 事件 → error payload（含分类）', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'error', new Error('network down'));
      expect(lastPayload(win)).toEqual({
        phase: 'error',
        errorKind: 'unknown',
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

    it('update-available 带 releaseNotes → payload 含更新说明', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-available', { version: '1.2.0', releaseNotes: '修复 A\n新增 B' });
      expect(lastPayload(win)).toEqual({
        phase: 'available',
        version: '1.2.0',
        releaseNotes: '修复 A\n新增 B',
      });
    });

    it('update-downloaded 继承发现新版时的更新说明', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-available', { version: '1.2.0', releaseNotes: '说明原文' });
      fire(updater, 'update-downloaded', { version: '1.2.0' });
      expect(lastPayload(win)).toEqual({
        phase: 'downloaded',
        version: '1.2.0',
        releaseNotes: '说明原文',
      });
    });

    it('取消下载后清空更新说明（不在取消态带出）', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-available', { version: '1.2.0', releaseNotes: '说明原文' });
      fire(updater, 'update-cancelled', { version: '1.2.0' });
      expect(lastPayload(win)).toEqual({ phase: 'cancelled', version: '1.2.0' });
    });

    it('下载进度同步到任务栏（0-1，结束后清除）', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-available', { version: '1.2.0' });
      fire(updater, 'download-progress', {
        percent: 42.6,
        transferred: 1,
        total: 2,
        bytesPerSecond: 1,
      });
      expect(win.setProgressBar).toHaveBeenCalledWith(0.43);
      fire(updater, 'update-downloaded', { version: '1.2.0' });
      expect(win.setProgressBar).toHaveBeenLastCalledWith(-1);
    });

    it('取消下载清除任务栏进度', () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      service.start();
      fire(updater, 'update-available', { version: '1.2.0' });
      fire(updater, 'download-progress', {
        percent: 50,
        transferred: 1,
        total: 2,
        bytesPerSecond: 1,
      });
      fire(updater, 'update-cancelled', { version: '1.2.0' });
      expect(win.setProgressBar).toHaveBeenLastCalledWith(-1);
    });

    it('无窗口时仍留快照（getStatus 可读）', () => {
      mockGetAllWindows.mockReturnValue([]);
      service.start();
      expect(service.getStatus()).toEqual({ snapshot: null, lastCheckAt: null });
      fire(updater, 'checking-for-update');
      expect(service.getStatus().snapshot).toEqual({ phase: 'checking' });
    });

    it('检查后记录上次检查时间', async () => {
      expect(service.getStatus().lastCheckAt).toBeNull();
      await service.check(false);
      expect(service.getStatus().lastCheckAt).toBeTypeOf('number');
    });
  });

  describe('cancelDownload', () => {
    it('无在途下载时为空操作（幂等，不抛错）', () => {
      service.start();
      expect(() => service.cancelDownload()).not.toThrow();
    });

    it('下载在途时取消自持令牌', () => {
      service.start();
      fire(updater, 'update-available', { version: '1.2.0' });
      service.cancelDownload();
      expect(tokens[0]?.cancel).toHaveBeenCalledOnce();
    });

    it('下载完成后取消为空操作（令牌已清理）', () => {
      service.start();
      fire(updater, 'update-available', { version: '1.2.0' });
      const token = tokens[0];
      fire(updater, 'update-downloaded', { version: '1.2.0' });
      service.cancelDownload();
      expect(token?.cancel).not.toHaveBeenCalled();
    });

    it('取消导致的下载失败不再推 error（由 update-cancelled 接管）', async () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      updater.downloadUpdate.mockImplementation(async (token: CancellationTokenLike) => {
        (token as { cancel: () => void }).cancel();
        throw new Error('cancelled');
      });
      service.start();
      fire(updater, 'update-available', { version: '1.2.0' });
      await vi.waitFor(() => {
        expect(updater.downloadUpdate).toHaveBeenCalled();
      });
      const phases = win.webContents.send.mock.calls.map((call) => call[1]);
      expect(phases).not.toContainEqual({ phase: 'error', message: 'cancelled' });
    });
  });

  describe('check', () => {
    it('开发模式（未打包）：返回 error 且不调用 checkForUpdates', async () => {
      const devService = new UpdateService(
        updater,
        () => false,
        () => createFakeToken(),
      );
      const result = await devService.check(true);
      expect(result.status).toBe('error');
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
      devService.dispose();
    });

    it('开发模式手动检查：额外推送 error 事件', async () => {
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      const devService = new UpdateService(
        updater,
        () => false,
        () => createFakeToken(),
      );
      await devService.check(true);
      expect(win.webContents.send).toHaveBeenCalledWith('update:event:status', {
        phase: 'error',
        message: expect.stringContaining('开发模式'),
      });
      devService.dispose();
    });

    it('打包模式：调用 checkForUpdates 并返回 checking', async () => {
      const result = await service.check(false);
      expect(updater.checkForUpdates).toHaveBeenCalledOnce();
      expect(result).toEqual({ status: 'checking' });
    });

    it('在途检查去重：并发调用只发起一次远端检查', async () => {
      let release: (() => void) | undefined;
      updater.checkForUpdates.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const first = service.check(false);
      const second = await service.check(false);
      expect(second).toEqual({ status: 'checking' });
      expect(updater.checkForUpdates).toHaveBeenCalledOnce();
      release?.();
      await first;
    });

    it('检查超时（网络黑洞）：45s 后判失败并复位在途标记，可再次发起检查', async () => {
      vi.useFakeTimers();
      // 永不 settle：模拟 Electron net 路径下无 socket 超时的悬挂请求
      updater.checkForUpdates.mockImplementation(() => new Promise<void>(() => {}));
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);

      const pending = service.check(true);
      await vi.advanceTimersByTimeAsync(44_999);
      const notYet = await Promise.race([pending, Promise.resolve('pending' as const)]);
      expect(notYet).toBe('pending');

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({
        status: 'error',
        message: expect.stringContaining('超时'),
      });
      expect(lastPayload(win)).toEqual({
        phase: 'error',
        errorKind: 'network',
        message: expect.stringContaining('超时'),
      });

      // 关键回归：看门狗复位了 checkInFlight，手动重试必须真的再发一次请求
      updater.checkForUpdates.mockResolvedValueOnce(undefined);
      await expect(service.check(true)).resolves.toEqual({ status: 'checking' });
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    });

    it('checkForUpdates 抛错：返回 error；手动检查时推送 error 事件', async () => {
      updater.checkForUpdates.mockRejectedValueOnce(new Error('feed unreachable'));
      const win = createFakeWindow();
      mockGetAllWindows.mockReturnValue([win]);
      const result = await service.check(true);
      expect(result).toEqual({ status: 'error', message: 'feed unreachable' });
      expect(win.webContents.send).toHaveBeenCalledWith('update:event:status', {
        phase: 'error',
        errorKind: 'unknown',
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
    it('静默安装 + 装完自动启动（isSilent=true, isForceRunAfter=true）', () => {
      service.quitAndInstall();
      expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    });
  });

  describe('toReleaseNotes', () => {
    it('字符串原样返回（trim 首尾空白）', () => {
      expect(toReleaseNotes('  修复 A\n')).toBe('修复 A');
    });

    it('空白字符串 → null（不产出空说明区块）', () => {
      expect(toReleaseNotes('   ')).toBeNull();
      expect(toReleaseNotes('')).toBeNull();
    });

    it('分段数组 → 各 note 用空行连接', () => {
      expect(
        toReleaseNotes([
          { version: '1.0.0', note: 'a' },
          { version: '1.0.1', note: 'b' },
        ]),
      ).toBe('a\n\nb');
    });

    it('无法识别的形状 → null（不编造内容）', () => {
      expect(toReleaseNotes(undefined)).toBeNull();
      expect(toReleaseNotes(42)).toBeNull();
      expect(toReleaseNotes([{ foo: 1 }])).toBeNull();
    });
  });

  describe('classifyUpdateError', () => {
    it('HttpError 的 403/429 → rate-limited（statusCode 与 code 两种信号）', () => {
      expect(classifyUpdateError(Object.assign(new Error('HTTP error'), { statusCode: 429 }))).toBe(
        'rate-limited',
      );
      expect(classifyUpdateError(Object.assign(new Error('HTTP error'), { statusCode: 403 }))).toBe(
        'rate-limited',
      );
      expect(classifyUpdateError(Object.assign(new Error('x'), { code: 'HTTP_ERROR_429' }))).toBe(
        'rate-limited',
      );
    });

    it('sha512/checksum 文本 → checksum', () => {
      expect(classifyUpdateError(new Error("Sha512 checksum doesn't match"))).toBe('checksum');
      expect(classifyUpdateError(new Error('Cannot parse checksum'))).toBe('checksum');
    });

    it('ENOSPC/EDQUOT → disk', () => {
      expect(
        classifyUpdateError(Object.assign(new Error('write failed'), { code: 'ENOSPC' })),
      ).toBe('disk');
      expect(classifyUpdateError(new Error('ENOSPC: no space left on device'))).toBe('disk');
      expect(classifyUpdateError(Object.assign(new Error('quota'), { code: 'EDQUOT' }))).toBe(
        'disk',
      );
    });

    it('Electron net 文本与 Node 网络错误码 → network', () => {
      expect(classifyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('network');
      expect(classifyUpdateError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe('network');
      expect(
        classifyUpdateError(Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })),
      ).toBe('network');
      expect(classifyUpdateError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe('network');
    });

    it('无法归类（含非 Error 值）→ unknown', () => {
      expect(classifyUpdateError(new Error('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'))).toBe('unknown');
      expect(classifyUpdateError('weird')).toBe('unknown');
      expect(classifyUpdateError(null)).toBe('unknown');
    });
  });
});
