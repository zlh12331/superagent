import type {
  ApiKeyProvider,
  ListRuntimeModelsRes,
  ModelApiFormat,
  ModelCapabilitiesOverride,
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
  /** API 协议格式（省略 = 主进程按 kind 默认，即服务商模式） */
  readonly apiFormat?: ModelApiFormat;
  /** 能力覆盖（高级配置手填项；省略 = 未填写，resolve 回退内置清单） */
  readonly capabilities?: ModelCapabilitiesOverride;
}

/** 新增 mutation：成功后失效运行时模型 key + 全局模型清单 key */
export function useAddRuntimeModel() {
  const queryClient = useQueryClient();
  const onError = useMutationOnError();
  return useMutation({
    mutationFn: async (input: AddRuntimeModelInput) => {
      if (window.api === undefined) return;
      unwrap(await window.api.settings.addRuntimeModel(buildAddRequest(input)));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RUNTIME_MODELS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
    onError,
  });
}

/** 表单入参 → addRuntimeModel IPC 请求（条件展开集中一处，mutationFn 保持直线） */
function buildAddRequest(input: AddRuntimeModelInput): {
  readonly modelId: string;
  readonly providerKind: ApiKeyProvider;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly displayName?: string;
  readonly timeoutMs?: number;
  readonly apiFormat?: ModelApiFormat;
  readonly capabilities?: ModelCapabilitiesOverride;
} {
  return {
    modelId: input.modelId,
    providerKind: input.providerKind,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.apiFormat !== undefined ? { apiFormat: input.apiFormat } : {}),
    ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
  };
}

/** 编辑/启停入参（partial 语义：省略字段不修改；timeoutMs 另支持 null = 清除） */
export interface UpdateRuntimeModelInput {
  readonly modelId: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  /** 三态：省略 = 不修改，null = 清除（回不限制），number = 设置 */
  readonly timeoutMs?: number | null;
  /** API 协议格式（省略 = 不修改；仅自定义模式下发） */
  readonly apiFormat?: ModelApiFormat;
  /** 能力覆盖（三态：省略 = 不修改，null = 清除覆盖回退内置清单） */
  readonly capabilities?: ModelCapabilitiesOverride | null;
  readonly isEnabled?: boolean;
}

/** 表单入参 → updateRuntimeModel IPC 请求（条件展开集中一处，mutationFn 保持直线） */
function buildUpdateRequest(input: UpdateRuntimeModelInput): {
  readonly modelId: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number | null;
  readonly apiFormat?: ModelApiFormat;
  readonly capabilities?: ModelCapabilitiesOverride | null;
  readonly isEnabled?: boolean;
} {
  return {
    modelId: input.modelId,
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.apiFormat !== undefined ? { apiFormat: input.apiFormat } : {}),
    ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
    ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
  };
}

/** 编辑/启停 mutation：成功后失效运行时模型 key + 全局模型清单 key */
export function useUpdateRuntimeModel() {
  const queryClient = useQueryClient();
  const onError = useMutationOnError();
  return useMutation({
    mutationFn: async (input: UpdateRuntimeModelInput) => {
      if (window.api === undefined) return;
      unwrap(await window.api.settings.updateRuntimeModel(buildUpdateRequest(input)));
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
  /** API 协议格式（仅自定义模式下发；省略 = 主进程按 kind 默认） */
  readonly apiFormat?: ModelApiFormat;
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
          ...(input.apiFormat !== undefined ? { apiFormat: input.apiFormat } : {}),
        }),
      );
    },
    onError,
  });
}
