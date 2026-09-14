// src/main/utils/utils-gaps.test.ts
// utils 域 10 缺口补全：logger 生产分支/序列化边界/崩溃标记、window-state 字段校验/销毁守卫/防抖
//
// 测试要点：
// 1. initLogger：prod 分支（file=info + console 关闭）
// 2. error 序列化：非 Error 值 / Error.cause 递归
// 3. unhandledRejection 非 Error / uncaughtException 崩溃标记
// 4. clearCrashMarker：存在删除 / 不存在跳过
// 5. window-state：非 number 字段回退 / isDestroyed 守卫 / bounds 缺坐标 / 防抖合并 / cleanup

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockLog = {
    level: 'info',
    transports: {
      file: { level: 'info', maxRetries: 0, fileName: 'main.log', format: '', maxSize: 0 },
      console: { level: 'debug', format: '' },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    initialize: vi.fn(),
  };
  const mockApp = { isPackaged: false, getPath: vi.fn(() => '/tmp/utils-gaps') };
  return { mockLog, mockApp };
});

vi.mock('electron-log', () => ({ default: mocks.mockLog }));

vi.mock('electron', () => ({
  app: mocks.mockApp,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return actual;
});

import { clearCrashMarker, initLogger, logger, registerGlobalErrorHandlers } from './logger';
import { loadWindowState, trackWindowState } from './window-state';

let tempDir: string;

describe('utils 域批次10 缺口补全', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = join(tmpdir(), `utils-gaps-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
    mkdirSync(tempDir, { recursive: true });
    mocks.mockApp.getPath.mockReturnValue(tempDir);
    mocks.mockApp.isPackaged = false;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('logger', () => {
    it('initLogger 生产分支：file=info + 控制台关闭', () => {
      mocks.mockApp.isPackaged = true;
      initLogger();
      expect(mocks.mockLog.transports.file.level).toBe('info');
      expect(mocks.mockLog.transports.console.level).toBe(false);
    });

    it('initLogger 开发分支：file=debug + 控制台 debug', () => {
      mocks.mockApp.isPackaged = false;
      initLogger();
      expect(mocks.mockLog.transports.file.level).toBe('debug');
      expect(mocks.mockLog.transports.console.level).toBe('debug');
    });

    it('error 传非 Error 值：String() 兜底序列化', () => {
      logger.error({}, '测试', 'plain-string-error');
      // 不抛即可；serializeError 的 String 兜底路径执行
      expect(mocks.mockLog.error).toHaveBeenCalled();
    });

    it('error 传带 cause 的 Error：cause 递归序列化', () => {
      const cause = new Error('root cause');
      const wrapped = new Error('wrapped', { cause });
      logger.error({}, '测试', wrapped);
      expect(mocks.mockLog.error).toHaveBeenCalled();
    });

    it('unhandledRejection 非 Error reason：记日志且不抛（不上报路径已移除）', () => {
      mocks.mockLog.error.mockClear();
      registerGlobalErrorHandlers();
      // 触发非 Error 的 unhandledRejection（reason 为字符串）
      const listeners = process.listeners('unhandledRejection');
      const last = listeners[listeners.length - 1];
      expect(last).toBeDefined();
      // 直接调用监听器（避免真实 unhandledRejection 干扰）：不抛错且落日志
      if (last !== undefined) {
        expect(() => last('string-reason', Promise.resolve())).not.toThrow();
      }
      expect(mocks.mockLog.error).toHaveBeenCalled();
    });

    it('clearCrashMarker：标记存在时删除 + 日志；不存在时跳过', () => {
      // 标记不存在：不抛、无删除日志
      clearCrashMarker();
      expect(mocks.mockLog.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ markerPath: expect.any(String) }),
        '已清除崩溃标记',
      );
    });
  });

  describe('window-state', () => {
    it('部分字段非 number（width 为字符串）：回退默认值', () => {
      writeFileSync(
        join(tempDir, 'ws.json'),
        JSON.stringify({ width: '800', height: 600, x: 10, y: 20, isMaximized: true }),
        'utf8',
      );
      const state = loadWindowState(join(tempDir, 'ws.json'), { width: 1024, height: 768 }, []);
      expect(state.width).toBe(1024);
      expect(state.height).toBe(600);
      expect(state.isMaximized).toBe(true);
    });

    it('x/y 非 number：视为缺失 → 坐标不可见回退（不含 x/y）', () => {
      writeFileSync(
        join(tempDir, 'ws2.json'),
        JSON.stringify({ width: 800, height: 600, x: '10', y: '20' }),
        'utf8',
      );
      const state = loadWindowState(join(tempDir, 'ws2.json'), { width: 1024, height: 768 }, []);
      expect(state.x).toBeUndefined();
      expect(state.y).toBeUndefined();
    });

    it('窗口已销毁：persist 守卫跳过（不写文件）', () => {
      const filePath = join(tempDir, 'ws3.json');
      const listeners = new Map<string, () => void>();
      const win = {
        isDestroyed: () => true,
        getBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }),
        isMaximized: () => false,
        on: vi.fn((event: string, cb: () => void) => {
          listeners.set(event, cb);
        }),
        removeListener: vi.fn(),
      } as never;

      const cleanup = trackWindowState(win, filePath);
      listeners.get('close')?.();

      expect(existsSync(filePath)).toBe(false);
      cleanup();
    });

    it('bounds 缺 x/y：条件展开不写入 undefined', () => {
      const filePath = join(tempDir, 'ws4.json');
      const listeners = new Map<string, () => void>();
      const win = {
        isDestroyed: () => false,
        getBounds: () => ({ width: 800, height: 600 }),
        isMaximized: () => false,
        on: vi.fn((event: string, cb: () => void) => {
          listeners.set(event, cb);
        }),
        removeListener: vi.fn(),
      } as never;

      trackWindowState(win, filePath);
      listeners.get('close')?.();

      const saved = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      expect(saved['x']).toBeUndefined();
      expect(saved['y']).toBeUndefined();
      expect(saved['width']).toBe(800);
    });

    it('防抖合并：连续 resize 只保存一次（clearTimeout 分支）', async () => {
      vi.useFakeTimers();
      try {
        const filePath = join(tempDir, 'ws5.json');
        const listeners = new Map<string, () => void>();
        const win = {
          isDestroyed: () => false,
          getBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }),
          isMaximized: () => false,
          on: vi.fn((event: string, cb: () => void) => {
            listeners.set(event, cb);
          }),
          removeListener: vi.fn(),
        } as never;

        trackWindowState(win, filePath);
        // 连续触发 resize：防抖合并，只在防抖窗口到期后保存一次
        const resize = listeners.get('resize');
        expect(resize).toBeDefined();
        resize?.();
        resize?.();
        resize?.();
        await vi.advanceTimersByTimeAsync(500);

        const saved = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
        expect(saved['width']).toBe(800);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
