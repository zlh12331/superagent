/**
 * FuzzySearchDialog — 文件模糊搜索对话框
 *
 * 基于 Radix Dialog 包装（@/components/ui/dialog），实现：
 * - 顶部居中弹窗（覆盖默认居中样式）
 * - 实时搜索（输入防抖 200ms），调用 fuzzyFileSearch
 * - 结果列表：文件图标 + 文件名（高亮匹配） + 路径
 * - 键盘导航：ArrowUp/Down 切换、Enter 确认、Escape 关闭
 * - 点击结果 → onSelect(path) → onClose()
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, Hash } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { fuzzyFileSearch } from '@/lib/codex/fs'
import { useThreads } from '@/queries/threads'
import { useThreadStore } from '@/store/thread-store'
import { cn } from '@/lib/utils'
import type { FuzzySearchResult } from './types'
import { FileIcon } from './FileIcon'

interface FuzzySearchDialogProps {
  /** 是否打开 */
  open: boolean
  /** 关闭回调 */
  onClose: () => void
  /** 选中某文件路径回调 */
  onSelect: (path: string) => void
}

/**
 * 统一搜索结果项 — 会话或文件。
 *
 * H1 修复：FuzzySearchDialog 除搜索文件外，还支持搜索会话（thread）。
 * 会话匹配显示在文件匹配上方，键盘导航在统一列表中连续索引。
 */
type UnifiedResult =
  | { type: 'session'; threadId: string; title: string; cwd: string | null }
  | { type: 'file'; path: string; title: string }

/** 防抖延迟（毫秒） */
const DEBOUNCE_MS = 200

/**
 * 高亮匹配子串：将 title 按 query 切分，匹配部分用 <mark> 标记。
 * 仅做大小写不敏感的 includes 匹配（与 fuzzyFileSearch 内部一致）。
 */
function highlightMatch(title: string, query: string): React.ReactNode {
  const q = query.trim()
  if (q.length === 0) return title
  const lower = title.toLowerCase()
  const ql = q.toLowerCase()
  const idx = lower.indexOf(ql)
  if (idx < 0) return title

  return (
    <>
      {title.slice(0, idx)}
      <mark className="rounded bg-[rgba(0,255,136,0.2)] px-0.5 text-[var(--accent)]">
        {title.slice(idx, idx + q.length)}
      </mark>
      {title.slice(idx + q.length)}
    </>
  )
}

/** 从完整路径中提取目录部分（不含文件名） */
function extractDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash >= 0 ? path.slice(0, slash) : ''
}

export function FuzzySearchDialog({
  open,
  onClose,
  onSelect,
}: FuzzySearchDialogProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FuzzySearchResult[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // H1: 会话搜索 — 从 useThreads 获取线程列表，按 query 过滤标题匹配的会话
  const { data: threads = [] } = useThreads()
  const setActiveThread = useThreadStore(state => state.setActiveThread)

  // 会话匹配结果 — query 匹配线程标题时显示，最多 5 条
  const sessionResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    return threads
      .filter(t => t.title.toLowerCase().includes(q))
      .slice(0, 5)
      .map(t => ({
        type: 'session' as const,
        threadId: t.id,
        title: t.title,
        cwd: t.cwd,
      }))
  }, [threads, query])

  // 统一结果列表 — 会话在上、文件在下，用于键盘导航的连续索引
  const combinedResults = useMemo<UnifiedResult[]>(() => {
    const files = results.map(f => ({
      type: 'file' as const,
      path: f.path,
      title: f.title,
    }))
    return [...sessionResults, ...files]
  }, [sessionResults, results])

  // 重置状态：每次打开对话框时清空 query / results。
  // 通过 rAF 延迟 setState，避免 effect 体内同步调用 setState 触发级联渲染
  // （react-hooks/set-state-in-effect 规则）。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const handle = requestAnimationFrame(() => {
      if (cancelled) return
      setQuery('')
      setResults([])
      setSelectedIndex(0)
      inputRef.current?.focus()
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(handle)
    }
  }, [open])

  // 防抖搜索：query 变化时延迟 DEBOUNCE_MS 调用 fuzzyFileSearch
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const handle = setTimeout(() => {
      const q = query.trim()
      if (q.length === 0) {
        setResults([])
        setSelectedIndex(0)
        return
      }
      fuzzyFileSearch(q)
        .then(data => {
          if (!cancelled) {
            setResults(data)
            setSelectedIndex(0)
          }
        })
        .catch(err => {
          if (!cancelled) {
            // 保留 console.error 用于开发调试，同时用 toast 给用户即时反馈
            console.error('Fuzzy search failed:', err)
            toast.error('模糊搜索失败')
            setResults([])
          }
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [query, open])

  // 选中项变化时自动滚动到可见区域
  // H1: 使用 combinedResults.length（含会话+文件），保证键盘导航在统一列表中正确滚动
  useEffect(() => {
    if (!open || combinedResults.length === 0) return
    const list = listRef.current
    if (!list) return
    const item = list.children[selectedIndex]
    if (item instanceof HTMLElement) {
      item.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex, combinedResults.length, open])

  // H1: 确认选择时区分会话/文件 — 会话调用 setActiveThread 切换线程，文件调用 onSelect
  const handleConfirm = useCallback(() => {
    const item = combinedResults[selectedIndex]
    if (!item) return
    if (item.type === 'session') {
      setActiveThread(item.threadId)
    } else {
      onSelect(item.path)
    }
    onClose()
  }, [combinedResults, selectedIndex, onSelect, setActiveThread, onClose])

  // H1: 键盘导航边界使用 combinedResults.length（会话+文件统一索引）
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i =>
          Math.min(i + 1, Math.max(combinedResults.length - 1, 0))
        )
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleConfirm()
      }
    },
    [combinedResults.length, handleConfirm]
  )

  // 防御性：selectedIndex 不能超出 combinedResults 范围（含会话+文件）
  const safeSelectedIndex = useMemo(
    () =>
      combinedResults.length === 0
        ? 0
        : Math.min(selectedIndex, combinedResults.length - 1),
    [selectedIndex, combinedResults.length]
  )

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        if (!o) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-[20vh] translate-y-0 left-[50%] translate-x-[-50%] w-[90vw] max-w-[560px] gap-0 rounded-[10px] border border-[var(--border)] bg-[var(--bg-elev)] p-0 shadow-[0_16px_48px_rgba(0,0,0,0.5)]"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>文件搜索</DialogTitle>
        </DialogHeader>

        {/* 输入框 */}
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <Search
            width={14}
            height={14}
            className="shrink-0 text-[var(--text-faint)]"
            aria-hidden
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索文件或会话…"
            aria-label="搜索文件或会话"
            aria-autocomplete="list"
            aria-controls="fuzzy-search-results"
            aria-activedescendant={
              combinedResults.length > 0
                ? `fuzzy-result-${safeSelectedIndex}`
                : undefined
            }
            className="flex-1 border-none bg-transparent text-[14px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
          />
        </div>

        {/* 结果列表 */}
        <div
          id="fuzzy-search-results"
          ref={listRef}
          role="listbox"
          className="max-h-[400px] overflow-y-auto p-1.5"
        >
          {query.trim().length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-[var(--text-faint)]">
              输入关键词搜索文件或会话
            </div>
          ) : combinedResults.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-[var(--text-faint)]">
              未找到匹配的文件或会话
            </div>
          ) : (
            /*
             * H1: 统一渲染会话+文件结果。
             * combinedResults 中会话在前、文件在后，通过 type 字段区分渲染：
             *  - session: Hash 图标 + 标题高亮 + cwd 路径
             *  - file:    FileIcon + 标题高亮 + 目录路径
             * 键盘导航使用统一索引 i（与会话/文件顺序一致），保证 ArrowUp/Down 连续切换。
             */
            combinedResults.map((item, i) => {
              // 选中态样式：左侧 accent 竖线 + 浅色背景
              const selectedCls =
                i === safeSelectedIndex
                  ? 'border-l-2 border-[var(--accent)] bg-[var(--bg-elev-2)]'
                  : 'border-l-2 border-transparent'
              // 公共 className — 所有结果项共用
              const baseCls =
                'flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-left cursor-pointer transition-colors'

              // 会话结果 — Hash 图标，点击切换到该线程
              if (item.type === 'session') {
                return (
                  <button
                    key={`session-${item.threadId}`}
                    id={`fuzzy-result-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === safeSelectedIndex}
                    onClick={() => {
                      setActiveThread(item.threadId)
                      onClose()
                    }}
                    onMouseEnter={() => setSelectedIndex(i)}
                    className={cn(baseCls, selectedCls)}
                  >
                    <Hash
                      className="size-3.5 shrink-0 text-[var(--text-faint)]"
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] text-[var(--text)]">
                        {highlightMatch(item.title, query)}
                      </div>
                      {item.cwd && (
                        <div className="truncate text-[10.5px] text-[var(--text-faint)]">
                          {item.cwd}
                        </div>
                      )}
                    </div>
                  </button>
                )
              }

              // 文件结果 — FileIcon，点击调用 onSelect(path)
              const dir = extractDir(item.path)
              return (
                <button
                  key={`file-${item.path}`}
                  id={`fuzzy-result-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === safeSelectedIndex}
                  onClick={() => {
                    onSelect(item.path)
                    onClose()
                  }}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={cn(baseCls, selectedCls)}
                >
                  <FileIcon name={item.title} isFolder={false} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px] text-[var(--text)]">
                      {highlightMatch(item.title, query)}
                    </div>
                    {dir && (
                      <div className="truncate text-[10.5px] text-[var(--text-faint)]">
                        {dir}
                      </div>
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
