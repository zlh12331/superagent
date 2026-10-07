// src/renderer/hooks/use-runtime-models.ts
// 运行时模型管理 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - settings:listRuntimeModels 查询（模型设置页列表数据源）
// - add / update / remove mutation（成功后统一失效本 key + MODELS_QUERY_KEY，
//   保证 ModelSelector 与设置页同源刷新）
// - models:test 连通性测试 mutation（只读探测，不失效任何缓存）
// ──────────────────────────────────────────────────────────────

import type {
  ApiKeyProvider,
  ListRuntimeModelsRes,
  TestModelRes,
} from '@code-agent/shared/renderer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { hasIpcBridge, unwrap } from '@/lib/ipc';
import { MODELS_QUERY_KEY } from './use-models';
import { useMutationOnError } from './use-mutation-error';

/** 运行时模型列表查询 key（模型设置页列表） */
export const RUNTIME_MODELS_QUERY_KEY = ['settings', 'runtime-models'] as const;

/** 运行时模型查询（浏览器模式无 window.api 时降级空列表） */
export function useRuntimeModelsQuery() {
  return useQuery({
    queryKey: RUNTIME_MODELS_QUERY_KEY,
    queryFn: async (): Promise<ListRuntimeModelsRes> => {
      if (!hasIpcBridge()) {
        return { models: [] };
      }
      return unwrap<ListRuntimeModelsRes>(await window.api.settings.listRuntimeModels());
    },
  });
}

/** 新增入参（表单字段；与 addRuntimeModel 契约对齐；null = 未设置，等价省略） */
export interface AddRuntimeModelInput {
  readonly modelId: string;
  readonly providerKind: ApiKeyProvider;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly displayName?: string;
  /** 单回合总时长上限（毫秒；省略或 null = 不限制） */
  readonly timeoutMs?: number | null;
}

/** 新增 mutation：成功后失效运行时模型 key + 全局模型清单 key */
export function useAddRuntimeModel() {
  const queryClient = useQueryClient();
  const onError = useMutationOnError();
  return useMutation({
    mutationFn: async (input: AddRuntimeModelInput) => {
      if (window.api === undefined) return;
      unwrap(
        await window.api.settings.addRuntimeModel({
          modelId: input.modelId,
          providerKind: input.providerKind,
          ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
          ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          // null 与省略同义（add 契约无「清除」形态——新记录本就无旧值可清）
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        }),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RUNTIME_MODELS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
    onError,
  });
}

/** 编辑/启停入参（partial 语义：省略字段不修改；timeoutMs 另支持 null = 清除） */
export interface UpdateRuntimeModelInput {
  readonly modelId: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  /** 三态：省略 = 不修改，null = 清除（回不限制），number = 设置 */
  readonly timeoutMs?: number | null;
  readonly isEnabled?: boolean;
}

/** 编辑/启停 mutation：成功后失效运行时模型 key + 全局模型清单 key */
export function useUpdateRuntimeModel() {
  const queryClient = useQueryClient();
  const onError = useMutationOnError();
  return useMutation({
    mutationFn: async (input: UpdateRuntimeModelInput) => {
      if (window.api === undefined) return;
      unwrap(
        await window.api.settings.updateRuntimeModel({
          modelId: input.modelId,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
          ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
          // null !== undefined：条件展开不会误吞清除语义
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        }),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RUNTIME_MODELS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
    onError,
  });
}

/** 删除 mutation：成功后失效运行时模型 key + 全局模型清单 key */
export function useRemoveRuntimeModel() {
  const queryClient = useQueryClient();
  const onError = useMutationOnError();
  return useMutation({
    mutationFn: async (modelId: string) => {
      if (window.api === undefined) return;
      unwrap(await window.api.settings.removeRuntimeModel({ modelId }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RUNTIME_MODELS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
    onError,
  });
}

/** 连通性测试入参（与 models:test 契约对齐） */
export interface TestModelInput {
  readonly providerKind: ApiKeyProvider;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
}

/**
 * 连通性测试 mutation（只读探测）
 *
 * 浏览器模式降级为失败结果（无主进程可探测）。
 */
export function useTestModel() {
  const onError = useMutationOnError();
  return useMutation({
    mutationFn: async (input: TestModelInput): Promise<TestModelRes> => {
      if (!hasIpcBridge()) {
        return { ok: false, error: 'browser mode' };
      }
      return unwrap<TestModelRes>(
        await window.api.models.test({
          providerKind: input.providerKind,
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
          ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        }),
      );
    },
    onError,
  });
}
