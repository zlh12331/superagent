import type { ModelsListRes } from '@code-agent/shared/renderer';
import { useQuery } from '@tanstack/react-query';

import { hasIpcBridge, unwrap } from '@/lib/ipc';

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
      if (!hasIpcBridge()) {
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
      if (!hasIpcBridge()) {
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
