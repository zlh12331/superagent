// src/main/ipc/models.handler.ts
// 模型清单 handler（models:list）
// ──────────────────────────────────────────────────────────────
// 职责：暴露主进程 modelRegistry 真实模型清单（内置 + 运行时合并），
// 渲染层模型选择器数据源——渲染层不再硬编码模型表。
// ──────────────────────────────────────────────────────────────

import type { ModelsListRes } from '@code-agent/shared/main';

import { modelRegistry } from '../infra/ai/models';

/** models 域 handler（定义表驱动，InferHandlers 编译期约束） */
export const modelsHandlers = {
  /** 可用模型清单（内置 + 运行时，主进程单一真源） */
  list: async (): Promise<ModelsListRes> => ({
    models: modelRegistry.listModels().map((m) => ({
      id: m.id,
      label: m.label,
      providerKind: m.providerKind,
      isRuntime: m.isRuntime,
      capabilities: { ...m.capabilities } as Record<string, unknown>,
    })),
  }),
};
