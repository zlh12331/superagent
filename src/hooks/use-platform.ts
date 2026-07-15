import { platform, type Platform } from '@tauri-apps/plugin-os'
import { logger } from '@/lib/logger'

/**
 * 本模板支持的桌面平台。
 * 其他平台（iOS、Android）不支持。
 */
export type AppPlatform = 'macos' | 'windows' | 'linux'

// 平台检测的模块级缓存
let cachedPlatform: AppPlatform | null = null

/**
 * 重置平台缓存。
 * 仅为测试目的导出 —— 允许测试模拟不同平台。
 * @internal
 */
export function __resetPlatformCache(): void {
  cachedPlatform = null
}

/**
 * 将 Tauri 的平台字符串映射为我们支持的平台类型。
 * Linux 及其他类 Unix 系统统一视为 'linux'。
 */
function mapPlatform(p: Platform): AppPlatform {
  if (p === 'macos') return 'macos'
  if (p === 'windows') return 'windows'
  return 'linux'
}

/**
 * 浏览器环境下的平台检测（非 Tauri 环境回退方案）。
 *
 * 通过 navigator.userAgent 判断操作系统：
 * - Windows: UA 包含 "Win"
 * - macOS: UA 包含 "Mac"
 * - 其他: 默认 linux
 */
function detectBrowserPlatform(): AppPlatform {
  if (typeof navigator === 'undefined') return 'linux'
  const ua = navigator.userAgent
  if (/Win/i.test(ua)) return 'windows'
  if (/Mac/i.test(ua)) return 'macos'
  return 'linux'
}

/**
 * 初始化平台检测。
 * 首次访问时调用并缓存结果。
 */
function initPlatform(): AppPlatform {
  if (cachedPlatform === null) {
    try {
      cachedPlatform = mapPlatform(platform())
    } catch {
      // 非 Tauri 环境（如浏览器开发模式）：用 UA 检测实际操作系统
      cachedPlatform = detectBrowserPlatform()
      logger.info('Platform detection via UA (non-Tauri)', {
        platform: cachedPlatform,
      })
    }
  }
  return cachedPlatform
}

/**
 * 同步获取当前平台。
 * 适用于非 hook 上下文（事件处理器、回调）。
 * 结果会缓存以提升性能。
 *
 * @example
 * const currentPlatform = getPlatform()
 * if (currentPlatform === 'windows') {
 *   // Windows 专属逻辑
 * }
 */
export function getPlatform(): AppPlatform {
  return initPlatform()
}

/**
 * 获取当前平台的 React hook。
 *
 * 平台同步检测并缓存，因此本 hook 始终立即返回值（无 loading 状态）。
 *
 * @example
 * const platform = usePlatform()
 * if (platform === 'macos') {
 *   // 渲染 macOS 专属 UI
 * }
 */
export function usePlatform(): AppPlatform {
  // 平台是常量 —— 直接返回缓存值
  return initPlatform()
}

/**
 * 判断当前平台是否为 macOS。
 * 平台特定渲染的便捷 hook。
 *
 * @returns boolean —— true 表示当前为 macOS 平台
 *
 * @example
 * if (useIsMacOS()) {
 *   // 渲染 macOS 风格的 traffic light 控件
 * }
 */
export function useIsMacOS(): boolean {
  return usePlatform() === 'macos'
}

/**
 * 判断当前平台是否为 Windows。
 * 平台特定渲染的便捷 hook。
 *
 * @returns boolean —— true 表示当前为 Windows 平台
 */
export function useIsWindows(): boolean {
  return usePlatform() === 'windows'
}

/**
 * 判断当前平台是否为 Linux。
 * 平台特定渲染的便捷 hook。
 *
 * @returns boolean —— true 表示当前为 Linux 平台
 */
export function useIsLinux(): boolean {
  return usePlatform() === 'linux'
}
