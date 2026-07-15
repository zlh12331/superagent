/**
 * useApprovalListener — 监听 codex-rs 审批请求事件
 *
 * 在组件挂载时注册 approval:request 事件监听器，
 * 收到事件后将审批请求写入 approval-store，触发审批弹窗。
 *
 * 采用 isMounted 守卫模式（与 useMainWindowEventListeners 一致）：
 * 若监听器注册完成前组件已卸载，立即调用 unlisten 释放资源，
 * 避免 StrictMode 双挂载下的监听器泄漏。
 *
 * 副作用：
 *  - 注册 Tauri 事件监听器（onApprovalRequest）
 *  - 卸载时调用 unlisten 释放资源
 *
 * 使用场景：在主窗口组件中调用一次，全局监听审批请求。
 *
 * @see src/lib/codex/approval.ts — onApprovalRequest 事件源
 * @see src/store/approval-store.ts — 写入的 store
 * @see src/features/approval/ApprovalModal.tsx — 订阅 store 显示弹窗
 */

import { useEffect } from 'react'
import {
  onApprovalRequest,
  type ApprovalRequestEvent,
  type ApprovalType,
} from '@/lib/codex/approval'
import { useApprovalStore, type PendingApproval } from '@/store/approval-store'
import { logger } from '@/lib/logger'

/**
 * 合法的审批类型列表（运行时校验用）。
 * 与 ApprovalType 联合类型保持同步（7 种）。
 */
const VALID_APPROVAL_TYPES: readonly ApprovalType[] = [
  'command',
  'patch',
  'tool',
  'mcp',
  'perm',
  'dyn',
  'attest',
]

/**
 * 运行时类型守卫：判断字符串是否为合法的 ApprovalType。
 * 后端发出未知类型时返回 false，调用方应记录 warning 并跳过。
 *
 * @param value - 待校验的字符串
 * @returns 是否为合法 ApprovalType
 */
function isValidApprovalType(value: string): value is ApprovalType {
  return (VALID_APPROVAL_TYPES as readonly string[]).includes(value)
}

/**
 * 监听审批请求事件，自动更新 approval store。
 *
 * 收到事件后将 ApprovalRequestEvent 转换为 PendingApproval 并写入 store。
 * status 初始化为 'pending'，等待用户在弹窗中操作。
 */
export function useApprovalListener(): void {
  const setPendingApproval = useApprovalStore(s => s.setPendingApproval)

  useEffect(() => {
    let isMounted = true
    let unlisten: (() => void) | null = null

    onApprovalRequest((event: ApprovalRequestEvent) => {
      // 运行时校验 approvalType：后端发出未知类型时记录 warning 并跳过，
      // 避免非法值污染 store（P1）。虽然 approvalType 在类型层面已是联合类型，
      // 但后端 JSON 反序列化不保证类型安全，需运行时防御。
      if (!isValidApprovalType(event.approvalType)) {
        logger.warn('Unknown approvalType from backend, skipping', {
          approvalType: event.approvalType,
        })
        return
      }
      const approval: PendingApproval = {
        id: event.requestIdJson,
        requestIdDisplay: event.requestIdDisplay,
        type: event.approvalType,
        payload: event.payload,
        status: 'pending',
      }
      setPendingApproval(approval)
    })
      .then(unlistenFn => {
        if (!isMounted) {
          // 组件已卸载：立即释放监听器，避免泄漏
          unlistenFn()
        } else {
          unlisten = unlistenFn
        }
      })
      .catch(error => {
        logger.error('Failed to register approval listener', { error })
      })

    return () => {
      isMounted = false
      if (unlisten) {
        unlisten()
      }
    }
  }, [setPendingApproval])
}
