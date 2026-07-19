// src/renderer/lib/constants.ts
// 渲染层 UI 常量
// 集中管理布局尺寸、动画时长等，避免散落在各组件硬编码

/**
 * 侧边栏宽度（px）
 * 折叠时宽度为 SIDEBAR_WIDTH_COLLAPSED
 */
export const SIDEBAR_WIDTH = 240;
export const SIDEBAR_WIDTH_COLLAPSED = 56;

/** 顶部栏高度（px） */
export const TOPBAR_HEIGHT = 44;

/** 底部状态栏高度（px） */
export const STATUS_BAR_HEIGHT = 28;

/**
 * 路由路径常量
 * 与 router.tsx 中的 path 保持一致，避免到处硬编码字符串
 */
export const ROUTES = {
  /** 根路径（重定向到 PROJECTS） */
  ROOT: '/',
  /** 项目列表 */
  PROJECTS: '/projects',
  /** 项目工作台前缀 */
  PROJECT: '/projects/:projectId',
  /** 章节管理 */
  CHAPTERS: '/projects/:projectId/chapters',
  /** 人物卡 */
  CHARACTERS: '/projects/:projectId/characters',
  /** 世界观 */
  WORLDVIEW: '/projects/:projectId/worldview',
  /** AI 对话 */
  CHAT: '/projects/:projectId/chat',
  /** RAG 文档 */
  RAG: '/projects/:projectId/rag',
  /** 设置 */
  SETTINGS: '/settings',
} as const;

/**
 * 构造项目工作台子路由的完整路径
 *
 * @example
 * projectRoute('p1', 'chapters') // → '/projects/p1/chapters'
 */
export function projectRoute(
  projectId: string,
  sub: 'chapters' | 'characters' | 'worldview' | 'chat' | 'rag',
): string {
  return `/projects/${projectId}/${sub}`;
}
