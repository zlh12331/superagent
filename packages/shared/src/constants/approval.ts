// approval.ts：审批与提问时限常量（跨进程单一真源）
// 每个时限成对导出：毫秒值供主进程计时与过期判定，分钟/秒值供渲染层倒计时与文案插值。

/**
 * 记忆决策有效期（毫秒）：5 分钟，与审批超时对齐；过期后同一工具+入参会重新询问。
 *
 * 主进程 PermissionService 据此写决策的 expireAt；渲染层「批准并记住」按钮与提示
 * （approval.whitelist / approval.whitelistHint）插值 REMEMBER_TTL_MINUTES——
 * 两端共用一个值，避免文案与实现漂移（曾出现 UI 误称「本次会话内」）。
 */
export const REMEMBER_TTL_MS = 5 * 60 * 1000;

/** 记忆决策有效期（分钟）：由 REMEMBER_TTL_MS 派生，供文案插值与测试断言 */
export const REMEMBER_TTL_MINUTES = REMEMBER_TTL_MS / 60_000;

/**
 * 审批请求超时（毫秒）：5 分钟，超时视为拒绝（工具不执行）。
 *
 * 与 REMEMBER_TTL_MS 数值相同但语义独立（用户离开的兜底 vs 决策记忆期），
 * 故意不合并为一个常量——合并后改一处会同时波及两条语义。
 * 计时挂在 src/main/infra/ai/agent-runtime/agent-turn-machine.ts 的 after 转换上
 * （随状态退出自动取消）；超时经 expireApproval 以 'timed-out' 结案，错误码/文案
 * 区别于用户拒绝。渲染层审批卡倒计时用同源派生的 APPROVAL_TIMEOUT_MINUTES。
 */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** 审批请求超时（分钟）：由 APPROVAL_TIMEOUT_MS 派生，供渲染层倒计时文案 */
export const APPROVAL_TIMEOUT_MINUTES = APPROVAL_TIMEOUT_MS / 60_000;

/**
 * 交互式提问超时（毫秒）：60 秒，超时后工具返回「用户未响应」让 LLM 继续。
 *
 * 与审批超时的差异是有意的：审批是安全门（宁可等 5 分钟也不放过危险操作），
 * 提问是信息收集（长等无收益，快速放行让 LLM 自行决策）。计时同样经
 * agent-turn-machine.ts 的 after 转换（声明式，随状态退出自动取消）；
 * 改此值需同步 ask-user-question.tool 提示文案里写死的「60 秒」。
 */
export const ASK_TIMEOUT_MS = 60_000;

/** 交互式提问超时（秒）：供渲染层倒计时文案 */
export const ASK_TIMEOUT_SECONDS = ASK_TIMEOUT_MS / 1_000;
