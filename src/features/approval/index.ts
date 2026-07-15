/**
 * Approval feature — 审批弹窗
 *
 * 监听 codex-rs ServerRequest 事件，弹出审批对话框，
 * 用户批准 / 拒绝后通过 submitApproval 回传结果。
 *
 * 状态管理: src/store/approval-store.ts
 * 事件监听: src/hooks/useApprovalListener.ts
 */
export { ApprovalDialog } from './ApprovalDialog'
