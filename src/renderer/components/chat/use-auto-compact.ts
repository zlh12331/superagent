import type { UIMessage } from 'ai';
import { type RefObject, useEffect, useRef } from 'react';

import { useSettingsStore } from '@/stores/persistent/settings-store';

/** 自动压缩触发阈值（消息条数；长会话护栏，实验性默认关闭） */
export const AUTO_COMPACT_THRESHOLD = 600;

/** 回合状态（ChatMessageListProps.status 同款联合；useChat 四态） */
type TurnStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/** 自动压缩 hook 选项（chatId/messages/status/compact 回调与测试阈值覆盖） */
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
  const watermarkRef = useRef(0);

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
    watermarkRef.current = length;
    compact();
  }, [enabled, status, messages.length, threshold, compact, chatId]);

  return { watermarkRef };
}
