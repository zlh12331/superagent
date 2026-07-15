import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import { motion } from 'motion/react'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { commands } from '@/lib/tauri-bindings'
import i18n from '@/i18n/config'
import { logger } from '@/lib/logger'
import { scaleFadeVariants, gentleSpring } from '@/lib/animations'
import { applyThemeClass, isValidTheme, readStoredTheme } from '@/lib/theme'
import type { Theme } from '@/lib/theme-context'

/** 关闭 quick pane 窗口，并记录可能出现的错误 */
async function dismissQuickPane() {
  const result = await commands.dismissQuickPane()
  if (result.status === 'error') {
    logger.error('Failed to dismiss quick pane', { error: result.error })
  }
}

/**
 * QuickPaneApp — 用于快速文本输入的最小化浮窗。
 *
 * 主题通过 Tauri 事件（theme-changed）与主窗口同步。
 * quick-pane.html 中的内联脚本会在首次绘制之前应用主题，
 * 以避免 FOUC（主题闪烁）。此组件随后通过 useLayoutEffect
 * 和事件监听器保持 DOM class 同步。
 */
export default function QuickPaneApp() {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme())

  // 绘制前应用主题 class，并响应主题变化
  useLayoutEffect(() => {
    applyThemeClass(theme)

    if (theme !== 'system') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (e: MediaQueryListEvent) => {
      applyThemeClass(e.matches ? 'dark' : 'light')
    }
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  // 监听来自主窗口的主题变更事件
  useEffect(() => {
    const unlistenPromise = listen<{ theme: string }>(
      'theme-changed',
      event => {
        const newTheme = event.payload.theme
        if (isValidTheme(newTheme)) {
          setTheme(newTheme)
        }
      }
    )

    return () => {
      unlistenPromise.then(fn => fn()).catch(() => {
        // 监听器注册失败时 unlistenPromise 会 reject，此处兜底防止未捕获 rejection
      })
    }
  }, [])

  // 窗口可见时聚焦输入框，失焦时隐藏
  useEffect(() => {
    const currentWindow = getCurrentWindow()
    const unlisten = currentWindow.onFocusChanged(
      async ({ payload: focused }) => {
        if (focused) {
          // 重新从 localStorage 同步主题，以防隐藏期间发生变更
          setTheme(readStoredTheme())
          inputRef.current?.focus()
        } else {
          // 失焦时隐藏窗口（失焦即关闭）
          await dismissQuickPane()
        }
      }
    )

    return () => {
      unlisten.then(fn => fn()).catch(() => {
        // onFocusChanged 注册失败时 unlisten 会 reject，此处兜底
      })
    }
  }, [])

  // 处理 Escape 键关闭浮窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault() // 避免系统提示音
        void dismissQuickPane()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    try {
      if (text.trim()) {
        // 发送事件交由主窗口处理
        await emit('quick-pane-submit', { text: text.trim() })
        setText('')
      }
    } catch (err) {
      logger.error('Failed to emit quick-pane-submit', { error: err })
    } finally {
      // 使用 dismiss 命令以避免 macOS 上的 Space 切换
      await dismissQuickPane()
    }
  }

  return (
    <motion.form
      onSubmit={handleSubmit}
      variants={scaleFadeVariants}
      initial="initial"
      animate="animate"
      transition={gentleSpring}
      className="flex h-screen w-screen items-center rounded-[var(--app-corner-radius)] border border-border bg-background px-5 shadow-lg"
    >
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={i18n.t('quickPane.placeholder')}
        className="w-full bg-transparent text-lg text-foreground placeholder:text-muted-foreground outline-none"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
    </motion.form>
  )
}
