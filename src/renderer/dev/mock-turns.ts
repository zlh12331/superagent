// src/renderer/dev/mock-turns.ts
// dev mock 的回合派生（browser 模式 mock-api 用；debt.md#d2 回合分页配套）
// ──────────────────────────────────────────────────────────────
// 从 messagesBySession 的扁平消息按「每个用户消息开一个回合」派生回合列表与
// 回合消息明细，turnId 形如 `${sessionId}-turn-${用户消息序号}`——与主进程
// 不变量（所有持久化消息带 turnId、回合以用户消息开始）对齐。
// 独立成文件的原因：mock-api.ts 有 file-size 棘轮基线（净行只减不增）。
// ──────────────────────────────────────────────────────────────

/** 回合派生输入的最小消息形状（结构兼容 mock-api 的 MockMessage） */
export interface MockTurnSourceMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** 回合 mock 的公共摘要字段（tokens/耗时/状态） */
const MOCK_TURN_BASE = {
  modelId: 'deepseek-v4-flash',
  status: 'completed',
  inputTokens: 120,
  outputTokens: 320,
  totalTokens: 440,
  durationMs: 8_400,
} as const;

/** 用户消息起始索引（回合切分锚点） */
function userStarts(msgs: readonly MockTurnSourceMessage[]): number[] {
  const starts: number[] = [];
  msgs.forEach((m, i) => {
    if (m.role === 'user') {
      starts.push(i);
    }
  });
  return starts;
}

/**
 * 从扁平消息派生回合列表（TurnSummary 形状）
 *
 * @param msgs 会话扁平消息
 * @param sessionId 会话 id（turnId 前缀）
 * @param now 当前时间戳（createdAt 以消息位置倒推，保证顺序稳定）
 */
export function buildMockTurns(
  msgs: readonly MockTurnSourceMessage[],
  sessionId: string,
  now: number,
) {
  return userStarts(msgs).map((start, n) => ({
    turnId: `${sessionId}-turn-${n}`,
    seq: n,
    ...MOCK_TURN_BASE,
    createdAt: now - (msgs.length - start) * 60_000,
  }));
}

/**
 * 按 turnId（`${sessionId}-turn-${n}`）取该回合消息：第 n 个用户消息起至下一个
 * 用户消息前（turnId 非法或回合不存在时返回空数组）
 *
 * @param getMsgs 按 sessionId 取该会话扁平消息（由调用方绑定消息存储）
 * @param turnId 回合 id
 */
export function buildMockTurnMessages(
  getMsgs: (sessionId: string) => readonly MockTurnSourceMessage[],
  turnId: string,
): ReadonlyArray<MockTurnSourceMessage> {
  const sep = '-turn-';
  const idx = turnId.lastIndexOf(sep);
  if (idx < 0) {
    return [];
  }
  const sessionId = turnId.slice(0, idx);
  const msgs = getMsgs(sessionId);
  const starts = userStarts(msgs);
  const turnNo = Number(turnId.slice(idx + sep.length));
  const start = starts[turnNo];
  if (start === undefined) {
    return [];
  }
  const end = starts[turnNo + 1] ?? msgs.length;
  return msgs.slice(start, end);
}
