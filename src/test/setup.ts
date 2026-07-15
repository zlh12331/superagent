import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

// 测试用 matchMedia mock
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(function (query: string) {
    return {
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
  }),
})

// Polyfill：Radix UI 组件依赖 pointer capture API，jsdom 未实现。
// 在此全局注册，避免各测试文件重复 polyfill。
if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false
}
if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => undefined
}
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => undefined
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined
}

// Polyfill：Radix UI 组件依赖 ResizeObserver，jsdom 未实现。
// 使用 vi.fn() 以避免 @typescript-eslint/no-empty-function 报错。
globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }
}) as unknown as typeof ResizeObserver

// 测试用 Tauri API mock
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(function () {
    // unlisten 函数 mock
  }),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn().mockResolvedValue(null),
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  locale: vi.fn().mockResolvedValue('en-US'),
  platform: vi.fn().mockReturnValue('macos'),
}))

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: vi.fn().mockResolvedValue([]),
  onOpenUrl: vi.fn().mockResolvedValue(vi.fn()),
}))

vi.mock('@tauri-apps/api/menu', () => ({
  Menu: { new: vi.fn().mockResolvedValue({ setAsAppMenu: vi.fn() }) },
  MenuItem: { new: vi.fn().mockResolvedValue({}) },
  Submenu: { new: vi.fn().mockResolvedValue({}) },
  PredefinedMenuItem: { new: vi.fn().mockResolvedValue({}) },
}))

// 类型化 Tauri 绑定 mock（tauri-specta 生成）
vi.mock('@/lib/tauri-bindings', () => ({
  commands: {
    greet: vi.fn().mockResolvedValue('Hello, test!'),
    loadPreferences: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        theme: 'system',
        quick_pane_shortcut: null,
        language: null,
        crash_reporting_consent: null,
      },
    }),
    savePreferences: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    sendNativeNotification: vi
      .fn()
      .mockResolvedValue({ status: 'ok', data: null }),
    saveEmergencyData: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    loadEmergencyData: vi.fn().mockResolvedValue({ status: 'ok', data: '{}' }),
    cleanupOldRecoveryFiles: vi
      .fn()
      .mockResolvedValue({ status: 'ok', data: 0 }),
    readCrashReport: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    deleteCrashReport: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    setConsent: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
  },
}))
