// src/renderer/lib/ipc.test.ts
// unwrap（IPC 响应解包）单测
import { describe, expect, it } from 'vitest';

import { unwrap } from './ipc';

describe('unwrap', () => {
  it('成功响应：返回 data', () => {
    const result = unwrap<{ value: number }>({ data: { value: 42 } });
    expect(result).toEqual({ value: 42 });
  });

  it('错误响应：抛 Error 且格式为 [CODE] message', () => {
    expect(() => unwrap({ error: { code: 'AI_TIMEOUT', message: '超时' } })).toThrow(
      '[AI_TIMEOUT] 超时',
    );
  });

  it('data 为 falsy 值（0/空串）仍正常返回', () => {
    expect(unwrap({ data: 0 })).toBe(0);
    expect(unwrap({ data: '' })).toBe('');
  });
});
