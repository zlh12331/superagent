// src/main/infra/ai/agent-runtime/index.ts
// Agent 回合运行时统一入口（目录级桶出口）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 导出 TurnEventEmitter（回合事件生产/订阅，本目录对外主出口）
// - 导出 turn-translator（AI SDK part → TurnEvent 纯函数翻译 + 类型收窄辅助）
// - 导出 TurnRunner（回合执行器：读流 → 翻译 → 事件产出 → 统计）
// - 导出 stream-reader（带空闲超时守卫的读流原语）
//
// 导出面现状（按真实消费落笔）：
// - 主出口 = TurnEventEmitter：agent-service / turn-subscriptions 两处经本桶导入
// - 其余 re-export（TurnRunner / stream-reader / turn-translator）当前无桶级消费方
//   ——消费者一律深度导入直达（turn-assembly / create-stream / 机器及其测试）；
//   保留 re-export 是把目录公共面显式化，属 knip exports 级人工审阅范畴
// ──────────────────────────────────────────────────────────────

export { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readWithIdleTimeout } from './stream-reader';
export { TurnEventEmitter } from './turn-emitter';
export type { TurnRunnerOptions, TurnRunResult } from './turn-runner';
export { TurnRunner } from './turn-runner';
export type { StreamPart } from './turn-translator';
export { isTurnEventOfType, translatePart } from './turn-translator';
