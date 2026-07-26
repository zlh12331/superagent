// src/main/infra/novel/project-service.ts
// 项目管理 CRUD
// ──────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../storage/db';
import {
  type NovelProjectInsert,
  type NovelProjectRow,
  novelProjects,
} from '../storage/schema';

/**
 * 列出所有项目（按 updatedAt 倒序）
 */
export function listProjects(): NovelProjectRow[] {
  const db = getDb();
  return db
    .select()
    .from(novelProjects)
    .orderBy(novelProjects.updatedAt)
    .all();
}

/**
 * 获取单个项目
 */
export function getProject(id: string): NovelProjectRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(novelProjects)
    .where(eq(novelProjects.id, id))
    .get();
}

/**
 * 创建项目
 */
export function createProject(input: {
  title: string;
  author: string;
  genre: string;
  description?: string | undefined;
}): NovelProjectRow {
  const db = getDb();
  const now = Date.now();
  const insert: NovelProjectInsert = {
    id: randomUUID(),
    title: input.title,
    author: input.author,
    genre: input.genre,
    description: input.description ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(novelProjects).values(insert).run();
  return getProject(insert.id)!;
}

/**
 * 删除项目（级联删除关联数据）
 */
export function deleteProject(id: string): void {
  const db = getDb();
  db.delete(novelProjects).where(eq(novelProjects.id, id)).run();
}
