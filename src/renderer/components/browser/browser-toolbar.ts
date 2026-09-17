// src/renderer/components/browser/browser-toolbar.ts
// 浏览器预览工具栏共享样式常量
// ──────────────────────────────────────────────────────────────
// browser-pane 的导航按钮与 browser-device-bar 的关闭按钮此前各自内联
// 同一份逐字相同的 class 字符串，靠注释「与 browser-pane 工具栏一致」
// 人工同步——改一处忘另一处即静默视觉漂移。收敛到本模块作单一真源。
// 独立成文件而非挂在某个组件模块上：两条工具栏都消费，
// 归属任一组件都会让另一个组件为其样式反向依赖。
// ──────────────────────────────────────────────────────────────

/** 工具栏图标按钮基础样式（透明底、hover 显底、禁用降透明） */
export const TOOLBAR_BTN_CLASS =
  'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30';
