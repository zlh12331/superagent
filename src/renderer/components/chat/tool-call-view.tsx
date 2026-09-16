// src/renderer/components/chat/tool-call-view.tsx
// 通用工具调用卡片（自 message-item 拆出，2026-09-15 结构审计）
// ──────────────────────────────────────────────
// 拆分依据：message-item 同时承担「消息/part 编排」与「工具卡渲染」两个子域；
// 同类工具卡 file-change-card（edit_file/write_file 专用）早已独立成文件，
// 通用 ToolCallView 内联属待遇不一致。拆出后 message-item 只保留编排职责。
// 数据源：tool-store 推送标题（会话作用域查找）+ part.input/output/errorText。
// ──────────────────────────────────────────────

import { FileCode, Loader2, Terminal } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useToolStore } from '@/stores/transient/tool-store';
import {
  formatJson,
  mapToolStateToStatusClass,
  mapToolStateToStatusLabelKey,
  type ToolCallState,
} from './message-utils';

/**
 * 工具调用卡片（对齐原型 .card.tool-card）
 *
 * 显示工具名称、状态、入参、输出 / 错误。
 * 可折叠：点击 card-head 切换 .open 类。
 *
 * 注意：可选字段使用 `T | undefined` 而非 `T?`，
 * 以兼容 exactOptionalPropertyTypes（exactOptionalPropertyTypes 下 `T?` 不允许显式传入 undefined）。
 */
interface ToolCallViewProps {
  type: string;
  toolCallId: string;
  state: ToolCallState;
  input: unknown | undefined;
  output: unknown | undefined;
  errorText: string | undefined;
}

export function ToolCallView({
  type,
  toolCallId,
  state,
  input,
  output,
  errorText,
}: ToolCallViewProps): ReactElement {
  // 折叠状态：默认折叠（对齐原型 #toolCard 初始无 .open 类）
  const [open, setOpen] = useState(false);
  // 本地化文案
  const { t } = useTranslation();

  // 从 tool-store 查找 title（主进程通过 AgentToolResultPayload 推送的人类可读标题）
  // 没有找到时回退到工具名（type）。
  // 会话作用域：消息列表只渲染活跃会话的消息（ChatPanel 按 chatId 装配），故按活跃
  // 会话索引查找（对齐 right-panel-panes.tsx 的 callsBySession.get(sessionId) 模式），
  // 避免流式期 store 高频推送 × 每张卡片对全部会话全表扫描的 O(卡片×调用) 放大
  const activeSessionId = useActiveSessionStore((s) => s.activeSessionId);
  const title = useToolStore((s) => {
    const calls = activeSessionId === null ? undefined : s.callsBySession.get(activeSessionId);
    return calls?.find((c) => c.id === toolCallId)?.title ?? null;
  });

  // 状态映射：AI SDK state → .card-status 类 + 本地化文案
  const statusClass = mapToolStateToStatusClass(state);
  const statusLabel = mapToolStateToStatusLabelKey(state);
  const localizedStatusLabel = t(`chat.${statusLabel}`);

  // 归一化工具名（2026-09 审计修复）
  //
  // 调用方传两种形态：
  // - 静态工具：part.type = 'tool-exec_command'（带 'tool-' 前缀）
  // - 动态工具：message-item 传 `dynamic-tool: ${part.toolName}`（见其调用处）
  // 此前只剥 'tool-' 前缀，动态工具得到 'dynamic-tool: exec_command' →
  // COMMAND_TOOLS 永不命中（命令工具不高亮）、无 title 时还把该字符串当标题显示。
  const toolName = type.replace(/^dynamic-tool:\s*/, '').replace(/^tool-/, '');
  // 命令工具高亮（照搬参考项目 COMMAND_TOOLS：命令行块 accent 左边条 + 深色背景）
  const isCommandTool = COMMAND_TOOLS.has(toolName);
  // 工具图标（照搬参考项目 getToolIcon：命令工具 Terminal / 其他 FileCode，运行中换 spinner）
  // 运行中判定复用徽章映射（ToolCallState 的 running 档，见 message-utils）
  const isRunning = statusClass === 'running';
  const ToolIcon = isRunning ? Loader2 : isCommandTool ? Terminal : FileCode;

  return (
    <div className="msg msg-tool enter-anim">
      <div className="msg-body">
        <div className={cn('card tool-card', open && 'open')}>
          <button
            type="button"
            className="card-head"
            onClick={() => setOpen((v) => !v)}
            aria-label={t('chat.toggleToolDetails')}
            aria-expanded={open}
          >
            <span className="card-icon">
              <ToolIcon className={cn('size-3.5 text-accent', isRunning && 'animate-spin')} />
            </span>
            <span className="card-title">{title ?? toolName}</span>
            <span className={cn('card-status', statusClass)}>{localizedStatusLabel}</span>
            <span className="tool-chev" aria-hidden="true">
              ▸
            </span>
          </button>
          {/* 展开动画（照搬参考项目 grid-rows 方案：始终挂载切换 class，非条件渲染） */}
          <div
            className={cn(
              'grid transition-all duration-200',
              open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
            )}
          >
            <div className="overflow-hidden">
              <div className="card-body">
                {/* 入参（JSON 序列化，最多 200 字符避免膨胀） */}
                {input !== undefined && (
                  <CodeBlock
                    label="input"
                    content={formatJson(input, t)}
                    commandStyle={isCommandTool}
                  />
                )}
                {/* 输出（output 优先于 errorText） */}
                {output !== undefined && (
                  <CodeBlock
                    label="output"
                    content={formatJson(output, t)}
                    commandStyle={isCommandTool}
                  />
                )}
                {errorText !== undefined && errorText !== '' && (
                  <CodeBlock label="error" content={errorText} />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 命令工具集合（照搬参考项目 COMMAND_TOOLS：命令工具显示命令行块样式）
 */
const COMMAND_TOOLS = new Set(['exec_command', 'shell', 'run_command']);

/**
 * 代码块（带标签 + 内容）
 *
 * 用于展示工具调用的 input / output / error；
 * 命令工具时加 accent 左边条 + 深色背景（照搬参考项目命令行块）。
 */
function CodeBlock({
  label,
  content,
  commandStyle = false,
}: {
  label: string;
  content: string;
  /** 命令工具样式：accent 左边条 + 深色背景 */
  commandStyle?: boolean;
}): ReactElement {
  return (
    <div className="mt-1">
      <div className="text-muted-foreground font-mono text-2xs uppercase tracking-wider">
        {label}
      </div>
      <pre
        className={cn(
          'text-foreground mt-0.5 overflow-x-auto rounded p-1.5 font-mono text-xs leading-snug',
          commandStyle ? 'border-l-accent-dim bg-code-block-bg border-l-2' : 'bg-background/50',
        )}
      >
        {content}
      </pre>
    </div>
  );
}
