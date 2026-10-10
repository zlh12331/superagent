import { z } from 'zod';
import { t } from '../../i18n';
import type { SkillRegistry } from '../skills/skill-registry';
import type { Tool, ToolContext, ToolResult } from './tool';

/** load_skill 入参 */
const LoadSkillInputSchema = z.object({
  /** 技能名（skill:list 可查） */
  name: z.string().min(1).max(100),
});

type LoadSkillInput = z.infer<typeof LoadSkillInputSchema>;

/**
 * 创建 load_skill 工具（依赖 SkillRegistry 注入）
 */
export function createLoadSkillTool(skills: SkillRegistry): Tool<LoadSkillInput> {
  return {
    name: 'load_skill',
    description:
      '加载一个可复用技能（代码审查/重构/调试/提交信息等）的提示词到当前上下文。技能名可通过 skill:list 查询。',
    inputSchema: LoadSkillInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: LoadSkillInput, _ctx: ToolContext): Promise<ToolResult> => {
      const skill = skills.load(input.name);
      if (skill === undefined) {
        return {
          title: t('tools.loadSkill.notFound', { name: input.name }),
          output: `技能 "${input.name}" 不存在。可用技能：${skills
            .list()
            .map((s) => s.name)
            .join(', ')}`,
        };
      }
      return {
        title: t('tools.loadSkill.loaded', { name: skill.name }),
        output: `【技能：${skill.name}】${skill.description}\n\n${skill.prompt}`,
      };
    },
  };
}
