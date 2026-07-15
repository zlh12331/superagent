/**
 * Demo feature — 演示面板模块
 *
 * 提供开发模式下的演示入口，对齐 HTML 原型的 Demo 下拉菜单功能。
 * 包含演示消息注入、演示卡片注入、审批变体触发、综合演示等能力。
 *
 * 架构说明：
 *   - DemoPanel（UI 组件）：渲染下拉菜单按钮，仅开发模式可见
 *   - demo-injector（注入器）：通过事件总线派发注入事件，
 *     ConversationArea 监听 `codex:demo-inject` 事件并渲染
 *
 * 参考源码：prototype.html — #abDev / #demoDropdown / handleDemoMsg /
 *           handleDemoCard / triggerInlineApproval / handleDemoComprehensive
 */
export { DemoPanel } from './DemoPanel'
export * from './demo-injector'
