/**
 * Conversation feature — 对话区
 *
 * 负责消息流（用户/助手消息、工具调用卡片、文件变更卡片、推理摘要、内联审批）、
 * 输入框（多行输入、@提及、附件上传、发送按钮、快捷键）、
 * 垂直进度条（tooltip 背景使用不透明色 --bg-elev-3）。
 *
 * 参考源码: prototype.html — 搜索 `messages`, `msg`, `composer`, `progress-bar`
 */

// 主容器与列表
export { ConversationArea } from './ConversationArea'
export { MessageList } from './MessageList'
export { MessageBubble } from './MessageBubble'
export { ChatInput } from './ChatInput'
export { VerticalProgressBar } from './VerticalProgressBar'

// UX 状态横幅与快捷入口（对齐 HTML 原型）
export { NetStatusBanner } from './NetStatusBanner'
export { RateLimitBanner } from './RateLimitBanner'
export { ConversationSearchBar } from './ConversationSearchBar'
export { WelcomeQuickActions } from './WelcomeQuickActions'

// 消息内容子组件
export { ToolCard } from './ToolCard'
export { ReasoningBlock } from './ReasoningBlock'
export { FileChangeCard } from './FileChangeCard'
export { InlineApprovalCard } from './InlineApprovalCard'
export { CodeBlock } from './CodeBlock'
export { TypingIndicator } from './TypingIndicator'
export { MessageActions } from './MessageActions'
export { StreamingCursor } from './StreamingCursor'

// 状态管理（Store）
export {
  useConversationStore,
  type ConversationStoreState,
} from './conversation-store'
