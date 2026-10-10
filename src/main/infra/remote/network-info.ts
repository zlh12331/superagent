import { networkInterfaces } from 'node:os';

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

export function buildRemoteEndpoints(addresses: readonly string[], port: number): string[] {
  return addresses.map((address) => `http://${address}:${port}`);
}
