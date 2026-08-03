// src/renderer/hooks/use-file-write.ts
// 文件写入 hook（L3 服务端请求状态层 - mutation）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 通过 TanStack Query mutation 调用 file:write IPC
// - 保存成功后失效对应文件的 read 缓存（保证下次打开是最新内容）
// - 失败时保留编辑态内容，提示用户重试
//
// 设计依据（项目规范）：
// - "Server state from IPC `invoke` (request-response) must use TanStack Query
//    for caching, invalidation, and race condition handling"
// - 写操作走 mutation，不污染 query 缓存，但成功后需 invalidate read 缓存
// ──────────────────────────────────────────────────────────────

import type { FileWriteReq, FileWriteRes } from '@code-agent/shared/renderer';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

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
  const queryClient = useQueryClient();

  return useMutation<FileWriteRes, Error, FileWriteReq>({
    mutationFn: async (input: FileWriteReq): Promise<FileWriteRes> => {
      // E2E 浏览器模式下 window.api 未注入
      if (typeof window === 'undefined' || window.api === undefined) {
        return { bytesWritten: input.content.length };
      }
      const response = await window.api.file.write(input);
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      throw new Error('Unexpected response: missing data and error');
    },
    onSuccess: (_data, variables) => {
      // 失效对应文件路径的 read 缓存，保证下次打开是最新内容
      queryClient.invalidateQueries({
        queryKey: FILE_CONTENT_QUERY_KEY(variables.path),
      });
    },
    onError: (error) => {
      toast.error('保存失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
