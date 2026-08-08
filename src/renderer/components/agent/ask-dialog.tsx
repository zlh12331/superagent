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
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useAgentAskStore } from '@/stores/transient/agent-ask-store';

/** 单选答案记录 */
interface AnswerState {
  readonly selectedIndexes: number[];
  readonly text: string;
}

/** Agent 提问对话框 */
export function AskDialog(): ReactElement | null {
  const { t } = useTranslation();
  const { askId, questions, clearAsk } = useAgentAskStore();
  const [answers, setAnswers] = useState<AnswerState[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 新提问到达时初始化回答状态
  useEffect(() => {
    if (askId !== null) {
      setAnswers(questions.map(() => ({ selectedIndexes: [], text: '' })));
      setSubmitting(false);
    }
  }, [askId, questions]);

  if (askId === null) {
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
      const res = await window.api.agent.respondAsk({
        askId,
        answers: answers.map((a) => ({
          ...(a.selectedIndexes.length > 0 ? { selectedIndexes: a.selectedIndexes } : {}),
          ...(a.text !== '' ? { text: a.text } : {}),
        })),
      });
      if ('error' in res && res.error !== undefined) {
        toast.error(`[${res.error.code}] ${res.error.message}`);
      }
    } catch {
      toast.error(t('agent.askSubmitFailed'));
    } finally {
      clearAsk();
      setSubmitting(false);
    }
  };

  const handleCancel = (): void => {
    // 取消 = 回传空回答（LLM 按「用户未选择」继续执行）
    void handleSubmit();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
      <div className="bg-card border-border max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg border shadow-lg">
        {/* 头部 */}
        <div className="border-border flex items-center gap-2 border-b px-4 py-3">
          <span className="bg-primary/10 text-primary flex size-5 items-center justify-center rounded text-2xs font-bold">
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

        {/* 问题列表 */}
        <div className="space-y-4 p-4">
          {questions.map((q, qIndex) => (
            <div key={`${askId}-${q.question}`}>
              {q.header !== undefined && (
                <p className="text-muted-foreground text-2xs uppercase tracking-wide">{q.header}</p>
              )}
              <p className="text-foreground mt-0.5 text-sm leading-relaxed">{q.question}</p>

              {/* 选项 */}
              {q.options !== undefined && q.options.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {q.options.map((opt, optIndex) => {
                    const selected = answers[qIndex]?.selectedIndexes.includes(optIndex) ?? false;
                    return (
                      <button
                        key={`${askId}-${q.question}-${opt.label}`}
                        type="button"
                        onClick={() => toggleOption(qIndex, optIndex)}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors',
                          selected
                            ? 'bg-primary/10 border-primary/40'
                            : 'border-border bg-background hover:bg-muted/40',
                        )}
                      >
                        <span
                          className={cn(
                            'flex size-4 shrink-0 items-center justify-center rounded border text-2xs',
                            selected
                              ? 'bg-primary border-primary text-primary-foreground'
                              : 'border-border text-transparent',
                          )}
                        >
                          ✓
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-foreground block">{opt.label}</span>
                          {opt.description !== undefined && (
                            <span className="text-muted-foreground block text-2xs">
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
      </div>
    </div>
  );
}
