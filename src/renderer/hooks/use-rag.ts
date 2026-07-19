// src/renderer/hooks/use-rag.ts
// RAG 领域 hooks（文档 CRUD + 检索）
// 设计文档 §5.1 数据流 + §6 RAG 检索增强
//
// 职责：
// - useRagDocumentList：按 projectId 获取已入库文档列表
// - useIngestRagDocument：上传文档（FileReader 转 text 后通过 fileContent 字符串传输）
// - useDeleteRagDocument：删除文档
// - useRagSearch：检索测试（不缓存，每次都重新调）
// - readFileAsText：工具函数，把 File 包装为 Promise<string>

import type {
  RagDocument,
  RagIngestDocumentInput,
  RagSearchInput,
  RagSearchResultItem,
} from '@novel-writer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import { queryKeys } from '@/api/query-keys';

/**
 * 把 File 读取为文本
 *
 * 用于 RAG 文档上传：FileReader.readAsText 后通过 IPC 字符串传输。
 * 仅支持文本格式文件（.md/.txt/.json），PDF 需主进程侧解析（Phase 9 增强）。
 *
 * @param file - 用户选择的文件
 * @returns 文件文本内容
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result);
      } else {
        reject(new Error('文件读取失败：结果非字符串'));
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('文件读取失败'));
    };
    reader.readAsText(file);
  });
}

/**
 * 获取 RAG 文档列表
 *
 * @param projectId - 项目 ID（为 falsy 时不启用查询）
 */
export function useRagDocumentList(projectId: string | null | undefined) {
  const safeId = projectId ?? '';
  return useQuery({
    queryKey: queryKeys.ragDocuments.list(safeId),
    queryFn: async () =>
      unwrap<RagDocument[]>(await apiClient.rag.listDocuments({ projectId: safeId })),
    enabled: projectId !== undefined && projectId !== null && projectId.length > 0,
  });
}

/**
 * 上传 RAG 文档
 *
 * 入参为 RagIngestDocumentInput（含 fileContent 字符串）。
 * 调用方负责先用 readFileAsText 把 File 转 text。
 * 成功后失效文档列表缓存。
 */
export function useIngestRagDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RagIngestDocumentInput) =>
      unwrap<{ documentId: string; chunksCount: number }>(
        await apiClient.rag.ingestDocument(input),
      ),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: queryKeys.ragDocuments.list(vars.projectId) });
    },
  });
}

/**
 * 删除 RAG 文档
 *
 * 成功后失效文档列表缓存（不确定 projectId，简化处理为失效所有）。
 */
export function useDeleteRagDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap<{ id: string }>(await apiClient.rag.deleteDocument({ id })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.ragDocuments.all });
    },
  });
}

/**
 * RAG 检索（不缓存，每次都重新调）
 *
 * 用于检索测试面板：用户输入查询 + topK + threshold 后点击"搜索"。
 */
export function useRagSearch() {
  return useMutation({
    mutationFn: async (input: RagSearchInput) =>
      unwrap<RagSearchResultItem[]>(await apiClient.rag.search(input)),
  });
}
