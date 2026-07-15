/**
 * FileTree — 文件树侧栏视图
 *
 * 包含：
 * - 头部：返回按钮（切回会话视图）+ 标题 + 刷新 + 搜索
 * - 主体：递归渲染文件树节点
 * - 右键菜单：通过 store 共享状态，由本组件渲染
 * - 模糊搜索对话框：本地状态控制开关
 *
 * 状态管理分层：
 * - 服务端数据（文件树）通过 TanStack Query 管理（useFileTree hook）
 * - 纯 UI 状态（展开路径、选中项、右键菜单）通过 Zustand 管理
 *
 * 生命周期：
 * - mount 时 TanStack Query 自动加载文件树
 * - mount 时注册 fs/watch 监听器，事件触发 invalidateFileTree 自动刷新
 * - unmount 时取消监听
 */

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import {
  onFsWatch,
  removePath,
  renamePath,
  type FsWatchEvent,
} from '@/lib/codex/fs'
import { useFileTree, invalidateFileTree } from '@/queries/file-tree'
import { CONTEXT_PANEL_SWITCH_TAB_EVENT } from '@/features/context-panel'
import { isTauri } from '@/lib/env'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'
// 命令式确认/输入对话框 — 对齐原型 showConfirmDialog / showPromptDialog
import { confirm, prompt } from '@/features/dialog'
import { useFileTreeStore } from './file-tree-store'
import type { FileTreeNode as FileTreeNodeType } from './types'
import { FileTreeNode } from './FileTreeNode'
import { FileTreeContextMenu } from './FileTreeContextMenu'
import { FuzzySearchDialog } from './FuzzySearchDialog'

export function FileTree() {
  const queryClient = useQueryClient()

  // ---- 服务端数据（TanStack Query）----
  // useFileTree 自动管理 loading、缓存、重试、stale-while-revalidate、错误提示
  const { data: tree, isLoading: loading } = useFileTree()

  // ---- 纯 UI 状态（Zustand）----
  const expandedPaths = useFileTreeStore(s => s.expandedPaths)
  const selectedPath = useFileTreeStore(s => s.selectedPath)
  const contextMenu = useFileTreeStore(s => s.contextMenu)
  const rootAutoExpanded = useFileTreeStore(s => s.rootAutoExpanded)

  // 操作方法
  const toggleExpand = useFileTreeStore(s => s.toggleExpand)
  const setExpanded = useFileTreeStore(s => s.setExpanded)
  const setSelectedPath = useFileTreeStore(s => s.setSelectedPath)
  const setSidebarView = useFileTreeStore(s => s.setSidebarView)
  const setContextMenu = useFileTreeStore(s => s.setContextMenu)
  const setRootAutoExpanded = useFileTreeStore(s => s.setRootAutoExpanded)

  const [fuzzyOpen, setFuzzyOpen] = useState(false)

  // 监听 fs/watch 事件，自动刷新（失效缓存，TanStack Query 自动重新拉取）
  useEffect(() => {
    // 浏览器模式无需监听 Tauri 事件
    if (!isTauri()) return

    let isMounted = true
    let unlisten: (() => void) | null = null
    // 防抖定时器 — 批量文件变更（如 git checkout / npm install）会产生
    // 数十到数百个 fs/watch 事件，每个都触发 invalidateFileTree 会导致
    // 前端雪崩。用 300ms 防抖累积事件后统一 invalidate 一次。
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    onFsWatch((_event: FsWatchEvent) => {
      // 防抖：300ms 内多次事件只触发一次 invalidate
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        invalidateFileTree(queryClient)
      }, 300)
    })
      .then(fn => {
        if (!isMounted) {
          // 组件已卸载，立即取消订阅
          fn()
        } else {
          unlisten = fn
        }
      })
      .catch(error => {
        logger.error('Failed to subscribe fs/watch', { error })
      })

    return () => {
      isMounted = false
      if (debounceTimer) clearTimeout(debounceTimer)
      if (unlisten) unlisten()
    }
  }, [queryClient])

  // G1: 文件树首次加载后自动展开根目录。
  // 初次进入文件树视图时，根目录路径未知（需等待 useFileTree 返回数据），
  // 因此不能在 store 初始值中预设 expandedPaths。此 effect 在数据到达后
  // 自动展开根节点，并通过 rootAutoExpanded 标志防止每次刷新都重复展开。
  useEffect(() => {
    if (tree && !rootAutoExpanded) {
      setExpanded(tree.path, true)
      setRootAutoExpanded(true)
    }
  }, [tree, rootAutoExpanded, setExpanded, setRootAutoExpanded])

  const handleBack = useCallback(() => {
    setSidebarView('threads')
  }, [setSidebarView])

  // 刷新按钮：失效缓存触发重新拉取，TanStack Query 自动管理 loading 状态
  const handleRefresh = useCallback(() => {
    invalidateFileTree(queryClient)
    toast.success('文件树已刷新')
  }, [queryClient])

  const handleSelect = useCallback(
    (node: FileTreeNodeType) => {
      setSelectedPath(node.path)
      // F1: 点击文件时派发事件，通知 ContextPanel 切到 info tab（会话详情）。
      // 点击文件夹不切 tab（仅展开/折叠，由 handleToggle 处理）。
      if (node.type === 'file') {
        window.dispatchEvent(
          new CustomEvent(CONTEXT_PANEL_SWITCH_TAB_EVENT)
        )
      }
    },
    [setSelectedPath]
  )

  const handleToggle = useCallback(
    (node: FileTreeNodeType) => {
      if (node.type === 'folder') {
        toggleExpand(node.path)
      }
    },
    [toggleExpand]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: FileTreeNodeType) => {
      e.preventDefault()
      e.stopPropagation()
      setContextMenu({
        position: { x: e.clientX, y: e.clientY },
        nodePath: node.path,
        nodeType: node.type,
      })
    },
    [setContextMenu]
  )

  const handleContextAction = useCallback(
    async (action: string) => {
      // 从 contextMenu 状态读取目标节点信息（菜单打开时由 handleContextMenu 写入）
      const nodePath = contextMenu?.nodePath ?? ''
      const nodeType = contextMenu?.nodeType ?? 'file'
      const nodeName = nodePath.split('/').pop() ?? nodePath

      switch (action) {
        case 'open': {
          // F2: 在编辑器（FilesPane）中打开 —— 选中文件 + 切到 files tab
          // 文件夹则展开（不切 tab）
          if (nodeType === 'folder') {
            setExpanded(nodePath, true)
          } else {
            setSelectedPath(nodePath)
            window.dispatchEvent(
              new CustomEvent(CONTEXT_PANEL_SWITCH_TAB_EVENT, {
                detail: { tab: 'files' },
              })
            )
          }
          break
        }
        case 'newFile':
          // 新建文件/文件夹功能依赖文件创建 API，暂未接入
          toast.info('新建文件功能开发中')
          break
        case 'newFolder':
          toast.info('新建文件夹功能开发中')
          break
        case 'rename': {
          // F2: 重命名 —— 使用命令式 prompt 获取新名称（对齐原型 showPromptDialog）
          const newName = await prompt({
            title: '重命名',
            label: '新名称',
            defaultValue: nodeName,
            confirmText: '确认',
          })
          if (newName && newName !== nodeName) {
            const parent = nodePath.split('/').slice(0, -1).join('/')
            const newPath = parent ? `${parent}/${newName}` : newName
            void renamePath(nodePath, newPath)
              .then(() => {
                toast.success('重命名成功')
                invalidateFileTree(queryClient)
              })
              .catch(() => toast.error('重命名失败'))
          }
          break
        }
        case 'copy': {
          // F2: 复制路径到剪贴板
          void navigator.clipboard
            .writeText(nodePath)
            .then(() => toast.success('已复制路径'))
            .catch(() => toast.error('复制失败'))
          break
        }
        case 'paste':
          toast.info('粘贴功能开发中')
          break
        case 'delete': {
          // F2: 删除 —— 破坏性操作需用户二次确认
          // 使用命令式 confirm（对齐原型 showConfirmDialog），替代 window.confirm
          const confirmed = await confirm({
            title: '删除文件',
            message: `确定要删除 ${nodeName} 吗？此操作不可撤销。`,
            confirmText: '确认删除',
            danger: true,
          })
          if (confirmed) {
            void removePath(nodePath, nodeType === 'folder')
              .then(() => {
                toast.success('删除成功')
                invalidateFileTree(queryClient)
                // 删除当前选中项时清除选中状态
                if (selectedPath === nodePath) {
                  setSelectedPath(null)
                }
              })
              .catch(() => toast.error('删除失败'))
          }
          break
        }
        case 'refresh':
          handleRefresh()
          break
        default:
          break
      }
    },
    [
      contextMenu,
      selectedPath,
      setSelectedPath,
      setExpanded,
      handleRefresh,
      queryClient,
    ]
  )

  const handleFuzzySelect = useCallback(
    (path: string) => {
      setSelectedPath(path)
      toast.success(`已选择: ${path}`)
    },
    [setSelectedPath]
  )

  /**
   * 递归渲染节点
   * 仅当文件夹处于展开状态时才渲染其 children
   * 使用 useCallback 保持引用稳定，配合 FileTreeNode 的 memo 避免不必要的重渲染
   */
  const renderNode = useCallback(
    (node: FileTreeNodeType, level: number): React.ReactNode => {
      const isActive = selectedPath === node.path
      const isExpanded = expandedPaths.has(node.path)
      return (
        <div key={node.path}>
          <FileTreeNode
            node={node}
            level={level}
            isActive={isActive}
            isExpanded={isExpanded}
            onSelect={handleSelect}
            onToggle={handleToggle}
            onContextMenu={handleContextMenu}
          />
          {node.type === 'folder' &&
            isExpanded &&
            node.children &&
            node.children.length > 0 && (
              <div>
                {node.children.map(child => renderNode(child, level + 1))}
              </div>
            )}
        </div>
      )
    },
    [selectedPath, expandedPaths, handleSelect, handleToggle, handleContextMenu]
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 头部：返回 + 标题 + 操作按钮 */}
      <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-2">
        <button
          type="button"
          onClick={handleBack}
          title="返回会话"
          aria-label="返回会话"
          className="flex h-[22px] w-[22px] items-center justify-center rounded text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]"
        >
          <ArrowLeft width={14} height={14} />
        </button>
        <span className="flex-1 truncate font-mono text-[11px] uppercase tracking-[0.05em] text-[var(--text-dim)]">
          文件目录
        </span>
        <button
          type="button"
          onClick={() => setFuzzyOpen(true)}
          title="搜索文件"
          aria-label="搜索文件"
          className="flex h-[22px] w-[22px] items-center justify-center rounded text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]"
        >
          <Search width={13} height={13} />
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          title="刷新"
          aria-label="刷新文件树"
          disabled={loading}
          className={cn(
            'flex h-[22px] w-[22px] items-center justify-center rounded text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]',
            loading && 'animate-spin'
          )}
        >
          <RefreshCw width={13} height={13} />
        </button>
      </div>

      {/* 主体：递归渲染文件树 */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1">
        {tree ? (
          renderNode(tree, 0)
        ) : (
          <div className="px-4 py-8 text-center text-[12px] leading-[1.6] text-[var(--text-faint)]">
            {loading ? '加载中…' : '暂无文件'}
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <FileTreeContextMenu
          position={contextMenu.position}
          nodeType={contextMenu.nodeType}
          onAction={handleContextAction}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 模糊搜索对话框 */}
      <FuzzySearchDialog
        open={fuzzyOpen}
        onClose={() => setFuzzyOpen(false)}
        onSelect={handleFuzzySelect}
      />
    </div>
  )
}
