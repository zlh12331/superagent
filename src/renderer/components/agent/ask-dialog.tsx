// src/renderer/components/agent/ask-dialog.tsx
// Agent 提问对话框（ask_user_question 工具的渲染层 UI）
// ──────────────────────────────────────────────────────────────
// - 展示 Agent 提出的问题（可带预置选项，单选/多选）
// - 用户点选选项 + 自由输入文本 → agent:ask:respond 回传
// - 取消：回传空回答（LLM 按「用户未选择」继续）
// - 浏览器模式守卫：无 window.api 时直接关闭
// ──────────────────────────────────────────────────────────────

import { X } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useAgentAskStore } from '@/stores/transient/agent-ask-store';

/** 单选答案记录 */
interface AnswerState {
  readonly selectedIndexes: number[];
  readonly text: string;
}

/** 回答载荷：仅带非空字段（单选索引/自由文本二选一或并存） */
function toAnswerPayload(a: AnswerState): { selectedIndexes?: number[]; text?: string } {
  return {
    ...(a.selectedIndexes.length > 0 ? { selectedIndexes: [...a.selectedIndexes] } : {}),
    ...(a.text !== '' ? { text: a.text } : {}),
  };
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
  return (
    <div
      className="flex h-1.5 gap-1"
      role="progressbar"
      aria-valuenow={current}
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
              i < current ? 'scale-x-100' : 'scale-x-0',
            )}
          />
        </div>
      ))}
    </div>
  );
}

/** Agent 提问对话框 */
export function AskDialog(): ReactElement | null {
  const { t } = useTranslation();
  const { sessionId: askSessionId, askId, questions, clearAsk } = useAgentAskStore();
  const [answers, setAnswers] = useState<AnswerState[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // 会话归属校验：多会话并发回合时，仅渲染当前激活会话的提问（防后台回合串扰前台弹窗）
  const activeSessionId = useActiveSessionStore((s) => s.activeSessionId);

  // 新提问到达时初始化回答状态
  useEffect(() => {
    if (askId !== null) {
      setAnswers(questions.map(() => ({ selectedIndexes: [], text: '' })));
      setSubmitting(false);
    }
  }, [askId, questions]);

  // 非当前会话的提问不渲染（askSessionId 为 null 的旧数据照常显示，向后兼容）
  const open = askId !== null && (askSessionId === null || askSessionId === activeSessionId);
  if (!open) {
    return null;
  }

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
    if (typeof window === 'undefined' || window.api === undefined || askId === null) {
      clearAsk();
      return;
    }
    setSubmitting(true);
    try {
      // 错误响应由 unwrap 抛 [CODE] message；异常走下方 catch 统一提示
      unwrap(await window.api.agent.respondAsk({ askId, answers: answers.map(toAnswerPayload) }));
    } catch (err) {
      // 区分 IPC 错误响应（已含具体原因）与异常（回退通用提交失败文案）
      const isIpcError = err instanceof Error && /^\[[A-Z_]+\]/.test(err.message);
      toast.error(isIpcError ? err.message : t('agent.askSubmitFailed'));
    }
    // finally 语义（React Compiler 不优化 try/finally）：catch 不 rethrow，
    // 成功/失败路径统一在这里关闭弹窗并复位提交态
    clearAsk();
    setSubmitting(false);
  };

  const handleCancel = (): void => {
    // 取消 = 回传空回答（LLM 按「用户未选择」继续执行）
    void handleSubmit();
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
          <button
            type="button"
            onClick={() => void handleCancel()}
            className="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto flex size-6 cursor-pointer items-center justify-center rounded"
            aria-label={t('common.close')}
          >
            <X className="size-3.5" />
          </button>
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
                      <button
                        key={`${askId}-${q.question}-${opt.label}`}
                        type="button"
                        onClick={() => toggleOption(qIndex, optIndex)}
                        className={cn(
                          'group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-xs transition-colors',
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
                      </button>
                    );
                  })}
                </div>
              )}

              {/* 自由输入 */}
              <Input
                type="text"
                value={answers[qIndex]?.text ?? ''}
                onChange={(e) => setText(qIndex, e.target.value)}
                placeholder={t('agent.askFreeInput')}
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
