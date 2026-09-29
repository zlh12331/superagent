// src/main/infra/network/proxy-resolver.ts
// 网络代理配置解析器（34 号网络代理；docs/design/34-network-proxy-spec.md §2.1）
// ──────────────────────────────────────────────────────────────
// 职责：settings.proxy 键（DB 值不可信）→ 归一化 ProxyConfig → 各网络栈要的形态。
// 全部纯函数（除 warn 日志），单点真源——Chromium 三分区 / Node proxiedFetch /
// env 侧门五个应用点全部经此模块，无双份状态。
//
// 失败路径：解析失败 fail-open 回 mode='system'（33 号 D2 同语义——向既有行为
// 兜底，代理是增强能力），每次解析失败 warn 一次（诊断包可见，不静默）。
//
// 安全：代理 URL 可内嵌凭据（D5），进日志一律经 maskProxyUrl 脱敏。
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

import { logger } from '../../utils/logger';

/** 代理模式（D4：system=默认不改变现状 / direct=强制直连 / fixed=自定义代理） */
export type ProxyMode = 'system' | 'direct' | 'fixed';

/** 归一化后的代理配置（解析成功的产品形态） */
export interface ProxyConfig {
  readonly mode: ProxyMode;
  /** 代理地址（http(s) URL，可含 user:pass@；仅 mode=fixed 时有效） */
  readonly url?: string;
  /** 不走代理的主机后缀列表（localhost 家族恒绕过，无需配置） */
  readonly bypass?: readonly string[];
}

/** settings.proxy 值 schema（与 SettingsSetReqSchema superRefine 门禁同构的运行时侧） */
const ProxyConfigSchema = z.object({
  mode: z.enum(['system', 'direct', 'fixed']),
  url: z
    .string()
    .refine((v) => {
      try {
        const parsed = new URL(v);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    }, '代理地址必须是合法 http(s) URL')
    .optional(),
  bypass: z.array(z.string().min(1).max(253)).max(64).optional(),
});

/** 缺省配置（mode=system：全栈走 Chromium/Node 默认行为，V1 不变量） */
const SYSTEM_DEFAULT: ProxyConfig = { mode: 'system' };

/**
 * 解析 settings.proxy 原始值 → 归一化配置
 *
 * DB 值不可信：缺失/损坏/字段级非法逐级回落（整体损坏 → system；字段非法 →
 * 该字段剔除后仍可用则保留，否则整配置回 system）。失败 warn 留诊断痕迹。
 */
export function parseProxyConfig(raw: unknown): ProxyConfig {
  if (raw === undefined || raw === null) {
    return { ...SYSTEM_DEFAULT };
  }
  const parsed = ProxyConfigSchema.safeParse(raw);
  if (parsed.success) {
    const { mode, url, bypass } = parsed.data;
    // mode=fixed 但 url 缺失（半损坏）→ 整配置不可用，回 system
    if (mode === 'fixed' && url === undefined) {
      logger.warn({ raw: String(raw).slice(0, 120) }, '代理配置 mode=fixed 缺 url，按 system 兜底');
      return { ...SYSTEM_DEFAULT };
    }
    return {
      mode,
      ...(url !== undefined ? { url } : {}),
      ...(bypass !== undefined && bypass.length > 0 ? { bypass } : {}),
    };
  }
  logger.warn({ error: parsed.error.message }, '代理配置解析失败，按 system 兜底');
  return { ...SYSTEM_DEFAULT };
}

/**
 * Chromium ProxyConfig 形态（session.setProxy 直接入参）
 *
 * fixed 拆 http/https 两条 rules（Chromium 语法不支持裸 URL 整体注入）；
 * proxyBypassRules 强制前置 <local>——localhost 家族直连是硬规则（反例 2：
 * 记忆引擎 healthcheck / ollama 本地模型经代理必挂）。
 */
export function buildChromiumProxyConfig(cfg: ProxyConfig): {
  mode: 'system' | 'direct' | 'fixed_servers';
  proxyRules?: string;
  proxyBypassRules?: string;
} {
  if (cfg.mode === 'system') {
    return { mode: 'system' };
  }
  if (cfg.mode === 'direct') {
    return { mode: 'direct' };
  }
  if (cfg.url === undefined) {
    // 防御：parseProxyConfig 已保证 fixed 必有 url，此处兜底
    return { mode: 'system' };
  }
  const host = proxyHostPort(cfg.url);
  const userBypass = cfg.bypass ?? [];
  return {
    mode: 'fixed_servers',
    proxyRules: `http=${host};https=${host}`,
    proxyBypassRules: ['<local>', ...userBypass].join(';'),
  };
}

/**
 * undici ProxyAgent / env 侧门共用的代理 URL（D5：Node 栈原生支持 user:pass@）
 *
 * 非 fixed 返回 undefined（调用方据此走直连 dispatcher / 清空 env）。
 */
export function buildProxyUrl(cfg: ProxyConfig): string | undefined {
  return cfg.mode === 'fixed' ? cfg.url : undefined;
}

/**
 * 是否绕过代理（proxiedFetch 前置判断；Chromium 侧由 proxyBypassRules 承担同语义）
 *
 * localhost/127.0.0.1/[::1] 恒绕过（硬规则）+ 用户 bypass 主机后缀匹配
 * （hostname === 后缀 或以 .后缀 结尾——`api.corp.example` 命中 `corp.example`，
 * `evil-corp.example.com` 不命中）。
 */
export function shouldBypass(cfg: ProxyConfig, requestUrl: string): boolean {
  if (cfg.mode !== 'fixed') {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(requestUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.localhost')) {
    return true;
  }
  // IPv4 回环（127.0.0.0/8 首字节 127；URL hostname 无方括号）
  if (hostname.startsWith('127.')) {
    return true;
  }
  // IPv6 回环：URL hostname 形如 [::1]
  if (hostname === '[::1]') {
    return true;
  }
  for (const suffix of cfg.bypass ?? []) {
    const s = suffix.toLowerCase();
    if (hostname === s || hostname.endsWith(`.${s}`)) {
      return true;
    }
  }
  return false;
}

/**
 * 日志脱敏：URL 内嵌凭据（user:pass@）→ ***（安全边界：凭据不落日志）
 *
 * 用正则保形替换而非 URL 重写——URL.toString() 会补尾斜杠/默认端口，
 * 脱敏输出应与输入同形，便于日志比对。
 */
export function maskProxyUrl(url: string): string {
  return url.replace(/\/\/[^/@]+@/, '//***@');
}

/** 从代理 URL 提取 host:port（Chromium proxyRules 语法；默认端口 80/443 显式补全） */
function proxyHostPort(proxyUrl: string): string {
  const parsed = new URL(proxyUrl);
  const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
  return `${parsed.hostname}:${port}`;
}
