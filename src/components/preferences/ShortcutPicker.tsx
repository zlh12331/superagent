/**
 * ShortcutPicker —— 快捷键选择器组件。
 *
 * 用于在设置抽屉中让用户按下组合键来设置全局快捷键。
 *
 * 工作流程：
 *  1. 用户点击组件 → 进入捕获模式（isCapturing=true）
 *  2. 用户按下组合键 → keyEventToShortcut 转换为 Tauri 兼容字符串
 *  3. 用户松开按键 → 与 defaultValue 比较：相同则保存 null（恢复默认），不同则保存新值
 *  4. Escape 取消捕获，不保存任何值
 *
 * 平台适配：
 *  - macOS：修饰键显示为 ⌘⇧⌥⌃ 符号，符号间紧凑无分隔符
 *  - Windows/Linux：修饰键显示为 Ctrl/Shift/Alt/Win 文字，用 + 分隔
 *
 * 跨平台兼容：
 *  - 内部存储格式使用 CommandOrControl 而非 CmdOrCtrl，由 Tauri 自动适配
 */

import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { getPlatform } from '@/hooks/use-platform'

interface ShortcutPickerProps {
  /** 当前快捷键值（null 表示使用 defaultValue） */
  value: string | null
  /** 默认快捷键（用户未自定义时显示） */
  defaultValue: string
  /** 快捷键变更回调（传入 null 表示恢复默认） */
  onChange: (shortcut: string | null) => void
  /** 是否禁用 */
  disabled?: boolean
  /** 自定义 className */
  className?: string
}

/**
 * 将快捷键字符串格式化为带符号的可读形式。
 * 把 "CommandOrControl+Shift+." 在 macOS 上转换为 "⌘⇧."，在其他平台上转换为 "Ctrl+Shift+."。
 *
 * @param shortcut — Tauri 兼容的快捷键字符串（如 "CommandOrControl+Shift+Period"）
 * @returns 平台适配后的可读字符串
 *
 * @example
 * formatShortcutForDisplay('CommandOrControl+Shift+Period')  // macOS → '⌘⇧.'
 * formatShortcutForDisplay('CommandOrControl+K')             // Windows → 'Ctrl+K'
 */
function formatShortcutForDisplay(shortcut: string): string {
  const isMac = getPlatform() === 'macos'

  let formatted = shortcut
    // 优先处理 CommandOrControl
    .replace(/CommandOrControl/gi, isMac ? '⌘' : 'Ctrl')
    .replace(/CmdOrCtrl/gi, isMac ? '⌘' : 'Ctrl')
    // 再处理单个修饰键
    .replace(/Command/gi, '⌘')
    .replace(/Control/gi, isMac ? '⌃' : 'Ctrl')
    .replace(/Ctrl/gi, isMac ? '⌃' : 'Ctrl')
    .replace(/Shift/gi, isMac ? '⇧' : 'Shift')
    .replace(/Alt/gi, isMac ? '⌥' : 'Alt')
    .replace(/Super/gi, isMac ? '⌘' : 'Win')
    // 处理常见按键名
    .replace(/Period/gi, '.')
    .replace(/Comma/gi, ',')
    .replace(/Slash/gi, '/')
    .replace(/Backslash/gi, '\\')
    .replace(/BracketLeft/gi, '[')
    .replace(/BracketRight/gi, ']')
    .replace(/Semicolon/gi, ';')
    .replace(/Quote/gi, "'")
    .replace(/Backquote/gi, '`')
    .replace(/Minus/gi, '-')
    .replace(/Equal/gi, '=')
    .replace(/Space/gi, 'Space')
    .replace(/Enter/gi, '↵')
    .replace(/Escape/gi, 'Esc')
    .replace(/Backspace/gi, '⌫')
    .replace(/Delete/gi, '⌦')
    .replace(/ArrowUp/gi, '↑')
    .replace(/ArrowDown/gi, '↓')
    .replace(/ArrowLeft/gi, '←')
    .replace(/ArrowRight/gi, '→')
    .replace(/Tab/gi, '⇥')

  // macOS 上修饰键符号之间不使用分隔符
  if (isMac) {
    // 将符号间的 + 替换为空，以实现紧凑显示
    formatted = formatted.replace(/\+/g, '')
  }

  return formatted
}

/**
 * 将 KeyboardEvent 转换为 Tauri 可识别的快捷键字符串格式。
 * 若不是有效快捷键（例如仅按下修饰键），返回 null。
 *
 * 转换规则：
 *  - metaKey 或 ctrlKey → CommandOrControl（跨平台兼容）
 *  - shiftKey → Shift
 *  - altKey → Alt
 *  - 必须至少包含一个修饰键，否则返回 null（避免单键冲突）
 *  - 主键使用 e.code（如 'KeyA' / 'Digit1' / 'Period'），并简化常见前缀
 *
 * @param e — 浏览器键盘事件
 * @returns Tauri 兼容的快捷键字符串（如 "CommandOrControl+Shift+Period"），无效时返回 null
 *
 * @example
 * keyEventToShortcut({ metaKey: true, shiftKey: true, code: 'Period' })
 *   // → 'CommandOrControl+Shift+Period'
 */
function keyEventToShortcut(e: KeyboardEvent): string | null {
  // 仅按下修饰键时不捕获
  const modifierKeys = ['Control', 'Shift', 'Alt', 'Meta', 'ContextMenu', 'OS']
  if (modifierKeys.includes(e.key)) {
    return null
  }

  // 构建快捷键字符串
  const parts: string[] = []

  // 使用 CommandOrControl 以保证跨平台兼容性
  if (e.metaKey || e.ctrlKey) {
    parts.push('CommandOrControl')
  }
  if (e.shiftKey) {
    parts.push('Shift')
  }
  if (e.altKey) {
    parts.push('Alt')
  }

  // 全局快捷键必须至少包含一个修饰键
  if (parts.length === 0) {
    return null
  }

  // 将按键映射为 Tauri 兼容格式
  let key = e.code

  // 处理特殊按键
  if (key.startsWith('Key')) {
    key = key.slice(3) // KeyA -> A
  } else if (key.startsWith('Digit')) {
    key = key.slice(5) // Digit1 -> 1
  } else if (key.startsWith('Numpad')) {
    key = 'Num' + key.slice(6) // Numpad1 -> Num1
  }

  parts.push(key)

  return parts.join('+')
}

/**
 * ShortcutPicker 组件 —— 快捷键选择器。
 *
 * 渲染逻辑：
 *  - 默认态：显示当前快捷键（value 为 null 时显示 defaultValue，灰色字体）
 *  - 捕获态：显示 "Press shortcut..." 占位文字，捕获用户按键
 *  - 非默认值且未禁用时显示「重置」按钮
 *
 * 状态依赖：
 *  - 本地 useState 管理 isCapturing / pendingShortcut
 *  - 通过 props 接收 value / defaultValue / onChange / disabled / className
 *
 * 副作用：
 *  - isCapturing=true 时注册 window keydown/keyup（capture 阶段）+ 元素 blur 监听
 *  - keydown：阻止默认行为 + 阻止冒泡，记录 pendingShortcut
 *  - keyup：若有 pendingShortcut 则确认（与 defaultValue 比较决定保存值）
 *  - blur：取消捕获
 *
 * 交互约束：
 *  - Escape 取消捕获，不保存
 *  - 仅按下修饰键不视为有效快捷键
 *  - 必须至少包含一个修饰键
 *
 * @param props —— 见 ShortcutPickerProps 接口
 */
export function ShortcutPicker({
  value,
  defaultValue,
  onChange,
  disabled = false,
  className,
}: ShortcutPickerProps) {
  const { t } = useTranslation()
  const [isCapturing, setIsCapturing] = useState(false)
  const [pendingShortcut, setPendingShortcut] = useState<string | null>(null)
  const inputRef = useRef<HTMLDivElement>(null)

  const displayValue = value ?? defaultValue
  const isDefault = value === null

  // 捕获状态下处理键盘事件
  useEffect(() => {
    if (!isCapturing) return

    const inputElement = inputRef.current

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      // Escape 取消捕获
      if (e.key === 'Escape') {
        setPendingShortcut(null)
        setIsCapturing(false)
        return
      }

      const shortcut = keyEventToShortcut(e)
      if (shortcut) {
        setPendingShortcut(shortcut)
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      // 若有待确认快捷键且按键已释放，则确认
      if (pendingShortcut) {
        // 与默认值比较，决定保存 null 还是快捷键
        const valueToSave =
          pendingShortcut === defaultValue ? null : pendingShortcut
        onChange(valueToSave)
        setPendingShortcut(null)
        setIsCapturing(false)
      }
    }

    const handleBlur = () => {
      setPendingShortcut(null)
      setIsCapturing(false)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)
    inputElement?.addEventListener('blur', handleBlur)

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      inputElement?.removeEventListener('blur', handleBlur)
    }
  }, [isCapturing, pendingShortcut, defaultValue, onChange])

  const handleClick = () => {
    if (disabled) return
    setIsCapturing(true)
    inputRef.current?.focus()
  }

  const handleReset = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (disabled) return
    onChange(null)
  }

  return (
    <div className="flex items-center gap-2">
      <div
        ref={inputRef}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onClick={handleClick}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleClick()
          }
        }}
        className={cn(
          'border-input h-9 min-w-[120px] rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none select-none',
          'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
          'flex items-center justify-center font-mono',
          isCapturing && 'border-ring ring-ring/50 ring-[3px] bg-muted/50',
          disabled && 'pointer-events-none cursor-not-allowed opacity-50',
          className
        )}
      >
        {isCapturing ? (
          <span className="text-muted-foreground animate-pulse">
            {pendingShortcut
              ? formatShortcutForDisplay(pendingShortcut)
              : 'Press shortcut...'}
          </span>
        ) : (
          <span className={isDefault ? 'text-muted-foreground' : ''}>
            {formatShortcutForDisplay(displayValue)}
          </span>
        )}
      </div>

      {!isDefault && !disabled && (
        <button
          type="button"
          onClick={handleReset}
          className="text-muted-foreground hover:text-foreground text-xs underline"
        >
          {t('common.reset')}
        </button>
      )}
    </div>
  )
}
