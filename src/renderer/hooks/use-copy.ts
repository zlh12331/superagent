// src/renderer/hooks/use-copy.ts
// 剪贴板复制统一反馈 hook（一致性审计收敛项）
// ──────────────────────────────────────────────
// 统一此前三处各自实现的「copied state + 定时器复位」模式，并补上
// 此前静默丢失的失败反馈（clipboard 不可用/写入失败 → toast）。
// 需要 toast 形态反馈的场景（如远程令牌）直接用 toast，不走本 hook。
// ──────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@/i18n/use-translation';

/** 复制反馈 hook 返回：copied 反馈态 + copy 动作 */
export interface UseCopyResult {
  /** 最近一次复制是否处于「已复制」反馈期（2 秒后自动复位） */
  readonly copied: boolean;
  /** 复制文本：成功进入反馈期；失败 toast 提示（不再静默） */
  readonly copy: (text: string) => Promise<void>;
}

/**
 * 剪贴板复制 hook（全仓统一入口）：成功进入 2 秒「已复制」反馈期，失败 toast；
 * 卸载时清理反馈定时器
 */
export function useCopy(): UseCopyResult {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const copy = async (text: string): Promise<void> => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      toast.error(t('common.copyFailed'));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, 2000);
    } catch {
      toast.error(t('common.copyFailed'));
    }
  };

  return { copied, copy };
}
