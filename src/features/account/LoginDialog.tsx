/**
 * LoginDialog — 登录弹窗（Task 19）
 *
 * 提供三种登录方式（tab 切换）：
 * 1. API Key — 直接输入 key（后端 LoginAccountArgs 不支持 orgId，已移除组织 ID 输入）
 * 2. ChatGPT — 浏览器 OAuth 登录（codex_streamlined_login）
 * 3. ChatGPT Device Code — 设备码登录
 *
 * 交互流程:
 *   startLogin() → 显示 loading → onLoginCompleted 事件 → 关闭弹窗 + toast
 *
 * 样式参照 prototype.html `.login-tabs`, `.login-tab`, `.login-field`,
 * `.login-input`, `.oauth-btn`, `.login-hint`。
 *
 * 注意: 项目未引入 @/components/ui/tabs，这里用 useState 手动实现 tab 切换。
 *
 * @see src/lib/codex/account.ts — startLogin / onLoginCompleted
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { LogIn, Loader2, Globe, Copy, ExternalLink } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDialogStore, type DialogState } from '@/store/dialog-store'
import {
  startLogin,
  cancelLogin,
  onLoginCompleted,
  getAccount,
  type DeviceCodeInfo,
} from '@/lib/codex/account'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/env'

/**
 * Tab 标识
 *
 * 顺序对齐原型 #loginModal（行 6403-6406）：
 * - OAuth 登录（默认 active）— 对应 chatgpt OAuth 流程
 * - API Key — 直接输入 key
 * - ChatGPT Device Code — 设备码（功能增强，默认不激活）
 */
type TabId = 'api_key' | 'chatgpt' | 'chatgptDeviceCode'

/** Tab 配置 */
interface TabConfig {
  id: TabId
  label: string
}

// Tab 顺序：OAuth 登录 → API Key → ChatGPT Device Code（#13 P2）
const TABS: TabConfig[] = [
  { id: 'chatgpt', label: 'OAuth 登录' },
  { id: 'api_key', label: 'API Key' },
  { id: 'chatgptDeviceCode', label: 'ChatGPT Device Code' },
]

export function LoginDialog() {
  // 弹窗开关状态
  const loginOpen = useDialogStore((s: DialogState) => s.loginOpen)
  const setLoginOpen = useDialogStore((s: DialogState) => s.setLoginOpen)

  // 当前激活的 tab — 默认 OAuth 登录（#13 P2，对齐原型 .login-tab.active[data-tab="oauth"]）
  const [activeTab, setActiveTab] = useState<TabId>('chatgpt')
  // 共享 loading 状态（所有 tab 共用）
  const [loading, setLoading] = useState(false)

  // API Key tab 表单状态
  const [apiKey, setApiKey] = useState('')

  // 设备码 tab 状态
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null)
  const [deviceCountdown, setDeviceCountdown] = useState(0)

  // 设备码轮询定时器 ref —— 用于在组件卸载 / 设备码过期 / 弹窗关闭时清理，避免内存泄漏与重复轮询
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 倒计时镜像 ref —— 供倒计时 interval 回调读取最新值，避免闭包陈旧与每秒重建定时器
  const deviceCountdownRef = useRef(0)

  // 清理设备码轮询定时器（在多处 cleanup 中调用）
  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  // 启动设备码轮询：按指定间隔（秒）定时调用 getAccount 检查登录是否完成。
  // 登录成功后清理轮询；账户 UI 由 useAccountListener 通过 onLoginCompleted 事件更新。
  const startDeviceCodePolling = useCallback(
    (intervalSeconds: number) => {
      // 清理上一次的轮询定时器，避免重复轮询
      clearPollTimer()
      // 间隔最小 1 秒，防止后端返回 0 导致高频轮询
      const pollInterval = Math.max(intervalSeconds, 1) * 1000
      pollTimerRef.current = setInterval(async () => {
        try {
          const account = await getAccount()
          if (account) {
            // 登录成功：清理轮询定时器
            clearPollTimer()
          }
        } catch {
          // 轮询失败时静默忽略，下次轮询会自动重试
        }
      }, pollInterval)
    },
    [clearPollTimer]
  )

  // 监听登录完成事件：关闭弹窗 + toast 提示
  useEffect(() => {
    if (!loginOpen) return
    let cancelled = false
    let unlisten: (() => void) | null = null

    onLoginCompleted(event => {
      if (cancelled) return
      setLoading(false)
      setDeviceCode(null)
      // 登录成功后停止设备码轮询
      clearPollTimer()
      setLoginOpen(false)
      toast.success(`登录成功 · ${event.account}`)
    })
      .then(un => {
        if (cancelled) {
          un()
          return
        }
        unlisten = un
      })
      .catch(err => {
        logger.error('Failed to listen login completed', { error: err })
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [loginOpen, setLoginOpen, clearPollTimer])

  // 同步倒计时到 ref —— 供下方 interval 回调读取最新值，避免闭包陈旧
  // （仅赋值 ref，不调用 setState，符合 set-state-in-effect 规则）
  useEffect(() => {
    deviceCountdownRef.current = deviceCountdown
  }, [deviceCountdown])

  // 设备码倒计时 —— isCountdownActive 仅在 0/非0 切换时变化，避免每秒重建 setInterval（Bug 4）。
  // 倒计时归零时在 interval 回调中处理过期（Bug 5）：清理设备码与轮询并提示用户。
  // interval 回调中的 setState 属异步触发，不违反 set-state-in-effect 规则。
  const isCountdownActive = deviceCountdown > 0
  useEffect(() => {
    if (!isCountdownActive) return
    const timer = setInterval(() => {
      const prev = deviceCountdownRef.current
      const next = Math.max(prev - 1, 0)
      deviceCountdownRef.current = next
      setDeviceCountdown(next)
      // 倒计时刚好归零：清理设备码与轮询，提示用户重新获取
      if (next === 0 && prev > 0) {
        setDeviceCode(null)
        clearPollTimer()
        toast.warning('设备码已过期，请重新获取')
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [isCountdownActive, clearPollTimer])

  // 组件卸载时清理设备码轮询定时器，避免内存泄漏
  useEffect(() => {
    return () => clearPollTimer()
  }, [clearPollTimer])

  // 弹窗关闭时重置状态
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && loading) {
        // 登录进行中：取消登录流程
        cancelLogin().catch(() => {
          /* 忽略取消登录失败 */
        })
      }
      if (!open) {
        setLoading(false)
        setDeviceCode(null)
        setDeviceCountdown(0)
        setApiKey('')
        // 清理设备码轮询定时器
        clearPollTimer()
      }
      setLoginOpen(open)
    },
    [loading, setLoginOpen, clearPollTimer]
  )

  // 格式化倒计时为 mm:ss
  const formatCountdown = (seconds: number): string => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  // API Key 登录
  const handleApiKeyLogin = useCallback(async () => {
    const key = apiKey.trim()
    if (!key) {
      toast.error('请输入 API Key')
      return
    }
    setLoading(true)
    try {
      await startLogin('api_key', key)
      toast.success('API Key 验证中…')
      // Tauri 模式下保持 loading，等待 onLoginCompleted 事件回调重置（Bug 2）
      // 浏览器 mock 模式下无 Tauri 事件，需立即重置 loading
      if (!isTauri()) {
        setLoading(false)
      }
    } catch (err) {
      logger.error('API Key login failed', { error: err })
      toast.error('登录请求失败')
      setLoading(false)
    }
    // 注意：不在此处统一 setLoading(false) —— Tauri 模式需等 onLoginCompleted 事件回调
  }, [apiKey])

  // ChatGPT OAuth 登录
  const handleChatGPTLogin = useCallback(async () => {
    setLoading(true)
    try {
      await startLogin('chatgpt')
      toast.info('OAuth 跳转中…')
    } catch (err) {
      logger.error('ChatGPT OAuth login failed', { error: err })
      toast.error('登录请求失败')
      setLoading(false)
    }
  }, [])

  // 获取设备码
  const handleFetchDeviceCode = useCallback(async () => {
    setLoading(true)
    try {
      const result = await startLogin('chatgptDeviceCode')
      if (result.deviceCode) {
        setDeviceCode(result.deviceCode)
        setDeviceCountdown(result.deviceCode.expiresIn)
        // Bug 1: 成功获取设备码后启动轮询，按后端返回的 interval 检查登录状态
        startDeviceCodePolling(result.deviceCode.interval ?? 5)
      } else if (isTauri()) {
        // Tauri 模式下后端未返回 deviceCode —— 属于异常情况，不应构造假数据展示给用户。
        // 之前的 mock 设备码 'CDX-1234' 会让用户误以为流程正常，掩盖真实故障。
        logger.error('Device code missing in Tauri response', { result })
        toast.error('获取设备码失败', {
          description: '后端未返回设备码，请检查后端服务或重试',
        })
        return
      } else {
        // 浏览器开发模式：构造假设备码供 UI 演示（仅用于前端独立调试）
        const mockDeviceCode: DeviceCodeInfo = {
          userCode: 'CDX-1234',
          verificationUri: 'https://chatgpt.com/device',
          expiresIn: 900,
          interval: 5,
        }
        setDeviceCode(mockDeviceCode)
        setDeviceCountdown(mockDeviceCode.expiresIn)
        toast.info('已获取设备码（演示）')
        // 浏览器演示模式同样启动轮询
        startDeviceCodePolling(mockDeviceCode.interval)
      }
    } catch (err) {
      logger.error('Fetch device code failed', { error: err })
      toast.error('获取设备码失败')
    } finally {
      setLoading(false)
    }
  }, [startDeviceCodePolling])

  // 复制设备码到剪贴板
  const handleCopyDeviceCode = useCallback(async () => {
    if (!deviceCode) return
    try {
      await navigator.clipboard.writeText(deviceCode.userCode)
      toast.success('设备码已复制')
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }, [deviceCode])

  // 打开验证页面
  const handleOpenVerification = useCallback(() => {
    if (!deviceCode) return
    window.open(deviceCode.verificationUri, '_blank', 'noopener,noreferrer')
  }, [deviceCode])

  return (
    <Dialog open={loginOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[420px] max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0"
      >
        {/* Header — accent 图标 + 标题 + 副标题 */}
        <DialogHeader className="flex flex-row items-center gap-2.5 border-b border-[var(--border)] px-4 py-3.5">
          {/* warn-icon 圆角 6px — 对齐原型 border-radius:6px（D-A-008 修复） */}
          <div className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-[rgba(0,229,199,0.15)] text-[var(--accent)]">
            <LogIn width={13} height={13} />
          </div>
          <DialogTitle className="text-[14px] font-semibold text-[var(--text)]">
            登录账户
          </DialogTitle>
          {/* ml-auto 使副标题右对齐 — 对齐原型 .modal-sub { margin-left: auto } */}
          <span className="ml-auto font-mono text-[11.5px] text-[var(--text-faint)]">
            Account Login
          </span>
        </DialogHeader>

        {/* Tabs — 水平排列，底部 border */}
        <div
          className="flex border-b border-[var(--border)] bg-[var(--bg-elev-2)]"
          role="tablist"
          aria-label="登录方式"
        >
          {TABS.map(tab => {
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex-1 border-b-2 border-transparent py-[11px] px-[11px] font-sans text-[12.5px] font-medium transition-colors',
                  isActive
                    ? 'border-[var(--accent)] text-[var(--accent)]'
                    : 'text-[var(--text-dim)] hover:text-[var(--text)]'
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* Tab 面板 */}
        <div className="p-4">
          {activeTab === 'api_key' && (
            <div role="tabpanel">
              {/* API Key 输入 */}
              <div className="mb-3">
                <label className="mb-[5px] block text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-dim)]">
                  API Key
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-[7px] border border-[var(--border-strong)] bg-[var(--bg)] px-[11px] py-[9px] font-mono text-[12.5px] text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-faint)] focus:border-[var(--accent)]"
                />
              </div>
              {/* 登录按钮 */}
              <Button
                onClick={handleApiKeyLogin}
                disabled={loading}
                className="w-full bg-[var(--accent)] text-[#001814] hover:bg-[var(--accent-dim)]"
              >
                {loading ? (
                  <Loader2 className="animate-spin" width={14} height={14} />
                ) : null}
                验证并登录
              </Button>
              {/* 提示文字 */}
              <p className="mt-3 text-center text-[11px] leading-[1.5] text-[var(--text-faint)]">
                API Key 存储在{' '}
                <code className="rounded-[3px] bg-[var(--bg-elev-2)] px-[5px] py-px font-mono text-[var(--accent)]">
                  keyring
                </code>{' '}
                中，
                <br />
                不会写入磁盘配置文件
              </p>
            </div>
          )}

          {activeTab === 'chatgpt' && (
            <div role="tabpanel">
              {/* OAuth 登录大按钮 */}
              <button
                type="button"
                onClick={handleChatGPTLogin}
                disabled={loading}
                className={cn(
                  'flex w-full items-center justify-center gap-2 rounded-[7px] border border-[var(--border-strong)] bg-[var(--bg-elev-2)] py-2.5 px-2.5 text-[12.5px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]',
                  loading && 'cursor-not-allowed opacity-60'
                )}
              >
                {loading ? (
                  <Loader2 className="animate-spin" width={15} height={15} />
                ) : (
                  <Globe width={15} height={15} />
                )}
                使用 ChatGPT 账户登录
              </button>
              {/* 提示文字 */}
              <p className="mt-3 text-center text-[11px] leading-[1.5] text-[var(--text-faint)]">
                点击后将通过{' '}
                <code className="rounded-[3px] bg-[var(--bg-elev-2)] px-[5px] py-px font-mono text-[var(--accent)]">
                  tauri-plugin-deep-link
                </code>
                <br />
                接收 OAuth 回调，无需手动粘贴 code
              </p>
            </div>
          )}

          {activeTab === 'chatgptDeviceCode' && (
            <div role="tabpanel">
              {deviceCode ? (
                <>
                  {/* 设备码展示 */}
                  <div className="mb-3 rounded-md border border-[var(--border-strong)] bg-[var(--bg)] p-3">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-dim)]">
                      设备码
                    </div>
                    <div className="font-mono text-[18px] font-semibold tracking-wider text-[var(--accent)]">
                      {deviceCode.userCode}
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-[var(--text-faint)]">
                      {deviceCode.verificationUri}
                    </div>
                  </div>
                  {/* 操作按钮 */}
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCopyDeviceCode}
                      className="flex-1"
                    >
                      <Copy width={13} height={13} />
                      复制设备码
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleOpenVerification}
                      className="flex-1"
                    >
                      <ExternalLink width={13} height={13} />
                      打开验证页面
                    </Button>
                  </div>
                  {/* 等待验证提示 */}
                  <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-[var(--text-faint)]">
                    {loading ? (
                      <>
                        <Loader2
                          className="animate-spin"
                          width={12}
                          height={12}
                        />
                        等待验证中…
                      </>
                    ) : (
                      <>等待验证 · 剩余 {formatCountdown(deviceCountdown)}</>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* 获取设备码按钮 */}
                  <button
                    type="button"
                    onClick={handleFetchDeviceCode}
                    disabled={loading}
                    className={cn(
                      'flex w-full items-center justify-center gap-2 rounded-[7px] border border-[var(--border-strong)] bg-[var(--bg-elev-2)] py-2.5 px-2.5 text-[12.5px] font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]',
                      loading && 'cursor-not-allowed opacity-60'
                    )}
                  >
                    {loading ? (
                      <Loader2
                        className="animate-spin"
                        width={15}
                        height={15}
                      />
                    ) : (
                      <Globe width={15} height={15} />
                    )}
                    获取设备码
                  </button>
                  <p className="mt-3 text-center text-[11px] leading-[1.5] text-[var(--text-faint)]">
                    设备码登录适用于无浏览器环境，
                    <br />
                    获取后在另一设备打开验证页面输入设备码
                  </p>
                </>
              )}
            </div>
          )}

          {/* G1: foot-meta — 版本号 + 隐私政策 + 服务条款链接 */}
          <div className="mt-6 border-t border-[var(--border)] pt-4 text-center text-[11px] text-[var(--text-faint)]">
            <span>v1.0.0</span>
            <span className="mx-2">·</span>
            {/* 隐私政策按钮 — 原 href="#" 无实际跳转，改用 button 避免误导（Bug 6） */}
            <button
              type="button"
              onClick={() => {
                /* TODO: 后续接入隐私政策页面 */
              }}
              className="p-0 transition-colors hover:text-[var(--accent)]"
            >
              隐私政策
            </button>
            <span className="mx-2">·</span>
            {/* 服务条款按钮 — 原 href="#" 无实际跳转，改用 button 避免误导（Bug 6） */}
            <button
              type="button"
              onClick={() => {
                /* TODO: 后续接入服务条款页面 */
              }}
              className="p-0 transition-colors hover:text-[var(--accent)]"
            >
              服务条款
            </button>
          </div>
        </div>

        {/* Footer — 取消按钮 */}
        <DialogFooter className="flex-row justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
          >
            取消
          </Button>
        </DialogFooter>

        {/* 无障碍：隐藏描述（Radix Dialog 要求有 Description 或 aria-describedby） */}
        <DialogDescription className="sr-only">
          选择登录方式并完成账户认证
        </DialogDescription>
      </DialogContent>
    </Dialog>
  )
}
