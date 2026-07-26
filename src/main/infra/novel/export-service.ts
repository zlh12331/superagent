// src/main/infra/novel/export-service.ts
// TXT 导出功能
// ──────────────────────────────────────────

import { eq } from 'drizzle-orm';
import { getDb } from '../storage/db';
import { chapters, volumes } from '../storage/schema';
import { getProject } from './project-service';
import type { ExportResult } from './types';

/**
 * 导出整本书为 TXT（按卷-章顺序拼接）
 */
export function exportProjectToTxt(projectId: string): ExportResult {
  const project = getProject(projectId);
  if (!project) {
    return { content: '', fileName: '未知项目.txt' };
  }

  const db = getDb();
  const parts: string[] = [];

  // 标题
  parts.push(project.title);
  parts.push('='.repeat(project.title.length));
  parts.push('');
  parts.push(`作者：${project.author}`);
  parts.push(`类型：${project.genre}`);
  if (project.description) {
    parts.push('');
    parts.push(project.description);
  }
  parts.push('');
  parts.push('─'.repeat(40));
  parts.push('');

  // 遍历卷
  const volumeList = db
    .select()
    .from(volumes)
    .where(eq(volumes.projectId, projectId))
    .orderBy(volumes.sortOrder)
    .all();

  for (const vol of volumeList) {
    parts.push(`第${vol.sortOrder}卷 ${vol.title}`);
    parts.push('─'.repeat(20));
    parts.push('');

    const chapterList = db
      .select()
      .from(chapters)
      .where(eq(chapters.volumeId, vol.id))
      .orderBy(chapters.sortOrder)
      .all();

    for (const ch of chapterList) {
      parts.push(`第${ch.sortOrder}章 ${ch.title}`);
      parts.push('');
      if (ch.content) {
        parts.push(ch.content);
      }
      parts.push('');
      parts.push('');
    }
  }

  const fileName = `${project.title}.txt`;
  return { content: parts.join('\n'), fileName };
}

/**
 * 导出单章为 TXT
 */
export function exportChapterToTxt(chapterId: string): ExportResult {
  const db = getDb();
  const ch = db
    .select()
    .from(chapters)
    .where(eq(chapters.id, chapterId))
    .get();

  if (!ch) {
    return { content: '', fileName: '未知章节.txt' };
  }

  const vol = db
    .select()
    .from(volumes)
    .where(eq(volumes.id, ch.volumeId))
    .get();

  const parts: string[] = [];
  if (vol) {
    parts.push(`${vol.title} / ${ch.title}`);
    parts.push('');
  }
  if (ch.content) {
    parts.push(ch.content);
  }

  const fileName = `${ch.title}.txt`;
  return { content: parts.join('\n'), fileName };
}
