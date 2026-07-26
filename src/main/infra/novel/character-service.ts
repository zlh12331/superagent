// src/main/infra/novel/character-service.ts
// 角色 + 角色关系 CRUD
// ──────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../storage/db';
import {
  type CharacterInsert,
  type CharacterRelationshipInsert,
  characterRelationships,
  type CharacterRow,
  characters,
} from '../storage/schema';
import type { CharacterRelationshipDetail } from './types';

// ── 角色 ─────────────────────────────────

export function listCharacters(projectId: string): CharacterRow[] {
  const db = getDb();
  return db
    .select()
    .from(characters)
    .where(eq(characters.projectId, projectId))
    .orderBy(characters.createdAt)
    .all();
}

export function getCharacter(id: string): CharacterRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(characters)
    .where(eq(characters.id, id))
    .get();
}

export function createCharacter(input: {
  projectId: string;
  name: string;
  aliases?: string | undefined;
  role?: string | undefined;
  appearance?: string | undefined;
  personality?: string | undefined;
  background?: string | undefined;
  abilities?: string | undefined;
  status?: string | undefined;
  avatarUrl?: string | undefined;
}): CharacterRow {
  const db = getDb();
  const now = Date.now();
  const insert: CharacterInsert = {
    id: randomUUID(),
    projectId: input.projectId,
    name: input.name,
    aliases: input.aliases ?? null,
    role: (input.role as '主角' | '重要' | '次要') ?? '次要',
    appearance: input.appearance ?? null,
    personality: input.personality ?? null,
    background: input.background ?? null,
    abilities: input.abilities ?? null,
    status: input.status ?? null,
    avatarUrl: input.avatarUrl ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(characters).values(insert).run();
  return getCharacter(insert.id)!;
}

export function updateCharacter(id: string, input: Record<string, unknown>): CharacterRow {
  const db = getDb();
  const update: Record<string, unknown> = { updatedAt: Date.now() };

  if (input['name'] !== undefined) update['name'] = input['name'];
  if (input['aliases'] !== undefined) update['aliases'] = input['aliases'];
  if (input['role'] !== undefined) update['role'] = input['role'];
  if (input['appearance'] !== undefined) update['appearance'] = input['appearance'];
  if (input['personality'] !== undefined) update['personality'] = input['personality'];
  if (input['background'] !== undefined) update['background'] = input['background'];
  if (input['abilities'] !== undefined) update['abilities'] = input['abilities'];
  if (input['status'] !== undefined) update['status'] = input['status'];
  if (input['avatarUrl'] !== undefined) update['avatarUrl'] = input['avatarUrl'];

  db.update(characters).set(update).where(eq(characters.id, id)).run();
  return getCharacter(id)!;
}

export function deleteCharacter(id: string): void {
  const db = getDb();
  // 删除角色的同时删除关联关系
  db.delete(characterRelationships)
    .where(eq(characterRelationships.characterAId, id))
    .run();
  db.delete(characterRelationships)
    .where(eq(characterRelationships.characterBId, id))
    .run();
  db.delete(characters).where(eq(characters.id, id)).run();
}

// ── 角色关系 ────────────────────────────

export function listCharacterRelationships(
  projectId: string,
  // biome-ignore lint/style/useNamingConvention: snake_case for DB column
): CharacterRelationshipDetail[] {
  const db = getDb();
  const rows = db
    .select()
    .from(characterRelationships)
    .where(eq(characterRelationships.projectId, projectId))
    .orderBy(characterRelationships.createdAt)
    .all();

  return rows.map((row) => {
    const charA = getCharacter(row.characterAId);
    const charB = getCharacter(row.characterBId);
    return {
      ...row,
      characterAName: charA?.name ?? '',
      characterBName: charB?.name ?? '',
    };
  });
}

export function createCharacterRelationship(input: {
  projectId: string;
  characterAId: string;
  characterBId: string;
  relationshipType: string;
  description?: string | undefined;
}): CharacterRelationshipDetail {
  const db = getDb();
  const insert: CharacterRelationshipInsert = {
    id: randomUUID(),
    projectId: input.projectId,
    characterAId: input.characterAId,
    characterBId: input.characterBId,
    relationshipType: input.relationshipType,
    description: input.description ?? null,
    createdAt: Date.now(),
  };
  db.insert(characterRelationships).values(insert).run();
  return listCharacterRelationships(input.projectId).find(
    (r) => r.id === insert.id,
  )!;
}

export function deleteCharacterRelationship(id: string): void {
  const db = getDb();
  db.delete(characterRelationships)
    .where(eq(characterRelationships.id, id))
    .run();
}
