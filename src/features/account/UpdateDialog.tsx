/**
 * @file UpdateDialog — 检查更新弹窗
 *
 * 参照 prototype.html `openUpdater` 函数（行 14984-15012）实现：
 * - 检查更新状态流转：idle → checking → available / not-available → downloading → installed
 * - 有更新时显示：新版本号 + 当前版本号 + 更新内容列表 + 下载进度条
 * - 下载安装：调用 Tauri updater 插件的 downloadAndInstall API
 * - 下载完成：toast 提示"更新已安装，即将重启..."
 *
 * 触发入口：
 *  - 设置抽屉 → AboutSettingsPane → "检查更新"按钮
 *  - 应用菜单 → "检查更新"菜单项
 *
 * 状态管理：useDialogStore.updateOpen 控制开关。
 *
 * @see prototype.html 行 14984-15012 — openUpdater 函数
 * @see @tauri-apps/plugin-updater — Tauri 官方更新插件
 * @see src/hooks/use-auto-updater.ts — 启动时自动检查更新
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useDialogStore, type DialogState } from '@/store/dialog-store'
import { isTauri } from '@/lib/env'
import { logger } from '@/lib/logger'
// 仅类型导入 —— 运行时通过动态 import('@tauri-apps/plugin-updater') 加载
import type { Update } from '@tauri-apps/plugin-updater'

// ===== 类型定义 =====

/**
 * 更新检查状态机
 *
 * 状态流转：
 *  idle → checking → available（有更新）
 *                  → not-available（无更新）
 *                  → error（检查失败）
 *  available → downloading → installed（下载完成）
 */
type UpdateStatus =
  | 'idle' // 初始状态（未检查）
  | 'checking' // 检查中
  | 'available' // 发现新版本
  | 'not-available' // 已是最新版本
  | 'error' // 检查失败
  | 'downloading' // 下载中
  | 'installed' // 下载完成，即将重启

/**
 * 更新信息结构 — 对齐 Tauri updater 插件的 Update 对象
 */
interface UpdateInfo {
  /** 新版本号（如 "1.4.2"） */
  version: string
  /** 当前版本号（如 "1.4.0"） */
  currentVersion: string
  /** 更新内容列表（按行拆分） */
  notes: string[]
}

// ===== Mock 数据（浏览器模式 / 检查失败时使用）=====

/**
 * Mock 更新信息 — 对齐原型 L14989 的数据
 *
 * 在浏览器模式（非 Tauri）下使用，模拟发现新版本的场景。
 */
const MOCK_UPDATE: UpdateInfo = {
  version: '1.4.2',
  currentVersion: '1.4.0',
  notes: [
    '新增 MCP OAuth 登录流程',
    '修复 thread rollback 在大消息流时的性能问题',
    '优化终端渲染性能 (xterm webgl)',
    '新增 Windows Sandbox 配置向导',
    '修复 macOS titleBarStyle 适配',
  ],
}

// ===== 组件 =====

/**
 * UpdateDialog 检查更新弹窗组件。
 *
 * 受控组件：由 dialog-store 的 updateOpen 控制开关。
 * 打开时自动触发检查更新流程。
 *
 * 状态流转：
 *  1. 打开 → checking（调用 Tauri check() 或使用 mock）
 *  2. 检查完成 → available（有更新）/ not-available（无更新）/ error
 *  3. 用户点击"下载并安装" → downloading（进度条）
 *  4. 下载完成 → installed → 1秒后关闭 + toast 提示
 */
export function UpdateDialog() {
  // 弹窗开关状态
  const updateOpen = useDialogStore((s: DialogState) => s.updateOpen)
  const setUpdateOpen = useDialogStore((s: DialogState) => s.setUpdateOpen)

  // ---- 状态 ----
  /** 当前检查状态 */
  const [status, setStatus] = useState<UpdateStatus>('idle')
  /** 更新信息（有更新时填充） */
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  /** 下载进度百分比（0-100） */
  const [progress, setProgress] = useState(0)
  /** 错误信息（检查失败时填充） */
  const [errorMsg, setErrorMsg] = useState('')

  // ---- ref：防止 StrictMode 双触发检查 ----
  const checkInitiatedRef = useRef(false)
  // ---- ref：未清理的 timer 句柄（组件卸载时统一清理，避免内存泄漏与对已卸载组件调用 setState）----
  // closeTimerRef：下载完成后 1 秒关闭弹窗的 setTimeout
  // progressIntervalRef：浏览器模式模拟下载进度的 setInterval
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  )
  // ---- ref：缓存 performCheck 获取的 Tauri Update 对象 ----
  // 避免 handleDownload 重复调用 check() —— 重复请求可能因网络抖动返回 null，
  // 使下载流程卡死在 downloading 状态（Bug 5 修复）
  const updateInfoRef = useRef<Update | null>(null)

  // 组件卸载时清理所有未完成的 timer —— 防止对已卸载组件调用 setState 引发警告
  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      if (progressIntervalRef.current !== null) {
        clearInterval(progressIntervalRef.current)
        progressIntervalRef.current = null
      }
    }
  }, [])

  // ===== 检查更新 =====

  /**
   * 执行更新检查
   *
   * Tauri 模式：调用 @tauri-apps/plugin-updater 的 check()
   * 浏览器模式：延迟 800ms 后返回 mock 数据（模拟网络请求）
   */
  const performCheck = useCallback(async () => {
    setStatus('checking')
    setErrorMsg('')

    try {
      if (isTauri()) {
        // Tauri 模式：调用真实 updater 插件
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()

        if (update) {
          // 缓存 update 对象供 handleDownload 复用，避免重复 check()
          updateInfoRef.current = update
          // 有更新 — 解析 release notes（按换行拆分）
          const notes = (update.body || '')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)

          setUpdateInfo({
            version: update.version,
            currentVersion: update.currentVersion ?? '0.0.0',
            notes: notes.length > 0 ? notes : ['更新内容详见发布说明'],
          })
          setStatus('available')
        } else {
          // 无更新 — 清空缓存
          updateInfoRef.current = null
          setStatus('not-available')
        }
      } else {
        // 浏览器模式：延迟 800ms 后返回 mock 数据
        await new Promise<void>(resolve => setTimeout(resolve, 800))
        setUpdateInfo(MOCK_UPDATE)
        setStatus('available')
      }
    } catch (error) {
      logger.error('Update check failed', { error })
      setErrorMsg(error instanceof Error ? error.message : '未知错误')
      setStatus('error')
    }
  }, [])

  // ===== 弹窗打开时自动检查 =====

  useEffect(() => {
    if (updateOpen && !checkInitiatedRef.current) {
      checkInitiatedRef.current = true
      void performCheck()
    }
    // 关闭时重置 ref，允许下次打开重新检查
    if (!updateOpen) {
      checkInitiatedRef.current = false
    }
  }, [updateOpen, performCheck])

  // ===== 弹窗关闭时重置状态 =====

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        // 重置所有状态（延迟到下一个渲染周期，避免闪烁）
        setStatus('idle')
        setUpdateInfo(null)
        setProgress(0)
        setErrorMsg('')
        // 清理可能残留的 interval（浏览器模式模拟下载进度时关闭弹窗）
        if (progressIntervalRef.current !== null) {
          clearInterval(progressIntervalRef.current)
          progressIntervalRef.current = null
        }
      }
      setUpdateOpen(open)
    },
    [setUpdateOpen]
  )

  // ===== 下载并安装 =====

  /**
   * 下载并安装更新
   *
   * Tauri 模式：调用 update.downloadAndInstall()，带进度回调
   *   - Started 事件：记录总字节数（contentLength）
   *   - Progress 事件：累计已下载字节，计算百分比
   *   - Finished 事件：标记完成
   * 浏览器模式：模拟下载进度（每 300ms 增加随机值）
   */
  const handleDownload = useCallback(async () => {
    setStatus('downloading')
    setProgress(0)

    try {
      if (isTauri()) {
        // Tauri 模式：复用 performCheck 缓存的 update 对象，避免重复 check()
        // 重复 check() 可能因网络抖动返回 null，导致下载流程卡死
        const update = updateInfoRef.current
        if (!update) {
          // 缓存失效（理论上不应发生）—— 提示错误并退出
          setStatus('error')
          setErrorMsg('更新信息获取失败，请重试')
          return
        }

        // 累计已下载字节数（Progress 事件只提供本次 chunk 长度，需累加）
        let downloaded = 0
        // 总字节数（从 Started 事件获取，可能为 undefined）
        let total = 0

        await update.downloadAndInstall(event => {
          // event.event: 'Started' | 'Progress' | 'Finished'
          if (event.event === 'Started') {
            // Started 事件携带 contentLength（可能为 undefined）
            total = event.data.contentLength ?? 0
          } else if (event.event === 'Progress') {
            // Progress 事件只携带本次 chunk 长度
            downloaded += event.data.chunkLength ?? 0
            // 仅在 total 已知时更新进度条
            if (total > 0) {
              const pct = Math.min(100, (downloaded / total) * 100)
              setProgress(pct)
            }
          }
        })
        setStatus('installed')
        toast.success('更新已安装，即将重启...')
        // 1 秒后关闭弹窗 —— 保存到 ref 以便组件卸载时清理
        closeTimerRef.current = setTimeout(() => {
          handleOpenChange(false)
          closeTimerRef.current = null
        }, 1000)
      } else {
        // 浏览器模式：模拟下载进度
        await new Promise<void>(resolve => {
          // 保存 interval id 到 ref —— 组件卸载时由统一 cleanup 清理
          progressIntervalRef.current = setInterval(() => {
            setProgress(prev => {
              const next = prev + Math.random() * 15
              if (next >= 100) {
                if (progressIntervalRef.current !== null) {
                  clearInterval(progressIntervalRef.current)
                  progressIntervalRef.current = null
                }
                resolve()
                return 100
              }
              return next
            })
          }, 300)
        })
        setStatus('installed')
        toast.success('更新已安装，即将重启...')
        // 同上：保存到 ref 以便卸载时清理
        closeTimerRef.current = setTimeout(() => {
          handleOpenChange(false)
          closeTimerRef.current = null
        }, 1000)
      }
    } catch (error) {
      logger.error('Download failed', { error })
      toast.error('下载失败，请稍后重试')
      setStatus('available') // 回退到有更新状态，允许重试
    }
  }, [handleOpenChange])

  // ===== 渲染 =====

  return (
    <Dialog open={updateOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={status !== 'downloading'}
        className="w-[420px] max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0"
      >
        {/* Header — 标题 */}
        <DialogHeader className="flex flex-row items-center gap-2.5 border-b border-[var(--border)] px-4 py-3.5">
          <DialogTitle className="text-[14px] font-semibold text-[var(--text)]">
            检查更新
          </DialogTitle>
        </DialogHeader>

        {/* 无障碍描述 */}
        <DialogDescription className="sr-only">
          检查应用程序是否有新版本可用
        </DialogDescription>

        {/* Body — 根据状态渲染不同内容 */}
        <div className="px-4 py-3.5 text-center">
          {status === 'checking' && (
            // 检查中 — 显示 loading 动画
            <div className="flex flex-col items-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--accent)]" />
              <p className="mt-3 text-[12px] text-[var(--text-dim)]">
                正在检查更新…
              </p>
            </div>
          )}

          {status === 'available' && updateInfo && (
            // 有更新 — 显示新版本号 + 更新内容
            <>
              <p className="text-[12px] text-[var(--text-faint)]">发现新版本</p>
              {/* 新版本号 — 大号 accent 色 mono 字体 */}
              <p className="my-2 font-mono text-[20px] font-bold text-[var(--accent)]">
                v{updateInfo.version}
              </p>
              {/* 当前版本号 — 小号 faint 色 */}
              <p className="font-mono text-[11.5px] text-[var(--text-faint)]">
                当前版本: v{updateInfo.currentVersion}
              </p>
              {/* 更新内容列表 — 可滚动区域 */}
              <div className="my-4 max-h-[180px] overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg)] p-3 text-left text-[12px] leading-[1.6] text-[var(--text-dim)]">
                <strong className="text-[var(--text)]">更新内容：</strong>
                <br />
                {updateInfo.notes.map((note, idx) => (
                  <div key={idx}>• {note}</div>
                ))}
              </div>
            </>
          )}

          {status === 'not-available' && (
            // 无更新 — 显示"已是最新版本"
            <div className="py-8">
              <p className="text-[14px] text-[var(--accent)]">
                ✓ 当前已是最新版本
              </p>
            </div>
          )}

          {status === 'error' && (
            // 检查失败 — 显示错误信息
            <div className="py-8">
              <p className="text-[14px] text-[var(--error)]">
                ✗ 检查更新失败
              </p>
              {errorMsg && (
                <p className="mt-2 font-mono text-[11px] text-[var(--text-faint)]">
                  {errorMsg}
                </p>
              )}
            </div>
          )}

          {status === 'downloading' && (
            // 下载中 — 显示进度条
            <div className="py-8">
              {/* 进度条容器 */}
              <div className="mx-auto max-w-[320px]">
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-elev-3)]">
                  {/* 进度条填充 — accent 色，带过渡动画 */}
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                {/* 进度文本 — 百分比 */}
                <p className="mt-1 font-mono text-[10.5px] text-[var(--text-faint)]">
                  {progress >= 100
                    ? '下载完成，正在安装...'
                    : `下载中... ${Math.floor(progress)}%`}
                </p>
              </div>
            </div>
          )}

          {status === 'installed' && (
            // 下载完成 — 显示成功提示
            <div className="py-8">
              <p className="text-[14px] text-[var(--accent)]">
                ✓ 更新已安装，即将重启...
              </p>
            </div>
          )}
        </div>

        {/* Footer — 操作按钮（下载中/已完成时不显示） */}
        {status !== 'downloading' && status !== 'installed' && (
          <DialogFooter className="flex-row justify-center gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-3">
            {status === 'available' && (
              <>
                {/* 稍后按钮 — 关闭弹窗 */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleOpenChange(false)}
                >
                  稍后
                </Button>
                {/* 下载并安装按钮 — accent 色 */}
                <Button
                  size="sm"
                  onClick={handleDownload}
                  className="bg-[var(--accent)] text-[#001814] hover:bg-[var(--accent-dim)]"
                >
                  下载并安装
                </Button>
              </>
            )}

            {status === 'not-available' && (
              <Button
                size="sm"
                onClick={() => handleOpenChange(false)}
                className="bg-[var(--accent)] text-[#001814] hover:bg-[var(--accent-dim)]"
              >
                确定
              </Button>
            )}

            {status === 'error' && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleOpenChange(false)}
                >
                  关闭
                </Button>
                {/* 重试按钮 */}
                <Button
                  size="sm"
                  onClick={performCheck}
                  className="bg-[var(--accent)] text-[#001814] hover:bg-[var(--accent-dim)]"
                >
                  <RefreshCw width={13} height={13} /> 重试
                </Button>
              </>
            )}

            {status === 'checking' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleOpenChange(false)}
              >
                取消
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
