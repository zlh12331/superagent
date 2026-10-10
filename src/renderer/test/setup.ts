import { vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import '@/i18n';

type MockApi = {
  // biome-ignore lint/suspicious/noExplicitAny: 测试环境用 any 简化类型
  [domain: string]: any;
};

/** 重建空骨架（模块加载与 afterEach 共用）：避免复用单例导致注入域残留到下一测试 */
function createEmptyApi(): MockApi {
  return {
    app: {
      getLoginItemSettings: async () => ({
        data: { openAtLogin: false, supported: false, requiresApproval: false },
      }),
      setLoginItemSettings: async () => ({
        data: { openAtLogin: false, supported: false, requiresApproval: false },
      }),
      subscribeLoginItemChanged: () => () => {},
      subscribeDeepLink: () => () => {},
    },
    chat: {},
    agent: {},
    session: {},
    file: {},
    search: {},
    terminal: {},
    git: {},
    codebase: {},
    tool: {},
    settings: {
      subscribeChanged: () => () => {},
    },
    update: {
      check: async () => ({ data: { status: 'checking' } }),
      install: async () => ({ data: { ok: true } }),
      cancel: async () => ({ data: { ok: true } }),
      getStatus: async () => ({ data: { snapshot: null, lastCheckAt: null } }),
      getCacheInfo: async () => ({ data: { path: null, bytes: 0, fileCount: 0 } }),
      clearCache: async () => ({ data: { path: null, bytes: 0, fileCount: 0 } }),
      subscribeStatus: () => () => {},
    },
  };
}

Object.defineProperty(window, 'api', {
  value: createEmptyApi(),
  writable: true,
  configurable: true,
});

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: 与 lib.dom ResizeObserver 同名
    ResizeObserver: typeof MockResizeObserver;
  }
}

window.ResizeObserver = MockResizeObserver;

window.HTMLElement.prototype.scrollIntoView = vi.fn();
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

window.matchMedia =
  window.matchMedia ??
  ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));

class MockIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
globalThis.IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver;

import { afterEach } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'api', {
    value: createEmptyApi(),
    writable: true,
    configurable: true,
  });
});
