// src/renderer/lib/constants.ts
// 渲染层 UI 常量
// 集中管理布局尺寸与路由路径，避免散落在各组件硬编码
//
// 设计：
// - 布局尺寸常量供 AppShell / Sidebar / Topbar 引用，便于统一调整
// - 路由常量 ROUTES 提供 path 模板 + 工厂函数，避免字符串拼接 typo

/** 顶部栏高度（px） - 与原型 --topbar-h 一致 */
export const TOPBAR_HEIGHT = 52;

/** 拖拽分隔线宽度（px） - 与原型 --resizer-w 一致 */
export const RESIZER_WIDTH = 6;

/**
 * 草稿会话 id
 *
 * 当无激活会话时使用，作为 TerminalPanel/GitPanel 的 sessionId 占位。
 * 同一应用周期内复用同一个 'draft' 终端实例。
 */
export const DRAFT_SESSION_ID = 'draft';

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

/**
 * 响应式断点（px）— 与 useLayoutBreakpoint 对齐
 *
 * 低于该宽度时触发对应面板自动显隐：
 * - BREAKPOINT_COMPACT：右面板应自动隐藏（可浮层抽屉唤出）
 * - BREAKPOINT_NARROW：侧栏应自动隐藏（可浮层抽屉唤出）
 */
export const BREAKPOINT_COMPACT = 1200;
export const BREAKPOINT_NARROW = 900;

/**
 * 侧栏会话搜索高亮（对齐原型 debounce/过期行为）
 */
export const SEARCH_HIGHLIGHT_DEBOUNCE_MS = 300;
export const SEARCH_HIGHLIGHT_EXPIRE_MS = 2000;
export const SEARCH_HIGHLIGHT_MIN_CHARS = 2;
