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

/** 工具调用 inline 卡片：按 state 渲染执行态，input/output 折叠展开（含 diff 类专用视图） */
export function ToolCallView({
  type,
  toolCallId,
  state,
  input,
  output,
  errorText,
}: ToolCallViewProps): ReactElement {
  const [open, setOpen] = useState(() => state === 'output-error');
  const { t } = useTranslation();

  const activeSessionId = useActiveSessionStore((s) => s.activeSessionId);
  const title = useToolStore((s) => {
    const calls = activeSessionId === null ? undefined : s.callsBySession.get(activeSessionId);
    return calls?.find((c) => c.id === toolCallId)?.title ?? null;
  });

  const statusClass = mapToolStateToStatusClass(state);
  const statusLabel = mapToolStateToStatusLabelKey(state);
  const localizedStatusLabel = t(`chat.${statusLabel}`);

  const toolName = type.replace(/^dynamic-tool:\s*/, '').replace(/^tool-/, '');
  const isCommandTool = COMMAND_TOOLS.has(toolName);
  const isRunning = statusClass === 'running';
  const ToolIcon = isRunning ? Loader2 : isCommandTool ? Terminal : FileCode;

  return (
    <div className="msg msg-tool enter-anim">
      <div className="msg-body">
        <div
          className={cn(
            'card tool-card',
            open && 'open',
            statusClass === 'success' && 'is-settled',
            statusClass === 'error' && 'is-error',
          )}
        >
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
          <div
            className={cn(
              'grid transition-all duration-200',
              open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
            )}
          >
            <div className="overflow-hidden">
              <div className="card-body">
                {input !== undefined && (
                  <CodeBlock
                    label={t('chat.toolInput')}
                    content={formatJson(input, t)}
                    commandStyle={isCommandTool}
                  />
                )}
                {output !== undefined && (
                  <CodeBlock
                    label={t('chat.toolOutput')}
                    content={formatJson(output, t)}
                    commandStyle={isCommandTool}
                  />
                )}
                {errorText !== undefined && errorText !== '' && (
                  <CodeBlock label={t('chat.toolError')} content={errorText} />
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
