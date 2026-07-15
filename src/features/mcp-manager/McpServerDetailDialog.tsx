/**
 * McpServerDetailDialog — MCP 服务器详情弹窗（Task 20）
 *
 * 展示服务器配置信息、已注册工具列表、已注册资源列表。
 *
 * 交互:
 * - 点击工具 → 打开 McpToolCallDialog 进行工具调用
 * - 点击资源 → 调用 readMcpResource 读取内容并内联展示
 *
 * 数据加载采用 cancelled 守卫模式，防止 StrictMode 双挂载下的
 * 异步数据写入已卸载的组件。
 *
 * @see src/lib/codex/mcp.ts — listMcpTools / listMcpResources / readMcpResource
 * @see McpToolCallDialog — 工具调用弹窗
 */

import { useState, useEffect, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { McpServer, McpTool, McpResource } from '@/lib/codex/types'
import {
  listMcpTools,
  listMcpResources,
  readMcpResource,
} from '@/lib/codex/mcp'
import { McpToolCallDialog } from './McpToolCallDialog'
import { logger } from '@/lib/logger'
import { toast } from 'sonner'

interface McpServerDetailDialogProps {
  /** 当前选中的服务器（null 时关闭弹窗） */
  server: McpServer | null
  /** 关闭弹窗回调 */
  onClose: () => void
}

/**
 * McpServerDetailDialog 组件 —— MCP 服务器详情弹窗。
 *
 * 渲染逻辑：
 *  - 由 Dialog（shadcn/ui）承载，受控于 `server !== null`
 *  - 内容分三栏：配置信息 / 工具列表 / 资源列表
 *  - 工具列表点击后嵌套打开 McpToolCallDialog
 *  - 资源列表点击后内联展示读取的内容（readMcpResource）
 *
 * 状态依赖：
 *  - 本地 useState 管理：tools / resources / loadingLists / selectedTool / resourceContent / loadingResource
 *  - 通过 props 接收 `server`（null 时关闭）和 `onClose`
 *
 * 副作用：
 *  - `server` 变化时通过 useEffect 异步加载 tools 和 resources
 *  - 关闭弹窗时重置所有本地状态
 *  - 使用 cancelled 守卫防止 StrictMode 双挂载下的数据写入已卸载组件
 *
 * 设计决策：
 *  - 工具与资源列表并发加载（Promise.all），减少等待时间
 *  - 资源内容使用 <pre> 原样展示，保留格式与换行
 *
 * @param props —— 见 McpServerDetailDialogProps 接口
 */
export function McpServerDetailDialog({
  server,
  onClose,
}: McpServerDetailDialogProps) {
  // 工具列表
  const [tools, setTools] = useState<McpTool[]>([])
  // 资源列表
  const [resources, setResources] = useState<McpResource[]>([])
  // 列表加载中
  const [loadingLists, setLoadingLists] = useState(false)
  // 当前选中的工具（打开工具调用弹窗）
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null)
  // 当前查看的资源内容
  const [resourceContent, setResourceContent] = useState<{
    uri: string
    content: string
  } | null>(null)
  // 资源加载中
  const [loadingResource, setLoadingResource] = useState(false)

  // 服务器变化时加载工具和资源列表
  // 注意: server 为 null 时不在此处重置状态，由 handleOpenChange 负责清理
  useEffect(() => {
    if (!server) return

    let cancelled = false

    // 使用 async 函数封装加载逻辑，避免在 effect 体内同步调用 setState
    const loadData = async () => {
      setLoadingLists(true)
      try {
        const [toolList, resourceList] = await Promise.all([
          listMcpTools(server.id),
          listMcpResources(server.id),
        ])
        if (cancelled) return
        setTools(toolList)
        setResources(resourceList)
      } catch (error) {
        if (cancelled) return
        // 记录失败日志并提示用户，避免错误被静默吞掉
        logger.warn('Failed to load MCP tools/resources', { serverId: server.id, error })
        setTools([])
        setResources([])
        toast.error('加载 MCP 工具/资源失败')
      } finally {
        if (!cancelled) setLoadingLists(false)
      }
    }
    void loadData()

    return () => {
      cancelled = true
    }
  }, [server])

  // 点击资源 — 读取内容
  const handleReadResource = useCallback(
    async (resource: McpResource) => {
      if (!server) return
      setLoadingResource(true)
      setResourceContent(null)
      try {
        const content = await readMcpResource(server.id, resource.uri)
        setResourceContent({ uri: resource.uri, content })
      } catch {
        setResourceContent({
          uri: resource.uri,
          content: '读取资源失败',
        })
      } finally {
        setLoadingResource(false)
      }
    },
    [server]
  )

  // 关闭弹窗时重置所有状态
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setTools([])
        setResources([])
        setSelectedTool(null)
        setResourceContent(null)
        onClose()
      }
    },
    [onClose]
  )

  return (
    <>
      <Dialog open={server !== null} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-[520px] gap-0 overflow-hidden p-0">
          {/* 标题 */}
          <DialogHeader className="border-b border-[var(--border)] px-4 py-3.5">
            <DialogTitle className="text-[14px] font-semibold text-[var(--text)]">
              MCP 服务器详情 · {server?.name ?? ''}
            </DialogTitle>
            <DialogDescription className="text-[11.5px] text-[var(--text-faint)]">
              查看服务器配置、工具与资源
            </DialogDescription>
          </DialogHeader>

          {/* 内容区域 */}
          <div className="max-h-[60vh] overflow-y-auto p-4 space-y-4">
            {/* 服务器配置信息 */}
            <div>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-faint)]">
                配置信息
              </h4>
              <div className="rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 space-y-1">
                <ConfigRow label="名称" value={server?.name ?? ''} />
                <ConfigRow label="传输方式" value={server?.transport ?? ''} />
                <ConfigRow label="命令" value={server?.command ?? '（无）'} />
                <ConfigRow label="参数" value={server?.args.join(' ') ?? ''} />
                <ConfigRow
                  label="环境变量"
                  value={
                    server && Object.keys(server.env).length > 0
                      ? Object.entries(server.env)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(' ')
                      : '（无）'
                  }
                />
              </div>
            </div>

            {/* 工具列表 */}
            <div>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-faint)]">
                工具 ({tools.length})
              </h4>
              {loadingLists ? (
                <div className="flex items-center gap-2 py-2 text-[11px] text-[var(--text-faint)]">
                  <Loader2 className="animate-spin" width={12} height={12} />
                  加载中...
                </div>
              ) : tools.length === 0 ? (
                <p className="py-2 text-[11px] text-[var(--text-faint)]">
                  暂无已注册工具
                </p>
              ) : (
                <div className="space-y-1.5">
                  {tools.map(tool => (
                    <button
                      key={tool.name}
                      type="button"
                      onClick={() => setSelectedTool(tool)}
                      className="flex w-full items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] px-2.5 py-1.5 text-left transition-colors hover:border-[var(--accent)]"
                    >
                      <span className="font-mono text-[12px] text-[var(--accent)]">
                        {tool.name}
                      </span>
                      <span className="truncate text-[11px] text-[var(--text-dim)]">
                        {tool.description}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 资源列表 */}
            <div>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-faint)]">
                资源 ({resources.length})
              </h4>
              {loadingLists ? (
                <div className="flex items-center gap-2 py-2 text-[11px] text-[var(--text-faint)]">
                  <Loader2 className="animate-spin" width={12} height={12} />
                  加载中...
                </div>
              ) : resources.length === 0 ? (
                <p className="py-2 text-[11px] text-[var(--text-faint)]">
                  暂无已注册资源
                </p>
              ) : (
                <div className="space-y-1.5">
                  {resources.map(resource => (
                    <button
                      key={resource.uri}
                      type="button"
                      onClick={() => handleReadResource(resource)}
                      className="flex w-full items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] px-2.5 py-1.5 text-left transition-colors hover:border-[var(--accent)]"
                    >
                      <span className="font-mono text-[12px] text-[var(--accent)]">
                        {resource.name}
                      </span>
                      <span className="truncate text-[11px] text-[var(--text-dim)]">
                        {resource.description}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* 资源内容展示 */}
              {loadingResource && (
                <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--text-faint)]">
                  <Loader2 className="animate-spin" width={12} height={12} />
                  读取资源中...
                </div>
              )}
              {resourceContent !== null && (
                <div className="mt-2">
                  <div className="mb-1 font-mono text-[10px] text-[var(--text-faint)]">
                    {resourceContent.uri}
                  </div>
                  <pre className="max-h-[180px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all text-[var(--text)]">
                    {resourceContent.content}
                  </pre>
                </div>
              )}
            </div>
          </div>

          {/* 底部关闭按钮 */}
          <DialogFooter className="flex-row justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-3">
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

      {/* 工具调用弹窗（嵌套） */}
      {server && (
        <McpToolCallDialog
          serverId={server.id}
          serverName={server.name}
          tool={selectedTool}
          onClose={() => setSelectedTool(null)}
        />
      )}
    </>
  )
}

/** 配置信息行 — label + value 水平排列 */
function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[11.5px]">
      <span className="w-16 shrink-0 text-[var(--text-faint)]">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-[var(--text)]">
        {value}
      </span>
    </div>
  )
}
