import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { LearnSkillService } from '../infra/ai/knowledge/learn-skill-agent';
import { llmClient } from '../infra/ai/llm-client/ai-provider';
import { skillRegistry } from '../infra/ai/skills/skill-registry';
import type { IpcHandlerContext } from '../utils/wrap';

/** 技能域 handler 实现（依赖模块级 skillRegistry 单例 + LearnSkillService） */
export const skillHandlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['skill'] = {
  list: async () => {
    const skills = skillRegistry.list();
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
    };
  },

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

  listLearned: async () => {
    const service = new LearnSkillService(llmClient);
    return service.listLearned().map((skill) => ({
      name: skill.name,
      description: skill.description,
      prompt: skill.prompt,
    }));
  },

  removeLearned: async (input) => {
    const service = new LearnSkillService(llmClient);
    return { removed: service.remove(input.name) };
  },
};
