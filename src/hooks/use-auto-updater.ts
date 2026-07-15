import { useEffect } from 'react'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { logger } from '@/lib/logger'

/**
 * 应用启动后通过延迟定时器检查更新。
 *
 * 流程：
 * 1. 挂载后等待 5 秒（避免与启动期的 I/O 竞争资源）
 * 2. 通过 Tauri updater 插件检查更新
 * 3. 若有更新，静默下载并安装
 * 4. 重启应用
 *
 * 网络错误会被静默忽略（开发环境/离线场景常见）。
 * 安装错误会记录日志，但不会打扰用户。
 *
 * 本 hook 不显示 UI 对话框 —— 更新器设计为无打扰。
 * 如需向用户展示确认提示，应通过应用的 dialog/toast 系统，
 * 而非原生 confirm()/alert()。
 *
 * 副作用：
 *  - 注册 setTimeout 定时器（5 秒后触发检查）
 *  - 组件卸载时取消定时器并中断异步链
 *
 * 使用场景：仅在根组件（App.tsx）顶层调用一次，全应用共享单个更新检查实例。
 *
 * @see @tauri-apps/plugin-updater — Tauri 官方更新插件
 * @see @tauri-apps/plugin-process — relaunch 用于安装后重启
 */
export function useAutoUpdater(): void {
  useEffect(() => {
    // 取消保护 —— 确保异步链在组件卸载后不再继续执行。
    // 虽然本 hook 在根组件中使用（实践中不会卸载），
    // 但该保护是防御性最佳实践。
    let cancelled = false

    const checkForUpdates = async () => {
      try {
        const update = await check()
        if (cancelled) return
        if (!update) return

        logger.info('Update available', { version: update.version })

        try {
          await update.downloadAndInstall(event => {
            switch (event.event) {
              case 'Started':
                logger.info('Update download started', {
                  contentLength: event.data.contentLength,
                })
                break
              case 'Progress':
                logger.debug('Update download progress', {
                  chunkLength: event.data.chunkLength,
                })
                break
              case 'Finished':
                logger.info('Update download complete, installing')
                break
            }
          })

          if (cancelled) return
          logger.info('Update installed successfully, relaunching')
          await relaunch()
        } catch (updateError) {
          if (cancelled) return
          logger.error('Update installation failed', {
            error: String(updateError),
          })
        }
      } catch (checkError) {
        // 更新检查静默失败 —— 不因网络问题打扰用户
        if (cancelled) return
        logger.debug('Update check failed (network unavailable?)', {
          error: String(checkError),
        })
      }
    }

    // 应用加载 5 秒后检查更新
    const updateTimer = setTimeout(() => void checkForUpdates(), 5000)
    return () => {
      cancelled = true
      clearTimeout(updateTimer)
    }
  }, [])
}
