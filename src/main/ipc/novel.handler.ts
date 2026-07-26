// src/main/ipc/novel.handler.ts
// Novel 域 IPC handler：注册所有 novel:* 通道
// ──────────────────────────────────────────────────────────────
// 职责：
// - 注册 30+ novel:* 请求-响应 channel
// - 使用 cast/getStr/updPayload 辅助函数处理类型约束
// - 将所有 IPC 调用委托给对应的 novel service 函数
//
// 设计：
// - 无 DI 依赖（服务直接调用 static 函数，无状态）
// - 使用 null schema（无需 zod 校验，handler 内部用 cast 处理）
// - 严格遵循 AGENTS.md 的类型约束绕过策略
// ──────────────────────────────────────────────────────────────

import { IPC_CHANNELS } from '@novel-writer/shared';
import { wrap } from '../utils/wrap';
import {
  createChapter,
  createVolume,
  deleteChapter,
  getChapter,
  listChapters,
  listScenes,
  listVolumes,
  saveChapter,
} from '../infra/novel/chapter-service';
import {
  createCharacter,
  createCharacterRelationship,
  deleteCharacter,
  deleteCharacterRelationship,
  getCharacter,
  listCharacterRelationships,
  listCharacters,
  updateCharacter,
} from '../infra/novel/character-service';
import { exportChapterToTxt, exportProjectToTxt } from '../infra/novel/export-service';
import {
  createOutlineItem,
  deleteOutlineItem,
  listOutlineItems,
  updateOutlineItem,
} from '../infra/novel/outline-service';
import { createProject, deleteProject, getProject, listProjects } from '../infra/novel/project-service';
import { getStr } from '../infra/novel/types';
import {
  createWorldSetting,
  deleteWorldSetting,
  listWorldSettings,
  updateWorldSetting,
} from '../infra/novel/world-setting-service';
import { createWritingSession, getAll as getAllWritingSessions } from '../infra/novel/writing-session-service';

/**
 * 注册所有 novel:* IPC handler
 *
 * 所有通道使用 null schema（不入参校验），handler 内部通过 cast/getStr 辅助函数
 * 处理类型约束。这是 AGENTS.md 中"类型约束绕过策略"的延续。
 */
export function registerNovelHandlers(): void {
  // ── 项目管理 ─────────────────────────────────

  wrap(IPC_CHANNELS.NOVEL_PROJECT_LIST, null, async () => {
    return { data: listProjects() };
  });

  wrap(IPC_CHANNELS.NOVEL_PROJECT_CREATE, null, async (input) => {
    const p = input as Record<string, unknown>;
    return {
      data: createProject({
        title: getStr(input, 'title'),
        author: getStr(input, 'author'),
        genre: getStr(input, 'genre'),
        description: (p['description'] as string) || undefined,
      }),
    };
  });

  wrap(IPC_CHANNELS.NOVEL_PROJECT_GET, null, async (input) => {
    return { data: getProject(getStr(input, 'id')) };
  });

  wrap(IPC_CHANNELS.NOVEL_PROJECT_DELETE, null, async (input) => {
    deleteProject(getStr(input, 'id'));
    return { data: { ok: true } };
  });

  // ── 章节管理（卷/章/节） ─────────────────────

  wrap(IPC_CHANNELS.NOVEL_CHAPTER_LIST, null, async (input) => {
    const pId = getStr(input, 'projectId');
    const volumesList = listVolumes(pId);
    const result = volumesList.map((vol) => ({
      ...vol,
      chapters: listChapters(vol.id),
    }));
    return { data: result };
  });

  wrap(IPC_CHANNELS.NOVEL_CHAPTER_GET, null, async (input) => {
    const ch = getChapter(getStr(input, 'id'));
    if (!ch) return { data: null };
    const sceneList = listScenes(ch.id);
    return { data: { ...ch, scenes: sceneList } };
  });

  wrap(IPC_CHANNELS.NOVEL_CHAPTER_SAVE, null, async (input) => {
    const p = input as Record<string, unknown>;
    const result = saveChapter(getStr(input, 'id'), {
      title: p['title'] as string | undefined,
      content: p['content'] as string | undefined,
      summary: p['summary'] as string | undefined,
      wordCount: p['wordCount'] as number | undefined,
      status: p['status'] as string | undefined,
    });
    return { data: result };
  });

  wrap(IPC_CHANNELS.NOVEL_CHAPTER_CREATE, null, async (input) => {
    const p = input as Record<string, unknown>;
    const volumeId = getStr(input, 'volumeId');
    if (p['isVolume']) {
      const vol = createVolume({
        projectId: getStr(input, 'projectId'),
        title: getStr(input, 'title'),
        sortOrder: (p['sortOrder'] as number) ?? 0,
        summary: p['summary'] as string | undefined,
      });
      return { data: { volume: vol } };
    }
    const ch = createChapter({
      volumeId,
      title: getStr(input, 'title'),
      sortOrder: (p['sortOrder'] as number) ?? 0,
      content: p['content'] as string | undefined,
      summary: p['summary'] as string | undefined,
    });
    return { data: { chapter: ch } };
  });

  wrap(IPC_CHANNELS.NOVEL_CHAPTER_DELETE, null, async (input) => {
    deleteChapter(getStr(input, 'id'));
    return { data: { ok: true } };
  });

  // ── 大纲管理 ─────────────────────────────────

  wrap(IPC_CHANNELS.NOVEL_OUTLINE_LIST, null, async (input) => {
    return { data: listOutlineItems(getStr(input, 'projectId')) };
  });

  wrap(IPC_CHANNELS.NOVEL_OUTLINE_CREATE, null, async (input) => {
    const p = input as Record<string, unknown>;
    const item = createOutlineItem({
      projectId: getStr(input, 'projectId'),
      parentId: p['parentId'] as string | undefined,
      level: getStr(input, 'level') as 'volume' | 'chapter' | 'scene',
      title: getStr(input, 'title'),
      sortOrder: (p['sortOrder'] as number) ?? 0,
      summary: p['summary'] as string | undefined,
      targetWordCount: p['targetWordCount'] as number | undefined,
      emotionalGoal: p['emotionalGoal'] as string | undefined,
      pacing: p['pacing'] as string | undefined,
    });
    return { data: item };
  });

  wrap(IPC_CHANNELS.NOVEL_OUTLINE_UPDATE, null, async (input) => {
    const p = input as Record<string, unknown>;
    const item = updateOutlineItem(getStr(input, 'id'), {
      title: p['title'] as string | undefined,
      sortOrder: p['sortOrder'] as number | undefined,
      summary: p['summary'] as string | undefined,
      targetWordCount: p['targetWordCount'] as number | undefined,
      emotionalGoal: p['emotionalGoal'] as string | undefined,
      pacing: p['pacing'] as string | undefined,
    });
    return { data: item };
  });

  wrap(IPC_CHANNELS.NOVEL_OUTLINE_DELETE, null, async (input) => {
    deleteOutlineItem(getStr(input, 'id'));
    return { data: { ok: true } };
  });

  // ── 角色管理 ─────────────────────────────────

  wrap(IPC_CHANNELS.NOVEL_CHARACTER_LIST, null, async (input) => {
    return { data: listCharacters(getStr(input, 'projectId')) };
  });

  wrap(IPC_CHANNELS.NOVEL_CHARACTER_CREATE, null, async (input) => {
    const p = input as Record<string, unknown>;
    const char = createCharacter({
      projectId: getStr(input, 'projectId'),
      name: getStr(input, 'name'),
      aliases: p['aliases'] as string | undefined,
      role: p['role'] as string | undefined,
      appearance: p['appearance'] as string | undefined,
      personality: p['personality'] as string | undefined,
      background: p['background'] as string | undefined,
      abilities: p['abilities'] as string | undefined,
      status: p['status'] as string | undefined,
      avatarUrl: p['avatarUrl'] as string | undefined,
    });
    return { data: char };
  });

  wrap(IPC_CHANNELS.NOVEL_CHARACTER_GET, null, async (input) => {
    return { data: getCharacter(getStr(input, 'id')) };
  });

  wrap(IPC_CHANNELS.NOVEL_CHARACTER_UPDATE, null, async (input) => {
    const p = input as Record<string, unknown>;
    const char = updateCharacter(getStr(input, 'id'), {
      name: p['name'] as string | undefined,
      aliases: p['aliases'] as string | undefined,
      role: p['role'] as string | undefined,
      appearance: p['appearance'] as string | undefined,
      personality: p['personality'] as string | undefined,
      background: p['background'] as string | undefined,
      abilities: p['abilities'] as string | undefined,
      status: p['status'] as string | undefined,
      avatarUrl: p['avatarUrl'] as string | undefined,
    });
    return { data: char };
  });

  wrap(IPC_CHANNELS.NOVEL_CHARACTER_DELETE, null, async (input) => {
    deleteCharacter(getStr(input, 'id'));
    return { data: { ok: true } };
  });

  // ── 角色关系管理 ────────────────────────────

  wrap(IPC_CHANNELS.NOVEL_CHARACTER_RELATIONSHIP_LIST, null, async (input) => {
    return { data: listCharacterRelationships(getStr(input, 'projectId')) };
  });

  wrap(IPC_CHANNELS.NOVEL_CHARACTER_RELATIONSHIP_CREATE, null, async (input) => {
    const p = input as Record<string, unknown>;
    const rel = createCharacterRelationship({
      projectId: getStr(input, 'projectId'),
      characterAId: getStr(input, 'characterAId'),
      characterBId: getStr(input, 'characterBId'),
      relationshipType: getStr(input, 'relationshipType'),
      description: p['description'] as string | undefined,
    });
    return { data: rel };
  });

  wrap(IPC_CHANNELS.NOVEL_CHARACTER_RELATIONSHIP_DELETE, null, async (input) => {
    deleteCharacterRelationship(getStr(input, 'id'));
    return { data: { ok: true } };
  });

  // ── 世界观管理 ──────────────────────────────

  wrap(IPC_CHANNELS.NOVEL_WORLD_SETTING_LIST, null, async (input) => {
    return { data: listWorldSettings(getStr(input, 'projectId')) };
  });

  wrap(IPC_CHANNELS.NOVEL_WORLD_SETTING_CREATE, null, async (input) => {
    const p = input as Record<string, unknown>;
    const ws = createWorldSetting({
      projectId: getStr(input, 'projectId'),
      category: getStr(input, 'category'),
      title: getStr(input, 'title'),
      content: p['content'] as string | undefined,
      tags: p['tags'] as string | undefined,
    });
    return { data: ws };
  });

  wrap(IPC_CHANNELS.NOVEL_WORLD_SETTING_UPDATE, null, async (input) => {
    const p = input as Record<string, unknown>;
    const ws = updateWorldSetting(getStr(input, 'id'), {
      category: p['category'] as string | undefined,
      title: p['title'] as string | undefined,
      content: p['content'] as string | undefined,
      tags: p['tags'] as string | undefined,
    });
    return { data: ws };
  });

  wrap(IPC_CHANNELS.NOVEL_WORLD_SETTING_DELETE, null, async (input) => {
    deleteWorldSetting(getStr(input, 'id'));
    return { data: { ok: true } };
  });

  // ── 写作会话管理 ────────────────────────────

  wrap(IPC_CHANNELS.NOVEL_WRITING_SESSION_LIST, null, async (input) => {
    return { data: getAllWritingSessions(getStr(input, 'projectId')) };
  });

  wrap(IPC_CHANNELS.NOVEL_WRITING_SESSION_CREATE, null, async (input) => {
    const p = input as Record<string, unknown>;
    const session = createWritingSession({
      projectId: getStr(input, 'projectId'),
      chapterId: p['chapterId'] as string | undefined,
      sessionType: getStr(input, 'sessionType') as 'write' | 'review' | 'inspiration',
      messages: p['messages'] as string | undefined,
    });
    return { data: session };
  });

  // ── 导出 ────────────────────────────────────

  wrap(IPC_CHANNELS.NOVEL_EXPORT_TXT, null, async (input) => {
    const p = input as Record<string, unknown>;
    if (p['chapterId']) {
      return { data: exportChapterToTxt(getStr(input, 'chapterId')) };
    }
    return { data: exportProjectToTxt(getStr(input, 'projectId')) };
  });
}
