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

/** 剩余秒数（向上取整 + 归零兜底）；模块级纯函数，身份稳定不进 hook 依赖 */
function secondsUntil(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
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
  const deadline = receivedAt + ASK_TIMEOUT_SECONDS * 1000;
  const [secondsLeft, setSecondsLeft] = useState(() => secondsUntil(deadline));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setSecondsLeft(secondsUntil(deadline));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active, deadline]);
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
  const { getErrorMessage } = useErrorMessage();
  const [answers, setAnswers] = useState<AnswerState[]>([]);
  const [submitting, setSubmitting] = useState(false);

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
      removeAsk(askId);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? unwrapErrorMessage(error, getErrorMessage)
          : t('agent.askSubmitFailed'),
      );
    }
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
  const activeSessionId = useActiveSessionStore((s) => s.activeSessionId);
  const {
    sessionId: askSessionId,
    askId,
    questions,
    receivedAt,
    removeAsk,
  } = useAskState(activeSessionId);
  const timeout = useAskCountdown(receivedAt, askId !== null);
  const { answers, submitting, toggleOption, setText, handleSubmit } = useAskAnswers({
    askId,
    questions,
    removeAsk,
  });

  const open = askId !== null && askSessionId !== null;
  if (!open) {
    return null;
  }

  const handleCancel = (): void => {
    if (hasIpcBridge() && askId !== null) {
      void respondAgentAsk({ askId, answers: [] }).catch(() => {});
    }
    if (askId !== null) {
      removeAsk(askId);
    }
  };

  return (
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
          if (submitting) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (submitting) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">{t('agent.askTitle')}</DialogTitle>

        <div className="border-border flex items-center gap-2 border-b px-4 py-3">
          <span className="bg-primary/10 text-accent-text flex size-5 items-center justify-center rounded text-2xs font-bold">
            ?
          </span>
          <span className="text-foreground text-sm font-semibold">{t('agent.askTitle')}</span>
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

        <div className="px-4 pt-3">
          <QuestionProgressBar
            current={
              answers.filter((a) => a.selectedIndexes.length > 0 || a.text !== '').length + 1
            }
            total={questions.length}
          />
        </div>

        <div className="flex flex-col gap-4 p-4">
          {questions.map((q, qIndex) => (
            <div key={`${askId}-${q.question}`}>
              {q.header !== undefined && (
                <p className="text-muted-foreground text-2xs uppercase tracking-wide">{q.header}</p>
              )}
              <p className="text-foreground mt-0.5 text-sm leading-relaxed">{q.question}</p>

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
