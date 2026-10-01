// src/renderer/hooks/use-mutation-error.ts
// mutation 失败反馈共享 hook（useMutation onError 单一真源）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 收敛「mutation 失败 → sonner toast」的重复实现（原 use-remote-control /
//   use-runtime-models 各持一份逐字相同的局部工厂）
// - 错误经 unwrapErrorMessage 的 [CODE] 前缀解析为本地化文案，杜绝静默失败
// 适用边界：onError 恰为纯 toast 语义的 mutation 直接复用；含回滚/自定义
// 文案等附加逻辑的调用点保持各自实现，不强行套用。
// ──────────────────────────────────────────────────────────────

import { toast } from 'sonner';

import { useErrorMessage } from '@/i18n/use-translation';
import { unwrapErrorMessage } from '@/lib/ipc';

/** mutation 失败反馈（一致性收敛：错误经 [CODE] 解析本地化，杜绝静默失败） */
export function useMutationOnError(): (error: Error) => void {
  const { getErrorMessage } = useErrorMessage();
  return (error: Error): void => {
    toast.error(unwrapErrorMessage(error, getErrorMessage));
  };
}
