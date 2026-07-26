// src/main/infra/novel/writing-session-service.ts
// 写作会话 CRUD（AI 对话记录）
// ──────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../storage/db';
import {
  type WritingSessionInsert,
  type WritingSessionRow,
  writingSessions,
} from '../storage/schema';

export function getAll(projectId: string): WritingSessionRow[] {
  const db = getDb();
  return db
    .select()
    .from(writingSessions)
    .where(eq(writingSessions.projectId, projectId))
    .orderBy(writingSessions.createdAt)
    .all();
}

export function createWritingSession(input: {
  projectId: string;
  chapterId?: string | undefined;
  sessionType: 'write' | 'review' | 'inspiration';
  messages?: string | undefined;
}): WritingSessionRow {
  const db = getDb();
  const now = Date.now();
  const insert: WritingSessionInsert = {
    id: randomUUID(),
    projectId: input.projectId,
    chapterId: input.chapterId ?? null,
    sessionType: input.sessionType,
    messages: input.messages ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(writingSessions).values(insert).run();
  return db.select().from(writingSessions).where(eq(writingSessions.id, insert.id)).get()!;
}
