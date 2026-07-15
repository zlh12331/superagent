import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { useCommandContext } from '@/hooks/use-command-context'
import { executeCommand } from '@/lib/commands'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '@/lib/env'
import { WindowsIcons } from './WindowControlIcons'
import i18n from '@/i18n/config'

/**
 * Windows 风格的窗口控制按钮组（最小化、最大化/还原、关闭）。
 * 按 Windows 习惯放置在标题栏右侧。
 *
 * 浏览器环境兼容：getCurrentWindow() 在非 Tauri 环境会抛
 * "Cannot read properties of undefined (reading 'metadata')"。
 * 浏览器开发模式下按钮仍渲染（视觉对齐），但跳过 Tauri 窗口 API 调用。
 */
export function WindowsWindowControls() {
  const context = useCommandContext()
  const [isMaximized, setIsMaximized] = useState(false)

  // 初始化并与实际窗口状态同步 maximized 标志
  useEffect(() => {
    // 浏览器环境：跳过 Tauri API 调用，避免崩溃
    if (!isTauri()) return

    const appWindow = getCurrentWindow()

    // 查询初始最大化状态
    appWindow
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {
        // 忽略错误 —— 窗口可能尚未就绪
      })

    // 订阅 resize 事件以保持状态同步
    // （覆盖双击标题栏最大化/还原等场景）
    let aborted = false
    let resolvedUnsub: (() => void) | null = null

    appWindow
      .onResized(async () => {
        try {
          const maximized = await appWindow.isMaximized()
          if (!aborted) setIsMaximized(maximized)
        } catch {
          // 清理期间忽略错误
        }
      })
      .then(unsub => {
        // 若组件已卸载（aborted=true），立即取消订阅以避免泄漏
        if (aborted) {
          unsub()
        } else {
          resolvedUnsub = unsub
        }
      })

    return () => {
      aborted = true
      // 若取消订阅函数已就绪，立即调用；否则上面的 then 回调中会自动调用
      if (resolvedUnsub) {
        resolvedUnsub()
      }
    }
  }, [])

  const handleClose = async () => {
    await executeCommand('window-close', context)
  }

  const handleMinimize = async () => {
    await executeCommand('window-minimize', context)
  }

  const handleMaximizeToggle = async () => {
    try {
      const appWindow = getCurrentWindow()
      const maximized = await appWindow.isMaximized()
      if (maximized) {
        await appWindow.unmaximize()
        setIsMaximized(false)
      } else {
        await appWindow.maximize()
        setIsMaximized(true)
      }
    } catch {
      await executeCommand('window-toggle-maximize', context)
    }
  }

  // 按钮基础样式 — 对齐原型 .wc-btn：宽度 46px，高度撑满顶栏（h-full）
  // 容器 self-stretch 让按钮组在顶栏 align-items:center 下仍能撑满 52px 高度
  const buttonClass =
    'flex h-full w-[46px] items-center justify-center transition-colors'

  return (
    // 容器 — 对齐原型 .window-controls：
    //   - items-stretch + self-stretch：按钮高度撑满顶栏
    //   - -mr-[18px]：负右 margin 抵消顶栏 px-[18px] 右侧内边距，按钮贴边
    //   - ml-2：左侧 8px 间距（对齐原型 margin-left:8px）
    <div className="flex h-full self-stretch items-stretch -mr-[18px] ml-2">
      {/* 最小化按钮 */}
      <button
        type="button"
        onClick={handleMinimize}
        className={cn(buttonClass, 'hover:bg-foreground/10')}
        title={i18n.t('titlebar.minimize')}
        aria-label={i18n.t('titlebar.minimizeWindow')}
      >
        <WindowsIcons.minimize />
      </button>

      {/* 最大化/还原按钮（根据当前状态切换图标与 aria-label） */}
      <button
        type="button"
        onClick={handleMaximizeToggle}
        className={cn(buttonClass, 'hover:bg-foreground/10')}
        title={
          isMaximized ? i18n.t('titlebar.restore') : i18n.t('titlebar.maximize')
        }
        aria-label={
          isMaximized
            ? i18n.t('titlebar.restoreWindow')
            : i18n.t('titlebar.maximizeWindow')
        }
      >
        {isMaximized ? <WindowsIcons.restore /> : <WindowsIcons.maximize />}
      </button>

      {/* 关闭按钮 */}
      <button
        type="button"
        onClick={handleClose}
        // 关闭按钮 hover — 对齐原型 .wc-close:hover，硬编码 Windows 标准红
        className={cn(
          buttonClass,
          'hover:bg-[#e81123] hover:text-white active:bg-[#c50f25] active:text-white'
        )}
        title={i18n.t('titlebar.close')}
        aria-label={i18n.t('titlebar.closeWindow')}
      >
        <WindowsIcons.close />
      </button>
    </div>
  )
}
