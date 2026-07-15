/**
 * FileChangeCard — 文件变更 diff 卡片
 *
 * 对应 prototype.html 的 `.card` + `.diff-file` + `.diff-lines`。
 * 展示单个文件的 diff 变更，包含文件路径、变更类型、增删统计和逐行 diff。
 *
 * 交互：默认折叠，点击 card-head 展开 diff 内容。
 * 底部操作按钮：忽略 + 应用到文件。
 *
 * diff 行配色：
 * - context（上下文）：text-[var(--text-dim)]
 * - add（新增）：bg-[rgba(0,229,199,0.08)] text-[var(--accent)]
 * - del（删除）：bg-[rgba(255,107,107,0.08)] text-[var(--error)]
 *
 * 参考样式：prototype.html 第 1340-1438 行
 */

import { useState } from 'react'
import { ChevronRight, FileCode, FilePlus, FileX } from 'lucide-react'
import type { FileChange, FileChangeType, DiffLine } from '@/lib/codex/types'
import { cn } from '@/lib/utils'

export interface FileChangeCardProps {
  /** 文件变更数据 */
  fileChange: FileChange
  /** 额外的 className */
  className?: string
  /** C1: 查看按钮回调（展开 diff 视图） */
  onViewDiff?: () => void
  /** C1: 应用按钮回调（应用文件变更） */
  onApply?: () => void
  /** C1: 拒绝按钮回调（拒绝文件变更） */
  onReject?: () => void
}

/** 变更类型对应的中文标签 */
const CHANGE_TYPE_LABEL: Record<FileChangeType, string> = {
  created: '新建',
  modified: '修改',
  deleted: '删除',
}

/** 变更类型对应的标签样式 */
const CHANGE_TYPE_BADGE_CLASS: Record<FileChangeType, string> = {
  created: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  modified: 'bg-[var(--info-blue)] text-[var(--accent-2)]',
  deleted: 'bg-[rgba(255,107,107,0.1)] text-[var(--error)]',
}

/** C2: 变更类型对应的左侧装饰条颜色（added=green, modified=accent, deleted=red） */
const CHANGE_TYPE_BAR_CLASS: Record<FileChangeType, string> = {
  // 新建：绿色（使用 --success 变量，对应原型 added=green 语义）
  created: 'bg-[var(--success)]',
  // 修改：accent 主色
  modified: 'bg-[var(--accent)]',
  // 删除：红色
  deleted: 'bg-[var(--error)]',
}

/** 变更类型对应的图标 */
function getChangeTypeIcon(type: FileChangeType) {
  switch (type) {
    case 'created':
      return <FilePlus className="size-3 text-[var(--accent)]" />
    case 'deleted':
      return <FileX className="size-3 text-[var(--error)]" />
    case 'modified':
    default:
      return <FileCode className="size-3 text-[var(--accent)]" />
  }
}

/** diff 行类型对应的样式类名 */
const DIFF_LINE_CLASS: Record<DiffLine['type'], string> = {
  context: 'text-[var(--text-dim)]',
  // diff 行背景透明度 0.07 — 对齐原型 .diff-line.add { background:rgba(0,229,199,0.07) }
  add: 'bg-[rgba(0,229,199,0.07)] text-[var(--accent)]',
  del: 'bg-[rgba(255,107,107,0.07)] text-[var(--error)]',
}

/** diff 行类型对应的前缀符号 */
const DIFF_LINE_PREFIX: Record<DiffLine['type'], string> = {
  context: ' ',
  add: '+',
  del: '-',
}

/**
 * 文件变更 diff 卡片组件。
 *
 * 结构：
 * - card-head：变更类型图标 + 文件路径（mono，accent 色）+ 变更类型标签 + 增删统计 + 折叠箭头
 * - diff-lines（展开时）：逐行显示行号 + 内容
 * - 底部操作按钮：忽略 + 应用到文件
 */
export function FileChangeCard({
  fileChange,
  className,
  onViewDiff,
  onApply,
  onReject,
}: FileChangeCardProps) {
  // 折叠状态：默认折叠
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div
      className={cn(
        // C2: 外层容器改为 relative，左侧增加 2px 装饰条
        // 圆角 9px — 对齐原型 .card { border-radius:9px }
        // P0 修复：外层补 hover transform + box-shadow（对齐原型 .card:hover { transform:translateX(2px); box-shadow:0 4px 16px rgba(0,0,0,0.25) }）
        //   transition 从 transition-colors 改为精确属性 + 200ms（对齐原型 0.2s）
        'relative overflow-hidden rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev)]',
        'transition-[border-color,transform,box-shadow] duration-200',
        'hover:border-[var(--border-strong)] hover:translate-x-0.5 hover:shadow-[0_4px_16px_rgba(0,0,0,0.25)]',
        className
      )}
    >
      {/* C2: 左侧 2px 彩色装饰条（颜色根据变更类型：added=green/modified=accent/deleted=red） */}
      {/* P0 修复：宽度 4px → 2px（对齐原型 .card::before { width:2px }），删除 rounded-l-[8px]（原型直角） */}
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-0.5',
          CHANGE_TYPE_BAR_CLASS[fileChange.type]
        )}
        aria-hidden="true"
      />

      {/* card-head：点击切换折叠 */}
      <button
        type="button"
        onClick={() => {
          setIsOpen(prev => !prev)
          // C1: 展开时触发查看回调（首次展开）
          if (!isOpen) onViewDiff?.()
        }}
        className={cn(
          // P0 修复：
          //   - padding-y py-1.5(6px) → py-[9px]（对齐原型 .card-head { padding:9px 12px 9px 14px }）
          //   - padding-left pl-[16px] → pl-3.5(14px)（装饰条改 2px 后让位减少）
          //   - font-size 11.5px → 12px（对齐原型 .card-head { font-size:12px }）
          //   - 加 cursor-pointer
          'flex w-full cursor-pointer items-center gap-2 pl-3.5 pr-3 py-[9px] text-left',
          'border-b border-[var(--border)] bg-[var(--bg-elev-2)]',
          'font-mono text-xs transition-colors hover:bg-[var(--bg-elev)]'
        )}
        aria-expanded={isOpen}
        aria-label="折叠/展开文件变更详情"
      >
        {/* 变更类型图标 */}
        {getChangeTypeIcon(fileChange.type)}

        {/* 文件路径（accent 色） */}
        <span className="truncate text-[var(--accent)]">{fileChange.path}</span>

        {/* 变更类型标签 */}
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-semibold',
            CHANGE_TYPE_BADGE_CLASS[fileChange.type]
          )}
        >
          {CHANGE_TYPE_LABEL[fileChange.type]}
        </span>

        {/* 增删统计（右侧自适应） */}
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
          <span className="text-[var(--accent)]">+{fileChange.additions}</span>
          <span className="text-[var(--error)]">-{fileChange.deletions}</span>
        </span>

        {/* 折叠箭头 */}
        <ChevronRight
          className={cn(
            'size-3.5 text-[var(--text-faint)] transition-transform duration-200',
            isOpen && 'rotate-90 text-[var(--accent)]'
          )}
        />
      </button>

      {/* diff 内容（展开时显示） */}
      {isOpen && (
        <>
          {/* P0 修复：line-height leading-relaxed(1.625) → leading-[1.55]（对齐原型 .diff-lines { line-height:1.55 }） */}
          <div className="overflow-x-auto py-2 font-mono text-[12px] leading-[1.55]">
            {fileChange.diff.map((line, index) => (
              <div
                key={index}
                className={cn(
                  'flex items-start px-3',
                  DIFF_LINE_CLASS[line.type]
                )}
              >
                {/* 行号区域（上下文/删除显示旧行号，新增显示新行号） */}
                <span className="w-7 shrink-0 select-none pr-3 text-right text-[var(--text-faint)]">
                  {line.newLine ?? line.oldLine ?? ''}
                </span>
                {/* 前缀符号（+/-/空格） */}
                <span className="w-4 shrink-0 select-none">
                  {DIFF_LINE_PREFIX[line.type]}
                </span>
                {/* 行内容（保留空白字符） */}
                <span className="whitespace-pre">{line.content}</span>
              </div>
            ))}
          </div>

          {/* 底部操作按钮 */}
          {/* P0 修复：justify-end → justify-start（对齐原型 .diff-actions 默认 flex-start） */}
          <div className="flex justify-start gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2.5">
            {/* C1: 忽略按钮 — 调用 onReject 回调 */}
            <button
              type="button"
              onClick={onReject}
              className={cn(
                'cursor-pointer rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1.5',
                'text-xs font-semibold text-[var(--text-dim)] transition-colors',
                'hover:border-[var(--border-strong)] hover:text-[var(--text)]'
              )}
            >
              忽略
            </button>
            {/* C1: 应用按钮 — 调用 onApply 回调 */}
            {/* P0 修复：py-1.5(6px) → py-[7px]（对齐原型 .ap-btn { padding:7px 12px }） */}
            <button
              type="button"
              onClick={onApply}
              className={cn(
                'cursor-pointer rounded-md bg-[var(--accent)] px-3 py-[7px]',
                'text-xs font-semibold text-[#001814] transition-colors',
                'hover:bg-[var(--accent-dim)]'
              )}
            >
              应用到文件
            </button>
          </div>
        </>
      )}
    </div>
  )
}
