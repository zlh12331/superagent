// src/main/infra/network/proxied-fetch.ts
// Node 栈代理 fetch（34 号网络代理 §2.1/§2.2）
// ──────────────────────────────────────────────────────────────
// 背景（探针实测，2026-09-29）：Electron 44 内嵌 Node 24.20 / undici 7.29，
// 但**全局 fetch 不认 dispatcher 选项**（传入被静默忽略）——Node 栈代理必须
// 用 npm undici 的 fetch + ProxyAgent 闭环，不能用全局 fetch 加选项。
//
// 职责：
// - proxiedFetch(input, init)：AI SDK fetch 注入 / IM 适配器 fetchFn / MCP
//   transport / postWebhook 的统一出口——非 fixed 模式直连全局 fetch（零开销），
//   fixed 模式先过 shouldBypass（localhost 恒绕过）再经 ProxyAgent 发出。
// - ProxyAgent 实例按代理 URL 缓存（连接池复用）；配置变更由 applyProxyChange
//   调 clearProxyAgents() 重建（V5 免重启生效）。
// ──────────────────────────────────────────────────────────────

import { type Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';

import type { ProxyConfig } from './proxy-resolver';
import { shouldBypass } from './proxy-resolver';

/** 代理 URL → ProxyAgent 缓存（同 URL 复用连接池；换代理重建） */
const agentCache = new Map<string, ProxyAgent>();

/** 当前生效的代理配置（applyProxyChange 注入；null = 未初始化，直连） */
let currentConfig: ProxyConfig | null = null;

/**
 * 注入当前代理配置（applyProxyChange 调用；传入 null = 回落直连）
 *
 * 同时清空 ProxyAgent 缓存——旧代理的连接池不复用（凭据可能已变更）。
 */
export function setProxyFetchConfig(cfg: ProxyConfig | null): void {
  currentConfig = cfg;
  clearProxyAgents();
}

/** 清空 ProxyAgent 缓存（配置变更/测试复位用） */
export function clearProxyAgents(): void {
  for (const agent of agentCache.values()) {
    void agent.close().catch(() => {
      // 关闭失败不阻断（连接池随进程退出回收）
    });
  }
  agentCache.clear();
}

/** 取（或创建）代理 URL 对应的 ProxyAgent */
function getAgent(proxyUrl: string): ProxyAgent {
  const cached = agentCache.get(proxyUrl);
  if (cached !== undefined) {
    return cached;
  }
  const agent = new ProxyAgent(proxyUrl);
  agentCache.set(proxyUrl, agent);
  return agent;
}

/** 输入形状（兼容标准 fetch RequestInfo；主进程 lib.dom 不含 RequestInfo，用结构类型） */
type FetchInput = string | URL | { readonly url: string; readonly method?: string };

/**
 * 带代理感知的 fetch（AI SDK / IM / MCP 统一出口）
 *
 * - 未初始化或非 fixed 模式 → 直通全局 fetch（零代理开销，V1 不变量）
 * - fixed + 目标命中绕过规则（localhost 硬规则 / 用户 bypass）→ 直通全局 fetch
 * - 其余 → undici fetch + ProxyAgent dispatcher（探针已证此闭环可行）
 *
 * 错误透传不转译：ECONNREFUSED 等网络错误保持原样（反例 6 归因语义——
 * 用户/测试连接需要看到原始代理端口）。
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
