// src/main/ipc/skill.handler.ts
// 技能域 IPC handler（skill:list，定义表驱动）
// ──────────────────────────────────────────────────────────────
// 实现 1 个请求-响应方法：
// - skill:list  列出全部可用技能（设置页/提示面板展示）

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { LearnSkillService } from '../infra/ai/knowledge/learn-skill-agent';
import { llmClient } from '../infra/ai/llm-client/ai-provider';
import { skillRegistry } from '../infra/ai/skills/skill-registry';
import type { IpcHandlerContext } from '../utils/wrap';

/** 技能域 handler 实现（依赖模块级 skillRegistry 单例 + LearnSkillService） */
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

  // 学习技能：用户输入 → LLM 提炼 → 持久化 + 动态注册
  learn: async (input) => {
    const service = new LearnSkillService(llmClient);
    const result = await service.learn(input.rawInput);
    return {
      name: result.skill.name,
      description: result.skill.description,
      prompt: result.skill.prompt,
      replaced: result.replaced,
    };
  },

  // 列出已学习技能（skills 表）
  listLearned: async () => {
    const service = new LearnSkillService(llmClient);
    return service.listLearned().map((skill) => ({
      name: skill.name,
      description: skill.description,
      prompt: skill.prompt,
    }));
  },

  // 删除已学习技能
  removeLearned: async (input) => {
    const service = new LearnSkillService(llmClient);
    return { removed: service.remove(input.name) };
  },
};
