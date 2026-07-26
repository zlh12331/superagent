// src/renderer/types/novel-api.ts
// window.api.novel 类型安全访问工具
//
// 由于 shared 包尚未包含 novel 域 IPC 声明，此处提供类型断言辅助函数。
// 全局数据接口（NovelProject / NovelChapter 等）定义在 novel-interfaces.d.ts 中。

/**
 * Novel API 接口定义
 *
 * 匹配 preload 中 novel 域的 API 形状。
 */
export interface NovelApiShape {
  project: {
    list(): Promise<{ data: NovelProject[] }>;
    create(input: {
      title: string;
      author: string;
      genre: string;
      description: string;
    }): Promise<{ data: NovelProject }>;
    get(input: { id: string }): Promise<{ data: NovelProject }>;
    delete(input: { id: string }): Promise<{ data: { ok: boolean } }>;
  };
  chapter: {
    list(input: { projectId: string }): Promise<{ data: NovelChapterVolume[] }>;
    get(input: { id: string }): Promise<{ data: NovelChapter }>;
    save(input: {
      id: string;
      content: string;
      title?: string;
    }): Promise<{ data: NovelChapter }>;
    create(input: {
      volumeId: string;
      title: string;
      sortOrder?: number;
    }): Promise<{ data: NovelChapter }>;
    delete(input: { id: string }): Promise<{ data: { ok: boolean } }>;
  };
  outline: {
    list(input: { projectId: string }): Promise<{ data: OutlineItem[] }>;
    create(input: {
      projectId: string;
      parentId?: string;
      level: 'volume' | 'chapter' | 'scene';
      title: string;
      sortOrder?: number;
    }): Promise<{ data: OutlineItem }>;
    update(input: {
      id: string;
      title?: string;
      summary?: string;
      targetWordCount?: number;
    }): Promise<{ data: OutlineItem }>;
    delete(input: { id: string }): Promise<{ data: { ok: boolean } }>;
  };
  character: {
    list(input: { projectId: string }): Promise<{ data: CharacterData[] }>;
    get(input: { id: string }): Promise<{ data: CharacterData }>;
    create(input: {
      projectId: string;
      name: string;
      role: string;
    }): Promise<{ data: CharacterData }>;
    update(
      input: { id: string } & Partial<
        Omit<CharacterData, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>
      >,
    ): Promise<{ data: CharacterData }>;
    delete(input: { id: string }): Promise<{ data: { ok: boolean } }>;
  };
  worldSetting: {
    list(input: { projectId: string }): Promise<{ data: WorldSetting[] }>;
    create(input: {
      projectId: string;
      category: string;
      title: string;
      content: string;
      tags?: string[];
    }): Promise<{ data: WorldSetting }>;
    update(input: {
      id: string;
      title?: string;
      content?: string;
      tags?: string[];
    }): Promise<{ data: WorldSetting }>;
    delete(input: { id: string }): Promise<{ data: { ok: boolean } }>;
  };
  agent: {
    review(input: {
      projectId: string;
      chapterId: string;
    }): Promise<{ data: ReviewReport }>;
    inspire(input: {
      projectId: string;
      chapterId: string;
    }): Promise<{ data: { suggestions: string[] } }>;
  };
  export: {
    txt(input: {
      projectId: string;
      chapterId?: string;
    }): Promise<{ data: { filePath: string } }>;
  };
}

/**
 * 类型安全的 window.api.novel 访问器
 *
 * 使用示例：
 * ```ts
 * const api = getNovelApi();
 * const projects = await api.project.list();
 * ```
 */
export function getNovelApi(): NovelApiShape {
  return (window as unknown as { api: { novel: NovelApiShape } }).api.novel;
}
