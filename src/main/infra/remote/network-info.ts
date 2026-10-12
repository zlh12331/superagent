// network-info.ts：远程控制网络信息——LAN IPv4 枚举 + 端点拼装（remote 快照展示用）
import { networkInterfaces } from 'node:os';

/** 本机全部非环回 IPv4（虚拟网卡/多网卡都列出，由用户从快照里挑） */
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

/** 地址 + 端口 → 可直接访问的 http 端点串 */
export function buildRemoteEndpoints(addresses: readonly string[], port: number): string[] {
  return addresses.map((address) => `http://${address}:${port}`);
}
