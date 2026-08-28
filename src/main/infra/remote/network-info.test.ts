// src/main/infra/remote/network-info.test.ts
// 局域网地址枚举单测：回环/内部/IPv6 过滤 + 端点组装（os.networkInterfaces 桩化）

import { networkInterfaces } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRemoteEndpoints, getLanIPv4Addresses } from './network-info';

vi.mock('node:os', () => ({
  networkInterfaces: vi.fn(),
}));

type InterfaceInfo = NonNullable<ReturnType<typeof networkInterfaces>[string]>[number];

function stubInterfaces(entries: Record<string, Partial<InterfaceInfo>[]>): void {
  vi.mocked(networkInterfaces).mockReturnValue(entries as never);
}

describe('getLanIPv4Addresses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('仅保留非内部 IPv4 地址（回环与 IPv6 剔除）', () => {
    stubInterfaces({
      // biome-ignore lint/style/useNamingConvention: 网卡名是操作系统给定的字面量
      Ethernet: [
        { address: '192.168.1.10', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    });
    expect(getLanIPv4Addresses()).toEqual(['192.168.1.10']);
  });

  it('网卡列表缺失（undefined）时返回空数组而非抛错', () => {
    stubInterfaces({
      // biome-ignore lint/style/useNamingConvention: 网卡名是操作系统给定的字面量
      WLAN: undefined as never,
    });
    expect(getLanIPv4Addresses()).toEqual([]);
  });
});

describe('buildRemoteEndpoints', () => {
  it('组装 http://地址:端口 形式的完整直连入口', () => {
    expect(buildRemoteEndpoints(['192.168.1.10', '10.0.0.5'], 45918)).toEqual([
      'http://192.168.1.10:45918',
      'http://10.0.0.5:45918',
    ]);
  });
});
