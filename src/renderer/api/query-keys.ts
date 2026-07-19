// src/renderer/api/query-keys.ts
// TanStack Query queryKey 工厂
// 设计文档 §5.1 数据流：queryKey 是缓存失效的依据
//
// 命名规范：
// - 顶层域用 all：如 projects.all = ['projects']
// - 列表用 list：如 projects.list() = ['projects', 'list']
// - 详情用 detail：如 projects.detail(id) = ['projects', 'detail', id]
// - 子资源列表：chapters.list(projectId) = ['chapters', 'list', projectId]

/**
 * queryKey 工厂
 *
 * 参考：https://tanstack.com/query/v5/docs/framework/react/guides/query-keys
 * - all 用于 invalidate 整个域：qc.invalidateQueries({ queryKey: queryKeys.projects.all })
 * - list/detail 是函数，传入参数生成具体的 key
 *
 * 注意：每个 key 用 `as const` 断言，让 TS 推断字面量联合类型
 */
export const queryKeys = {
  projects: {
    all: ['projects'] as const,
    list: () => ['projects', 'list'] as const,
    detail: (id: string) => ['projects', 'detail', id] as const,
  },
  chapters: {
    all: ['chapters'] as const,
    list: (projectId: string) => ['chapters', 'list', projectId] as const,
    detail: (id: string) => ['chapters', 'detail', id] as const,
  },
  characters: {
    all: ['characters'] as const,
    list: (projectId: string) => ['characters', 'list', projectId] as const,
    detail: (id: string) => ['characters', 'detail', id] as const,
  },
  worldviews: {
    all: ['worldviews'] as const,
    tree: (projectId: string) => ['worldviews', 'tree', projectId] as const,
    detail: (id: string) => ['worldviews', 'detail', id] as const,
  },
  chatSessions: {
    all: ['chatSessions'] as const,
    list: (projectId: string) => ['chatSessions', 'list', projectId] as const,
    detail: (id: string) => ['chatSessions', 'detail', id] as const,
  },
  chatMessages: {
    all: ['chatMessages'] as const,
    list: (sessionId: string) => ['chatMessages', 'list', sessionId] as const,
  },
  ragDocuments: {
    all: ['ragDocuments'] as const,
    list: (projectId: string) => ['ragDocuments', 'list', projectId] as const,
    detail: (id: string) => ['ragDocuments', 'detail', id] as const,
  },
  settings: {
    all: ['settings'] as const,
    detail: (projectId: string) => ['settings', 'detail', projectId] as const,
  },
};
