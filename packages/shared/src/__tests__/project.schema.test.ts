// packages/shared/src/__tests__/project.schema.test.ts
// Project Zod schema 单元测试
import { describe, expect, it } from 'vitest';
import {
  ProjectCreateInputSchema,
  ProjectSchema,
  ProjectUpdateInputSchema,
} from '../schemas/project.schema';

describe('ProjectSchema', () => {
  const validProject = {
    id: 'clxxxxxxxxxxxxxxxxxxxxxxxxx',
    name: '我的第一本小说',
    description: '一个关于成长的故事',
    genre: '玄幻',
    cover: null,
    status: 'DRAFT',
    metadata: {},
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
    archivedAt: null,
  };

  it('接受合法项目对象', () => {
    expect(ProjectSchema.parse(validProject)).toEqual(validProject);
  });

  it('拒绝空 name', () => {
    expect(() => ProjectSchema.parse({ ...validProject, name: '' })).toThrow();
  });

  it('拒绝 name 超过 200 字符', () => {
    expect(() => ProjectSchema.parse({ ...validProject, name: 'a'.repeat(201) })).toThrow();
  });

  it('拒绝非法 status', () => {
    expect(() => ProjectSchema.parse({ ...validProject, status: 'INVALID' })).toThrow();
  });
});

describe('ProjectCreateInputSchema', () => {
  it('接受最小创建入参（仅 name）', () => {
    const input = { name: '新项目' };
    const parsed = ProjectCreateInputSchema.parse(input);
    expect(parsed.name).toBe('新项目');
  });

  it('trim name 后空字符串应拒绝', () => {
    expect(() => ProjectCreateInputSchema.parse({ name: '   ' })).toThrow();
  });

  it('description 可选', () => {
    const parsed = ProjectCreateInputSchema.parse({ name: 'X', description: 'desc' });
    expect(parsed.description).toBe('desc');
  });

  it('genre 长度上限 50', () => {
    expect(() => ProjectCreateInputSchema.parse({ name: 'X', genre: 'a'.repeat(51) })).toThrow();
  });
});

describe('ProjectUpdateInputSchema', () => {
  it('至少需要 1 个字段', () => {
    expect(() => ProjectUpdateInputSchema.parse({})).toThrow();
  });

  it('id 必填', () => {
    expect(() => ProjectUpdateInputSchema.parse({ name: '新名' })).toThrow();
  });

  it('接受部分更新', () => {
    const parsed = ProjectUpdateInputSchema.parse({ id: 'clxxx', name: '新名' });
    expect(parsed.name).toBe('新名');
    expect(parsed.description).toBeUndefined();
  });
});
