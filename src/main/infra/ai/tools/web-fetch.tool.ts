// web-fetch.tool.ts：web_fetch 工具——抓取网页正文（url-guard SSRF 防线 + 去标签截断）
import { z } from 'zod';
import { t } from '../../i18n';
import type { Tool, ToolContext, ToolResult } from './tool';
import { checkUrlAllowed } from './url-guard';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_CHARS = 4_000;
const MAX_REDIRECTS = 5;

const WebFetchInputSchema = z.object({
  url: z.string().url().max(500),
  maxChars: z.number().int().min(100).max(20_000).optional(),
});

type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

function failure(message: string): ToolResult {
  return { title: t('tools.webFetch.failed'), output: message };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

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
            title: t('tools.webFetch.completed'),
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

async function fetchWithTimeout(url: URL, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*[^>]*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, decodeEntity)
    .replace(/\s+/g, ' ');
}

function decodeEntity(entity: string): string {
  const lower = entity.slice(1, -1).toLowerCase();
  if (lower.startsWith('#')) {
    const isHex = lower.startsWith('#x');
    const code = Number.parseInt(isHex ? lower.slice(2) : lower.slice(1), isHex ? 16 : 10);
    const valid = !Number.isNaN(code) && code >= 0 && code <= 0x10ffff;
    return valid ? String.fromCodePoint(code) : entity;
  }
  return HTML_ENTITIES[lower] ?? entity;
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
