// src/main/infra/ai/skills/skill-registry.test.ts
// 技能注册表单测：内置技能列表/加载/注册

import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../tool';
import { createLoadSkillTool } from '../tools/load-skill.tool';
import { SkillRegistry, skillRegistry } from './skill-registry';

describe('SkillRegistry', () => {
  it('内置技能：list 按名排序且非空', () => {
    const registry = new SkillRegistry();
    const skills = registry.list();
    expect(skills.length).toBeGreaterThanOrEqual(4);
    expect(skills[0]?.name).toBe('code_review');
    // 按名排序
    const names = skills.map((s) => s.name);
    expect(names).toEqual([...names].sort());
  });

  it('load：按名加载技能（含 prompt）', () => {
    const registry = new SkillRegistry();
    const skill = registry.load('code_review');
    expect(skill?.description).toContain('系统化审查');
    expect(skill?.prompt.length).toBeGreaterThan(50);
  });

  it('load 不存在：返回 undefined', () => {
    const registry = new SkillRegistry();
    expect(registry.load('nonexistent')).toBeUndefined();
  });

  it('register：覆盖同名技能', () => {
    const registry = new SkillRegistry();
    registry.register({
      name: 'code_review',
      description: '自定义审查',
      prompt: '自定义提示词',
    });
    expect(registry.load('code_review')?.description).toBe('自定义审查');
  });
});

describe('load_skill 工具', () => {
  const tool = createLoadSkillTool(skillRegistry);
  const ctx = {} as ToolContext;

  it('加载存在的技能：返回技能提示词', async () => {
    const result = await tool.execute({ name: 'debugging' }, ctx);
    expect(result.output).toContain('系统化调试');
    expect(result.output).toContain('【技能：debugging】');
  });

  it('加载不存在的技能：返回可用技能列表', async () => {
    const result = await tool.execute({ name: 'nonexistent' }, ctx);
    expect(result.output).toContain('不存在');
    expect(result.output).toContain('code_review');
  });

  it('工具元数据：只读自动放行', () => {
    expect(tool.permission).toBe('auto');
    expect(tool.category).toBe('read');
  });
});
