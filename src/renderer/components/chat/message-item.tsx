// message-item.tsx（自 ChatMessageList 拆分）
// 聊天消息行：消息项 / part 渲染 / 工具调用 / 代码块 / 推理块
// ──────────────────────────────
// 拆分背景：ChatMessageList 685 行，消息渲染逻辑提取为独立文件
// ──────────────────────────────

// type-only import：仅引入类型，不引入运行时依赖
import type { UIMessage } from 'ai';
// AI SDK 官方类型守卫：在运行时判断 part 类型并收窄 TypeScript 类型
import {
  isDynamicToolUIPart,
  isFileUIPart,
  isReasoningUIPart,
  isStaticToolUIPart,
  isTextUIPart,
} from 'ai';
import { FileCode, Loader2, Terminal } from 'lucide-react';
import { motion } from 'motion/react';
import { memo, type ReactElement, useMemo, useState } from 'react';

import { useTranslation } from '@/i18n/use-translation';
import { smoothEaseOut } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useReasoningCollapseStore } from '@/stores/transient/reasoning-collapse-store';
import { useToolStore } from '@/stores/transient/tool-store';
import { FileChangeCard } from './file-change-card';
import { Markdown } from './Markdown';
import { MsgActions } from './message-actions';
import {
  extractText,
  formatJson,
  mapToolStateToStatusClass,
  mapToolStateToStatusLabelKey,
  type ToolCallState,
} from './message-utils';
import { StreamingCursor } from './streaming-cursor';

/** part 类型（UIMessage['parts'][number] 派生） */
type UIMessagePart = UIMessage['parts'][number];

// 记忆化导出：消息未变化（引用不变）时跳过重渲染——
// 去 Virtuoso 后流式场景仅变化消息重渲染，避免全列表 Markdown 重新解析
export const MessageItem = memo(function MessageItem({
  message,
  onRegenerate,
  disableActions,
  isStreaming = false,
  isContinuation = false,
}: {
  message: UIMessage;
  onRegenerate: ((messageId: string) => void) | undefined;
  disableActions: boolean;
  /** 是否为正在流式输出的消息（ChatMessageList 对最后一条 assistant 传入） */
  isStreaming?: boolean;
  /** 是否为连续 assistant 消息（前一条也是 assistant，隐藏头像与角色标签；照搬参考项目 isContinuation） */
  isContinuation?: boolean;
}): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 当前模型（对齐原型 .msg-role 展示模型名）
  const defaultModel = useSettingsStore((state) => state.ai.defaultModel);

  // parts 预映射：生成稳定 key（含 index 但不暴露给 JSX key，规避 noArrayIndexKey）
  // 并标记最后一条 text part 的流式光标（仅流式 assistant 消息；user/历史恒 false）
  const partsWithCursor = useMemo(
    () =>
      message.parts.map((part, index) => ({
        part,
        key: `${message.id}-${index}`,
        showCursor:
          message.role === 'assistant' && isStreaming && index === message.parts.length - 1,
      })),
    [message.parts, message.id, isStreaming, message.role],
  );

  if (message.role === 'user') {
    // user 消息：text 拼接为气泡内容；非 text parts（历史重建产生的孤儿
    // 工具结果 / 附件 file）此前一律不渲染——留下空气泡且工具卡丢失
    const text = extractText(message.parts);
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={smoothEaseOut}
        className="msg user enter-anim"
      >
        <div className="msg-body">
          {text.length > 0 && <div className="msg-content">{text}</div>}
          {partsWithCursor.map(({ part, key }) =>
            isTextUIPart(part) ? null : <PartView key={key} part={part} collapseKey={key} />,
          )}
        </div>
      </motion.div>
    );
  }

  if (message.role === 'assistant') {
    // assistant 消息：avatar + body（role + parts + actions）
    // 对齐原型 addMsgActions()：仅 assistant 消息显示 hover 操作栏
    // 连续 assistant 消息（isContinuation）：隐藏头像与角色标签，内容缩进对齐（照搬参考项目）
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={smoothEaseOut}
        className="msg assistant enter-anim"
      >
        {!isContinuation && (
          <div className="msg-avatar assistant" aria-hidden="true">
            C
          </div>
        )}
        <div className={cn('msg-body', isContinuation && 'ml-10')}>
          {/* 对齐原型 .msg-role（"codex · gpt-5-codex"）：品牌 · 当前模型 */}
          {!isContinuation && (
            <div className="msg-role assistant">
              {t('chat.assistant')} · {defaultModel}
            </div>
          )}
          {/* parts 列表：按 part 类型分别渲染；流式消息在最后一条文本 part 末尾加闪烁光标 */}
          {partsWithCursor.map(({ part, key, showCursor }) => (
            <PartView
              key={key}
              part={part}
              collapseKey={key}
              showCursor={showCursor}
              // 流式消息跳过高亮（对齐参考项目：流式期间跳过语法高亮，避免每 token 反复高亮）
              highlight={!isStreaming}
            />
          ))}
          {/* hover 操作栏：复制 + 重新生成（对齐原型 .msg-actions） */}
          <MsgActions
            text={extractText(message.parts)}
            messageId={message.id}
            onRegenerate={onRegenerate}
            disabled={disableActions}
          />
        </div>
      </motion.div>
    );
  }

  // system 消息：居中淡灰小字
  return (
    <div className="flex justify-center">
      <div className="text-muted-foreground font-mono text-xs italic">
        {extractText(message.parts)}
      </div>
    </div>
  );
});

/**
 * 单个 part 渲染
 *
 * 根据 part.type 分发到不同的展示组件：
 * - 'text'：.msg-content > Markdown（GFM 解析 + shiki 代码高亮）
 * - 'reasoning'：.reasoning-block（折叠式推理块，accent 左光条）
 * - 'tool-*' / 'dynamic-tool'：.card.tool-card（可折叠工具卡片）
 * - 'file'：.card 简易附件卡片
 * - 'step-start'：细分隔线表示新步骤
 * - 其他：fallback 展示 part.type
 */
function PartView({
  part,
  collapseKey,
  showCursor = false,
  highlight = true,
}: {
  part: UIMessagePart;
  /** 折叠态 key（`${message.id}-${index}`，part 级：同消息多个推理块各自独立） */
  collapseKey: string;
  /** 流式光标：仅最后一条 text part 渲染（照搬参考项目 StreamingCursor） */
  showCursor?: boolean;
  /** 是否启用代码块语法高亮（流式消息传 false，对齐参考项目流式跳过高亮） */
  highlight?: boolean;
}): ReactElement {
  // 本地化文案
  const { t } = useTranslation();

  // 文本 part：Markdown 渲染（支持 GFM + 代码语法高亮）
  if (isTextUIPart(part)) {
    if (part.text.length === 0) {
      return <div className="msg-content" />;
    }
    return (
      <div className="msg-content">
        <Markdown content={part.text} highlight={highlight} />
        {/* 流式光标：当前消息正在输出时，文本末尾显示闪烁光标 */}
        {showCursor && <StreamingCursor />}
      </div>
    );
  }

  // 思考 part：.reasoning-block 折叠式推理块（折叠 key 到 part 级：一条消息可含多段思考）
  if (isReasoningUIPart(part)) {
    return <ReasoningBlock text={part.text} collapseKey={collapseKey} />;
  }

  // 静态工具调用（tool-{name}）
  // 注意：errorText 在不同 state 下可能为 string 或 undefined，
  // 用 ?? undefined 统一为 string | undefined（兼容 exactOptionalPropertyTypes）
  if (isStaticToolUIPart(part)) {
    // 文件变更工具（edit_file / write_file）：渲染 FileChangeCard（diff 卡片）
    // 对齐参考项目 FileChangeCard——替代通用 JSON 展示，突出文件变更可视化
    if (part.type === 'tool-edit_file' || part.type === 'tool-write_file') {
      return <FileChangeCard toolName={part.type.slice(5)} input={part.input} />;
    }
    return (
      <ToolCallView
        type={part.type}
        toolCallId={part.toolCallId}
        state={part.state}
        input={part.input}
        output={part.output}
        errorText={part.errorText ?? undefined}
      />
    );
  }

  // 动态工具调用（dynamic-tool）
  if (isDynamicToolUIPart(part)) {
    return (
      <ToolCallView
        type={`dynamic-tool: ${part.toolName}`}
        toolCallId={part.toolCallId}
        state={part.state}
        input={part.input}
        output={part.output}
        errorText={part.errorText ?? undefined}
      />
    );
  }

  // 文件 part：展示为 .card 简易附件卡片
  if (isFileUIPart(part)) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="card-icon" aria-hidden="true">
            📎
          </span>
          <span className="card-title">{t('chat.attachment')}</span>
          <span className="card-status pending">{part.mediaType}</span>
        </div>
      </div>
    );
  }

  // step-start：步骤分隔线
  if (part.type === 'step-start') {
    return (
      <div className="border-border my-2 flex items-center gap-2 border-t pt-1">
        <span className="text-muted-foreground font-mono text-xs italic">{t('chat.nextStep')}</span>
      </div>
    );
  }

  // fallback：未知 part 类型，展示 type 字符串
  return (
    <div className="text-muted-foreground font-mono text-xs italic">
      {t('chat.unknownPart', { type: part.type })}
    </div>
  );
}

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

function ToolCallView({
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

  // AI SDK part 的 toolName 带 'tool-' 前缀（如 'tool-exec_command'），
  // 去前缀后与 COMMAND_TOOLS 匹配（对齐参考项目 toolCall.toolName 语义）
  const toolName = type.replace(/^tool-/, '');
  // 命令工具高亮（照搬参考项目 COMMAND_TOOLS：命令行块 accent 左边条 + 深色背景）
  const isCommandTool = COMMAND_TOOLS.has(toolName);
  // 工具图标（照搬参考项目 getToolIcon：命令工具 Terminal / 其他 FileCode，运行中换 spinner）
  // 运行中判定复用徽章映射（AI SDK v7 状态为 input-streaming/input-accepted，非字面 'running'）
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

/**
 * 推理块（对齐原型 .reasoning-block）
 *
 * 折叠式：默认折叠，点击 head 切换 .open 类。
 * accent 左光条 + 等宽字体展示思考内容。
 */
function ReasoningBlock({
  text,
  collapseKey,
}: {
  text: string;
  collapseKey: string;
}): ReactElement {
  // 折叠态：用户显式覆盖优先（L2 store，滚动卸载不丢失）；未覆盖时实时跟随实验设置
  const reasoningCollapsed = useSettingsStore((s) => s.experimental.reasoningCollapsed);
  const override = useReasoningCollapseStore((s) => s.overrides.get(collapseKey));
  const setCollapsed = useReasoningCollapseStore((s) => s.setCollapsed);
  const open = override === undefined ? !reasoningCollapsed : !override;
  // 本地化文案
  const { t } = useTranslation();

  return (
    <div className={cn('reasoning-block', open && 'open')}>
      <button
        type="button"
        className="reasoning-head"
        onClick={() => setCollapsed(collapseKey, open)}
        aria-expanded={open}
      >
        <span className="reasoning-title">{t('chat.thinking')}</span>
        <span className="rh-chevron ml-auto" aria-hidden="true">
          ▸
        </span>
      </button>
      <div className="reasoning-body">
        <div className="text-muted-foreground font-mono text-xs leading-relaxed whitespace-pre-wrap italic">
          {text}
        </div>
      </div>
    </div>
  );
}
