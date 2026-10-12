// proxied-fetch.ts：带代理的 fetch——⚠️ 全局 fetch 不认 dispatcher，必须走 undici 的 fetch
// 闭环（34 号实测结论，勿再探针）；direct/system 模式直通原生 fetch
import { type Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';

import type { ProxyConfig } from './proxy-resolver';
import { shouldBypass } from './proxy-resolver';

// ProxyAgent 按代理 URL 缓存复用（连接池）；配置变更时全量关闭重建
const agentCache = new Map<string, ProxyAgent>();

let currentConfig: ProxyConfig | null = null;

/** 更新全局代理配置（applyProxyChange 调用；null = 未配置态） */
export function setProxyFetchConfig(cfg: ProxyConfig | null): void {
  currentConfig = cfg;
  clearProxyAgents();
}

/** 关闭并清空全部缓存 agent（释放连接池） */
export function clearProxyAgents(): void {
  for (const agent of agentCache.values()) {
    void agent.close().catch(() => {});
  }
  agentCache.clear();
}

function getAgent(proxyUrl: string): ProxyAgent {
  const cached = agentCache.get(proxyUrl);
  if (cached !== undefined) {
    return cached;
  }
  const agent = new ProxyAgent(proxyUrl);
  agentCache.set(proxyUrl, agent);
  return agent;
}

type FetchInput = string | URL | { readonly url: string; readonly method?: string };

/**
 * 代理感知 fetch：fixed 且非绕过时走 undici ProxyAgent，否则直通原生 fetch
 * （签名与全局 fetch 对齐，调用方无感切换）
 */
export async function proxiedFetch(
  input: FetchInput,
  init?: Omit<RequestInit, 'dispatcher'>,
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const cfg = currentConfig;
  if (cfg === null || cfg.mode !== 'fixed' || cfg.url === undefined || shouldBypass(cfg, url)) {
    return fetch(input as string | URL, init as RequestInit | undefined);
  }
  const agent = getAgent(cfg.url);
  return undiciFetch(url, {
    ...(init as Record<string, unknown>),
    dispatcher: agent as unknown as Dispatcher,
  }) as unknown as Promise<Response>;
}
