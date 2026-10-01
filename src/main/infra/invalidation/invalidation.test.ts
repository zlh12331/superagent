// src/main/infra/invalidation/invalidation.test.ts
// 失效域广播单测：逐窗发送 / 销毁守卫 / 空窗降级 / payload 形状
import { beforeEach, describe, expect, it, vi } from 'vitest';

// electron 替身：BrowserWindow 由用例注入窗口清单
const mocks = vi.hoisted(() => ({
  /** 当前 getAllWindows 返回的窗口清单（用例改写） */
  windows: [] as Array<{
    isDestroyed: () => boolean;
    webContents: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void };
  }>,
}));

vi.mock('electron', () => ({
  // 方括号键：规避 useNamingConvention 对 electron API 名（PascalCase）的误报（既有先例 preview-service.test.ts）
  ['BrowserWindow']: {
    getAllWindows: vi.fn(() => mocks.windows),
  },
  // emitEvent 读取 app.isPackaged：false 走 dev 契约校验（顺带覆盖 payload schema）
  app: { isPackaged: false },
}));

import { broadcastInvalidation } from './invalidation';

/** 造一个窗口（各自独立 send spy，便于逐窗断言） */
function makeWindow(overrides?: { destroyed?: boolean; webContentsDestroyed?: boolean }): {
  isDestroyed: () => boolean;
  webContents: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void };
  sends: Array<[string, unknown]>;
} {
  const window = {
    isDestroyed: vi.fn(() => overrides?.destroyed === true),
    webContents: {
      isDestroyed: vi.fn(() => overrides?.webContentsDestroyed === true),
      send: vi.fn((channel: string, payload: unknown) => {
        window.sends.push([channel, payload]);
      }),
    },
    sends: [] as Array<[string, unknown]>,
  };
  return window;
}

describe('broadcastInvalidation', () => {
  beforeEach(() => {
    mocks.windows = [];
  });

  it('向全部存活窗口发送 invalidation:event:domains + payload（含 sessionId）', () => {
    const w1 = makeWindow();
    const w2 = makeWindow();
    mocks.windows = [w1, w2];

    broadcastInvalidation(['sessions', 'session:s1'], 's1');

    for (const win of [w1, w2]) {
      expect(win.webContents.send).toHaveBeenCalledTimes(1);
      expect(win.sends[0]?.[0]).toBe('invalidation:event:domains');
      expect(win.sends[0]?.[1]).toEqual({ domains: ['sessions', 'session:s1'], sessionId: 's1' });
    }
  });

  it('sessionId 缺省时 payload 不携带该字段（exactOptionalPropertyTypes 条件展开）', () => {
    const win = makeWindow();
    mocks.windows = [win];

    broadcastInvalidation(['memory']);

    expect(win.sends[0]?.[1]).toEqual({ domains: ['memory'] });
    expect(JSON.stringify(win.sends[0]?.[1])).not.toContain('sessionId');
  });

  it('isDestroyed 窗口跳过（不再触碰其 webContents）', () => {
    const alive = makeWindow();
    const dead = makeWindow({ destroyed: true });
    mocks.windows = [alive, dead];

    broadcastInvalidation(['im']);

    expect(alive.webContents.send).toHaveBeenCalledTimes(1);
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });

  it('无窗口时 no-op（冷启动/测试环境降级）', () => {
    mocks.windows = [];

    expect(() => broadcastInvalidation(['sessions'])).not.toThrow();
  });

  it('空域清单 no-op（不构造 payload 不发送）', () => {
    const win = makeWindow();
    mocks.windows = [win];

    broadcastInvalidation([]);

    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
