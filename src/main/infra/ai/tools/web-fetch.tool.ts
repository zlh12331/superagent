// src/main/infra/ai/tools/web-fetch.tool.ts
// web_fetch 工具：抓取网页正文（对齐 qwen web_fetch 工具语义收敛）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 全局 fetch（Node 18+）抓取 URL → HTML 去标签 → 正文截断
// - 仅支持 http/https；超时 15s；隐私考虑 permission='ask'
// - 失败（网络/超时/非 2xx）返回明确错误，不抛异常
//
// SSRF 防护（2026-09-06 安全审计修复）：
// - 出站目标先经 url-guard.checkUrlAllowed 判定：环回 / 私网 / 链路本地 /
//   保留段 / 本地主机名一律拒绝（auto 模式下本工具免审批，模型可被诱导探测内网）
// - 重定向改用 redirect:'manual' 并**逐跳**复查：此前 redirect:'follow'
//   允许 302 跳到 127.0.0.1 绕过首跳检查
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from './tool';
import { checkUrlAllowed } from './url-guard';

/** 抓取超时（毫秒） */
const FETCH_TIMEOUT_MS = 15_000;
/** 正文最大字符数（防单次响应膨胀） */
const MAX_CONTENT_CHARS = 4_000;
/** 重定向跳数上限（每一跳都重新做 SSRF 判定） */
const MAX_REDIRECTS = 5;

/** web_fetch 入参 */
const WebFetchInputSchema = z.object({
  /** 目标 URL（仅 http/https，且不得指向本机/内网/保留地址） */
  url: z.string().url().max(500),
  /** 正文截断上限（缺省 4000） */
  maxChars: z.number().int().min(100).max(20_000).optional(),
});

type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

/** 统一失败结果（不抛异常，交回模型可读原因） */
function failure(message: string): ToolResult {
  return { title: 'web_fetch 失败', output: message };
}

/** 3xx 重定向状态码 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 解析 URL 并做首次 SSRF 判定 */
async function resolveAllowedUrl(raw: string): Promise<{ url: URL } | { error: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `无效的 URL：${raw}` };
  }
  const guard = await checkUrlAllowed(url);
  if (!guard.allowed) {
    return { error: `目标地址被拒绝：${guard.reason}` };
  }
  return { url };
}

/**
 * 逐跳跟随重定向，每一跳重新做 SSRF 判定
 *
 * fetch 的 redirect:'manual' 会原样返回 3xx 响应（含 location 头，undici 实测），
 * 因此可以在这里拦截"公网地址 302 到内网地址"的绕过路径。
 */
async function fetchWithSafeRedirects(
  startUrl: URL,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchWithTimeout(current, FETCH_TIMEOUT_MS);
    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: current };
    }
    const location = response.headers.get('location');
    if (location === null) {
      return { response, finalUrl: current };
    }
    await response.body?.cancel();
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error(`重定向目标非法：${location}`);
    }
    const guard = await checkUrlAllowed(next);
    if (!guard.allowed) {
      throw new Error(`重定向被拦截：${guard.reason}`);
    }
    current = next;
  }
  throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次`);
}

/**
 * 创建 web_fetch 工具（无依赖注入：使用全局 fetch）
 */
export function createWebFetchTool(): Tool<WebFetchInput> {
  return {
    name: 'web_fetch',
    description:
      '抓取网页内容并返回正文文本（去 HTML 标签）。适合查阅文档、搜索资料、核实信息。仅支持 http/https 公网地址（本机/内网/保留地址会被拒绝）。',
    inputSchema: WebFetchInputSchema,
    permission: 'ask',
    category: 'read',
    execute: async (input: WebFetchInput, _ctx: ToolContext): Promise<ToolResult> => {
      const resolved = await resolveAllowedUrl(input.url);
      if ('error' in resolved) {
        return failure(resolved.error);
      }
      try {
        const { response, finalUrl } = await fetchWithSafeRedirects(resolved.url);
        if (!response.ok) {
          return failure(`HTTP ${response.status} ${response.statusText}：${finalUrl.hostname}`);
        }
        const html = await response.text();
        const text = stripHtml(html).trim();
        if (text.length === 0) {
          return {
            title: 'web_fetch 完成',
            output: '（页面无可提取的正文文本，可能为动态渲染页面）',
          };
        }
        const max = input.maxChars ?? MAX_CONTENT_CHARS;
        const content = text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
        return {
          title: `web_fetch: ${finalUrl.hostname}`,
          output: `来源：${finalUrl.toString()}\n\n${content}`,
        };
      } catch (err: unknown) {
        return failure(`抓取失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** 带超时的 fetch（AbortController 取消） */
async function fetchWithTimeout(url: URL, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    // redirect:'manual'：3xx 原样返回，由 fetchWithSafeRedirects 逐跳复查后自行跳转
    return await fetch(url, { signal: controller.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

/** HTML → 正文文本：去 script/style/标签/实体（弱耦合纯函数，借鉴自 qwen web 工具收敛） */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ');
}
