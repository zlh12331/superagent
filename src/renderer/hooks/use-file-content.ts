// src/renderer/hooks/use-file-content.ts
// 文件内容查询 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 通过 TanStack Query 调用 file:read IPC 拉取文件内容
// - 自动处理缓存失效 + 竞态 + 重试（QueryClient 默认配置）
// - 文件路径变化时自动重新查询
//
// 设计依据（项目规范）：
// - "Server state from IPC `invoke` (request-response) must use TanStack Query
//    for caching, invalidation, and race condition handling"
// - file:read 是 IPC invoke（请求-响应），不应在 Zustand 中持久化
//
// 缓存策略：
// - queryKey: ['file', path] - 单个文件内容缓存
// - staleTime: 30s（避免短时间内重复点击同一文件触发重复请求）
// - gcTime: 5min（关闭 Dialog 后 5 分钟内缓存仍可用，再次打开秒开）
// ──────────────────────────────────────────────────────────────

import type { FileReadRes } from '@code-agent/shared/renderer';
import { useQuery } from '@tanstack/react-query';

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
        // enabled: false 时不会执行，类型守卫用
        throw new Error('filePath is null');
      }
      // E2E 浏览器模式下 window.api 未注入
      if (typeof window === 'undefined' || window.api === undefined) {
        return { content: '', totalLines: 0, encoding: 'utf-8' };
      }
      // file:read 入参 schema 中 offset/limit 用了 .optional().transform()，
      // 推断出的类型要求属性必须存在（即使值为 undefined），需显式传入。
      // 详见 project_memory: Zod `.default()` / `.optional().transform()` 字段在 z.infer 中是 required
      const response = await window.api.file.read({
        path: filePath,
        offset: undefined,
        limit: undefined,
      });
      // IpcResponse 是 discriminated union：
      // - 'error' in response → 错误分支，throw 让 query 进入 error 状态
      // - 否则 → data 分支，TS 自动收窄类型
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      throw new Error('Unexpected response: missing data and error');
    },
    // 仅当 filePath 不为 null 时启用查询
    enabled: filePath !== null,
    // 30s 内重复点击同一文件不重新请求
    staleTime: 30_000,
    // 关闭 Dialog 后 5 分钟内缓存仍可用
    gcTime: 5 * 60_000,
  });
}
