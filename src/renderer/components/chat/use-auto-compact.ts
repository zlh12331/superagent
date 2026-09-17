// src/renderer/components/chat/use-auto-compact.ts
// 长会话自动压缩（实验性，opt-in 默认关闭）
// ──────────────────────────────────────────────
// 背景：分页渲染只裁剪 DOM，UIMessage[] 全量驻留渲染进程内存——超长会话
// 内存无界增长。本 hook 在用户显式开启 experimental.autoCompact 后，于
// 「消息数达阈值 + 回合空闲（status=ready）」时自动触发 session:compact
// （主进程按模型窗口预算裁剪 + 落库，渲染层 setMessages 替换本地态）。
//
// 防循环：压缩后消息数骤降（低于阈值自然不再触发）；即使压缩失败
// （消息数不变），也以触发时刻的消息数推进水位线——同一水位只触发一次，
// 需再增长满一个阈值区间才会重试。
// ──────────────────────────────────────────────

import type { UIMessage } from 'ai';
import { type RefObject, useEffect, useRef } from 'react';

import { useSettingsStore } from '@/stores/persistent/settings-store';

/** 自动压缩触发阈值（消息条数；长会话护栏，实验性默认关闭） */
export const AUTO_COMPACT_THRESHOLD = 600;

/** 回合状态（ChatMessageListProps.status 同款联合；useChat 四态） */
type TurnStatus = 'submitted' | 'streaming' | 'ready' | 'error';

export interface AutoCompactOptions {
  /** 会话 id（切换会话时重置水位线） */
  readonly chatId: string;
  /** 当前消息列表（仅读 length） */
  readonly messages: readonly UIMessage[];
  /** 回合状态 */
  readonly status: TurnStatus;
  /** 触发压缩的回调（ChatPanel 注入 compactMutation.mutate） */
  readonly compact: () => void;
  /** 阈值覆盖（测试用；生产默认 AUTO_COMPACT_THRESHOLD） */
  readonly threshold?: number;
}

/**
 * 长会话自动压缩 hook（实验性）
 *
 * 返回水位线 ref（测试断言用；生产无消费方）。
 */
export function useAutoCompact(options: AutoCompactOptions): {
  watermarkRef: RefObject<number>;
} {
  const { chatId, messages, status, compact, threshold = AUTO_COMPACT_THRESHOLD } = options;
  const enabled = useSettingsStore((s) => s.experimental.autoCompact);
  // 水位线：上次触发（或重置）时的消息数；增长超过阈值才再次触发
  const watermarkRef = useRef(0);

  // 会话切换：水位线归零（新会话从零计量）
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId 只是重置触发信号，effect 体不读取
  useEffect(() => {
    watermarkRef.current = 0;
  }, [chatId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId 只是重置信号（上方 effect 已处理），compact 由调用方稳定注入
  useEffect(() => {
    if (!enabled || status !== 'ready') {
      return;
    }
    const length = messages.length;
    if (length < threshold || length - watermarkRef.current < threshold) {
      return;
    }
    // 触发即推进水位线（无论压缩成败）：同一水位只触发一次，防失败风暴
    watermarkRef.current = length;
    compact();
  }, [enabled, status, messages.length, threshold, compact, chatId]);

  return { watermarkRef };
}
