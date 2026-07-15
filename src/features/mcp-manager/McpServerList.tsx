/**
 * McpServerList — MCP 服务器列表主组件（Task 20）
 *
 * 职责:
 * - 通过 useMcpServers hook 加载服务器列表并监听状态更新
 * - 从 useMcpStore 读取 servers / loading / error 状态
 * - 渲染服务器卡片列表（McpServerCard）
 * - 提供添加服务器入口（AddMcpServerDialog）
 * - 提供服务器详情查看入口（McpServerDetailDialog）
 *
 * 数据流:
 *   useMcpServers (加载/监听) → useMcpStore → McpServerList 渲染
 *
 * @see src/features/mcp-manager/useMcpServers.ts — 加载 hook
 * @see src/features/mcp-manager/McpServerCard.tsx — 服务器卡片
 */

import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionTitle } from '@/components/preferences/shared/SettingsControls'
import type { McpServer } from '@/lib/codex/types'
import { refreshMcpServer, listMcpServers } from '@/lib/codex/mcp'
import { useMcpStore } from './mcp-store'
import { useMcpServers } from './useMcpServers'
import { McpServerCard } from './McpServerCard'
import { McpServerDetailDialog } from './McpServerDetailDialog'
import { AddMcpServerDialog } from './AddMcpServerDialog'

/**
 * McpServerList 组件 —— MCP 服务器列表主组件。
 *
 * 渲染逻辑：
 *  - 顶部：SectionTitle + MCP 概念说明
 *  - 主体：根据状态展示 加载中 / 错误 / 服务器卡片列表 / 暂无服务器
 *  - 底部：「添加服务器」按钮 + AddMcpServerDialog
 *  - 详情：McpServerDetailDialog（点击卡片「详情/配置」按钮触发）
 *
 * 状态依赖：
 *  - 通过 useMcpServers() 触发加载并监听后端事件更新
 *  - 从 useMcpStore 读取 servers / loading / error / setServers
 *  - 本地 useState 管理 addDialogOpen / detailServer
 *
 * 副作用：
 *  - 调用 useMcpServers hook 在 mount 时拉取列表并注册事件监听
 *  - 刷新按钮调用 refreshMcpServer + listMcpServers 并更新 store
 *
 * @example
 * // 通常嵌入在设置抽屉的 MCP 分区中
 * <McpServerList />
 */
export function McpServerList() {
  // 加载服务器列表并监听状态更新
  useMcpServers()

  // 从 store 读取状态
  const servers = useMcpStore(s => s.servers)
  const loading = useMcpStore(s => s.loading)
  const error = useMcpStore(s => s.error)
  const setServers = useMcpStore(s => s.setServers)

  // 添加服务器弹窗开关
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  // 当前查看详情的服务器
  const [detailServer, setDetailServer] = useState<McpServer | null>(null)

  // 刷新 / 重连 / 重试服务器
  const handleRefresh = useCallback(
    async (server: McpServer) => {
      try {
        await refreshMcpServer(server.id)
        toast.success(`正在刷新 ${server.name}...`)
        // 刷新后重新加载列表
        const updated = await listMcpServers()
        setServers(updated)
      } catch (err) {
        toast.error(
          `刷新失败: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    },
    [setServers]
  )

  return (
    <div className="space-y-2">
      <SectionTitle>已注册服务器 ({servers.length})</SectionTitle>
      <p className="mb-3 text-[11px] leading-[1.5] text-[var(--text-faint)]">
        MCP（Model Context Protocol）服务器为 codex
        提供外部工具和数据源接入能力。
      </p>

      {/* 加载中 */}
      {loading && (
        <p className="py-4 text-center text-[12px] text-[var(--text-faint)]">
          加载中...
        </p>
      )}

      {/* 错误信息 */}
      {error !== null && !loading && (
        <p className="py-4 text-center text-[12px] text-[var(--error)]">
          {error}
        </p>
      )}

      {/* 服务器卡片列表 */}
      {!loading && error === null && (
        <>
          {servers.map(server => (
            <McpServerCard
              key={server.id}
              server={server}
              onShowDetail={() => setDetailServer(server)}
              onRefresh={() => handleRefresh(server)}
            />
          ))}
          {servers.length === 0 && (
            <p className="py-4 text-center text-[12px] text-[var(--text-faint)]">
              暂无已注册服务器
            </p>
          )}
        </>
      )}

      {/* 添加服务器按钮 */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setAddDialogOpen(true)}
        className="mt-2 w-full"
      >
        <Plus width={13} height={13} /> 添加服务器
      </Button>

      {/* 添加服务器弹窗 */}
      <AddMcpServerDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
      />

      {/* 服务器详情弹窗 */}
      <McpServerDetailDialog
        server={detailServer}
        onClose={() => setDetailServer(null)}
      />
    </div>
  )
}
