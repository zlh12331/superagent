// src/main/infra/ai/agent-runtime/index.ts
// Agent 回合运行时统一入口
// ──────────────────────────────────────────────────────────────
// 职责：
// - 导出 TurnEventEmitter（事件生产/订阅）
// - 导出 turn-translator（AI SDK part → TurnEvent 纯函数翻译）
// - 导出 TurnRunner（回合执行器：读流 → 翻译 → 事件产出 → 统计）
// - 导出 stream-reader（共享空闲超时读流，chat/agent 共用）
// ──────────────────────────────────────────────────────────────

export { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readWithIdleTimeout } from './stream-reader';
export { TurnEventEmitter } from './turn-emitter';
export type { TurnRunnerOptions, TurnRunResult } from './turn-runner';
export { TurnRunner } from './turn-runner';
export type { StreamPart } from './turn-translator';
export { isTurnEventOfType, translatePart } from './turn-translator';
