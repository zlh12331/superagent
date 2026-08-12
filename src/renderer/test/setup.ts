// src/renderer/test/setup.ts
// 渲染层测试全局 setup
// ──────────────────────────────────────────────────────────────
// 职责：
// - 在所有测试前注册全局 mock（window.api、ResizeObserver、matchMedia 等）
// - 为 jsdom 缺失的浏览器 API 补充 polyfill / mock
// - 不在此处 mock 具体业务逻辑（每个测试文件自行 mock 业务方法）
//
// 设计：
// - window.api 是 IPC 入口，所有渲染层代码都依赖它
//   全局 mock 一个空实现（每个测试文件再 vi.mock 覆盖具体方法）
// - ResizeObserver 在 jsdom 中未实现，需手动 polyfill
// - matchMedia 是 Radix UI 等组件库依赖的 API
// ──────────────────────────────────────────────────────────────

import { vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
// 初始化 i18next（资源内联，同步完成；语言已由 setup-lang.ts 固定为 zh-CN）
// 同步 import：组件内 t() 返回默认中文文案，测试断言保持中文
import '@/i18n';

// ── window.api 全局 mock ────────────────────────────────────
//
// 每个测试文件通过 vi.mock('@/stores/...') 或直接覆盖 window.api 的具体方法
// 来注入特定行为。此处仅提供一个空骨架，避免 undefined 报错。
//
// 类型断言：测试环境不需要完整实现 IpcApi，只需要被测代码引用到的部分
type MockApi = {
  // 各域用一个空对象占位，测试文件按需扩展
  // biome-ignore lint/suspicious/noExplicitAny: 测试环境用 any 简化类型
  [domain: string]: any;
};

const emptyApi: MockApi = {
  app: {},
  chat: {},
  agent: {},
  session: {},
  file: {},
  search: {},
  terminal: {},
  git: {},
  codebase: {},
  tool: {},
};

/** 重建空骨架（afterEach 用）：避免复用单例导致注入域残留到下一测试 */
function createEmptyApi(): MockApi {
  return {
    app: {},
    chat: {},
    agent: {},
    session: {},
    file: {},
    search: {},
    terminal: {},
    git: {},
    codebase: {},
    tool: {},
  };
}

// 注入 window.api（防止业务代码访问时报 undefined）
Object.defineProperty(window, 'api', {
  value: emptyApi,
  writable: true,
  configurable: true,
});

// ── ResizeObserver polyfill ────────────────────────────────
//
// jsdom 未实现 ResizeObserver，但 TerminalPanel 等组件依赖它
// 提供一个最小实现：observe/unobserve/disconnect 都是空函数
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// global 类型扩展（仅测试环境）
declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: 与 lib.dom ResizeObserver 同名
    ResizeObserver: typeof MockResizeObserver;
  }
}

window.ResizeObserver = MockResizeObserver;

// ── scrollIntoView polyfill ─────────────────────────────────
//
// jsdom 未实现 HTMLElement.scrollIntoView（FuzzySearchDialog 等列表
// 滚动定位依赖），补空实现避免运行时崩溃。
window.HTMLElement.prototype.scrollIntoView = vi.fn();
// 也挂到 globalThis 上（某些代码用 globalThis.ResizeObserver）
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// ── matchMedia polyfill ─────────────────────────────────────
//
// Radix UI 依赖 matchMedia 检测深色模式等，jsdom 未实现
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

// ── IntersectionObserver polyfill ──────────────────────────
//
// Radix UI ScrollArea 等组件依赖 IntersectionObserver
class MockIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

// 用 as unknown as 转型，因为 MockIntersectionObserver 不实现 IntersectionObserver 的所有属性
// （root/rootMargin/scrollMargin/thresholds 等）— 测试环境不需要这些
// 不扩展 Window 接口，保留 lib.dom 默认类型
window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
globalThis.IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver;

// ── afterEach：重置 mock ────────────────────────────────────
//
// 每个测试后重置所有 mock，避免测试间相互污染
import { afterEach } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  // 重置 window.api 为空实现（重建对象，防止某测试注入的方法污染下个测试）
  Object.defineProperty(window, 'api', {
    value: createEmptyApi(),
    writable: true,
    configurable: true,
  });
});
