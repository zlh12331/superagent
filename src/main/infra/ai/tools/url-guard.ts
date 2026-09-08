// src/main/infra/ai/tools/url-guard.ts
// web_fetch 出站 URL 安全守卫（SSRF 防护）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-06 安全审计）：web_fetch 此前只校验协议，不拦环回/私网/
// 链路本地地址且跟随重定向。auto 模式下所有非 exec 工具免审批，模型（或经
// IM / remote-control 触发的无头回合）可探测本机与内网服务——例如自托管
// Sentry(127.0.0.1:9000)、Ollama(11434)、路由器管理面(192.168.x.x)、
// 云元数据(169.254.169.254)——并把响应正文回灌进上下文。
//
// 策略（fail closed）：
// - 仅 http / https
// - 主机名命中本地名（localhost / *.localhost / *.local / 元数据域名）→ 拒
// - 字面量 IP → 直接按受限网段判定
// - 域名 → DNS 解析**全部**地址，任一落入受限段即拒
// - 重定向由调用方逐跳复查（fetch redirect: 'manual'）
// ──────────────────────────────────────────────────────────────

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** 出站 URL 检查结论（fail closed：不明确允许即拒绝） */
export type UrlGuardResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** 受限主机名（本地名 / 云元数据服务名） */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata',
]);

/** 主机名是否为本地/元数据名（含 *.localhost / *.local 后缀） */
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

/** 点分十进制 IPv4 → 四段数字（非法返回 null） */
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

/** IPv4 是否落在环回/私网/链路本地/保留段（SSRF 受限地址） */
export function isBlockedIPv4(ip: string): boolean {
  const octets = parseIPv4(ip);
  if (octets === null) {
    return true; // 解析失败 fail closed
  }
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // 未指定 / 私网 / 环回
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私网
  if (a === 192 && b === 168) return true; // 192.168/16 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 保留/文档
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试
  if (a === 198 && b === 51) return true; // 198.51.100/24 文档
  if (a === 203 && b === 0) return true; // 203.0.113/24 文档
  if (a >= 224) return true; // 组播 / 保留 / 广播
  return false;
}

/** IPv6 是否落在环回/未指定/ULA/链路本地/组播（含 IPv4 映射地址） */
export function isBlockedIPv6(ip: string): boolean {
  const addr = ip.trim().toLowerCase().split('%')[0] ?? '';
  if (addr === '::1' || addr === '::') {
    return true;
  }
  // IPv4 映射（::ffff:127.0.0.1）与 IPv4 兼容（::127.0.0.1）形式
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped !== null) {
    return isBlockedIPv4(mapped[1] ?? '');
  }
  const head = Number.parseInt(addr.split(':')[0] ?? '', 16);
  if (Number.isNaN(head)) {
    return true; // 无法解析 fail closed
  }
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地地址
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 组播
  return false;
}

/** IP 字面量是否受限（v4/v6 分派；非 IP 返回 false 交由主机名规则处理） */
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

/**
 * 检查出站 URL 是否允许访问（协议 + 主机名 + 全部解析地址）
 *
 * fail closed：DNS 解析失败、地址解析异常一律拒绝。
 */
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
