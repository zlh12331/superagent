// packages/shared/src/constants/approval.ts
// 审批「记住决策」有效期：跨进程单一真源
// ──────────────────────────────────────────────
// 定位：主进程 PermissionService 据此缓存记忆决策（expireAt），
// 渲染层审批按钮（approval.whitelistHint）据此向用户明示有效期，
// 避免两端各写一份导致文案与实现漂移（此前 UI 文案误写"本次会话内"）。
// ──────────────────────────────────────────────

/** 记忆决策有效期（毫秒）：5 分钟，与审批超时对齐；过期后同一工具+入参会重新询问 */
export const REMEMBER_TTL_MS = 5 * 60 * 1000;

/** 记忆决策有效期（分钟）：由 REMEMBER_TTL_MS 派生，供文案插值与测试断言 */
export const REMEMBER_TTL_MINUTES = REMEMBER_TTL_MS / 60_000;
