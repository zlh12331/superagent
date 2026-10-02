// packages/shared/src/constants/approval.ts
// 审批时限常量：跨进程单一真源
// ──────────────────────────────────────────────
// 定位：
// - REMEMBER_TTL_MS：主进程 PermissionService 据此缓存记忆决策（expireAt），
//   渲染层审批按钮（approval.whitelistHint）据此向用户明示有效期，
//   避免两端各写一份导致文案与实现漂移（此前 UI 文案误写"本次会话内"）。
// - APPROVAL_TIMEOUT_MS：审批请求超时（超时视为拒绝）。此前是 permission-service
//   私有字面量、与本文件 REMEMBER_TTL_MS 双写（注释互相引用"对齐"但无机制
//   保证）——38 号 spec 阶段 2 上收单一真源；渲染层审批卡倒计时同源派生。
// ──────────────────────────────────────────────

/** 记忆决策有效期（毫秒）：5 分钟，与审批超时对齐；过期后同一工具+入参会重新询问 */
export const REMEMBER_TTL_MS = 5 * 60 * 1000;

/** 记忆决策有效期（分钟）：由 REMEMBER_TTL_MS 派生，供文案插值与测试断言 */
export const REMEMBER_TTL_MINUTES = REMEMBER_TTL_MS / 60_000;

/**
 * 审批请求超时（毫秒）：5 分钟，超时视为拒绝（工具不执行）。
 * 与 REMEMBER_TTL_MS 数值相同但语义独立（用户离开兜底 vs 决策记忆期）——
 * 单一真源防漂移，不合并为一个常量。
 */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** 审批请求超时（分钟）：由 APPROVAL_TIMEOUT_MS 派生，供渲染层倒计时文案 */
export const APPROVAL_TIMEOUT_MINUTES = APPROVAL_TIMEOUT_MS / 60_000;
