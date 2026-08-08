// src/main/ipc/models.handler.ts
// 模型清单 handler（models:list）
// ──────────────────────────────────────────────────────────────
// 职责：暴露主进程 modelRegistry 中**已配置可用**的模型清单（对齐同类
// 桌面 LLM 客户端：配置好才显示，未配置不出现——没有就是没有）：
// - 运行时自定义模型：自带配置（baseUrl/API Key），始终显示
// - 内置模型：仅当该提供商 API Key 已保存（keychain）才显示
//   （ollama 无 key 概念且无独立配置存储，内置 ollama 模型不显示——
//   用户需要 ollama 时通过「运行时模型」添加，自带 baseUrl 配置）
// ──────────────────────────────────────────────────────────────

import type { ModelsListRes } from '@code-agent/shared/main';

import { modelRegistry } from '../infra/ai/models';
import { getSecret } from '../infra/storage/keychain';

/** models 域 handler（定义表驱动，InferHandlers 编译期约束） */
export const modelsHandlers = {
  /** 已配置可用模型清单（内置需 API Key 已配置 + 运行时全部） */
  list: async (): Promise<ModelsListRes> => {
    const all = modelRegistry.listModels();
    const configured = [];
    for (const m of all) {
      // 运行时模型自带配置：始终可用
      if (m.isRuntime) {
        configured.push(m);
        continue;
      }
      // 内置模型：提供商 API Key 已保存才显示（配置好才出现）
      const apiKey = await getSecret(`${m.providerKind}-api-key`);
      if (apiKey !== null && apiKey !== '') {
        configured.push(m);
      }
    }
    return {
      models: configured.map((m) => ({
        id: m.id,
        label: m.label,
        providerKind: m.providerKind,
        isRuntime: m.isRuntime,
        capabilities: { ...m.capabilities } as Record<string, unknown>,
      })),
    };
  },
};
