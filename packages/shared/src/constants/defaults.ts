// packages/shared/src/constants/defaults.ts
// 默认 AI 供应商与默认模型的「单一真源」
// ──────────────────────────────────────────────
// 定位：默认供应商 + 默认模型为跨进程共享的权威常量，供
// - 主进程：@code-agent/shared/main（src/main/infra/ai/models/builtin-models.ts）
// - 渲染层：@code-agent/shared/renderer（src/renderer/stores/persistent/settings-store.ts）
// 共同引用，避免双源漂移（此前两端各自写死 'deepseek' / 'deepseek-v4-flash'）。
//
// 变更：改默认供应商/模型只改这一处即可。
// ──────────────────────────────────────────────

/** 默认 AI 供应商（未指定模型/供应商时的全局回退） */
export const DEFAULT_PROVIDER = 'deepseek' as const;

/** 默认聊天 / Agent 模型 id */
export const DEFAULT_MODEL = 'deepseek-v4-flash' as const;

// ── 消息/附件/终端 UI 限制（渲染层 UX 拦截的权威数值） ──────────
// 说明：这些限制是渲染层输入/展示层的 UX 拦截，单一真源收敛于此，
// 供 ChatInput / attachments / TerminalPanel 引用，避免魔法值双写。
// 服务端 schema 不做强校验（LLM 工具输出等长内容不应被误伤）。

/** 单条消息最大字符数（ChatInput 发送前拦截，对齐原型 8000） */
export const MAX_MESSAGE_LENGTH_CHARS = 8000;

/** 附件内容拼接截断上限（字符；超出截断避免消息膨胀） */
export const ATTACHMENT_MAX_CHARS = 4000;

/**
 * 主进程入参纵深防御硬上限（字符）
 *
 * 语义：渲染层已拦截 base ≤ MAX_MESSAGE_LENGTH_CHARS、附件每文件 ≤ ATTACHMENT_MAX_CHARS；
 * 本值为「基础文本 × 4」的防御性上界，覆盖极端附件组合，仅用于拦截绕过渲染层的病态
 * 超大输入（正常 UI 消息远低于此）。服务端 schema 不做强校验——历史中 LLM 工具输出等长
 * 内容不应被误伤，故仅在 agent.handler 对「最后一条用户消息」做此检查。
 */
export const MAX_USER_INPUT_HARD_CAP = MAX_MESSAGE_LENGTH_CHARS * 4;

/** 终端创建时默认列数（缺省 dimensions 时使用） */
export const TERMINAL_DEFAULT_COLS = 80;

/** 终端创建时默认行数（缺省 dimensions 时使用） */
export const TERMINAL_DEFAULT_ROWS = 24;
