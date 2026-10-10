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
