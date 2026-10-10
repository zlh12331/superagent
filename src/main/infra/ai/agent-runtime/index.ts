// index.ts：agent-runtime barrel——回合执行层对外导出（机器不在此列，agent 层直引单文件）
export { DEFAULT_STREAM_IDLE_TIMEOUT_MS, readWithIdleTimeout } from './stream-reader';
export { TurnEventEmitter } from './turn-emitter';
export type { TurnRunnerOptions, TurnRunResult } from './turn-runner';
export { TurnRunner } from './turn-runner';
export type { StreamPart } from './turn-translator';
export { isTurnEventOfType, translatePart } from './turn-translator';
