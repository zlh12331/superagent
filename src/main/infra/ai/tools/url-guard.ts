// url-guard.ts：URL SSRF 防线——主机名黑名单（云元数据端点/本地域）+ 解析后 IP 黑名单
//（私网/环回/链路本地），DNS rebinding 经「先解析再判 IP」防住
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** URL 守卫结论：allowed=false 时 reason 说明命中哪类受限地址 */
export type UrlGuardResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

// 主机名黑名单：云厂商元数据端点（GCP/AWS）+ 本地域后缀——Agent 不该探测这些
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata',
]);

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (host.length === 0) {
    return true;
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    return true;
  }
  return host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    nums.push(value);
  }
  return nums;
}

export function isBlockedIPv4(ip: string): boolean {
  const octets = parseIPv4(ip);
  if (octets === null) {
    return true;
  }
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

export function isBlockedIPv6(ip: string): boolean {
  const addr = ip.trim().toLowerCase().split('%')[0] ?? '';
  if (addr === '::1' || addr === '::') {
    return true;
  }
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped !== null) {
    return isBlockedIPv4(mapped[1] ?? '');
  }
  const head = Number.parseInt(addr.split(':')[0] ?? '', 16);
  if (Number.isNaN(head)) {
    return true;
  }
  if ((head & 0xfe00) === 0xfc00) return true;
  if ((head & 0xffc0) === 0xfe80) return true;
  if ((head & 0xff00) === 0xff00) return true;
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip.trim().replace(/^\[|\]$/g, ''));
  if (family === 4) {
    return isBlockedIPv4(ip.trim());
  }
  if (family === 6) {
    return isBlockedIPv6(ip.trim());
  }
  return false;
}

export async function checkUrlAllowed(url: URL): Promise<UrlGuardResult> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `不支持的协议 ${url.protocol}（仅 http/https）` };
  }
  const hostname = url.hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (isBlockedHostname(hostname)) {
    return { allowed: false, reason: `本机/内网主机名 ${hostname}` };
  }
  if (isIP(hostname) !== 0) {
    return isBlockedAddress(hostname)
      ? { allowed: false, reason: `受限地址 ${hostname}（环回/私网/链路本地/保留段）` }
      : { allowed: true };
  }
  let addresses: readonly { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return { allowed: false, reason: `主机名无法解析：${hostname}` };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: `主机名无解析结果：${hostname}` };
  }
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) {
      return {
        allowed: false,
        reason: `${hostname} 解析到受限地址 ${entry.address}（环回/私网/链路本地/保留段）`,
      };
    }
  }
  return { allowed: true };
}
