// src/main/infra/novel/outline-service.ts
// 大纲 CRUD（卷纲/章纲/节纲统一表）
// ──────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../storage/db';
import {
  type OutlineItemInsert,
  type OutlineItemRow,
  outlineItems,
} from '../storage/schema';

export function listOutlineItems(projectId: string): OutlineItemRow[] {
  const db = getDb();
  return db
    .select()
    .from(outlineItems)
    .where(eq(outlineItems.projectId, projectId))
    .orderBy(outlineItems.sortOrder)
    .all();
}

export function createOutlineItem(input: {
  projectId: string;
  parentId?: string | undefined;
  level: 'volume' | 'chapter' | 'scene';
  title: string;
  sortOrder: number;
  summary?: string | undefined;
  targetWordCount?: number | undefined;
  emotionalGoal?: string | undefined;
  pacing?: string | undefined;
}): OutlineItemRow {
  const db = getDb();
  const now = Date.now();
  const insert: OutlineItemInsert = {
    id: randomUUID(),
    projectId: input.projectId,
    parentId: input.parentId ?? null,
    level: input.level,
    title: input.title,
    sortOrder: input.sortOrder,
    summary: input.summary ?? null,
    targetWordCount: input.targetWordCount ?? null,
    emotionalGoal: input.emotionalGoal ?? null,
    pacing: input.pacing ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(outlineItems).values(insert).run();
  return db.select().from(outlineItems).where(eq(outlineItems.id, insert.id)).get()!;
}

export function updateOutlineItem(id: string, input: Record<string, unknown>): OutlineItemRow {
  const db = getDb();
  const update: Record<string, unknown> = { updatedAt: Date.now() };

  if (input['title'] !== undefined) update['title'] = input['title'];
  if (input['sortOrder'] !== undefined) update['sortOrder'] = input['sortOrder'];
  if (input['summary'] !== undefined) update['summary'] = input['summary'];
  if (input['targetWordCount'] !== undefined)
    update['targetWordCount'] = input['targetWordCount'];
  if (input['emotionalGoal'] !== undefined)
    update['emotionalGoal'] = input['emotionalGoal'];
  if (input['pacing'] !== undefined) update['pacing'] = input['pacing'];

  db.update(outlineItems).set(update).where(eq(outlineItems.id, id)).run();
  return db.select().from(outlineItems).where(eq(outlineItems.id, id)).get()!;
}

export function deleteOutlineItem(id: string): void {
  const db = getDb();
  // 先删除子项
  db.delete(outlineItems).where(eq(outlineItems.parentId, id)).run();
  // 再删除自身
  db.delete(outlineItems).where(eq(outlineItems.id, id)).run();
}
