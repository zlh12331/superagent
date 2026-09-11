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

import { unwrap } from '@/lib/ipc';

/** 模型清单查询 key（全局共享：ModelSelector / ModelsSection 等） */
export const MODELS_QUERY_KEY = ['models', 'list'] as const;

/** 厂商内置模型清单 key（按厂商区分；未指定厂商为 'all'） */
export const BUILTIN_MODELS_QUERY_KEY = (providerKind: string | undefined) =>
  ['models', 'listBuiltin', providerKind ?? 'all'] as const;

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
      return unwrap(response);
    },
  });
}

/**
 * 厂商内置模型全集查询（models:listBuiltin IPC）
 *
 * 配置页下拉数据源：不做 keychain 过滤（未配置厂商也能看到全部官方模型）。
 * providerKind 随 queryKey 变化自动重查；浏览器模式降级空列表。
 */
export function useBuiltinModelsQuery(providerKind: string | undefined) {
  return useQuery({
    queryKey: BUILTIN_MODELS_QUERY_KEY(providerKind),
    queryFn: async (): Promise<ModelsListRes> => {
      if (typeof window === 'undefined' || window.api === undefined) {
        return { models: [] };
      }
      const response = await window.api.models.listBuiltin({
        ...(providerKind !== undefined
          ? { providerKind: providerKind as ModelsListRes['models'][number]['providerKind'] }
          : {}),
      });
      return unwrap(response);
    },
  });
}
