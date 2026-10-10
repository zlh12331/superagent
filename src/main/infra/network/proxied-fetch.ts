import { type Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';

import type { ProxyConfig } from './proxy-resolver';
import { shouldBypass } from './proxy-resolver';

const agentCache = new Map<string, ProxyAgent>();

let currentConfig: ProxyConfig | null = null;

export function setProxyFetchConfig(cfg: ProxyConfig | null): void {
  currentConfig = cfg;
  clearProxyAgents();
}

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
