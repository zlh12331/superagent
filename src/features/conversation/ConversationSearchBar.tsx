/**
 * ConversationSearchBar — 对话内搜索栏
 *
 * 对应 prototype.html 的 `.conv-search-bar`（第 1108-1114 行）。
 *
 * 功能职责：
 *   1. 搜索输入框：实时输入查询关键词（受控组件，查询文本由父组件管理）
 *   2. ↑↓ 导航按钮：在匹配项之间跳转（由父组件控制当前匹配项索引）
 *   3. 匹配计数显示：当前匹配序号 / 总匹配数
 *   4. 关闭按钮：隐藏搜索栏并清除搜索状态
 *
 * 设计要点（I-G-011 + I-G-012）：
 *   - 受控组件：所有状态（query、currentMatch、totalMatches）由父组件
 *     ConversationArea 持有，本组件仅负责 UI 展示与事件转发。
 *     这样父组件可在搜索栏隐藏时统一清除高亮，避免消息列表残留标记。
 *   - 键盘导航（I-G-012）：
 *       Enter      → 跳到下一个匹配项（dir=1）
 *       Shift+Enter→ 跳到上一个匹配项（dir=-1）
 *       Escape    → 关闭搜索栏
 *   - visible 为 false 时返回 null，不参与渲染。
 *
 * 样式参考：prototype.html 的 `.conv-search-bar`（固定在对话区右上角，
 * 半透明背景 + 边框，紧凑布局：图标 + 输入框 + 计数 + 导航按钮 + 关闭按钮）。
 */

// P0 修复：移除 Search 图标导入（原型 .conv-search-bar 无搜索图标，仅 input + 计数 + 按钮）
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ConversationSearchBarProps {
  /** 是否显示搜索栏（false 时返回 null，不渲染） */
  visible: boolean
  /** 当前查询文本（受控，由父组件管理） */
  query: string
  /** 匹配总数（0 表示无匹配或无查询） */
  totalMatches: number
  /** 当前匹配序号（1-based，0 表示无匹配） */
  currentMatch: number
  /** 查询文本变化回调（父组件执行搜索并更新匹配结果） */
  onSearch: (query: string) => void
  /** 导航回调：1=下一个，-1=上一个（循环切换） */
  onNavigate: (dir: 1 | -1) => void
  /** 关闭搜索栏回调（父组件隐藏搜索栏并清除搜索状态） */
  onClose: () => void
}

/**
 * 对话内搜索栏组件。
 *
 * 受控组件模式：父组件 ConversationArea 持有所有搜索状态
 * （query / searchResults / currentMatchIdx），本组件仅负责：
 *   - 渲染搜索输入框并将 onChange 转发给 onSearch
 *   - 渲染↑↓按钮并将点击转发给 onNavigate
 *   - 渲染匹配计数（currentMatch / totalMatches）
 *   - 渲染关闭按钮并将点击转发给 onClose
 *
 * 键盘导航（I-G-012）在 handleKeyDown 中实现：
 *   - Enter：下一个匹配（Shift+Enter：上一个匹配）
 *   - Escape：关闭搜索栏
 */
export function ConversationSearchBar({
  visible,
  query,
  totalMatches,
  currentMatch,
  onSearch,
  onNavigate,
  onClose,
}: ConversationSearchBarProps) {
  // visible 为 false 时不渲染（避免占用布局空间）
  if (!visible) return null

  // 是否有查询文本（用于禁用导航按钮 + 显示计数格式）
  const hasQuery = query.trim() !== ''
  // 是否有匹配结果（用于禁用导航按钮）
  const hasMatches = totalMatches > 0

  // 上一个匹配按钮回调
  const handlePrev = () => onNavigate(-1)
  // 下一个匹配按钮回调
  const handleNext = () => onNavigate(1)

  // I-G-012: 键盘导航
  // Enter → 下一个匹配；Shift+Enter → 上一个匹配；Escape → 关闭
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      // Shift 按下时上一个，否则下一个
      onNavigate(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className={cn(
        // P0 修复（对齐原型 .conv-search-bar）：
        //   - gap 8px → 6px（gap-1.5）
        //   - padding 8px 12px → 6px 12px（py-1.5 px-3）
        //   - 背景 bg-elev-2 → bg-elev（原型 background:var(--bg-elev)）
        //   - 移除 shadow（原型无 box-shadow）
        'flex items-center gap-1.5 px-3 py-1.5',
        'border-b border-[var(--border)] bg-[var(--bg-elev)]'
      )}
      role="search"
      aria-label="对话内搜索"
    >
      {/* P0 修复：移除搜索图标（原型 .conv-search-bar 结构中无搜索图标） */}

      {/* 搜索输入框（受控，value 由父组件管理） */}
      <input
        type="text"
        id="conv-search-input"
        value={query}
        onChange={e => onSearch(e.target.value)}
        onKeyDown={handleKeyDown}
        // P0 修复：placeholder 对齐原型 "在对话中搜索…"
        placeholder="在对话中搜索…"
        autoComplete="off"
        spellCheck={false}
        // 自动聚焦：搜索栏出现时立即可输入
        autoFocus
        aria-label="搜索关键词"
        className={cn(
          // 布局：占据剩余空间
          'flex-1 min-w-0',
          // P0 修复（对齐原型 .conv-search-bar input）：
          //   - 背景 bg-elev-2 → bg（原型 background:var(--bg)）
          //   - font-size 14px → 12px（text-xs）
          //   - border-radius 6px → 4px（rounded-[4px]）
          'border border-[var(--border)] bg-[var(--bg)] rounded-[4px] px-2 py-1',
          // 文本样式
          'text-xs text-[var(--text)] placeholder:text-[var(--text-faint)]',
          // P0 修复：focus 边框 accent-dim → accent（原型 input:focus { border-color:var(--accent) }）
          'outline-none focus:outline-none focus:border-[var(--accent)]'
        )}
      />

      {/* 匹配计数（仅在有查询时显示） */}
      {hasQuery && (
        <span
          className={cn(
            // P0 修复（对齐原型 .cs-count）：
            //   - font-size 12px → 11px（text-[11px]）
            //   - 补 font-mono（原型 font-family:var(--mono)）
            //   - 颜色统一 text-faint（原型 color:var(--text-faint)，不区分有无匹配）
            'flex-shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-[var(--text-faint)]'
          )}
          aria-live="polite"
        >
          {/* 无匹配时显示 "0/0"，有匹配时显示 "当前/总数" */}
          {hasMatches ? `${currentMatch}/${totalMatches}` : '0/0'}
        </span>
      )}

      {/* 上一个匹配按钮（↑） */}
      <button
        type="button"
        onClick={handlePrev}
        disabled={!hasMatches}
        aria-label="上一个匹配"
        title="上一个 (⇧⏎)"
        className={cn(
          // P0 修复（对齐原型 .cs-btn）：
          //   - size-6(24px方形) → px-1.5 py-[3px]（原型 padding:3px 6px）
          //   - rounded(4px) → rounded-[3px]（原型 border-radius:3px）
          //   - 补 cursor-pointer（原型 cursor:pointer）
          //   - 颜色 text-dim → text-faint（原型 color:var(--text-faint)）
          'flex flex-shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none px-1.5 py-[3px] transition-colors',
          hasMatches
            ? 'text-[var(--text-faint)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]'
            : 'cursor-not-allowed text-[var(--text-faint)] opacity-50'
        )}
      >
        <ChevronUp className="size-3" />
      </button>

      {/* 下一个匹配按钮（↓） */}
      <button
        type="button"
        onClick={handleNext}
        disabled={!hasMatches}
        aria-label="下一个匹配"
        title="下一个 (⏎)"
        className={cn(
          // P0 修复：同上（对齐原型 .cs-btn）
          'flex flex-shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none px-1.5 py-[3px] transition-colors',
          hasMatches
            ? 'text-[var(--text-faint)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]'
            : 'cursor-not-allowed text-[var(--text-faint)] opacity-50'
        )}
      >
        <ChevronDown className="size-3" />
      </button>

      {/* 关闭按钮（X） */}
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭搜索"
        title="关闭 (Esc)"
        className={cn(
          // P0 修复：同上（对齐原型 .cs-btn + .cs-close）
          //   .cs-close { font-size:14px } → 图标用 size-3.5（比导航按钮略大）
          'flex flex-shrink-0 cursor-pointer items-center justify-center rounded-[3px] border-none px-1.5 py-[3px] text-[var(--text-faint)] transition-colors',
          'hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]'
        )}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
