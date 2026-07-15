/**
 * useMcpServers — 加载 MCP 服务器列表并监听状态更新（Task 20）
 *
 * 在组件挂载时：
 * 1. 初次加载服务器列表（listMcpServers）
 * 2. 监听 mcpServer/startupStatus/updated 事件，状态变化时重新加载列表
 *
 * 采用 cancelled 守卫模式：若监听器注册完成前组件已卸载，
 * 立即调用 unlisten 释放资源，避免 StrictMode 双挂载下的监听器泄漏。
 *
 * @see src/lib/codex/mcp.ts — listMcpServers / onMcpServerStatusUpdated
 * @see src/features/mcp-manager/mcp-store.ts — 状态管理
 */

import { useEffect } from 'react'
import { useMcpStore } from './mcp-store'
import { listMcpServers, onMcpServerStatusUpdated } from '@/lib/codex/mcp'
import { logger } from '@/lib/logger'

/** 加载 MCP 服务器列表并监听状态更新 */
export function useMcpServers(): void {
  const setServers = useMcpStore(s => s.setServers)
  const setLoading = useMcpStore(s => s.setLoading)
  const setError = useMcpStore(s => s.setError)

  useEffect(() => {
    let cancelled = false

    // 1. 初次加载服务器列表
    setLoading(true)
    listMcpServers()
      .then(servers => {
        if (cancelled) return
        setServers(servers)
        setError(null)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    // 2. 监听服务器状态更新，状态变化时重新加载列表
    let unlisten: (() => void) | undefined
    onMcpServerStatusUpdated(() => {
      listMcpServers()
        .then(s => {
          if (!cancelled) setServers(s)
        })
        // 捕获重新加载服务器列表时的错误，记录日志便于排查
        .catch(err => {
          logger.error('Failed to list MCP servers', { error: err })
        })
    })
      .then(fn => {
        // 注册完成前组件已卸载：立即释放
        if (cancelled) {
          fn()
          return
        }
        unlisten = fn
      })
      // 捕获监听器注册失败，记录日志便于排查
      .catch(err => {
        logger.error('Failed to subscribe MCP server status', { error: err })
      })

    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [setServers, setLoading, setError])
}
