// src/renderer/components/agent/ask-dialog.tsx
// Agent 提问对话框（ask_user_question 工具的渲染层 UI）
// ──────────────────────────────────────────────────────────────
// - 展示 Agent 提出的问题（可带预置选项，单选/多选）
// - 用户点选选项 + 自由输入文本 → agent:ask:respond 回传
// - 取消：回传空回答（LLM 按「用户未选择」继续）
// - 浏览器模式守卫：无 window.api 时直接关闭
// ──────────────────────────────────────────────────────────────

import { type AgentQuestion, ASK_TIMEOUT_SECONDS } from '@code-agent/shared/renderer';
import { X } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { respondAgentAsk } from '@/lib/agent/agent-actions';
import { hasIpcBridge, unwrapErrorMessage } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useAgentAskStore } from '@/stores/transient/agent-ask-store';

/** 单选答案记录 */
interface AnswerState {
  readonly selectedIndexes: number[];
  readonly text: string;
}

/** 提问状态（逐字段 selector 的聚合形态） */
interface AskState {
  readonly sessionId: string | null;
  readonly askId: string | null;
  readonly questions: readonly AgentQuestion[];
  readonly receivedAt: number;
  readonly removeAsk: (askId: string) => void;
}

/**
 * 提问状态选择器（模块级提取，2026-09-11；2026-10-08 队列化适配）
 *
 * - **队列取队头**：store 持有全部待答提问（一轮可并行多个 ask 工具），
 *   本对话框为全屏模态，一次呈现**队头**（FIFO 先问先答）；队头出队后
 *   下一条自动上浮——超时的队头由主进程决议事件放行，不会阻塞队列。
 *   会话归属在前端过滤（多会话并发时只看当前激活会话的提问）。
 * - **逐字段 selector**：各字段独立比较，避免整体订阅导致的全量重渲染。
 * - 提取为模块级 hook：AskDialog 函数体受 check-functions 棘轮约束。
 */
function useAskState(activeSessionId: string | null): AskState {
  // 队头选择：取首个归属当前激活会话的条目（asks 按到达顺序 FIFO）
  // ⚠️ useShallow：filter/find 每次返回新对象引用，裸用触发
  // "getSnapshot should be cached" 无限重渲染（React 19 + zustand 5 实测）
  const head = useAgentAskStore(
    useShallow((s) => s.asks.find((a) => a.sessionId === activeSessionId) ?? null),
  );
  const removeAsk = useAgentAskStore((s) => s.removeAsk);
  return {
    sessionId: head?.sessionId ?? null,
    askId: head?.askId ?? null,
    questions: head?.questions ?? [],
    receivedAt: head?.receivedAt ?? 0,
    removeAsk,
  };
}

/**
 * 提问超时倒计时（38 号阶段 2 收尾：主进程 60s 超时自动继续对用户可见化）
 *
 * 以 store 的 receivedAt 为基准（与推送时刻同源）；逐秒刷新（秒级提示需
 * 秒级粒度，与审批卡的分钟粒度不同）；最后 10 秒切警示态。
 */
function useAskCountdown(
  receivedAt: number,
  active: boolean,
): {
  readonly secondsLeft: number;
  readonly expiring: boolean;
} {
  const compute = (): number =>
    Math.max(0, Math.ceil((receivedAt + ASK_TIMEOUT_SECONDS * 1000 - Date.now()) / 1000));
  const [secondsLeft, setSecondsLeft] = useState(compute);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setSecondsLeft(compute);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
    // compute 为闭包内纯函数（读 receivedAt），无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receivedAt, active]);
  return { secondsLeft, expiring: active && secondsLeft <= 10 };
}

/** 回答载荷：仅带非空字段（单选索引/自由文本二选一或并存） */
function toAnswerPayload(a: AnswerState): { selectedIndexes?: number[]; text?: string } {
  return {
    ...(a.selectedIndexes.length > 0 ? { selectedIndexes: [...a.selectedIndexes] } : {}),
    ...(a.text !== '' ? { text: a.text } : {}),
  };
}

/** useAskAnswers 依赖 */
interface UseAskAnswersDeps {
  /** 当前提问 id（null = 无提问；变化时重置回答状态） */
  readonly askId: string | null;
  /** 问题列表（初始化 AnswerState 的长度基准） */
  readonly questions: readonly AgentQuestion[];
  /** 出队（提交成功/取消后统一收尾；下一队列头自动上浮） */
  readonly removeAsk: (askId: string) => void;
}

/**
 * 回答状态机（模块级提取）
 *
 * - 职责：answers/submitting 状态 + 新提问初始化 + 选项切换/文本输入/提交回传
 * - 提取动机：AskDialog 函数体受 check-functions 棘轮约束（只允许下降），
 *   状态机与渲染职责本就可分（对齐文件内 useAskState 先例）
 */
function useAskAnswers({ askId, questions, removeAsk }: UseAskAnswersDeps): {
  readonly answers: AnswerState[];
  readonly submitting: boolean;
  readonly toggleOption: (qIndex: number, optionIndex: number) => void;
  readonly setText: (qIndex: number, text: string) => void;
  readonly handleSubmit: () => Promise<void>;
} {
  const { t } = useTranslation();
  // 错误码 → 本地化文案（unwrapErrorMessage 统一模式）
  const { getErrorMessage } = useErrorMessage();
  const [answers, setAnswers] = useState<AnswerState[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 新提问到达时初始化回答状态
  useEffect(() => {
    if (askId !== null) {
      setAnswers(questions.map(() => ({ selectedIndexes: [], text: '' })));
      setSubmitting(false);
    }
  }, [askId, questions]);

  const toggleOption = (qIndex: number, optionIndex: number): void => {
    setAnswers((prev) =>
      prev.map((a, i) => {
        if (i !== qIndex) return a;
        const multi = questions[qIndex]?.multiSelect === true;
        const next = multi
          ? a.selectedIndexes.includes(optionIndex)
            ? a.selectedIndexes.filter((x) => x !== optionIndex)
            : [...a.selectedIndexes, optionIndex]
          : [optionIndex];
        return { ...a, selectedIndexes: next };
      }),
    );
  };

  const setText = (qIndex: number, text: string): void => {
    setAnswers((prev) => prev.map((a, i) => (i === qIndex ? { ...a, text } : a)));
  };

  const handleSubmit = async (): Promise<void> => {
    if (askId === null || !hasIpcBridge()) {
      if (askId !== null) removeAsk(askId);
      return;
    }
    setSubmitting(true);
    try {
      await respondAgentAsk({ askId, answers: answers.map(toAnswerPayload) });
      // 仅成功才出队：失败保留现场（选项/文本/askId），用户可原地重试
      removeAsk(askId);
    } catch (error) {
      // 对齐全仓统一模式：[CODE] 前缀错误 → 错误码本地化；非 IPC 异常回退通用文案
      toast.error(
        error instanceof Error
          ? unwrapErrorMessage(error, getErrorMessage)
          : t('agent.askSubmitFailed'),
      );
    }
    // finally 语义（React Compiler 不优化 try/finally）：catch 不 rethrow，
    // 成功/失败统一复位 submitting（出队仅发生在成功分支）
    setSubmitting(false);
  };

  return { answers, submitting, toggleOption, setText, handleSubmit };
}

/**
 * 分节进度条（借鉴 tool-ui Question Flow ProgressBar）
 *
 * 多问题引导时展示：每节一段，已完成段 accent 填充 + 动画过渡。
 */
function QuestionProgressBar({
  current,
  total,
}: {
  readonly current: number;
  readonly total: number;
}): ReactElement | null {
  const { t } = useTranslation();
  if (total <= 1) return null;
  // 钳制到 [1, total]：调用方语义是「已答题数 + 1」（把当前题也点亮），全部答完时
  // 会算到 total + 1——作为填充进度无碍，但写进 aria-valuenow 会**超过
  // aria-valuemax**（违反 ARIA 要求 valuenow ≤ valuemax）。钳制后视觉不变
  // （全亮即全亮），且 ARIA 合法。
  const value = Math.min(Math.max(current, 1), total);
  return (
    <div
      className="flex h-1.5 gap-1"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={t('agent.askProgress')}
    >
      {Array.from({ length: total }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 分节纯静态视觉，无重排/状态场景
        <div key={i} className="bg-muted relative flex-1 overflow-hidden rounded-full">
          <div
            className={cn(
              // accent 填充（与导航圆点/热力图/骨架屏等进度类视觉一致；此前 bg-primary 与注释「accent 填充」不符）
              'bg-accent absolute inset-0 origin-left rounded-full transition-transform duration-300',
              i < value ? 'scale-x-100' : 'scale-x-0',
            )}
          />
        </div>
      ))}
    </div>
  );
}

/** Agent 提问对话框（队列队头呈现：FIFO 先问先答，出队后下一条自动上浮） */
export function AskDialog(): ReactElement | null {
  const { t } = useTranslation();
  // 会话归属校验在 selector 内完成（多会话并发时只看当前激活会话的提问）
  const activeSessionId = useActiveSessionStore((s) => s.activeSessionId);
  // 队头提问（见 useAskState 说明）
  const {
    sessionId: askSessionId,
    askId,
    questions,
    receivedAt,
    removeAsk,
  } = useAskState(activeSessionId);
  // 超时倒计时（hook 在 early return 前调用；无提问时 active=false 内部短路）
  const timeout = useAskCountdown(receivedAt, askId !== null);
  // 回答状态机（模块级 useAskAnswers：answers/submitting + 初始化 + 交互与提交）
  const { answers, submitting, toggleOption, setText, handleSubmit } = useAskAnswers({
    askId,
    questions,
    removeAsk,
  });

  // 无本会话提问时不渲染（队列由 store 持有，其他会话的提问在各自会话下呈现）
  const open = askId !== null && askSessionId !== null;
  if (!open) {
    return null;
  }

  const handleCancel = (): void => {
    // 取消 = 回传空回答（LLM 按「用户未选择」继续）。
    // 与「提交失败」区分：用户意图是离开，无论 IPC 成败都出队，
    // 否则关闭按钮失灵会把用户锁在弹窗里（且阻塞队列后续提问）。
    if (hasIpcBridge() && askId !== null) {
      void respondAgentAsk({ askId, answers: [] }).catch(() => {
        // 取消回传失败：主进程 60s 超时兜底，UI 不再阻塞用户
      });
    }
    if (askId !== null) {
      removeAsk(askId);
    }
  };

  return (
    // Radix Dialog：Esc/遮罩关闭 = 取消（回传空回答，与按钮取消同语义）；
    // 自带焦点陷阱/滚动锁定/动画，替代此前自研 fixed 浮层
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void handleCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="bg-card max-h-[80vh] w-full max-w-lg gap-0 overflow-y-auto p-0"
        onEscapeKeyDown={(event) => {
          // 提交中禁 Esc（避免半提交态被取消路径覆盖）
          if (submitting) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (submitting) event.preventDefault();
        }}
      >
        {/* sr-only 标题：满足 Radix 无障碍契约（视觉标题在下方头部行） */}
        <DialogTitle className="sr-only">{t('agent.askTitle')}</DialogTitle>

        {/* 头部 */}
        <div className="border-border flex items-center gap-2 border-b px-4 py-3">
          <span className="bg-primary/10 text-accent-text flex size-5 items-center justify-center rounded text-2xs font-bold">
            ?
          </span>
          <span className="text-foreground text-sm font-semibold">{t('agent.askTitle')}</span>
          {/* 超时倒计时（38 号阶段 2 收尾：60s 未回答自动继续对用户可见；最后 10 秒警示） */}
          <span
            className={cn(
              'ml-auto font-mono text-2xs',
              timeout.expiring ? 'text-warn-text' : 'text-muted-foreground',
            )}
          >
            {timeout.expiring && <span className="mr-1">{t('agent.askExpiresSoon')}·</span>}
            {t('agent.askTimeoutHint', { seconds: timeout.secondsLeft })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:bg-muted hover:text-foreground size-6"
            aria-label={t('common.close')}
            onClick={() => void handleCancel()}
          >
            <X className="size-3.5" />
          </Button>
        </div>

        {/* 多问题引导进度条（tool-ui Question Flow 借鉴） */}
        <div className="px-4 pt-3">
          <QuestionProgressBar
            current={
              answers.filter((a) => a.selectedIndexes.length > 0 || a.text !== '').length + 1
            }
            total={questions.length}
          />
        </div>

        {/* 问题列表 */}
        <div className="flex flex-col gap-4 p-4">
          {questions.map((q, qIndex) => (
            <div key={`${askId}-${q.question}`}>
              {q.header !== undefined && (
                <p className="text-muted-foreground text-2xs uppercase tracking-wide">{q.header}</p>
              )}
              <p className="text-foreground mt-0.5 text-sm leading-relaxed">{q.question}</p>

              {/* 选项 */}
              {q.options !== undefined && q.options.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {q.options.map((opt, optIndex) => {
                    const selected = answers[qIndex]?.selectedIndexes.includes(optIndex) ?? false;
                    return (
                      <Button
                        key={`${askId}-${q.question}-${opt.label}`}
                        variant="outline"
                        size="sm"
                        onClick={() => toggleOption(qIndex, optIndex)}
                        className={cn(
                          'group relative w-full justify-start gap-2.5 rounded-lg border px-3 py-2 text-left text-xs font-normal',
                          selected
                            ? 'bg-primary/10 border-primary/40'
                            : 'border-border bg-background hover:bg-muted/40',
                        )}
                      >
                        {/* hover 背景层（对齐 tool-ui Question Flow OptionItem） */}
                        <span
                          className={cn(
                            'bg-primary/5 absolute inset-0 -m-0.5 rounded-xl opacity-0 transition-opacity group-hover:opacity-100',
                            selected && 'opacity-0',
                          )}
                          aria-hidden="true"
                        />
                        <span
                          className={cn(
                            'relative flex size-4 shrink-0 items-center justify-center rounded border text-2xs',
                            selected
                              ? 'bg-primary border-primary text-primary-foreground'
                              : 'border-border text-transparent group-hover:border-primary/40',
                          )}
                        >
                          ✓
                        </span>
                        <span className="relative min-w-0 flex-1">
                          <span className="text-foreground block">{opt.label}</span>
                          {opt.description !== undefined && (
                            <span className="text-muted-foreground relative block text-2xs">
                              {opt.description}
                            </span>
                          )}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              )}

              {/* 自由输入：placeholder 带上题号作可访问名——多问时所有输入框若共用
                  「自由回答」，读屏用户无法分辨当前焦点属于哪一问 */}
              <Input
                type="text"
                value={answers[qIndex]?.text ?? ''}
                onChange={(e) => setText(qIndex, e.target.value)}
                placeholder={t('agent.askFreeInputFor', { n: qIndex + 1 })}
                aria-label={t('agent.askFreeInputFor', { n: qIndex + 1 })}
                className="mt-2 h-8 text-xs"
              />
            </div>
          ))}
        </div>

        {/* 底部操作 */}
        <div className="border-border flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={() => void handleCancel()}
            className="text-muted-foreground text-xs"
          >
            {t('agent.askCancel')}
          </Button>
          <Button
            size="sm"
            disabled={submitting}
            onClick={() => void handleSubmit()}
            className="gap-1 text-xs"
          >
            {t('agent.askSubmit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
