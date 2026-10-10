// proxy-resolver.ts：代理配置解析与派生——设置值 zod 校验、Chromium 分区规则、绕过判定、URL 脱敏
// 34 号：本文件是纯函数层（无副作用），应用/取 URL 的副作用在 proxy-applier / proxied-fetch
import { z } from 'zod';

import { logger } from '../../utils/logger';

/** 代理模式：system=随系统 / direct=直连 / fixed=用户指定 URL */
export type ProxyMode = 'system' | 'direct' | 'fixed';

export interface ProxyConfig {
  readonly mode: ProxyMode;
  readonly url?: string;
  readonly bypass?: readonly string[];
}

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

const SYSTEM_DEFAULT: ProxyConfig = { mode: 'system' };

/** 解析设置原始值（用户可控面）：损坏/fixed 缺 url 一律回落 system 兜底并告警 */
export function parseProxyConfig(raw: unknown): ProxyConfig {
  if (raw === undefined || raw === null) {
    return { ...SYSTEM_DEFAULT };
  }
  const parsed = ProxyConfigSchema.safeParse(raw);
  if (parsed.success) {
    const { mode, url, bypass } = parsed.data;
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

/** 派生 Chromium session.setProxy 参数（default/updater/preview 三分区共用一档） */
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

/** fixed 模式返回代理 URL（env 侧通道用），其余模式 undefined */
export function buildProxyUrl(cfg: ProxyConfig): string | undefined {
  return cfg.mode === 'fixed' ? cfg.url : undefined;
}

/**
 * 请求是否绕过代理：环回地址（各写法）永远绕过；bypass 列表按后缀匹配
 *（仅 fixed 模式有意义——system/direct 本就不走代理）
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
  if (hostname.startsWith('127.')) {
    return true;
  }
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

/** 日志用脱敏：代理 URL 可能带 `user:pass@` 认证段，替换为 *** */
export function maskProxyUrl(url: string): string {
  return url.replace(/\/\/[^/@]+@/, '//***@');
}

// 端口缺省按协议补齐（Chromium proxyRules 要求 host:port 形态）
function proxyHostPort(proxyUrl: string): string {
  const parsed = new URL(proxyUrl);
  const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
  return `${parsed.hostname}:${port}`;
}
