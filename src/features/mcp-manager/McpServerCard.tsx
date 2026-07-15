/**
 * McpServerCard — 单个 MCP 服务器卡片（Task 20）
 *
 * 参照 prototype.html `.mcp-server` 样式实现：
 * - 头部：状态圆点 + 服务器名称 + 状态标签
 * - 正文：元信息（tools/resources/transport 或错误信息）+ 操作按钮
 *
 * 操作按钮根据状态不同：
 * - connected:  [刷新] [详情]
 * - disconnected: [连接] [配置]
 * - error: [重试] [配置]
 *
 * @see prototype.html 行 2988-3048 — .mcp-server / .mcp-mini-btn 样式
 */

import type { McpServer } from '@/lib/codex/types'

interface McpServerCardProps {
  /** 服务器数据 */
  server: McpServer
  /** 打开详情弹窗 */
  onShowDetail: () => void
  /** 刷新 / 重连 / 重试 */
  onRefresh: () => void
}

/** 状态圆点样式映射 */
const DOT_CLASS: Record<McpServer['status'], string> = {
  connected: 'bg-[var(--accent)] shadow-[0_0_6px_var(--accent)]',
  disconnected: 'bg-[var(--text-faint)]',
  error: 'bg-[var(--error)]',
}

/**
 * Mini 按钮 — 对齐 prototype `.mcp-mini-btn` 样式。
 *
 * @param label 按钮文字
 * @param onClick 点击回调
 * @param accent 是否使用 accent 强调样式（主操作按钮）
 */
function MiniButton({
  label,
  onClick,
  accent = false,
}: {
  label: string
  onClick: () => void
  accent?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        accent
          ? 'px-2 py-[3px] text-[10.5px] border border-[var(--accent)] bg-[var(--accent)] text-[#001814] rounded-[5px] font-mono font-semibold transition-opacity hover:opacity-85'
          : 'px-2 py-[3px] text-[10.5px] border border-[var(--border-strong)] bg-[var(--bg-elev)] text-[var(--text-dim)] rounded-[5px] font-mono transition-colors hover:text-[var(--text)] hover:border-[var(--text-faint)]'
      }
    >
      {label}
    </button>
  )
}

/**
 * McpServerCard 组件 —— 渲染单个 MCP 服务器卡片。
 *
 * 渲染逻辑：
 *  - 头部：状态圆点（颜色随 status 变化）+ 服务器名称 + 状态文本
 *  - 正文：元信息（tools/resources/transport 或 error）+ 操作按钮
 *  - 操作按钮根据 status 不同：
 *    - connected → [刷新 accent] [详情]
 *    - disconnected → [连接 accent] [配置]
 *    - error → [重试 accent] [配置]
 *
 * 状态依赖：
 *  - 纯展示组件，所有数据通过 props 传入
 *  - 操作行为通过 onShowDetail / onRefresh 回调上抛，由父组件处理
 *
 * @param props —— 见 McpServerCardProps 接口
 *
 * @example
 * <McpServerCard
 *   server={server}
 *   onShowDetail={() => setDetailServer(server)}
 *   onRefresh={() => handleRefresh(server)}
 * />
 */
export function McpServerCard({
  server,
  onShowDetail,
  onRefresh,
}: McpServerCardProps) {
  // 根据状态计算元信息文本
  const metaText =
    server.error !== null
      ? `连接失败 · ${server.error}`
      : `${server.tools} tools · ${server.resources} resources · ${server.transport}`

  // 根据状态计算操作按钮
  // connected: [刷新(accent)] [详情]
  // disconnected: [连接(accent)] [配置]
  // error: [重试(accent)] [配置]
  const primaryLabel =
    server.status === 'connected'
      ? '刷新'
      : server.status === 'error'
        ? '重试'
        : '连接'
  const secondaryLabel = server.status === 'connected' ? '详情' : '配置'

  return (
    <div className="rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev-2)] overflow-hidden mb-2.5">
      {/* 头部：状态圆点 + 名称 + 状态标签 */}
      <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-[var(--border)]">
        <span
          className={`h-[7px] w-[7px] shrink-0 rounded-full ${DOT_CLASS[server.status]}`}
        />
        <span className="font-mono text-[12.5px] font-semibold text-[var(--text)]">
          {server.name}
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
          {server.status}
        </span>
      </div>
      {/* 正文：元信息 + 操作按钮 */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <div className="flex-1 font-mono text-[11px] text-[var(--text-dim)]">
          {metaText}
        </div>
        <div className="flex gap-[5px]">
          <MiniButton label={primaryLabel} onClick={onRefresh} accent />
          <MiniButton label={secondaryLabel} onClick={onShowDetail} />
        </div>
      </div>
    </div>
  )
}
