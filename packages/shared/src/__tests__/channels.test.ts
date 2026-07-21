// packages/shared/src/__tests__\channels.test.ts
// IPC_CHANNELS 完整性测试
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../ipc/channels';

describe('IPC_CHANNELS', () => {
  it('所有 channel 字符串符合命名规范 {domain}:{action}', () => {
    // 命名规范：{domain}（纯小写）:{action}（camelCase）
    const pattern = /^[a-z]+:[a-zA-Z]+$/;
    // 仅校验值，键不需要
    for (const [, channel] of Object.entries(IPC_CHANNELS)) {
      expect(channel).toMatch(pattern);
    }
  });

  it('channel 值全局唯一（无重复）', () => {
    const values = Object.values(IPC_CHANNELS);
    const set = new Set(values);
    expect(set.size).toBe(values.length);
  });

  it('包含应用级 channel', () => {
    expect(IPC_CHANNELS.APP_GET_STATUS).toBe('app:getStatus');
    expect(IPC_CHANNELS.APP_OPEN_EXTERNAL).toBe('app:openExternal');
  });
});
