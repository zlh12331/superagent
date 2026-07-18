// packages/shared/src/__tests__/character.schema.test.ts
import { describe, expect, it } from 'vitest';
import {
  CharacterCreateInputSchema,
  CharacterRelationInputSchema,
  CharacterSchema,
} from '../schemas/character.schema';

describe('CharacterSchema', () => {
  const valid = {
    id: 'clxxx',
    projectId: 'clp1',
    name: '林若曦',
    avatar: null,
    role: 'PROTAGONIST',
    description: '女主角，性格坚韧',
    profile: { age: 18, weapon: '青锋剑' },
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
  };

  it('接受合法人物', () => {
    expect(CharacterSchema.parse(valid)).toEqual(valid);
  });

  it('拒绝 name 超过 100 字符', () => {
    expect(() => CharacterSchema.parse({ ...valid, name: 'a'.repeat(101) })).toThrow();
  });

  it('拒绝非法 role', () => {
    expect(() => CharacterSchema.parse({ ...valid, role: 'HERO' })).toThrow();
  });
});

describe('CharacterCreateInputSchema', () => {
  it('projectId + name 必填', () => {
    const parsed = CharacterCreateInputSchema.parse({
      projectId: 'clp1',
      name: '苏墨白',
    });
    expect(parsed.name).toBe('苏墨白');
    expect(parsed.role).toBe('SUPPORTING');
  });

  it('role 可选，缺省为 SUPPORTING', () => {
    const parsed = CharacterCreateInputSchema.parse({
      projectId: 'clp1',
      name: '路人甲',
    });
    expect(parsed.role).toBe('SUPPORTING');
  });
});

describe('CharacterRelationInputSchema', () => {
  it('拒绝自环关系（from == to）', () => {
    expect(() =>
      CharacterRelationInputSchema.parse({
        fromCharacterId: 'c1',
        toCharacterId: 'c1',
        type: '朋友',
      }),
    ).toThrow();
  });

  it('接受合法关系', () => {
    const parsed = CharacterRelationInputSchema.parse({
      fromCharacterId: 'c1',
      toCharacterId: 'c2',
      type: '师徒',
      description: '林若曦拜苏墨白为师',
    });
    expect(parsed.type).toBe('师徒');
  });
});
