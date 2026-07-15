/**
 * AccountDialog — 账户信息弹窗（Task 19）
 *
 * 展示当前登录账户信息与用量统计：
 * - 账户头部：头像（email 前 2 位大写）+ 用户名 + email + plan 标签
 * - 用量网格（2×2）：5h 用量 / 本周用量 / Token 用量 / 速率限制
 * - 底部：登出按钮 + 关闭按钮
 *
 * 用量数据从集中式 MockData 获取（支持场景切换），
 * Tauri 模式下后续通过 GetAccountRateLimits / GetAccountTokenUsage 接入。
 *
 * 样式参照 prototype.html `.acct-panel`, `.acct-header`, `.acct-avatar`,
 * `.acct-stat-grid`, `.acct-stat`, `.usage-bar`。
 *
 * @see src/features/account/account-store.ts — 账户状态
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { User, LogOut } from 'lucide-react'
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
import { useAccountStore, type AccountState } from './account-store'
import { logout } from '@/lib/codex/account'
import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/env'
// 集中式 mock 数据 — 用量统计从 MockData 统一获取
import { getMockData } from '@/lib/codex/mock'

/**
 * 从 email 提取前 2 位作为头像文字（大写）。
 *
 * 处理逻辑：
 *  - 优先取用户名（@ 之前部分）的前两位
 *  - 用户名不足 2 位时，回退到域名首字母补齐
 *  - 全部缺失时用 '?' 占位
 *
 * @param email — 用户邮箱
 * @returns 大写的 2 字符头像标识
 *
 * @example
 * getAvatarText('alice@example.com') // → 'AL'
 * getAvatarText('a@example.com')     // → 'AE'（用户名 1 位，回退域名首字母）
 * getAvatarText('ab@cd.com')         // → 'AB'
 */
function getAvatarText(email: string): string {
  const atIndex = email.indexOf('@')
  // 提取 @ 之前的用户名部分；若不含 @，则原样使用整个字符串
  const name = atIndex > 0 ? email.slice(0, atIndex) : email
  // 提取域名部分（用于用户名过短时的回退）
  const domain = atIndex > 0 ? email.slice(atIndex + 1) : ''
  // 首字母取用户名第一位（缺失则用 '?' 占位）
  const first = name.charAt(0) || '?'
  // 第二字母优先取用户名第二位，否则回退到域名首字母
  const second = name.charAt(1) || domain.charAt(0) || ''
  return (first + second).toUpperCase()
}

/**
 * 从 email 提取用户名（@ 之前部分）。
 * 若 email 不含 @，则原样返回。
 *
 * @param email — 用户邮箱
 * @returns 用户名部分
 *
 * @example
 * getUsername('alice@example.com') // → 'alice'
 * getUsername('no-at-symbol')      // → 'no-at-symbol'
 */
function getUsername(email: string): string {
  const atIndex = email.indexOf('@')
  return atIndex > 0 ? email.slice(0, atIndex) : email
}

/**
 * AccountDialog 组件 —— 账户信息弹窗。
 *
 * 渲染逻辑：
 *  - 已登录（account 非空）：展示头像、用户名、email、plan 标签 + 用量统计网格 + 登出按钮
 *  - 未登录（account 为空）：展示"尚未登录"提示 + 跳转登录按钮
 *
 * 状态依赖：
 *  - dialog-store：弹窗开关（accountOpen）与跳转 login 弹窗
 *  - account-store：账户信息（account）与清空账户（clearAccount）
 *
 * 副作用：
 *  - 调用 `logout()` 触发后端登出 → 清空 store → 关闭弹窗 + toast
 *
 * @see src/features/account/account-store.ts — 账户状态
 * @see src/lib/codex/account.ts — logout API
 */
export function AccountDialog() {
  // 弹窗开关状态
  const accountOpen = useDialogStore((s: DialogState) => s.accountOpen)
  const setAccountOpen = useDialogStore((s: DialogState) => s.setAccountOpen)
  const setLoginOpen = useDialogStore((s: DialogState) => s.setLoginOpen)

  // 账户状态
  const account = useAccountStore((s: AccountState) => s.account)
  const clearAccount = useAccountStore((s: AccountState) => s.clearAccount)

  // 用量统计数据
  // 浏览器开发模式从 MockData 获取（场景可切）；
  // Tauri 生产模式初始为空数组，后续通过 GetAccountRateLimits /
  // GetAccountTokenUsage 接入真实数据，避免 mock 数据泄漏到生产环境
  const [usageStats] = useState(() =>
    isTauri() ? [] : getMockData().usageStats
  )
  // TODO: 后续通过 GetAccountRateLimits / GetAccountTokenUsage 接入

  // 登出后延迟打开登录弹窗的 timer 句柄 —— 组件卸载时清理
  // 避免登出后用户立即关闭弹窗导致对已卸载组件 setState
  const loginTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (loginTimerRef.current !== null) {
        clearTimeout(loginTimerRef.current)
        loginTimerRef.current = null
      }
    }
  }, [])

  // 登出
  // 登出成功后延迟 250ms 自动打开登录弹窗，对齐原型交互节奏：
  // 先让账户弹窗关闭动画完成，再唤起登录入口，避免两个弹窗叠层闪烁。
  const handleLogout = useCallback(async () => {
    try {
      await logout()
      clearAccount()
      setAccountOpen(false)
      toast.success('已登出')
      // 保存到 ref 以便卸载时清理
      loginTimerRef.current = setTimeout(() => {
        setLoginOpen(true)
        loginTimerRef.current = null
      }, 250)
    } catch (err) {
      logger.error('Logout failed', { error: err })
      toast.error('登出失败')
    }
  }, [clearAccount, setAccountOpen, setLoginOpen])

  // 打开登录弹窗
  const handleOpenLogin = useCallback(() => {
    setAccountOpen(false)
    setLoginOpen(true)
  }, [setAccountOpen, setLoginOpen])

  // 关闭/打开弹窗
  const handleOpenChange = useCallback(
    (open: boolean) => {
      // 重新打开弹窗时，清理可能残留的登出后跳转登录 timer
      // 避免登出 setTimeout 与重新打开冲突，导致非预期自动跳转登录弹窗
      if (open && loginTimerRef.current !== null) {
        clearTimeout(loginTimerRef.current)
        loginTimerRef.current = null
      }
      setAccountOpen(open)
    },
    [setAccountOpen]
  )

  return (
    <Dialog open={accountOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[420px] max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0"
      >
        {/* Header — accent 图标 + 标题 + 副标题 */}
        <DialogHeader className="flex flex-row items-center gap-2.5 border-b border-[var(--border)] px-4 py-3.5">
          {/*
            modal-head 图标 — 对齐原型 .modal-head .warn-icon（行 1948-1949）：
            - 尺寸 22×22（与原型一致）
            - 圆角 6px（rounded-md）— 原型 border-radius:6px（#P3 修复，原为 rounded=4px）
            注：原型中为 warn-icon（橙色），此处复用相同尺寸与圆角用于 accent 图标。
          */}
          <div className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-[rgba(0,229,199,0.15)] text-[var(--accent)]">
            <User width={13} height={13} />
          </div>
          <DialogTitle className="text-[14px] font-semibold text-[var(--text)]">
            账户
          </DialogTitle>
          {/* ml-auto 使副标题右对齐 — 对齐原型 .modal-sub { margin-left: auto } */}
          <span className="ml-auto font-mono text-[11.5px] text-[var(--text-faint)]">
            Account
          </span>
        </DialogHeader>

        {/* 无障碍描述 */}
        <DialogDescription className="sr-only">
          查看账户信息与用量统计
        </DialogDescription>

        {account ? (
          <div className="p-4">
            {/*
              账户头部 — 对齐原型 .acct-header（行 3268-3274）：
              - padding-bottom:14px（pb-3.5）— #P3 修复，原为 pb-3=12px
              - margin-bottom:14px（mb-3.5）— #P3 修复，原为 mb-3=12px
              - gap:12px（gap-3，与原型一致）
              - 头像 + 用户名 + email + plan
            */}
            <div className="mb-3.5 flex items-center gap-3 border-b border-[var(--border)] pb-3.5">
              {/*
                头像 — 对齐原型 .acct-avatar（行 3276-3286）：
                - 尺寸 44×44，圆角 10px（#15 P2）
                - 背景 accent→accent-dim 渐变（#16 P1）
                - 阴影 0 0 14px accent-glow（#16 P1）
                - 文字颜色 #001814（#17 P2，已在 #16 中一并修复）
              */}
              <div className="flex h-[44px] w-[44px] items-center justify-center rounded-[10px] bg-gradient-to-br from-[var(--accent)] to-[var(--accent-dim)] font-mono text-[16px] font-bold text-[#001814] shadow-[0_0_14px_var(--accent-glow)]">
                {getAvatarText(account.email)}
              </div>
              <div className="min-w-0 flex-1">
                {/* acct-name — 14px / 600 字重（D-A-004 修复） */}
                <div className="text-[14px] font-semibold text-[var(--text)]">
                  {getUsername(account.email)}
                </div>
                {/* acct-email — 11.5px / mt:2px 对齐原型（D-A-011 修复） */}
                <div className="mt-0.5 font-mono text-[11.5px] text-[var(--text-faint)]">
                  {account.email}
                </div>
                {/*
                  acct-plan — 对齐原型（D-A-005 修复）：
                  - border-radius:8px、padding:1.5px 7px、font-size:10px
                  - letter-spacing:0.04em、font-family:var(--mono)
                  - 移除 uppercase（原型无 text-transform）
                */}
                <span className="mt-1 inline-block rounded-[8px] bg-[var(--accent-glow)] px-[7px] py-[1.5px] font-mono text-[10px] font-semibold tracking-[0.04em] text-[var(--accent)]">
                  {account.plan}
                </span>
              </div>
            </div>

            {/*
              用量统计 — 对齐原型两个 .acct-stat-grid（行 6452-6478）：
              - 4 个统计项分为 2 组，每组 2 列网格（#18 P3）
              - 每个 .acct-stat: padding 10px 12px、圆角 8px（#19 P3）
              Tauri 模式下 usageStats 初始为空，显示"加载中"占位，
              避免渲染空网格造成视觉空洞。
            */}
            {usageStats.length === 0 ? (
              <div className="py-4 text-center text-xs text-[var(--text-faint)]">
                用量数据加载中…
              </div>
            ) : (
              <>
            <div className="mb-3.5 grid grid-cols-2 gap-2">
              {usageStats.slice(0, 2).map(stat => (
                <div
                  key={stat.label}
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5"
                >
                  {/* 标签 */}
                  {/* acct-stat-label — uppercase / tracking / font-semibold（D-A-012 修复） */}
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-faint)]">
                    {stat.label}
                  </div>
                  {/* 主值 */}
                  <div
                    className={cn(
                      'mt-1 font-mono tabular-nums text-[16px] font-semibold text-[var(--text)]',
                      stat.label === '速率限制' && 'text-[var(--accent)]'
                    )}
                  >
                    {stat.value}
                  </div>
                  {/* 副文本 */}
                  <div className="mt-0.5 font-mono text-[10.5px] text-[var(--text-faint)]">
                    {stat.sub}
                  </div>
                  {/* 进度条（无进度条时不渲染） */}
                  {stat.progress !== null && (
                    <div className="mt-1.5 h-[5px] overflow-hidden rounded-[3px] bg-[var(--border)]">
                      <div
                        className={cn(
                          'h-full rounded-[3px] transition-[width] duration-300',
                          stat.warn ? 'bg-[var(--warn)]' : 'bg-gradient-to-r from-[var(--accent)] to-[var(--accent-dim)]'
                        )}
                        style={{ width: `${stat.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
            {/* 第二个 acct-stat-grid — 添加 mb-3.5 对齐原型 margin-bottom:14px（D-A-015 修复） */}
            <div className="mb-3.5 grid grid-cols-2 gap-2">
              {usageStats.slice(2, 4).map(stat => (
                <div
                  key={stat.label}
                  className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5"
                >
                  {/* 标签 */}
                  {/* acct-stat-label — uppercase / tracking / font-semibold（D-A-012 修复） */}
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-faint)]">
                    {stat.label}
                  </div>
                  {/* 主值 */}
                  <div
                    className={cn(
                      'mt-1 font-mono tabular-nums text-[16px] font-semibold text-[var(--text)]',
                      stat.label === '速率限制' && 'text-[var(--accent)]'
                    )}
                  >
                    {stat.value}
                  </div>
                  {/* 副文本 */}
                  <div className="mt-0.5 font-mono text-[10.5px] text-[var(--text-faint)]">
                    {stat.sub}
                  </div>
                  {/* 进度条（无进度条时不渲染） */}
                  {stat.progress !== null && (
                    <div className="mt-1.5 h-[5px] overflow-hidden rounded-[3px] bg-[var(--border)]">
                      <div
                        className={cn(
                          'h-full rounded-[3px] transition-[width] duration-300',
                          stat.warn ? 'bg-[var(--warn)]' : 'bg-gradient-to-r from-[var(--accent)] to-[var(--accent-dim)]'
                        )}
                        style={{ width: `${stat.progress}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
              </>
            )}
          </div>
        ) : (
          // 未登录提示
          <div className="p-4">
            <p className="mb-3 text-center text-[12.5px] text-[var(--text-dim)]">
              尚未登录，请先登录账户
            </p>
            <Button
              onClick={handleOpenLogin}
              className="w-full bg-[var(--accent)] text-[#001814] hover:bg-[var(--accent-dim)]"
            >
              登录
            </Button>
          </div>
        )}

        {/* Footer — 元信息 + 登出 + 关闭按钮 */}
        <DialogFooter className="flex-row justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-3">
          {/*
            foot-meta — 对齐原型 .modal-foot .foot-meta（行 6481）：
            展示账户数据来源的命令名，左对齐占满剩余空间。
          */}
          {/* foot-meta — font-size:10.5px 对齐原型（D-A-020 修复） */}
          <span className="mr-auto self-center font-mono text-[10.5px] text-[var(--text-faint)]">
            GetAccount · GetAccountRateLimits · GetAccountTokenUsage
          </span>
          {account && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
              className="border-[rgba(255,107,107,0.3)] text-[var(--error)] hover:border-[var(--error)] hover:bg-[rgba(255,107,107,0.08)]"
            >
              <LogOut width={13} height={13} />
              登出
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
