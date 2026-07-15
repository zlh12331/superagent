/**
 * @file 平台相关 UI 字符串映射表。
 *
 * 职责：将平台无关的"动作语义"映射为平台本地化的字符串与符号，
 *   避免在各组件中散落 if/else 分支判断平台。
 *
 * 涵盖内容：文件管理器名称、修饰键名称/符号、偏好设置/退出/废纸篓的本地叫法等。
 * 与 `hooks/use-platform.ts` 中的 AppPlatform 类型联合对齐。
 */

import type { AppPlatform } from '@/hooks/use-platform'

/**
 * 平台相关的 UI 字符串。
 * 将平台无关的动作映射为平台相关的标签。
 */
export interface PlatformStrings {
  /** 在文件管理器中显示文件的标签 */
  revealInFileManager: string
  /** 当前平台文件管理器的名称 */
  fileManagerName: string
  /** 修饰键名称（macOS 上为 Cmd，其他平台为 Ctrl） */
  modifierKey: string
  /** 用于快捷键展示的修饰键符号 */
  modifierKeySymbol: string
  /** Option/Alt 键名称 */
  optionKey: string
  /** Option/Alt 键符号 */
  optionKeySymbol: string
  /** 偏好设置/设置 的标签 */
  preferencesLabel: string
  /** 退出/退出应用 的标签 */
  quitLabel: string
  /** 废纸篓/回收站 的名称 */
  trashName: string
}

/** macOS 平台字符串（亦作为平台未检测到时的默认值）。 */
const macOSStrings: PlatformStrings = {
  revealInFileManager: 'Reveal in Finder',
  fileManagerName: 'Finder',
  modifierKey: 'Cmd',
  modifierKeySymbol: '⌘',
  optionKey: 'Option',
  optionKeySymbol: '⌥',
  preferencesLabel: 'Preferences',
  quitLabel: 'Quit',
  trashName: 'Trash',
}

/** Windows 平台字符串。 */
const windowsStrings: PlatformStrings = {
  revealInFileManager: 'Show in Explorer',
  fileManagerName: 'Explorer',
  modifierKey: 'Ctrl',
  modifierKeySymbol: 'Ctrl',
  optionKey: 'Alt',
  optionKeySymbol: 'Alt',
  preferencesLabel: 'Settings',
  quitLabel: 'Exit',
  trashName: 'Recycle Bin',
}

/** Linux 平台字符串。 */
const linuxStrings: PlatformStrings = {
  revealInFileManager: 'Show in Files',
  fileManagerName: 'Files',
  modifierKey: 'Ctrl',
  modifierKeySymbol: 'Ctrl',
  optionKey: 'Alt',
  optionKeySymbol: 'Alt',
  preferencesLabel: 'Preferences',
  quitLabel: 'Quit',
  trashName: 'Trash',
}

/**
 * 获取用于 UI 标签的平台相关字符串。
 *
 * @param platform - 当前平台，或 undefined 表示默认（macOS）
 * @returns 平台相关的字符串映射
 *
 * @example
 * const platform = usePlatform()
 * const strings = getPlatformStrings(platform)
 * // strings.revealInFileManager === 'Reveal in Finder' on macOS
 */
export function getPlatformStrings(
  platform: AppPlatform | undefined
): PlatformStrings {
  switch (platform) {
    case 'windows':
      return windowsStrings
    case 'linux':
      return linuxStrings
    case 'macos':
    default:
      // 在平台检测完成前，默认使用 macOS 字符串
      return macOSStrings
  }
}

/**
 * 格式化用于展示的键盘快捷键。
 *
 * @param platform - 当前平台
 * @param key - 按键（如 'K'、'S'、'Enter'、'F1'）
 * @param modifiers - 要包含的修饰键（'mod' 表示 Cmd/Ctrl，'shift'，'alt'）
 * @returns 格式化后的快捷键字符串（如 '⌘K' 或 'Ctrl+K'）
 *
 * @example
 * formatShortcut('macos', 'K') // '⌘K'
 * formatShortcut('windows', 'K') // 'Ctrl+K'
 * formatShortcut('macos', 'K', ['shift', 'mod']) // '⇧⌘K'
 * formatShortcut('macos', 'F1', []) // 'F1' (no modifier)
 * formatShortcut('macos', 'Escape', []) // 'Escape'
 */
export function formatShortcut(
  platform: AppPlatform | undefined,
  key: string,
  modifiers: ('mod' | 'shift' | 'alt')[] = ['mod']
): string {
  // 规范化 platform，与 getPlatformStrings 的默认行为保持一致
  const normalizedPlatform: AppPlatform = platform ?? 'macos'
  const strings = getPlatformStrings(normalizedPlatform)
  const isMac = normalizedPlatform === 'macos'
  const parts: string[] = []

  if (modifiers.includes('shift')) {
    parts.push(isMac ? '⇧' : 'Shift+')
  }

  if (modifiers.includes('alt')) {
    parts.push(isMac ? strings.optionKeySymbol : 'Alt+')
  }

  if (modifiers.includes('mod')) {
    parts.push(strings.modifierKeySymbol)
    if (!isMac) {
      parts.push('+')
    }
  }

  parts.push(key)

  return parts.join('')
}
