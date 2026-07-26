// src/main/infra/novel/world-setting-service.ts
// 世界观设定 CRUD
// ──────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../storage/db';
import {
  type WorldSettingInsert,
  type WorldSettingRow,
  worldSettings,
} from '../storage/schema';

export function listWorldSettings(projectId: string): WorldSettingRow[] {
  const db = getDb();
  return db
    .select()
    .from(worldSettings)
    .where(eq(worldSettings.projectId, projectId))
    .orderBy(worldSettings.createdAt)
    .all();
}

export function createWorldSetting(input: {
  projectId: string;
  category: string;
  title: string;
  content?: string | undefined;
  tags?: string | undefined;
}): WorldSettingRow {
  const db = getDb();
  const now = Date.now();
  const insert: WorldSettingInsert = {
    id: randomUUID(),
    projectId: input.projectId,
    category: input.category,
    title: input.title,
    content: input.content ?? null,
    tags: input.tags ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(worldSettings).values(insert).run();
  return db.select().from(worldSettings).where(eq(worldSettings.id, insert.id)).get()!;
}

export function updateWorldSetting(id: string, input: Record<string, unknown>): WorldSettingRow {
  const db = getDb();
  const update: Record<string, unknown> = { updatedAt: Date.now() };

  if (input['category'] !== undefined) update['category'] = input['category'];
  if (input['title'] !== undefined) update['title'] = input['title'];
  if (input['content'] !== undefined) update['content'] = input['content'];
  if (input['tags'] !== undefined) update['tags'] = input['tags'];

  db.update(worldSettings).set(update).where(eq(worldSettings.id, id)).run();
  return db.select().from(worldSettings).where(eq(worldSettings.id, id)).get()!;
}

export function deleteWorldSetting(id: string): void {
  const db = getDb();
  db.delete(worldSettings).where(eq(worldSettings.id, id)).run();
}
