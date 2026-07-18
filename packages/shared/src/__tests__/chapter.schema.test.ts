// packages/shared/src/__tests__/chapter.schema.test.ts
import { describe, expect, it } from 'vitest';
import {
  ChapterCreateInputSchema,
  ChapterSchema,
  ChapterUpdateInputSchema,
} from '../schemas/chapter.schema';

describe('ChapterSchema', () => {
  const validChapter = {
    id: 'clxxx',
    projectId: 'clp1',
    volumeId: null,
    title: '第一章 开端',
    content: '那是一个风雨交加的夜晚……',
    wordCount: 12,
    status: 'DRAFT',
    sortOrder: 0,
    metadata: {},
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
  };

  it('接受合法章节', () => {
    expect(ChapterSchema.parse(validChapter)).toEqual(validChapter);
  });

  it('拒绝负的 wordCount', () => {
    expect(() => ChapterSchema.parse({ ...validChapter, wordCount: -1 })).toThrow();
  });

  it('拒绝负的 sortOrder', () => {
    expect(() => ChapterSchema.parse({ ...validChapter, sortOrder: -1 })).toThrow();
  });
});

describe('ChapterCreateInputSchema', () => {
  it('projectId + title 必填', () => {
    const parsed = ChapterCreateInputSchema.parse({
      projectId: 'clp1',
      title: '新章',
    });
    expect(parsed.title).toBe('新章');
  });

  it('缺 projectId 应拒绝', () => {
    expect(() => ChapterCreateInputSchema.parse({ title: '新章' })).toThrow();
  });

  it('content 默认空字符串', () => {
    const parsed = ChapterCreateInputSchema.parse({
      projectId: 'clp1',
      title: '新章',
    });
    expect(parsed.content).toBe('');
  });
});

describe('ChapterUpdateInputSchema', () => {
  it('id 必填', () => {
    expect(() => ChapterUpdateInputSchema.parse({ title: 'X' })).toThrow();
  });

  it('接受部分更新', () => {
    const parsed = ChapterUpdateInputSchema.parse({
      id: 'clxxx',
      content: '新内容',
    });
    expect(parsed.content).toBe('新内容');
  });
});
