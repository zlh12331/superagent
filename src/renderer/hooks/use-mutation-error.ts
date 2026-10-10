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
