// stream-retry-boundary.ts：流重试边界——「重试安全前奏」缓冲到首个真实 provider 内容事件为止。
// 参照 zcode stream-retry-boundary；本项目的边界判定基于 AI SDK UIMessageChunk 的 type 判别。
//
// 设计要点：
// - 结构类事件（start/step/text-start/reasoning-start/tool-input-start）是「前奏」——它们不构成
//   用户可见输出，缓冲不外发；此窗口内断流可直接重建流，用户无感
// - 空 delta（SDK 转签名时会产 ''）不构成内容，随前奏暂存
// - 边界事件（非空 delta / tool-call / finish / error / output-*）到达 = 提交点：
//   缓冲的前奏按原序释放 + 边界事件本身外发，此后不再重试
// - 未知 type 一律当边界（保守正确：宁可少一次无感重试，不可重复输出）

/** 重试安全前奏事件集（type 判别；这些事件缓冲不外发） */
const RETRY_SAFE_PRELUDE_TYPES: ReadonlySet<string> = new Set([
  'start',
  'start-step',
  'text-start',
  'reasoning-start',
  'tool-input-start',
]);

/** 带 delta 字段的事件（前奏期空 delta 暂存、非空 delta 即边界） */
const DELTA_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text-delta',
  'reasoning-delta',
  'tool-input-delta',
]);

/** 流 part 是否为重试安全前奏（true=缓冲，false=边界提交） */
export function isRetrySafePreludePart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) {
    return false;
  }
  const type = (part as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return false;
  }
  if (RETRY_SAFE_PRELUDE_TYPES.has(type)) {
    return true;
  }
  if (DELTA_EVENT_TYPES.has(type)) {
    // delta 字段缺失按边界处理（未知形态不无限缓冲——SDK 类型上 delta 必有，缺失即异常流）
    const delta = (part as { delta?: unknown }).delta;
    return delta === '';
  }
  return false;
}
