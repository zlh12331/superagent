/**
 * McpToolCallDialog — MCP 工具调用弹窗（Task 20）
 *
 * 允许用户输入 JSON 参数并调用指定的 MCP 工具，展示调用结果。
 *
 * 交互流程:
 *   输入 JSON 参数（可选） → 点击执行 → 调用 callMcpTool → 展示结果
 *
 * 结果展示:
 * - 正常结果: content 数组以换行拼接
 * - isError 为 true: 结果文字标红
 * - 执行中: 显示 "执行中..."
 * - 调用失败: 显示 "调用失败: {error.message}"
 * - JSON 解析失败: 显示 "参数 JSON 格式错误"
 *
 * @see src/lib/codex/mcp.ts — callMcpTool
 */

import { useState, useCallback } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import type { McpTool } from '@/lib/codex/types'
import { callMcpTool } from '@/lib/codex/mcp'

interface McpToolCallDialogProps {
  /** 服务器 ID */
  serverId: string
  /** 服务器名称（展示用） */
  serverName: string
  /** 当前选中的工具（null 时关闭弹窗） */
  tool: McpTool | null
  /** 关闭弹窗回调 */
  onClose: () => void
}

/** 工具调用结果展示状态 */
interface ResultState {
  /** 结果文本 */
  text: string
  /** 是否为错误结果 */
  isError: boolean
}

/**
 * McpToolCallDialog 组件 —— MCP 工具调用对话框。
 *
 * 渲染逻辑：
 *  - 顶部 DialogHeader：工具名称 + 服务器名 + 工具描述
 *  - 主体：参数输入框（JSON 格式，可选）+ 执行按钮 + 错误/结果展示
 *  - 底部：关闭按钮
 *
 * 状态依赖：
 *  - 本地 useState 管理：argsText / executing / result / errorMsg
 *  - 通过 props 接收 serverId / serverName / tool（null 时关闭）/ onClose
 *
 * 副作用：
 *  - 执行按钮触发 handleExecute：解析 JSON → callMcpTool → 设置结果或错误
 *  - 关闭弹窗时重置所有本地状态
 *
 * 设计决策：
 *  - 参数 JSON 必须为对象（拒绝数组与原始值），与 MCP 协议的 named-arguments 约定一致
 *  - 结果文本由 content 数组的 text 字段以换行拼接而成
 *  - 工具返回的 isError 字段决定结果文本颜色（红色错误 / 默认文本色）
 *
 * @param props —— 见 McpToolCallDialogProps 接口
 */
export function McpToolCallDialog({
  serverId,
  serverName,
  tool,
  onClose,
}: McpToolCallDialogProps) {
  // JSON 参数输入
  const [argsText, setArgsText] = useState('')
  // 是否正在执行
  const [executing, setExecuting] = useState(false)
  // 调用结果
  const [result, setResult] = useState<ResultState | null>(null)
  // 错误信息（JSON 解析错误或调用异常）
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // 执行工具调用
  const handleExecute = useCallback(async () => {
    if (!tool) return

    // 解析 JSON 参数（空字符串视为空对象）
    let args: Record<string, unknown> = {}
    const trimmed = argsText.trim()
    if (trimmed !== '') {
      try {
        const parsed = JSON.parse(trimmed)
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          args = parsed as Record<string, unknown>
        } else {
          setErrorMsg('参数 JSON 格式错误：需要 JSON 对象')
          return
        }
      } catch {
        setErrorMsg('参数 JSON 格式错误')
        return
      }
    }

    setExecuting(true)
    setErrorMsg(null)
    setResult(null)

    try {
      const res = await callMcpTool(serverId, tool.name, args)
      // 将 content 数组以换行拼接为结果文本
      const text = res.content.map(c => c.text).join('\n')
      setResult({ text, isError: res.isError })
    } catch (err) {
      setErrorMsg(
        `调用失败: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setExecuting(false)
    }
  }, [tool, argsText, serverId])

  // 关闭弹窗时重置状态
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setArgsText('')
        setExecuting(false)
        setResult(null)
        setErrorMsg(null)
        onClose()
      }
    },
    [onClose]
  )

  return (
    <Dialog open={tool !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[480px] gap-0 overflow-hidden p-0">
        {/* 标题 */}
        <DialogHeader className="border-b border-[var(--border)] px-4 py-3.5">
          <DialogTitle className="text-[14px] font-semibold text-[var(--text)]">
            调用工具 · {tool?.name ?? ''}
          </DialogTitle>
          <DialogDescription className="text-[11.5px] text-[var(--text-faint)]">
            服务器: {serverName}
            {tool ? ` · ${tool.description}` : ''}
          </DialogDescription>
        </DialogHeader>

        {/* 参数输入 + 结果 */}
        <div className="p-4 space-y-3">
          {/* 参数输入区 */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-dim)]">
              参数
            </label>
            <Textarea
              value={argsText}
              onChange={e => setArgsText(e.target.value)}
              placeholder="JSON 参数（可选）"
              spellCheck={false}
              className="font-mono text-[12px] min-h-[80px]"
            />
          </div>

          {/* 执行按钮 */}
          <Button
            onClick={handleExecute}
            disabled={executing || tool === null}
            className="w-full bg-[var(--accent)] text-[#001814] hover:bg-[var(--accent-dim)]"
          >
            {executing ? (
              <Loader2 className="animate-spin" width={14} height={14} />
            ) : null}
            执行
          </Button>

          {/* 错误信息（JSON 解析错误或调用异常） */}
          {errorMsg !== null && (
            <div className="rounded-md border border-[var(--error)] bg-[var(--bg-elev-2)] px-3 py-2 font-mono text-[11px] text-[var(--error)]">
              {errorMsg}
            </div>
          )}

          {/* 执行中提示 */}
          {executing && (
            <div className="font-mono text-[11px] text-[var(--text-faint)]">
              执行中...
            </div>
          )}

          {/* 调用结果 */}
          {result !== null && (
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-dim)]">
                结果
              </label>
              <pre
                className={`max-h-[200px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all ${
                  result.isError ? 'text-[var(--error)]' : 'text-[var(--text)]'
                }`}
              >
                {result.text}
              </pre>
            </div>
          )}
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
  )
}
