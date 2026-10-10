import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  windows: [] as Array<{
    isDestroyed: () => boolean;
    webContents: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void };
  }>,
}));

vi.mock('electron', () => ({
  ['BrowserWindow']: {
    getAllWindows: vi.fn(() => mocks.windows),
  },
  app: { isPackaged: false },
}));

import { broadcastInvalidation } from './invalidation';

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
