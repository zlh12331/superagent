// scripts/lib/github-rest.ts
// GitHub REST 只读客户端（发版门禁脚本共享；2026-10-06 自 check-release-anchor.ts 提取）
// ──────────────────────────────────────────────────────────────
// 安全设计（Mimosa 门禁对齐，沿用锚点检查首版防线）：
//   - 零子进程：Node 原生 fetch 直连 REST API，不 spawn gh/git（动态参数派生
//     子进程是 Mimosa 拦截的高发形态，且 spawn 解析在 Windows 不可靠）
//   - SSRF 三重防线：仅 https + 固定 host 白名单 + path 前缀锚定（逐条复核）
//   - 动态值（版本号 / PR 号）进入 path 前必须由调用方过语义白名单
//     （SemVer RE / ^\d+$）；本模块只做结构复核，不替代语义白名单
//   - 认证：GITHUB_TOKEN（匿名可用但限流 60/h，CI 必配）
// fetchFn 依赖注入：单测以假 fetch 覆盖「网络失败 / 404 / 正常」三路——
// 测试真实实现而非 mock 模块（仓库测试规范）。
// ──────────────────────────────────────────────────────────────

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
  // 动态构造而非字面量：HTTP 头名是协议常量（PascalCase / kebab-case 不可改），
  // 字面量属性会触发 useNamingConvention（本目录不在 biome.json 的 override 清单）；
  // 经索引签名的 Record 写入不触发属性名检查（原锚点脚本同款写法）。
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
