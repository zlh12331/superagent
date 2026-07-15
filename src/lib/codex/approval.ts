/**
 * Codex API — Approval 域
 *
 * 审批流程：响应 codex-rs ServerRequest 审批请求。
 *
 * ## 事件流
 *
 * ```text
 * codex-rs ServerRequest
 *     ↓
 * bridge::event → emit("codex:approval:request", ApprovalEventData)
 *     ↓
 * 前端 onApprovalRequest 监听 → approval-store.setPendingApproval
 *     ↓
 * ApprovalDialog 显示审批弹窗
 *     ↓
 * 用户点击"批准" → submitApproval({ approved: true })
 * 用户点击"拒绝" → submitApproval({ approved: false, reason? })
 *     ↓
 * bindings.approvalRespond / bindings.approvalReject
 *     ↓
 * bridge::approval:: respond / reject → sender 回传 codex-rs
 * ```
 *
 * ## 后端命令
 *
 * - `approvalRespond(args: ApprovalRespondArgs)` — 批准请求
 * - `approvalReject(args: ApprovalRejectArgs)` — 拒绝请求
 * - `approvalListPending()` — 列出 pending 请求 ID
 *
 * @see src/store/approval-store.ts — UI 状态管理
 * @see src/lib/codex/types.ts — ApprovalResponse 类型
 * @see src-tauri/codex-rs/desktop/src/bridge/approval.rs — 后端审批 bridge
 * @see src-tauri/codex-rs/desktop/src/bridge/mapper.rs — ApprovalEventData 定义
 */

import type { UnlistenFn } from '@tauri-apps/api/event'
import { commands } from '@/lib/bindings'
import { isTauri } from '@/lib/env'
import type { ApprovalResponse } from './types'
// 集中式 mock 模块 — 统一事件监听（Tauri 用原生 listen，浏览器用 mockEventBus）
import { universalListen } from './mock'

/**
 * 审批类型联合 —— 与后端 approval_policy 对齐。
 *
 * 与 src/store/approval-store.ts 的 ApprovalType、
 * src/features/demo/approval-variants.ts 的 ApprovalVariant 保持一致（7 种）。
 * 旧版 'file_change' 已合并到 'patch'，'permissions' 已重命名为 'perm'。
 */
export type ApprovalType =
  | 'command' // 命令执行审批
  | 'patch' // 文件变更 / 补丁应用审批
  | 'tool' // 工具输入请求
  | 'mcp' // MCP Elicitation
  | 'perm' // 权限授予审批
  | 'dyn' // 动态工具调用
  | 'attest' // Attestation 生成

/**
 * 审批请求事件 payload。
 *
 * 后端 `bridge::mapper::to_approval_event` 将 `ServerRequest` 枚举转换为
 * 此扁平结构后 emit，前端不需要了解 codex-rs 内部类型。
 *
 * 字段对应后端 `ApprovalEventData`（serde camelCase 序列化）。
 */
export interface ApprovalRequestEvent {
  /**
   * RequestId 序列化后的 JSON 字符串。
   * 前端原样作为 `requestIdJson` 参数回传给 approval_respond/reject 命令。
   * 例如：整数 ID 42 → `"42"`；字符串 ID "abc" → `"\"abc\""`
   */
  requestIdJson: string
  /** 用于 UI 显示的简短字符串（如 "42" 或 "abc"） */
  requestIdDisplay: string
  /** 审批类型（7 种，见 ApprovalType） */
  approvalType: ApprovalType
  /** 请求内容（JSON 格式，前端用 <pre> 显示） */
  payload: string
}

/**
 * 提交审批响应（批准 / 拒绝）。
 *
 * 根据 `response.approved` 调用不同的后端命令：
 * - 批准 → `approvalRespond`，result 为 `{ approved: true }`
 * - 拒绝 → `approvalReject`，error 为 `{ code: -32000, message: reason }`
 *
 * @param response — 审批响应（requestIdJson + approved + 可选 reason）
 * @throws Error — 后端命令调用失败时抛出
 */
export async function submitApproval(
  response: ApprovalResponse
): Promise<void> {
  if (!isTauri()) return

  if (response.approved) {
    // 批准：result payload 为 { approved: true }
    const resultJson = JSON.stringify({ approved: true })
    const result = await commands.approvalRespond({
      requestIdJson: response.requestId,
      resultJson,
    })
    if (result.status === 'error') {
      throw new Error(`approval/respond failed: ${result.error.message}`)
    }
  } else {
    // 拒绝：构造 JSON-RPC error 对象
    const errorJson = JSON.stringify({
      code: -32000,
      message: response.reason || 'User denied',
      data: null,
    })
    const result = await commands.approvalReject({
      requestIdJson: response.requestId,
      errorJson,
    })
    if (result.status === 'error') {
      throw new Error(`approval/reject failed: ${result.error.message}`)
    }
  }
}

/**
 * 监听审批请求事件（codex:approval:request）。
 *
 * 统一事件监听：Tauri 环境用原生 listen，浏览器环境用 mockEventBus，
 * 调用方可安全地在 cleanup 中直接调用返回的函数。
 *
 * @returns unlisten 函数，调用后取消监听
 */
export async function onApprovalRequest(
  callback: (event: ApprovalRequestEvent) => void
): Promise<UnlistenFn> {
  // 事件名与后端 bridge::event::event_names::APPROVAL_REQUEST 对齐
  // 统一事件监听：Tauri 用原生 listen，浏览器用 mockEventBus
  return universalListen<ApprovalRequestEvent>('codex:approval:request', callback)
}
