// src/main/infra/remote/network-info.ts
// 局域网直连地址枚举（远程控制配对展示用）
// ──────────────────────────────────────────────────────────────
// 移动端与桌面端同处局域网时，需要桌面端可直连的 IPv4 入口地址。
// 排除回环与内部接口；虚拟网卡（VMware/Hyper-V/Docker 网段）保留——
// 是否命中由用户按自己的网络环境判断，此处不做启发式猜测误删真实地址。
// ──────────────────────────────────────────────────────────────

import { networkInterfaces } from 'node:os';

/** 本机非回环 IPv4 地址列表（无可用网卡时为空数组） */
export function getLanIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal || info.family !== 'IPv4') {
        continue;
      }
      addresses.push(info.address);
    }
  }
  return addresses;
}

/** 组装 HTTP 命令入口完整地址（形如 http://192.168.1.10:52341） */
export function buildRemoteEndpoints(addresses: readonly string[], port: number): string[] {
  return addresses.map((address) => `http://${address}:${port}`);
}
