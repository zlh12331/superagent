/**
 * @file RemoteView — 远程控制视图
 *
 * 参照 prototype.html §2.17 Remote 视图（L14562-14644）实现。
 *
 * 视图结构（对齐原型 .remote-main）：
 *  1. Header：返回按钮 + 标题 + 启用开关
 *  2. Grid（两列）：
 *     - 配对码卡片：显示 6 位配对码 + 有效期提示
 *     - 已配对客户端卡片：在线状态 + 设备信息 + 撤销按钮
 *  3. 协作模式卡片（全宽）：当前无在线协作者时显示空态
 *
 * 交互：
 *  - 启用开关：调用 enable()/disable()，切换后 toast 提示
 *  - 撤销按钮：调用 revokeClient(clientId)，成功后 toast 提示
 *  - 返回按钮：调用 viewStore.goBack()
 *
 * 数据流：
 *  - 组件挂载时调用 initialize() 读取状态 + 客户端列表
 *  - 所有状态来自 useRemoteStore（Zustand）
 *
 * @see prototype.html L4775-4813 — Remote 视图 CSS
 * @see prototype.html L14562-14644 — renderRemote 函数
 * @see src/features/remote/remote-store.ts — 状态管理
 */

import { useEffect, useRef, useCallback } from 'react'
import { ChevronLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { useRemoteStore } from './remote-store'
import { useViewStore } from '@/store/view-store'
import { logger } from '@/lib/logger'

/**
 * RemoteView 远程控制视图组件。
 *
 * 职责：
 *  - 渲染远程控制 UI（配对码、客户端列表、协作模式）
 *  - 通过 useRemoteStore 管理状态和调用 API
 *  - 首次挂载时自动初始化（读取状态 + 客户端列表）
 *
 * 性能优化：
 *  - 使用 useRef 防止 StrictMode 双挂载导致重复初始化
 *  - 使用 useCallback 缓存事件处理器
 */
export function RemoteView() {
  // ---- store 状态 ----
  const status = useRemoteStore(s => s.status)
  const pairingCode = useRemoteStore(s => s.pairingCode)
  const clients = useRemoteStore(s => s.clients)
  const loading = useRemoteStore(s => s.loading)

  // ---- store 操作 ----
  const initialize = useRemoteStore(s => s.initialize)
  const enable = useRemoteStore(s => s.enable)
  const disable = useRemoteStore(s => s.disable)
  const revokeClient = useRemoteStore(s => s.revokeClient)

  // ---- 视图导航 ----
  const goBack = useViewStore(s => s.goBack)

  // ---- ref：防止 StrictMode 双挂载导致重复初始化 ----
  const initRef = useRef(false)

  // ===== 首次挂载时初始化 =====

  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true
      void initialize()
    }
  }, [initialize])

  // ===== 启用/禁用切换 =====

  /**
   * 处理启用开关切换。
   *
   * 对齐原型 L14606-14625：
   *  - 开启：调用 enable()（内部会自动获取配对码）
   *  - 关闭：调用 disable()（清空配对码和客户端列表）
   *  - 操作完成后 toast 提示
   */
  const handleToggle = useCallback(
    async (checked: boolean) => {
      try {
        if (checked) {
          await enable()
          // 启用后刷新客户端列表
          await useRemoteStore.getState().refreshClients()
          toast.success('已启用远程控制')
        } else {
          await disable()
          toast.success('已禁用远程控制')
        }
      } catch (error) {
        logger.error('Remote control toggle failed', { error })
        toast.error('操作失败，请稍后重试')
      }
    },
    [enable, disable]
  )

  // ===== 撤销客户端 =====

  /**
   * 处理撤销客户端访问权限。
   *
   * 对齐原型 L14631-14643：
   *  - 调用 revokeClient(clientId)
   *  - 成功后 toast 提示"已撤销客户端访问权限"
   *  - 失败时 toast 提示"撤销失败"
   */
  const handleRevoke = useCallback(
    async (clientId: string) => {
      try {
        await revokeClient(clientId)
        toast.warning('已撤销客户端访问权限')
      } catch (error) {
        logger.error('Revoke client failed', { error })
        toast.error('撤销失败')
      }
    },
    [revokeClient]
  )

  // ===== 返回上一视图 =====

  const handleBack = useCallback(() => {
    goBack()
  }, [goBack])

  // ===== 派生状态 =====

  const isEnabled = status === 'connected'

  // ===== 渲染 =====

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      {/* ---- Header：返回按钮 + 标题 + 启用开关 ---- */}
      <div className="mb-4 flex items-center gap-3 border-b border-[var(--border)] pb-4">
        {/* 返回按钮 — 对齐 .remote-back-btn */}
        <button
          type="button"
          onClick={handleBack}
          title="返回上一页"
          aria-label="返回上一页"
          className="flex items-center gap-1 rounded-[6px] border border-[var(--border)] bg-[var(--bg-elev-2)] px-2.5 py-1 text-[12px] text-[var(--text-dim)] transition-colors hover:border-[rgba(0,229,199,0.4)] hover:bg-[rgba(0,229,199,0.06)] hover:text-[var(--accent)]"
        >
          <ChevronLeft width={16} height={16} className="shrink-0" />
          <span>返回</span>
        </button>

        {/* 标题 */}
        <h3 className="flex-1 text-[16px] font-semibold text-[var(--text)]">
          远程控制 &amp; 协作
        </h3>

        {/* 启用开关 — 对齐 .remote-toggle */}
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-dim)]">
          <Switch
            checked={isEnabled}
            onCheckedChange={handleToggle}
            disabled={loading}
            aria-label="远程控制开关"
          />
          <span>{isEnabled ? '已启用' : '已禁用'}</span>
        </label>
      </div>

      {/* ---- Grid：配对码 + 已配对客户端（两列）---- */}
      <div className="mb-4 grid grid-cols-2 gap-4">
        {/* 配对码卡片 — 对齐 .remote-card > .remote-pairing-code */}
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-3.5">
          <h4 className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--text-faint)]">
            配对码
          </h4>
          {/* 配对码显示 — 虚线边框 + accent 色 mono 字体 */}
          <div className="rounded-lg border border-dashed border-[var(--accent)] bg-[var(--bg)] px-4 py-4 text-center font-mono text-[24px] font-bold tracking-[0.2em] text-[var(--accent)]">
            {pairingCode || '----'}
          </div>
          {/* 提示文字 */}
          <p className="mt-2 text-center font-mono text-[10.5px] text-[var(--text-faint)]">
            {pairingCode
              ? '在其他设备输入此配对码\n有效期: 5 分钟'
              : '启用远程控制后显示配对码'}
          </p>
        </div>

        {/* 已配对客户端卡片 — 对齐 .remote-card > .remote-clients */}
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-3.5">
          <h4 className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--text-faint)]">
            已配对客户端 ({clients.length})
          </h4>
          {/* 客户端列表 */}
          <div className="flex flex-col gap-2">
            {clients.length === 0 ? (
              // 空态：无已配对客户端
              <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-center text-[11px] text-[var(--text-faint)]">
                暂无已配对客户端
              </div>
            ) : (
              // 客户端列表项 — 对齐 .remote-client
              clients.map(client => (
                <div
                  key={client.clientId}
                  className="flex items-center gap-2.5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                >
                  {/* 在线状态指示灯 — 对齐 .remote-client-dot */}
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      client.status === 'online'
                        ? 'bg-[var(--accent)]'
                        : 'bg-[var(--text-faint)]'
                    }`}
                  />
                  {/* 客户端信息 */}
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-[var(--text)]">
                      {client.name}
                    </div>
                    <div className="font-mono text-[10px] text-[var(--text-faint)]">
                      {client.os} · {client.ip} · {client.last}
                    </div>
                  </div>
                  {/* 撤销按钮 — 对齐 .remote-client-revoke */}
                  <button
                    type="button"
                    onClick={() => handleRevoke(client.clientId)}
                    disabled={loading}
                    className="rounded-[4px] border border-[var(--border)] bg-none px-2 py-0.5 text-[10px] text-[var(--text-faint)] transition-colors hover:border-[var(--error)] hover:text-[var(--error)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    撤销
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ---- 协作模式卡片（全宽）---- */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-3.5">
        <h4 className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--text-faint)]">
          协作模式
        </h4>
        {/* 协作列表 — 对齐 .remote-collab-list */}
        <div className="flex flex-col gap-2">
          {/* 当前无在线协作者 — 空态提示 */}
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-center text-[11px] text-[var(--text-faint)]">
            当前无在线协作者
          </div>
        </div>
      </div>
    </div>
  )
}
