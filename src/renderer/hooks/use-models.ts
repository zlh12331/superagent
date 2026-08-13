// src/renderer/hooks/use-models.ts
// 模型清单查询 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// P3 修复：ModelSelector 与 ModelsSection 此前各自拉取 models:list
// （一 useQuery 一 useState），新增运行时模型后 composer 下拉 30s 内
// 不刷新——双实现不互通。此处收敛为单一 queryKey + 查询 hook，
// 增删 runtime model 的 mutation 统一 invalidate 共享 key。
// ──────────────────────────────────────────────────────────────

import type { ModelsListRes } from '@code-agent/shared/renderer';
import { useQuery } from '@tanstack/react-query';

/** 模型清单查询 key（全局共享：ModelSelector / ModelsSection 等） */
export const MODELS_QUERY_KEY = ['models', 'list'] as const;

/**
 * 模型清单查询（models:list IPC）
 *
 * 主进程 modelRegistry 真实清单（内置 + 运行时合并），渲染层零硬编码。
 * 浏览器模式（无 window.api）降级为空列表。
 */
export function useModelsQuery() {
  return useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: async (): Promise<ModelsListRes> => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { models: [] };
      }
      const response = await window.api.models.list();
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      throw new Error('Unexpected response');
    },
  });
}
