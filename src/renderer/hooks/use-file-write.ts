import type { FileWriteReq, FileWriteRes } from '@code-agent/shared/renderer';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTranslation } from '@/i18n/use-translation';
import { hasIpcBridge, unwrap } from '@/lib/ipc';
import { FILE_CONTENT_QUERY_KEY } from './use-file-content';

/**
 * 文件写入 mutation hook
 *
 * 调用 window.api.file.write 写入文件内容（覆盖模式）。
 * 成功后失效对应文件路径的 read 缓存。
 *
 * @example
 * ```tsx
 * const { mutateAsync: saveFile, isPending } = useFileWrite();
 * await saveFile({ path: '/path/to/file.ts', content: '...', append: false, createDirs: false });
 * ```
 */
export function useFileWrite() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<FileWriteRes, Error, FileWriteReq>({
    mutationFn: async (input: FileWriteReq): Promise<FileWriteRes> => {
      if (!hasIpcBridge()) {
        return { bytesWritten: input.content.length };
      }
      const response = await window.api.file.write(input);
      return unwrap(response);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: FILE_CONTENT_QUERY_KEY(variables.path),
      });
    },
    onError: (error) => {
      toast.error(t('common.writeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
