// src/renderer/lib/constants.ts
// 渲染层 UI 常量
// 集中管理布局尺寸与路由路径，避免散落在各组件硬编码
//
// 设计：
// - 布局尺寸常量供 AppShell / Sidebar / Topbar 引用，便于统一调整
// - 路由常量 ROUTES 提供 path 模板 + 工厂函数，避免字符串拼接 typo

/** 顶部栏高度（px） */
export const TOPBAR_HEIGHT = 44;

/** 侧边栏宽度（px） - 会话列表展示区 */
export const SIDEBAR_WIDTH = 260;

/**
 * 应用路由路径常量
 *
 * 设计：
 * - 提供 path 模板（用于 router 声明）
 * - 提供工厂函数（用于组件导航跳转），避免手写字符串拼接
 *
 * @example
 * ```tsx
 * // 路由声明
 * <Route path={ROUTES.chat} element={<ChatPage />} />
 *
 * // 导航跳转
 * navigate(ROUTES.chatPath(session.id));
 * ```
 */
export const ROUTES = {
  /** 首页（欢迎页） */
  home: '/',
  /** 聊天页路由模板（含 :sessionId 参数） */
  chat: '/chat/:sessionId',
  /**
   * 生成指定会话的聊天页路径
   *
   * @param sessionId 会话 id
   * @returns 形如 '/chat/abc123' 的路径
   */
  chatPath: (sessionId: string): string => `/chat/${sessionId}`,
} as const;
