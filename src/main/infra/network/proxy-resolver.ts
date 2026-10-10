import { z } from 'zod';

import { logger } from '../../utils/logger';

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

export function buildProxyUrl(cfg: ProxyConfig): string | undefined {
  return cfg.mode === 'fixed' ? cfg.url : undefined;
}

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

export function maskProxyUrl(url: string): string {
  return url.replace(/\/\/[^/@]+@/, '//***@');
}

function proxyHostPort(proxyUrl: string): string {
  const parsed = new URL(proxyUrl);
  const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
  return `${parsed.hostname}:${port}`;
}
