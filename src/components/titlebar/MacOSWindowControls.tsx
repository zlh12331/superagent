import React, { useEffect, useState, type HTMLProps } from 'react'
import { cn } from '@/lib/utils'
import { MacOSIcons } from './WindowControlIcons'
import { useCommandContext } from '@/hooks/use-command-context'
import { executeCommand } from '@/lib/commands'
import { getCurrentWindow } from '@tauri-apps/api/window'
import i18n from '@/i18n/config'

/**
 * macOS 窗口控制按钮 Props。
 * 继承原生 div 属性，允许调用方透传事件、data-* 等属性。
 */
interface MacOSWindowControlsProps extends HTMLProps<HTMLDivElement> {
  /** 自定义根容器类名（与默认样式合并） */
  className?: string
}

/**
 * macOS 风格的交通灯窗口控制按钮（关闭 / 最小化 / 最大化或全屏）。
 *
 * 渲染逻辑：
 *  - 三个圆形按钮从左到右依次为：关闭（红 #ff544d）、最小化（黄 #ffbd2e）、最大化/全屏（绿 #28c93f）
 *  - hover 时显示对应图标；失焦时按钮变灰（对齐 macOS 失焦行为）
 *  - 第三个按钮根据是否按住 Alt 切换图标：Alt+hover 显示 maximize（+），普通显示 fullscreen（↗）
 *
 * 状态依赖：
 *  - isAltKeyPressed：监听全局 Alt 键，决定第三个按钮的图标与点击行为
 *  - isHovering：控制图标显隐（仅 hover 时显示，对齐 macOS 原生行为）
 *  - isWindowFocused：监听 Tauri 窗口聚焦事件，失焦时按钮变灰
 *
 * 副作用：
 *  - useEffect 注册 keydown / keyup 监听 Alt 键状态
 *  - useEffect 注册 window focus / blur 事件 + Tauri onFocusChanged 监听窗口聚焦
 *  - 组件卸载时清理所有事件监听器
 *
 * 交互行为（对齐 macOS 原生）：
 *  - 关闭按钮：调用 window-close 命令
 *  - 最小化按钮：调用 window-minimize 命令
 *  - 第三个按钮：根据当前全屏状态与 Alt 键状态三分支处理（见 handleMaximizeOrFullscreen）
 *
 * @param props —— 见 MacOSWindowControlsProps 接口
 *
 * @see WindowsWindowControls — Windows 平台的对应实现
 * @see LinuxTitleBar — Linux 使用原生窗口装饰，不含控制按钮
 */
export function MacOSWindowControls({
  className,
  ...props
}: MacOSWindowControlsProps) {
  const context = useCommandContext()
  const [isAltKeyPressed, setIsAltKeyPressed] = useState(false)
  const [isHovering, setIsHovering] = useState(false)
  const [isWindowFocused, setIsWindowFocused] = useState(true)

  const last = isAltKeyPressed ? (
    <MacOSIcons.maximize />
  ) : (
    <MacOSIcons.fullscreen />
  )
  const key = 'Alt'

  const handleMouseEnter = () => {
    setIsHovering(true)
  }
  const handleMouseLeave = () => {
    setIsHovering(false)
  }

  const handleAltKeyDown = (e: KeyboardEvent) => {
    if (e.key === key) {
      setIsAltKeyPressed(true)
    }
  }
  const handleAltKeyUp = (e: KeyboardEvent) => {
    if (e.key === key) {
      setIsAltKeyPressed(false)
    }
  }

  useEffect(() => {
    // 组件挂载时绑定事件监听器
    window.addEventListener('keydown', handleAltKeyDown)
    window.addEventListener('keyup', handleAltKeyUp)

    // 监听窗口聚焦 / 失焦事件
    const handleWindowFocus = () => setIsWindowFocused(true)
    const handleWindowBlur = () => setIsWindowFocused(false)

    window.addEventListener('focus', handleWindowFocus)
    window.addEventListener('blur', handleWindowBlur)

    // 若可用，也监听 Tauri 窗口聚焦事件
    const setupTauriFocusListener = async () => {
      try {
        const appWindow = getCurrentWindow()
        const unlistenFocus = await appWindow.onFocusChanged(
          ({ payload: focused }) => {
            setIsWindowFocused(focused)
          }
        )
        return unlistenFocus
      } catch {
        // Tauri 事件不可用时回退到 window focus 事件
        return null
      }
    }

    let tauriUnlisten: (() => void) | null = null
    // cancelled flag：防止 async 监听器注册未完成时组件已卸载导致 unlisten 泄漏
    // - 若 setupTauriFocusListener 在组件卸载后才 resolve，此时 cancelled=true，
    //   立即调用返回的 unlisten 释放刚注册的监听器
    let cancelled = false
    setupTauriFocusListener().then(unlisten => {
      if (cancelled) {
        // 组件已卸载 —— 立即释放刚拿到的 unlisten，避免监听器泄漏
        unlisten?.()
      } else {
        tauriUnlisten = unlisten
      }
    })

    // 清理事件监听器
    return () => {
      cancelled = true
      window.removeEventListener('keydown', handleAltKeyDown)
      window.removeEventListener('keyup', handleAltKeyUp)
      window.removeEventListener('focus', handleWindowFocus)
      window.removeEventListener('blur', handleWindowBlur)
      if (tauriUnlisten) {
        tauriUnlisten()
        tauriUnlisten = null
      }
    }
  }, [])

  const handleClose = async () => {
    await executeCommand('window-close', context)
  }

  const handleMinimize = async () => {
    await executeCommand('window-minimize', context)
  }

  /**
   * 第三个交通灯按钮（绿色）的点击处理器。
   *
   * 行为对齐 macOS 原生：根据当前全屏状态与 Alt 键状态三分支处理：
   *  1. 当前已全屏 → 退出全屏（无论是否按住 Alt）
   *  2. 当前非全屏 + 按住 Alt → 切换最大化 / 还原（macOS 原生 Alt+绿按钮行为）
   *  3. 当前非全屏 + 未按 Alt → 进入全屏（macOS 原生点击绿按钮行为）
   *
   * 错误回退：若 Tauri 窗口 API 调用失败（如窗口未就绪），
   *  回退到简单的 Alt 判定，保证按钮始终可用。
   */
  const handleMaximizeOrFullscreen = async () => {
    try {
      const appWindow = getCurrentWindow()
      const isFullscreen = await appWindow.isFullscreen()

      if (isFullscreen) {
        // 分支 1：当前为全屏时，无论是否按住 Alt 都退出全屏
        await executeCommand('window-exit-fullscreen', context)
      } else if (isAltKeyPressed) {
        // 分支 2：Alt + 点击 → 切换最大化 / 还原
        await executeCommand('window-toggle-maximize', context)
      } else {
        // 分支 3：普通点击 → 进入全屏
        await executeCommand('window-fullscreen', context)
      }
    } catch {
      // 出错时回退到简化行为：仅按 Alt 判定，跳过全屏状态查询
      if (isAltKeyPressed) {
        await executeCommand('window-toggle-maximize', context)
      } else {
        await executeCommand('window-fullscreen', context)
      }
    }
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 text-black active:text-black dark:text-black',
        className
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      {...props}
    >
      <button
        type="button"
        onClick={handleClose}
        aria-label={i18n.t('titlebar.closeWindow')}
        className={cn(
          'group flex h-3 w-3 cursor-default items-center justify-center rounded-full border text-center text-black/60 hover:bg-[#ff544d] hover:border-black/[.12] active:bg-[#bf403a] active:text-black/60 dark:border-none',
          isWindowFocused
            ? 'border-black/[.12] bg-[#ff544d]'
            : 'border-gray-400/20 bg-gray-400'
        )}
      >
        <div className="flex h-3 w-3 items-center justify-center">
          {isHovering && (
            <MacOSIcons.close className="h-[6px] w-[6px] opacity-60" />
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={handleMinimize}
        aria-label={i18n.t('titlebar.minimizeWindow')}
        className={cn(
          'group flex h-3 w-3 cursor-default items-center justify-center rounded-full border text-center text-black/60 hover:bg-[#ffbd2e] hover:border-black/[.12] active:bg-[#bf9122] active:text-black/60 dark:border-none',
          isWindowFocused
            ? 'border-black/[.12] bg-[#ffbd2e]'
            : 'border-gray-400/20 bg-gray-400'
        )}
      >
        <div className="flex h-3 w-3 items-center justify-center">
          {isHovering && (
            <MacOSIcons.minimize className="h-[2px] w-[6px] opacity-60" />
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={handleMaximizeOrFullscreen}
        aria-label={
          isAltKeyPressed
            ? i18n.t('titlebar.maximizeWindow')
            : i18n.t('titlebar.enterFullscreen')
        }
        className={cn(
          'group flex h-3 w-3 cursor-default items-center justify-center rounded-full border text-center text-black/60 hover:bg-[#28c93f] hover:border-black/[.12] active:bg-[#1e9930] active:text-black/60 dark:border-none',
          isWindowFocused
            ? 'border-black/[.12] bg-[#28c93f]'
            : 'border-gray-400/20 bg-gray-400'
        )}
      >
        <div className="flex h-3 w-3 items-center justify-center">
          {isHovering &&
            React.cloneElement(last, {
              className: 'h-[5px] w-[5px] opacity-60',
            })}
        </div>
      </button>
    </div>
  )
}
