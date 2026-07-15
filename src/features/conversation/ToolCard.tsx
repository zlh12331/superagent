/**
 * ToolCard — 可折叠工具调用卡片
 *
 * 对应 prototype.html 的 `.card.tool-card`。
 * 展示 AI 发起的工具调用（如 exec_command、read_file、apply_patch），
 * 包含工具名、执行状态、参数详情和执行结果。
 *
 * 交互：默认折叠，点击 card-head 切换展开/折叠。
 *
 * 状态徽章颜色：
 * - running:  bg-[var(--accent-soft)] text-[var(--accent)]（+ spinner）
 * - success:  bg-[var(--accent-soft)] text-[var(--accent)]
 * - error:    bg-[rgba(255,107,107,0.1)] text-[var(--error)]
 * - pending:  bg-[var(--info-amber)] text-[var(--warn)]
 *
 * 参考样式：prototype.html 第 1133-1438 行
 */

import { useState } from 'react'
import { ChevronRight, FileCode, Loader2, Terminal } from 'lucide-react'
import type { ToolCall, ToolCallStatus } from '@/lib/codex/types'
import { cn } from '@/lib/utils'

export interface ToolCardProps {
  /** 工具调用数据 */
  toolCall: ToolCall
  /** 额外的 className */
  className?: string
}

/** 工具状态对应的中文标签 */
const STATUS_LABEL: Record<ToolCallStatus, string> = {
  running: '运行中',
  success: '成功',
  error: '错误',
  pending: '等待中',
}

/** 工具状态对应的徽章样式 */
const STATUS_BADGE_CLASS: Record<ToolCallStatus, string> = {
  running: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  success: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  error: 'bg-[rgba(255,107,107,0.1)] text-[var(--error)]',
  pending: 'bg-[var(--info-amber)] text-[var(--warn)]',
}

/** 命令类工具名集合（这些工具的 args 中通常包含 command/cmd 字段） */
const COMMAND_TOOLS = new Set(['exec_command', 'shell', 'run_command'])

/**
 * 根据工具名推断图标组件。
 *
 * - 命令类工具（exec_command 等）→ Terminal 图标
 * - 文件类工具（read_file 等）→ FileCode 图标
 * - 默认 → FileCode 图标
 */
function getToolIcon(name: string, isRunning: boolean) {
  // running 状态下统一显示 spinner
  if (isRunning) {
    return <Loader2 className="size-3.5 animate-spin text-[var(--accent)]" />
  }
  if (COMMAND_TOOLS.has(name)) {
    return <Terminal className="size-3.5 text-[var(--accent)]" />
  }
  return <FileCode className="size-3.5 text-[var(--accent)]" />
}

/**
 * 从工具参数中提取命令文本（用于 card-body 的命令行展示）。
 *
 * 优先查找 args.command / args.cmd 字段，找不到时返回 null。
 */
function extractCommand(args: Record<string, unknown>): string | null {
  const cmd = args['command'] ?? args['cmd']
  if (typeof cmd === 'string') return cmd
  return null
}

/**
 * 可折叠工具调用卡片组件。
 *
 * 结构：
 * - card-head：工具图标 + 工具名（mono）+ 状态徽章 + 折叠箭头
 * - card-body（展开时）：
 *   - 命令行（$ + 命令，仅命令类工具）
 *   - 参数 JSON（tool-args 样式块）
 *   - 执行结果/错误文本
 * - running 状态：底部 indeterminate 进度条
 */
export function ToolCard({ toolCall, className }: ToolCardProps) {
  // 折叠状态：默认折叠
  const [isOpen, setIsOpen] = useState(false)

  const isRunning = toolCall.status === 'running'
  const command = extractCommand(toolCall.args)
  // 将参数对象格式化为可读的 JSON 字符串（2 空格缩进）
  const argsJson = JSON.stringify(toolCall.args, null, 2)

  return (
    <div
      className={cn(
        // M4: 圆角 9px（对齐原型 .card { border-radius:9px }）
        // M4: 添加 group 类，使内部装饰条的 group-hover 由 ToolCard 自身触发（对齐 .card:hover::before）
        'group relative overflow-hidden rounded-[9px] border border-[var(--border)] bg-[var(--bg-elev)]',
        // M4: hover 时边框加深 + 右移 2px + 阴影（对齐 .card:hover）
        'transition-all duration-200',
        'hover:border-[var(--border-strong)] hover:translate-x-0.5 hover:shadow-[0_4px_16px_rgba(0,0,0,0.25)]',
        className
      )}
    >
      {/* 左侧装饰条：hover 或 running 时高亮 */}
      <span
        className={cn(
          'absolute left-0 top-0 bottom-0 w-0.5 transition-all',
          isRunning
            ? // F2: running 状态改为脉冲动画（原静态 accent 色），强化"进行中"视觉反馈
              'bg-[var(--accent)] animate-pulse'
            : 'bg-[var(--border-strong)] group-hover:bg-[var(--accent)]',
          // M4: hover 时发光（对齐原型 .card:hover::before { box-shadow:0 0 8px var(--accent-glow) }）
          'group-hover:shadow-[0_0_8px_var(--accent-glow)]'
        )}
      />

      {/* card-head：点击切换折叠 */}
      {/* I-M-014: 原型使用显式 keydown 监听，前端使用 button 原生语义，功能等价（button 原生支持 Enter/Space 激活） */}
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        className={cn(
          // M5: 内边距 9px 12px 9px 14px（对齐原型 .card-head { padding:9px 12px 9px 14px }，左14 右12）
          'flex w-full items-center gap-2 pl-3.5 pr-3 py-[9px] text-left',
          'bg-[var(--bg-elev-2)] font-mono text-xs transition-colors',
          'hover:bg-[var(--bg-elev)]'
        )}
        aria-expanded={isOpen}
        aria-label="折叠/展开工具调用详情"
      >
        {/* 工具图标（running 时替换为 spinner） */}
        <span className="flex size-3.5 items-center justify-center">
          {getToolIcon(toolCall.name, isRunning)}
        </span>

        {/* F1: running 状态下在工具名左侧显示脉动圆点，强化"进行中"视觉反馈 */}
        {isRunning && (
          <span
            className="inline-block h-2 w-2 rounded-full bg-[var(--accent)] animate-pulse mr-1"
            aria-hidden="true"
          />
        )}

        {/* 工具名（mono 字体） */}
        <span className="font-semibold text-[var(--text)]">{toolCall.name}</span>

        {/* 状态徽章（右侧自适应） */}
        <span
          className={cn(
            'ml-auto rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-wide',
            STATUS_BADGE_CLASS[toolCall.status]
          )}
        >
          {STATUS_LABEL[toolCall.status]}
        </span>

        {/* 折叠箭头（展开时旋转 90deg） */}
        <ChevronRight
          className={cn(
            'size-3.5 text-[var(--text-faint)] transition-transform duration-200',
            isOpen && 'rotate-90 text-[var(--accent)]'
          )}
        />
      </button>

      {/* card-body：展开/折叠动画 — grid-rows 过渡实现高度动画 */}
      {/* P2修复：从条件渲染改为始终渲染+grid-rows过渡，实现平滑展开/折叠动画 */}
      <div
        className={cn(
          'grid transition-all duration-200 ease-in-out',
          isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="overflow-hidden p-0">
          {/* 命令行展示（仅命令类工具且有 command 字段时显示） */}
          {/* M-B-006: 改为独立终端块样式（对齐原型 prototype.html 第 1311-1322 行 .cmd-line）
              padding:8px 10px 8px 12px、border-radius:5px、四周边框 + 左侧 2px accent-dim 装饰线、
              margin-bottom:8px、深色终端背景 #070A0E；移除原 border-b 简单底边框 */}
          {command && (
            <div className="flex items-center gap-1.5 mx-3 mb-2 rounded-[5px] border border-[var(--border)] border-l-2 border-l-[var(--accent-dim)] bg-[#070A0E] px-3 py-2 font-mono text-[11.5px] text-[var(--text-dim)]">
              <span className="text-[var(--accent)]">$</span>
              <span className="text-[var(--text)]">{command}</span>
            </div>
          )}

          {/* 参数 JSON 块（tool-args 样式） */}
          {/* M-B-004: 移除多余 margin（对齐原型 .tool-args 无 margin，在 .card-body[style="padding:0"] 内直接贴边） */}
          {/* M-B-005: padding 改为 10px 12px、圆角改为 5px（对齐原型 prototype.html 第 1424-1425 行 .tool-args { padding:10px 12px; border-radius:5px }） */}
          <pre
            className={cn(
              'overflow-x-auto rounded-[5px] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5',
              'border-l-2 border-l-[var(--accent-dim)]',
              'font-mono text-[11.5px] text-[var(--text-dim)]',
              'whitespace-pre-wrap'
            )}
          >
            {argsJson}
          </pre>

          {/* 执行结果（success 状态） */}
          {toolCall.status === 'success' && toolCall.result && (
            <pre className="mx-3 mb-2 overflow-x-auto whitespace-pre-wrap border-t border-[var(--border)] pt-2 font-mono text-[11.5px] text-[var(--text-dim)]">
              {toolCall.result}
            </pre>
          )}

          {/* 错误信息（error 状态） */}
          {toolCall.status === 'error' && toolCall.error && (
            <pre className="mx-3 mb-2 overflow-x-auto whitespace-pre-wrap border-t border-[var(--border)] pt-2 font-mono text-[11.5px] text-[var(--error)]">
              {toolCall.error}
            </pre>
          )}

          {/* 执行耗时（如有） */}
          {toolCall.durationMs !== undefined && (
            <div className="border-t border-[var(--border)] px-3.5 py-1.5 font-mono text-[10px] text-[var(--text-faint)]">
              耗时 {(toolCall.durationMs / 1000).toFixed(2)}s
            </div>
          )}
        </div>
      </div>

      {/* F2: running 状态的脉冲条已移至左侧装饰条（animate-pulse），
          此处不再渲染底部 indeterminate 进度条，避免视觉冗余 */}
    </div>
  )
}
