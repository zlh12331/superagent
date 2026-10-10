import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../ipc/channels';

describe('IPC_CHANNELS', () => {
  it('所有 channel 字符串符合命名规范', () => {
    const pattern = /^[a-z]+(:[a-zA-Z]+)+$/;
    for (const [, channel] of Object.entries(IPC_CHANNELS)) {
      expect(channel).toMatch(pattern);
    }
  });

  it('流式 channel 符合 {domain}:stream:{event} 命名', () => {
    const streamChannels = Object.values(IPC_CHANNELS).filter((c) => c.includes(':stream:'));
    for (const channel of streamChannels) {
      expect(channel).toMatch(/^[a-z]+:stream:[a-zA-Z]+$/);
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
