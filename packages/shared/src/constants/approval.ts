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

/**
 * 交互式提问超时（毫秒）：60 秒，超时后工具返回「用户未响应」让 LLM 继续。
 *
 * 与审批超时的差异是有意的：审批是安全门（宁可等 5 分钟也不放过危险操作），
 * 提问是信息收集（长等无收益，快速放行让 LLM 自行决策）。两者都经机器 after
 * 转换计时（38 号阶段 2 收尾：计时源从服务层裸 setTimeout 迁至状态机）。
 */
export const ASK_TIMEOUT_MS = 60_000;

/** 交互式提问超时（秒）：供渲染层倒计时文案 */
export const ASK_TIMEOUT_SECONDS = ASK_TIMEOUT_MS / 1_000;
