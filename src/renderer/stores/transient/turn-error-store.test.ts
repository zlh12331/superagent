// turn-error-store.test.ts
// 回合错误 store 单测：set 覆盖 / ensure 缺位才写 / clear 按会话 / 并发隔离
import { beforeEach, describe, expect, it } from 'vitest';

import { useTurnErrorStore } from './turn-error-store';

describe('useTurnErrorStore', () => {
  beforeEach(() => {
    useTurnErrorStore.setState({ errors: {} });
  });

  it('set：写入条目（code / message / 时间戳）', () => {
    useTurnErrorStore.getState().set('s1', 'AI_TIMEOUT', '超时了');
    const entry = useTurnErrorStore.getState().errors['s1'];
    expect(entry?.code).toBe('AI_TIMEOUT');
    expect(entry?.message).toBe('超时了');
    expect(entry?.at).toBeGreaterThan(0);
  });

  it('set：同会话再次写入直接覆盖（最近一次为准）', () => {
    useTurnErrorStore.getState().set('s1', 'A', 'm1');
    useTurnErrorStore.getState().set('s1', 'B', 'm2');
    expect(useTurnErrorStore.getState().errors['s1']?.code).toBe('B');
  });

  it('ensure：缺位时写入（invoke 阶段失败的兜底路径）', () => {
    useTurnErrorStore.getState().ensure('s1', 'UNKNOWN', 'fallback');
    expect(useTurnErrorStore.getState().errors['s1']?.message).toBe('fallback');
  });

  it('ensure：已有条目时不覆盖（权威载荷优先于 SDK 脱敏文案）', () => {
    useTurnErrorStore.getState().set('s1', 'AI_API_KEY_INVALID', '原文');
    useTurnErrorStore.getState().ensure('s1', 'UNKNOWN', 'An error occurred.');
    expect(useTurnErrorStore.getState().errors['s1']?.code).toBe('AI_API_KEY_INVALID');
    expect(useTurnErrorStore.getState().errors['s1']?.message).toBe('原文');
  });

  it('clear：仅清指定会话（并发会话互不影响）', () => {
    useTurnErrorStore.getState().set('s1', 'A', 'm');
    useTurnErrorStore.getState().set('s2', 'B', 'm');
    useTurnErrorStore.getState().clear('s1');
    expect(useTurnErrorStore.getState().errors['s1']).toBeUndefined();
    expect(useTurnErrorStore.getState().errors['s2']?.code).toBe('B');
  });

  it('clear：无条目时为幂等 no-op（不产生新引用）', () => {
    const before = useTurnErrorStore.getState().errors;
    useTurnErrorStore.getState().clear('nope');
    expect(useTurnErrorStore.getState().errors).toBe(before);
  });
});
