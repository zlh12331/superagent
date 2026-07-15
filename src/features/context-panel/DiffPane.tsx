/**
 * DiffPane — 文件变更面板（diff tab）
 *
 * 对应 prototype.html `#crpPaneDiff`。
 * 展示本轮会话产生的文件变更，以 diff 形式逐文件呈现。
 *
 * 数据来源：conversation-store 的 turnDiffsByThread（patch 审批追踪）。
 *
 * 参考样式: prototype.html `.crp-diff-files`, `.diff-file-item`,
 *           `.diff-file-head`, `.diff-file-body`, `.diff-add`, `.diff-del`
 */

import { FileDiff } from 'lucide-react'
import { useConversationStore, type TurnDiff } from '@/features/conversation/conversation-store'
import type { ThreadId } from '@/lib/codex/types'
import { cn } from '@/lib/utils'

/** diff 行类型：add=新增 / del=删除 / context=上下文（无变化） */
type DiffLineType = 'add' | 'del' | 'context'

/** 单行 diff 内容 */
export interface DiffLine {
  type: DiffLineType
  text: string
}

/** 单个文件的 diff 信息 */
export interface DiffFile {
  id: string
  /** 文件路径（用于显示） */
  fileName: string
  /** 新增行数 */
  additions: number
  /** 删除行数 */
  deletions: number
  /** diff 行列表 */
  lines: DiffLine[]
}

/** DiffPane 组件 props */
export interface DiffPaneProps {
  /** 当前活跃线程 ID；null 表示无活跃线程（显示空状态） */
  activeThreadId: ThreadId | null
}

// 模块级常量：避免在 Zustand selector 中每次返回新的 [] 引用，导致无限重渲染。
const EMPTY_TURN_DIFFS: TurnDiff[] = []

/**
 * 将 conversation-store 的 TurnDiff.lines 类型（'ctx' | 'add' | 'del'）
 * 映射为 DiffPane 内部的 DiffLine 类型（'context' | 'add' | 'del'）。
 */
function mapDiffLines(
  lines: TurnDiff['lines']
): DiffLine[] {
  if (!lines) return []
  return lines.map(line => ({
    // 'ctx' → 'context'，'add'/'del' 保持不变
    type: line.type === 'ctx' ? 'context' : line.type,
    text: line.text,
  }))
}

/**
 * 将 conversation-store 的 TurnDiff 转换为 DiffPane 内部的 DiffFile 格式。
 * 使用文件路径作为唯一标识（同一轮次中同一文件不应出现两次）。
 */
function mapTurnDiff(diff: TurnDiff, index: number): DiffFile {
  return {
    id: `diff-${index}-${diff.path}`,
    fileName: diff.path,
    additions: diff.additions,
    deletions: diff.deletions,
    lines: mapDiffLines(diff.lines),
  }
}

/**
 * 文件变更面板组件
 *
 * 从 conversation-store 获取当前线程本轮的文件变更 diff 列表，
 * 汇总增删行数，并逐文件展示 diff 内容。
 * 新增行使用主色高亮，删除行使用红色高亮。
 *
 * 如果无活跃线程或无 diff 数据，显示空状态。
 */
export function DiffPane({ activeThreadId }: DiffPaneProps) {
  // 从 conversation-store 获取当前线程本轮的文件变更列表
  const turnDiffs = useConversationStore(s =>
    activeThreadId
      ? (s.turnDiffsByThread[activeThreadId] ?? EMPTY_TURN_DIFFS)
      : EMPTY_TURN_DIFFS
  )

  // 将 TurnDiff[] 转换为 DiffFile[] 格式
  const diffFiles: DiffFile[] = turnDiffs.map(mapTurnDiff)

  // 汇总本轮变更统计
  const totalAdditions = diffFiles.reduce((sum, f) => sum + f.additions, 0)
  const totalDeletions = diffFiles.reduce((sum, f) => sum + f.deletions, 0)

  // 空状态：无活跃线程或无 diff 数据
  if (!activeThreadId || diffFiles.length === 0) {
    const message = !activeThreadId ? '未选中会话' : '暂无文件变更'
    const hint = !activeThreadId
      ? '从左侧选择一个会话以查看变更'
      : '本轮会话暂无文件变更记录'
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <FileDiff size={32} className="text-[var(--text-faint)] opacity-50" />
        <div className="font-mono text-xs text-[var(--text-faint)]">
          {message}
        </div>
        <div className="text-[11px] text-[var(--text-faint)]">
          {hint}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <section className="flex-1 overflow-auto px-4 py-3.5">
        {/* 标题行 + 统计信息 */}
        <h3 className="mb-2.5 flex items-center font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
          <span>本轮文件变更</span>
          <span className="ml-auto text-[10px] text-[var(--text-faint)]">
            {diffFiles.length} 文件 ·{' '}
            <span className="text-[var(--accent)]">+{totalAdditions}</span>{' '}
            <span className="text-[var(--error)]">-{totalDeletions}</span>
          </span>
        </h3>

        {/* diff 文件列表 */}
        <div className="flex flex-col gap-2.5">
          {diffFiles.map(file => (
            <div
              key={file.id}
              className="overflow-hidden rounded-md border border-[var(--border)]"
            >
              {/* 文件头：路径 + 增删统计 */}
              <div className="flex items-center gap-1.5 bg-[var(--bg-elev-2)] px-2.5 py-1.5 font-mono text-[11px]">
                <span className="flex-1 truncate text-[var(--text)]">
                  {file.fileName}
                </span>
                <span className="text-[10px] text-[var(--text-faint)]">
                  <span className="text-[var(--accent)]">+{file.additions}</span>{' '}
                  <span className="text-[var(--error)]">-{file.deletions}</span>
                </span>
              </div>

              {/* diff 内容体：等宽字体，保留空白符 */}
              <pre className="overflow-x-auto whitespace-pre px-2.5 py-2 font-mono text-[10.5px] leading-[1.5]">
                {file.lines.map((line, idx) => (
                  <span
                    key={idx}
                    className={cn(
                      'block',
                      line.type === 'add' &&
                        'bg-[var(--info-blue)] text-[var(--accent)]',
                      line.type === 'del' &&
                        'bg-[rgba(255,99,99,0.06)] text-[var(--error)]'
                    )}
                  >
                    {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                    {line.text}
                  </span>
                ))}
              </pre>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
