// src/main/ipc/skill.handler.ts
// 技能域 IPC handler（skill:list，定义表驱动）
// ──────────────────────────────────────────────────────────────
// 实现 1 个请求-响应方法：
// - skill:list  列出全部可用技能（设置页/提示面板展示）

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import { skillRegistry } from '../infra/ai/skills/skill-registry';
import type { IpcHandlerContext } from '../utils/wrap';

/** 技能域 handler 实现（依赖模块级 skillRegistry 单例） */
export const skillHandlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['skill'] = {
  // 列出全部技能
  list: async () => {
    const skills = skillRegistry.list();
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
    };
  },
};
