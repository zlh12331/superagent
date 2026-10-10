export const GH_API_HOST = 'api.github.com';

/** SSRF 防线：仅 https + host 白名单 + path 前缀锚定（逐条复核，不用 else 链省略）。 */
export function assertSafeApiUrl(url: string, pathPrefix: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:') {
    throw new Error('protocol not https');
  }
  if (u.hostname !== GH_API_HOST) {
    throw new Error('hostname not allowed');
  }
  if (!u.pathname.startsWith(pathPrefix)) {
    throw new Error('path outside repo namespace');
  }
}

export interface GhApiClient {
  /** GET 请求；404 → null（调用方按「不存在」处理），其他失败抛错（含网络失败）。 */
  getJson(pathAndQuery: string): Promise<unknown | null>;
}

export interface CreateGhApiOptions {
  /** 仓库 namespace（如 'owner/repo'）——path 前缀锚定的边界 */
  repo: string;
  /** 可选 Bearer token；缺省读环境变量由调用方决定，本模块不读 env（可测性） */
  token?: string;
  /** fetch 注入点（测试用）；缺省全局 fetch */
  fetchFn?: typeof fetch;
}

/** 构造绑定仓库 namespace 的只读 REST 客户端。请求超时 30s（AbortSignal.timeout）。 */
export function createGhApiClient(options: CreateGhApiOptions): GhApiClient {
  const pathPrefix = `/repos/${options.repo}/`;
  const fetchFn = options.fetchFn ?? fetch;
  const headers: Record<string, string> = {};
  headers['Accept'] = 'application/vnd.github+json';
  headers['X-GitHub-Api-Version'] = '2022-11-28';
  headers['User-Agent'] = 'release-gate-check';
  if (options.token !== undefined) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  return {
    async getJson(pathAndQuery: string): Promise<unknown | null> {
      const url = `https://${GH_API_HOST}${pathAndQuery}`;
      assertSafeApiUrl(url, pathPrefix);
      const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub API ${String(res.status)} for ${pathAndQuery}`);
      return (await res.json()) as unknown;
    },
  };
}
