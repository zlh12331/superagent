// channels.test.ts：IPC_CHANNELS 常量表（由 meta.ts 经 derive.ts 派生）的命名契约测试——
// 命名形态、流式段位、值唯一性与 app 域字面量探针；不校验通道的 zod/类型契约（那由 definitions.ts 与类型系统保证）
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../ipc/channels';

describe('IPC_CHANNELS', () => {
  it('所有 channel 字符串符合命名规范', () => {
    // 命名规范三模式（docs/design/19-ipc-spec.md §一）：{domain}:{action} 请求-响应、
    // {domain}:stream:{event} 流式、{domain}:event:{name} 状态推送；本正则只约束形态
    // （domain 全小写 + 至少一个字母段，不限制段数），流式通道由下一条单独收紧
    const pattern = /^[a-z]+(:[a-zA-Z]+)+$/;
    for (const [, channel] of Object.entries(IPC_CHANNELS)) {
      expect(channel).toMatch(pattern);
    }
  });

  it('流式 channel 符合 {domain}:stream:{event} 命名', () => {
    // 流式事件与状态推送同为 kind:'event'，preload 订阅不按名称分流；但主进程 dev 期 payload 校验
    // 按名称是否含 ':stream:' 决定采样（1/50）还是全量（src/main/utils/emit-event.ts:74）——命名漂移会静默改变校验覆盖率
    const streamChannels = Object.values(IPC_CHANNELS).filter((c) => c.includes(':stream:'));
    for (const channel of streamChannels) {
      expect(channel).toMatch(/^[a-z]+:stream:[a-zA-Z]+$/);
    }
  });

  it('channel 值全局唯一（无重复）', () => {
    // 派生 key 由通道字面量唯一决定，当前实现天然唯一；此断言把「一通道一方法」钉成契约
    const values = Object.values(IPC_CHANNELS);
    const set = new Set(values);
    expect(set.size).toBe(values.length);
  });

  it('包含应用级 channel', () => {
    // preload（src/preload/utils/create-api.ts）与主进程（src/main/ipc/register.ts）都从同一张表取通道，
    // 改名会两侧同步生效且不报错，故协议字符串需要显式锚点——取 app 域两条作探针
    expect(IPC_CHANNELS.APP_GET_STATUS).toBe('app:getStatus');
    expect(IPC_CHANNELS.APP_OPEN_EXTERNAL).toBe('app:openExternal');
  });
});
