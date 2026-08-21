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
