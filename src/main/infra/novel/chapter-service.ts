// src/main/infra/novel/chapter-service.ts
// 卷 / 章 / 节 CRUD
// ──────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../storage/db';
import {
  type ChapterInsert,
  type ChapterRow,
  type SceneInsert,
  type SceneRow,
  type VolumeInsert,
  type VolumeRow,
  chapters,
  scenes,
  volumes,
} from '../storage/schema';

// ── 卷 ───────────────────────────────────

export function listVolumes(projectId: string): VolumeRow[] {
  const db = getDb();
  return db
    .select()
    .from(volumes)
    .where(eq(volumes.projectId, projectId))
    .orderBy(volumes.sortOrder)
    .all();
}

export function createVolume(input: {
  projectId: string;
  title: string;
  sortOrder: number;
  summary?: string | undefined;
}): VolumeRow {
  const db = getDb();
  const insert: VolumeInsert = {
    id: randomUUID(),
    projectId: input.projectId,
    title: input.title,
    sortOrder: input.sortOrder,
    summary: input.summary ?? null,
    createdAt: Date.now(),
  };
  db.insert(volumes).values(insert).run();
  return db.select().from(volumes).where(eq(volumes.id, insert.id)).get()!;
}

// ── 章 ───────────────────────────────────

export function listChapters(volumeId: string): ChapterRow[] {
  const db = getDb();
  return db
    .select()
    .from(chapters)
    .where(eq(chapters.volumeId, volumeId))
    .orderBy(chapters.sortOrder)
    .all();
}

export function getChapter(id: string): ChapterRow | undefined {
  const db = getDb();
  return db
    .select()
    .from(chapters)
    .where(eq(chapters.id, id))
    .get();
}

export function createChapter(input: {
  volumeId: string;
  title: string;
  sortOrder: number;
  content?: string | undefined;
  summary?: string | undefined;
}): ChapterRow {
  const db = getDb();
  const now = Date.now();
  const insert: ChapterInsert = {
    id: randomUUID(),
    volumeId: input.volumeId,
    title: input.title,
    sortOrder: input.sortOrder,
    content: input.content ?? null,
    wordCount: input.content ? input.content.length : 0,
    summary: input.summary ?? null,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  db.insert(chapters).values(insert).run();
  return getChapter(insert.id)!;
}

export function saveChapter(id: string, input: {
  title?: string | undefined;
  content?: string | undefined;
  summary?: string | undefined;
  wordCount?: number | undefined;
  status?: string | undefined;
}): ChapterRow {
  const db = getDb();
  const update: Record<string, unknown> = { updatedAt: Date.now() };

  if (input.title !== undefined) update['title'] = input.title;
  if (input.content !== undefined) {
    update['content'] = input.content;
    update['wordCount'] = input.wordCount ?? input.content.length;
  }
  if (input.summary !== undefined) update['summary'] = input.summary;
  if (input.status !== undefined) update['status'] = input.status;

  db.update(chapters).set(update).where(eq(chapters.id, id)).run();
  return getChapter(id)!;
}

export function deleteChapter(id: string): void {
  const db = getDb();
  db.delete(chapters).where(eq(chapters.id, id)).run();
}

// ── 节 ───────────────────────────────────

export function listScenes(chapterId: string): SceneRow[] {
  const db = getDb();
  return db
    .select()
    .from(scenes)
    .where(eq(scenes.chapterId, chapterId))
    .orderBy(scenes.sortOrder)
    .all();
}

export function createScene(input: {
  chapterId: string;
  title?: string | undefined;
  sortOrder: number;
  summary?: string | undefined;
  content?: string | undefined;
}): SceneRow {
  const db = getDb();
  const insert: SceneInsert = {
    id: randomUUID(),
    chapterId: input.chapterId,
    title: input.title ?? null,
    sortOrder: input.sortOrder,
    summary: input.summary ?? null,
    content: input.content ?? null,
  };
  db.insert(scenes).values(insert).run();
  return db.select().from(scenes).where(eq(scenes.id, insert.id)).get()!;
}
