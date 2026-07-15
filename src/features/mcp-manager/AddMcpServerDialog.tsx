/**
 * AddMcpServerDialog — 添加 MCP 服务器弹窗（Task 20）
 *
 * 表单字段:
 * - 名称（必填）
 * - 传输方式（stdio / sse / websocket）
 * - 命令（stdio 必填，sse / websocket 可空）
 * - 参数（空格分隔，如 `-y @modelcontextprotocol/server-filesystem`）
 * - 环境变量（每行 KEY=VALUE）
 *
 * 保存流程:
 *   验证名称非空 → 解析参数与环境变量 → 调用 addMcpServer →
 *   upsertServer 到 store → 关闭弹窗 → toast 提示
 *
 * @see src/lib/codex/mcp.ts — addMcpServer
 * @see src/features/mcp-manager/mcp-store.ts — upsertServer
 */

import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  SegControl,
  SettingField,
} from '@/components/preferences/shared/SettingsControls'
import { addMcpServer } from '@/lib/codex/mcp'
import { useMcpStore } from './mcp-store'

/** 传输方式类型 */
type Transport = 'stdio' | 'sse' | 'websocket'

interface AddMcpServerDialogProps {
  /** 弹窗开关状态 */
  open: boolean
  /** 弹窗开关回调 */
  onOpenChange: (open: boolean) => void
}

/**
 * AddMcpServerDialog 组件 —— 添加 MCP 服务器的对话框。
 *
 * 渲染逻辑：
 *  - Dialog 由 shadcn/ui 提供，受控于 `open` / `onOpenChange`
 *  - 表单字段：name / transport / command / args / env
 *  - 传输方式使用 SegControl（分段控件）切换
 *
 * 状态依赖：
 *  - 本地 useState 管理 5 个表单字段 + saving 状态
 *  - 从 useMcpStore 获取 upsertServer 方法，保存成功后追加到列表
 *
 * 副作用：
 *  - 关闭弹窗时调用 resetForm 清空表单
 *  - 保存成功后自动关闭并 toast 提示
 *
 * 设计决策：
 *  - args 字段使用空格分隔的简单解析（不支持引号包裹），适合 npx 等场景
 *  - env 字段使用 KEY=VALUE 每行一个，与 shell 语法兼容
 *
 * @param props —— 见 AddMcpServerDialogProps 接口
 *
 * @see src/lib/codex/mcp.ts — addMcpServer 调用
 */
export function AddMcpServerDialog({
  open,
  onOpenChange,
}: AddMcpServerDialogProps) {
  // 表单状态
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<Transport>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  // 保存中状态
  const [saving, setSaving] = useState(false)

  // 从 store 获取 upsertServer
  const upsertServer = useMcpStore(s => s.upsertServer)

  // 重置表单
  const resetForm = useCallback(() => {
    setName('')
    setTransport('stdio')
    setCommand('')
    setArgs('')
    setEnv('')
  }, [])

  // 解析参数字符串为 string[]
  // 简单按空格分割，过滤空字符串
  const parseArgs = useCallback((argsText: string): string[] => {
    return argsText
      .trim()
      .split(/\s+/)
      .filter(part => part !== '')
  }, [])

  // 解析环境变量文本为 Record<string, string>
  // 每行格式为 KEY=VALUE，忽略空行和不含 = 的行
  const parseEnv = useCallback((envText: string): Record<string, string> => {
    const result: Record<string, string> = {}
    const lines = envText.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      if (key !== '') {
        result[key] = value
      }
    }
    return result
  }, [])

  // 保存服务器
  const handleSave = useCallback(async () => {
    // 验证名称非空
    const trimmedName = name.trim()
    if (trimmedName === '') {
      toast.error('请输入服务器名称')
      return
    }

    // stdio 传输方式下命令必填
    const trimmedCommand = command.trim()
    if (transport === 'stdio' && trimmedCommand === '') {
      toast.error('stdio 传输方式需要填写命令')
      return
    }

    setSaving(true)
    try {
      // 构建服务器数据
      // sse / websocket 且命令为空时，command 为 null
      const newServer = await addMcpServer({
        name: trimmedName,
        transport,
        command: trimmedCommand === '' ? null : trimmedCommand,
        args: parseArgs(args),
        env: parseEnv(env),
      })
      // 添加到 store
      upsertServer(newServer)
      // 重置表单并关闭弹窗
      resetForm()
      onOpenChange(false)
      toast.success(`已添加 MCP 服务器: ${trimmedName}`)
    } catch (err) {
      toast.error(
        `添加失败: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setSaving(false)
    }
  }, [
    name,
    command,
    transport,
    args,
    env,
    parseArgs,
    parseEnv,
    upsertServer,
    resetForm,
    onOpenChange,
  ])

  // 弹窗关闭时重置表单
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        resetForm()
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange, resetForm]
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[460px] gap-0 overflow-hidden p-0">
        {/* 标题 */}
        <DialogHeader className="border-b border-[var(--border)] px-4 py-3.5">
          <DialogTitle className="text-[14px] font-semibold text-[var(--text)]">
            添加 MCP 服务器
          </DialogTitle>
          <DialogDescription className="text-[11.5px] text-[var(--text-faint)]">
            配置新的 MCP 服务器连接
          </DialogDescription>
        </DialogHeader>

        {/* 表单 */}
        <div className="p-4 space-y-3">
          {/* 名称 */}
          <SettingField label="名称" description="服务器显示名称（必填）">
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="filesystem"
              spellCheck={false}
              className="font-mono text-[12px]"
            />
          </SettingField>

          {/* 传输方式 */}
          <SettingField label="传输方式">
            <SegControl
              value={transport}
              onChange={v => setTransport(v as Transport)}
              options={[
                { value: 'stdio', label: 'stdio' },
                { value: 'sse', label: 'sse' },
                { value: 'websocket', label: 'websocket' },
              ]}
            />
          </SettingField>

          {/* 命令 */}
          <SettingField
            label="命令"
            description={
              transport === 'stdio'
                ? '启动命令（必填），如 npx'
                : 'URL 地址（可选）'
            }
          >
            <Input
              value={command}
              onChange={e => setCommand(e.target.value)}
              placeholder={
                transport === 'stdio' ? 'npx' : 'https://example.com/mcp'
              }
              spellCheck={false}
              className="font-mono text-[12px]"
            />
          </SettingField>

          {/* 参数 */}
          <SettingField
            label="参数"
            description="空格分隔，如 -y @modelcontextprotocol/server-filesystem"
          >
            <Input
              value={args}
              onChange={e => setArgs(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
              spellCheck={false}
              className="font-mono text-[12px]"
            />
          </SettingField>

          {/* 环境变量 */}
          <SettingField label="环境变量" description="每行一个，格式 KEY=VALUE">
            <Textarea
              value={env}
              onChange={e => setEnv(e.target.value)}
              placeholder={'API_KEY=sk-...\nNODE_ENV=production'}
              spellCheck={false}
              className="font-mono text-[12px] min-h-[60px]"
            />
          </SettingField>
        </div>

        {/* 底部按钮 */}
        <DialogFooter className="flex-row justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-elev-2)] px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
          >
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
            className="bg-[var(--accent)] text-[#001814] hover:bg-[var(--accent-dim)]"
          >
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
