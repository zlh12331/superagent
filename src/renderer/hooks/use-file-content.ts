import type { FileReadRes } from '@code-agent/shared/renderer';
import { useQuery } from '@tanstack/react-query';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

/** 文件内容 query key 工厂（保持 queryKey 一致性，便于失效） */
export const FILE_CONTENT_QUERY_KEY = (path: string) => ['file', path] as const;

/**
 * 文件内容查询 hook
 *
 * 调用 file:read IPC 获取文件文本内容（UTF-8 解码）。
 * filePath 为 null 时跳过查询（避免无激活文件时请求）。
 *
 * @param filePath 文件绝对路径（null 时禁用查询）
 * @returns TanStack Query 结果（data: FileReadRes | undefined）
 *
 * @example
 * ```tsx
 * const { data, isLoading, error } = useFileContent(filePath);
 * if (isLoading) return <Loading />;
 * if (error) return <ErrorState />;
 * return <pre>{data?.content}</pre>;
 * ```
 */
export function useFileContent(filePath: string | null) {
  return useQuery({
    queryKey: FILE_CONTENT_QUERY_KEY(filePath ?? 'unknown'),
    queryFn: async (): Promise<FileReadRes> => {
      if (filePath === null) {
        throw new Error('filePath is null');
      }
      if (!hasIpcBridge()) {
        return { content: '', totalLines: 0, encoding: 'utf-8' };
      }
      const response = await window.api.file.read({
        path: filePath,
        offset: undefined,
        limit: undefined,
      });
      return unwrap(response);
    },
    enabled: filePath !== null,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });
}
