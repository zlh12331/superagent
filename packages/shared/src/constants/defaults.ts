// defaults.ts：跨进程共享的默认值单一真源（默认供应商/模型 + 消息、附件、终端上限）
// 默认供应商/模型被两端共同引用——主进程 src/main/infra/ai/models/builtin-models.ts、
// 渲染层 src/renderer/stores/persistent/settings-store.ts；改默认值只改这一处（避免双源漂移）。
/** 默认 AI 供应商（未指定模型/供应商时的全局回退） */
export const DEFAULT_PROVIDER = 'deepseek' as const;

/** 默认聊天 / Agent 模型 id（DeepSeek V4.1-Flash，官方模型名 deepseek-flash） */
export const DEFAULT_MODEL = 'deepseek-flash' as const;

// ── 消息/附件/终端上限：渲染层 UX 拦截的权威数值 ──────────────────────────
// 供 ChatInput / attachments / TerminalPanel 引用，避免魔法值双写；上限只作用于渲染层入口，
// 服务端 schema 不做强校验（历史中 LLM 工具输出等长内容不应被误伤）。
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

/** 终端创建默认列数（初始几何；首次 FitAddon 适配后经 resizeTerminal 同步真实尺寸） */
export const TERMINAL_DEFAULT_COLS = 80;

/** 终端创建默认行数（初始几何；首次 FitAddon 适配后经 resizeTerminal 同步真实尺寸） */
export const TERMINAL_DEFAULT_ROWS = 24;
