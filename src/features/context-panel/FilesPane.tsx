/**
 * FilesPane — 文件预览面板（files tab）
 *
 * 对应 prototype.html `#crpPaneFiles`。
 * 选中文件时显示文件内容预览，未选中时显示空状态提示。
 *
 * 数据来源：file-tree-store 的 selectedPath（由 FileTree 点击文件时设置）。
 * 文件内容通过 readFile API 异步加载。
 *
 * 参考样式: prototype.html `.file-preview`, `.file-preview-head`,
 *           `.file-preview-body`, `.crp-empty`
 */

import { useEffect, useState } from 'react'
import { FileQuestion, Loader2, X } from 'lucide-react'
import { useFileTreeStore } from '@/features/file-tree/file-tree-store'
import { readFile } from '@/lib/codex/fs'
import { logger } from '@/lib/logger'
import type { ThreadId } from '@/lib/codex/types'

/** FilesPane 组件 props */
export interface FilesPaneProps {
  /** 当前活跃线程 ID（由 ContextPanel 透传，当前 FilesPane 不直接使用） */
  activeThreadId: ThreadId | null
}

/**
 * 文件预览面板组件
 *
 * 从 file-tree-store 订阅 selectedPath，当用户在文件树中点击文件时，
 * 自动加载并显示文件内容。
 *
 * 状态管理：
 *  - selectedPath 来自 file-tree-store（跨组件共享）
 *  - fileContent / loading / error 为本地 useState（异步加载状态）
 *
 * 关闭预览时调用 setSelectedPath(null) 清除文件树的选中状态，
 * 确保文件树与预览面板的状态同步。
 */
export function FilesPane({ activeThreadId: _activeThreadId }: FilesPaneProps) {
  // 从 file-tree-store 订阅选中文件路径
  const selectedPath = useFileTreeStore(s => s.selectedPath)
  const setSelectedPath = useFileTreeStore(s => s.setSelectedPath)

  // 文件内容与加载状态
  const [fileContent, setFileContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 当 selectedPath 变化时，异步加载文件内容
  useEffect(() => {
    // 无选中路径时清空状态
    if (!selectedPath) {
      setFileContent('')
      setError(null)
      setLoading(false)
      return
    }

    // 开始加载
    setLoading(true)
    void (async () => {
      try {
        const content = await readFile(selectedPath)
        setFileContent(content)
        setError(null)
      } catch (err) {
        logger.error('Failed to read file for preview', {
          path: selectedPath,
          error: err,
        })
        setError(err instanceof Error ? err.message : '读取文件失败')
      } finally {
        setLoading(false)
      }
    })()
  }, [selectedPath])

  // 空状态：未选中文件
  if (!selectedPath) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <FileQuestion size={32} className="text-[var(--text-faint)] opacity-50" />
        <div className="font-mono text-xs text-[var(--text-faint)]">
          未选中文件
        </div>
        <div className="text-[11px] text-[var(--text-faint)]">
          点击左侧文件树中的文件以预览
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 预览头：文件路径 + 关闭按钮 */}
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2 font-mono text-[11px] text-[var(--text-dim)]">
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          {selectedPath}
        </span>
        <button
          type="button"
          title="关闭预览"
          onClick={() => setSelectedPath(null)}
          className="flex-shrink-0 rounded-[3px] px-1.5 py-0.5 text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]"
        >
          <X size={14} />
        </button>
      </div>

      {/* 预览体：加载中 / 错误 / 文件内容 */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[var(--text-faint)]">
          <Loader2 size={16} className="animate-spin" />
          <span className="font-mono text-xs">加载中…</span>
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <span className="font-mono text-xs text-[var(--error)]">{error}</span>
        </div>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto bg-[var(--bg)] px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] text-[var(--text)] whitespace-pre">
          {fileContent}
        </pre>
      )}
    </div>
  )
}
